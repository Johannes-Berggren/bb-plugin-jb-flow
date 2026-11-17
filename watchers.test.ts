// @vitest-environment node
// The background wiring around ci-watch.ts and release-delivery.ts: what the
// schedules do, how GitHub hiccups and failed sends are retried, that a reload
// stops a cycle cleanly, and that archived threads are dropped.
import { beforeEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CiWatch } from "./ci-watch";
import { MAX_SEND_FAILURES } from "./ci-watch";
import { parseLimitHit } from "./limits";
import type { ReleaseWatchConfig } from "./watchers";
import type { ConductorInboxEvent, ConductorSink } from "./conductor-routing";

vi.mock("./gh", async (importOriginal) => ({ ...(await importOriginal<typeof import("./gh")>()), gh: vi.fn() }));
const { gh } = await import("./gh");
const { createWatchers, releaseWatchSchema } = await import("./watchers");
const ghMock = vi.mocked(gh);

type Gh = (args: string[], options: { signal?: AbortSignal }) => string | Promise<string>;
/** Answers gh by its first words ("pr list", "run list", …); anything else fails loudly. */
function answerGh(routes: Record<string, Gh>) {
  ghMock.mockImplementation(async (args, options = {}) => {
    const route = routes[args.slice(0, 2).join(" ")];
    if (!route) throw new Error(`unexpected gh ${args.join(" ")}`);
    return route(args, options);
  });
}

const REPO = "acme/web-app";
const PROJECT = "web-app";
const releaseConfig: Record<string, ReleaseWatchConfig> = { [PROJECT]: releaseWatchSchema.parse({ repo: REPO }) };

const thread = (id: string, overrides: Parameters<typeof makeThreadResponse>[0] = {}) =>
  makeThreadResponse({ id, projectId: "p1", updatedAt: Date.now(), ...overrides });

function host(options: { threads?: Record<string, ReturnType<typeof thread>>; send?: () => Promise<unknown> } = {}) {
  const threads = options.threads ?? { t1: thread("t1") };
  const fake = createFakePluginHost({
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const found = threads[threadId];
          if (!found) throw Object.assign(new Error("HTTP 404: Not found"), { status: 404 });
          return found;
        },
        send: options.send ?? (async () => ({ delivery: "queued", queuedMessage: { id: "q1" } })),
        queuedMessages: { delete: async () => ({ ok: true }) },
      },
      projects: {
        get: async () => ({ id: "p1", name: PROJECT, gitRemoteUrl: `git@github.com:${REPO}.git` }),
        list: async () => [{ id: "p1", name: PROJECT, gitRemoteUrl: `git@github.com:${REPO}.git` }],
      },
    } as never,
  });
  return { ...fake, threads };
}

function load(bb: BbPluginApi, config = releaseConfig, autoContinue = true, conductor: ConductorSink | null = null) {
  let changes = 0;
  const watchers = createWatchers(bb, config, async () => autoContinue, () => void changes++, undefined, conductor);
  return { watchers, changes: () => changes };
}

const sent = (harness: ReturnType<typeof host>["harness"]) =>
  harness.sdk.callsTo("threads.send").map(([input]) => {
    const { threadId, input: parts } = input as { threadId: string; input: Array<{ text: string }> };
    return { threadId, text: parts[0]!.text };
  });

const waiter = (threadId: string, since = Date.now() - 3_600_000) => ({ threadId, projectName: PROJECT, since });
const mergedPr = (number: number, mergedAt: number) => ({ number, title: `Release v1.${number}`, mergedAt: new Date(mergedAt).toISOString(), mergeCommit: { oid: `sha${number}` } });
const run = (status: string, conclusion: string | null = null) => ({ name: "deploy", status, conclusion, url: "https://github.com/acme/web-app/actions/runs/1" });

beforeEach(() => {
  ghMock.mockReset();
});

// --- release watcher -----------------------------------------------------------

it("treats releases already out as history, then wakes waiters once a new release's workflows pass", async () => {
  const { bb, harness } = host();
  const { watchers } = load(bb);
  await bb.storage.kv.set("releaseWaiters", { [`t1@${PROJECT}`]: waiter("t1") });
  let prs = [mergedPr(10, Date.now() - 86_400_000)];
  let runs = [run("in_progress")];
  answerGh({ "pr list": () => JSON.stringify(prs), "run list": () => JSON.stringify(runs) });

  await watchers.checkReleases();
  expect(sent(harness)).toEqual([]);
  expect(Object.keys((await bb.storage.kv.get<Record<string, number>>("seenReleases"))!)).toContain(`${REPO}#10`);

  prs = [mergedPr(11, Date.now() - 60_000), ...prs];
  await watchers.checkReleases();
  expect(sent(harness)).toEqual([]);
  expect(Object.keys((await bb.storage.kv.get("pendingReleases"))!)).toEqual([`${REPO}#11`]);

  runs = [run("completed", "success")];
  await watchers.checkReleases();
  expect(sent(harness)).toHaveLength(1);
  expect(sent(harness)[0]!.text).toMatch(/^released: Release v1\.11 \(#11\) in web-app/);
  expect(await bb.storage.kv.get("releaseWaiters")).toEqual({});
  expect(await bb.storage.kv.get("pendingReleases")).toEqual({});

  // Announced once: the next cycle has nothing to say.
  await watchers.checkReleases();
  expect(sent(harness)).toHaveLength(1);
});

it("keeps a release pending when GitHub can't list its workflow runs, and announces it on the next cycle", async () => {
  const { bb, harness } = host();
  const { watchers } = load(bb);
  await bb.storage.kv.set("releaseWaiters", { [`t1@${PROJECT}`]: waiter("t1") });
  await bb.storage.kv.set("seenReleases", { [REPO]: 1 });
  let runsDown = true;
  answerGh({
    "pr list": () => JSON.stringify([mergedPr(11, Date.now() - 60_000)]),
    "run list": () => {
      if (runsDown) throw Object.assign(new Error("gh run list: HTTP 502"), { transient: true });
      return JSON.stringify([run("completed", "success")]);
    },
  });

  await watchers.checkReleases();
  expect(sent(harness)).toEqual([]);
  expect(Object.keys((await bb.storage.kv.get("pendingReleases"))!)).toEqual([`${REPO}#11`]);
  expect(harness.logEntries.some((entry) => entry.level === "warn" && entry.message.includes("HTTP 502"))).toBe(true);

  runsDown = false;
  await watchers.checkReleases();
  expect(sent(harness).map((message) => message.threadId)).toEqual(["t1"]);
  expect(await bb.storage.kv.get("pendingReleases")).toEqual({});
});

it("one project's GitHub failure doesn't stop another project's release", async () => {
  const { bb, harness } = host();
  const config = { ...releaseConfig, billing: releaseWatchSchema.parse({ repo: "acme/billing-api" }) };
  const { watchers } = load(bb, config);
  await bb.storage.kv.set("releaseWaiters", { [`t1@${PROJECT}`]: waiter("t1"), "t1@billing": { ...waiter("t1"), projectName: "billing" } });
  await bb.storage.kv.set("seenReleases", { [REPO]: 1, "acme/billing-api": 1 });
  answerGh({
    "pr list": (args) => {
      if (args[3] === "acme/billing-api") throw new Error("gh pr list: HTTP 401: Bad credentials");
      return JSON.stringify([mergedPr(11, Date.now() - 60_000)]);
    },
    "run list": () => JSON.stringify([run("completed", "success")]),
  });

  await watchers.checkReleases();
  expect(sent(harness)).toHaveLength(1);
  expect(sent(harness)[0]!.text).toContain("in web-app");
  expect(Object.keys((await bb.storage.kv.get("releaseWaiters"))!)).toEqual(["t1@billing"]);
});

it("a waiter that can't be told stays registered and the release is retried, until it's given up on", async () => {
  const { bb, harness } = host({ send: async () => Promise.reject(new Error("HTTP 503")) });
  const { watchers } = load(bb);
  await bb.storage.kv.set("releaseWaiters", { [`t1@${PROJECT}`]: waiter("t1") });
  await bb.storage.kv.set("seenReleases", { [REPO]: 1 });
  answerGh({
    "pr list": () => JSON.stringify([mergedPr(11, Date.now() - 60_000)]),
    "run list": () => JSON.stringify([run("completed", "success")]),
  });

  await watchers.checkReleases();
  const pending = (await bb.storage.kv.get<Record<string, { sendFailures?: number }>>("pendingReleases"))!;
  expect(pending[`${REPO}#11`]?.sendFailures).toBe(1);
  expect(Object.keys((await bb.storage.kv.get("releaseWaiters"))!)).toEqual([`t1@${PROJECT}`]);

  await watchers.checkReleases();
  expect((await bb.storage.kv.get<Record<string, { sendFailures?: number }>>("pendingReleases"))![`${REPO}#11`]?.sendFailures).toBe(2);

  pending[`${REPO}#11`]!.sendFailures = MAX_SEND_FAILURES - 1;
  await bb.storage.kv.set("pendingReleases", pending);
  await watchers.checkReleases();
  expect(await bb.storage.kv.get("pendingReleases")).toEqual({});
  expect((await bb.storage.kv.get<Record<string, number>>("seenReleases"))![`${REPO}#11`]).toBeDefined();
  expect(harness.logEntries.some((entry) => entry.message.includes("gave up"))).toBe(true);
  // Still waiting, so at least the next release reaches it.
  expect(Object.keys((await bb.storage.kv.get("releaseWaiters"))!)).toEqual([`t1@${PROJECT}`]);
});

it("a waiter whose thread was archived is dropped without a message", async () => {
  const { bb, harness } = host({ threads: { t1: thread("t1", { archivedAt: 1 }) } });
  const { watchers } = load(bb);
  await bb.storage.kv.set("releaseWaiters", { [`t1@${PROJECT}`]: waiter("t1") });
  await bb.storage.kv.set("seenReleases", { [REPO]: 1 });
  answerGh({
    "pr list": () => JSON.stringify([mergedPr(11, Date.now() - 60_000)]),
    "run list": () => JSON.stringify([run("completed", "success")]),
  });

  await watchers.checkReleases();
  expect(sent(harness)).toEqual([]);
  expect(await bb.storage.kv.get("releaseWaiters")).toEqual({});
  expect(await bb.storage.kv.get("pendingReleases")).toEqual({});
});

it("a failed workflow run is reported as such, not as released", async () => {
  const { bb, harness } = host();
  const { watchers } = load(bb);
  await bb.storage.kv.set("releaseWaiters", { [`t1@${PROJECT}`]: waiter("t1") });
  await bb.storage.kv.set("seenReleases", { [REPO]: 1 });
  answerGh({
    "pr list": () => JSON.stringify([mergedPr(11, Date.now() - 60_000)]),
    "run list": () => JSON.stringify([run("completed", "failure")]),
  });
  await watchers.checkReleases();
  expect(sent(harness)[0]!.text).toMatch(/^The release merged .* but 1 workflow run\(s\) failed: deploy/);
});

/** A workspace conductor that records what it's handed. */
function conductorSink(workspaceFor: ConductorSink["workspaceFor"]) {
  const delivered: Array<{ threadId: string; workspaceId: string; events: readonly ConductorInboxEvent[] }> = [];
  const sink: ConductorSink = { workspaceFor, deliver: async (threadId, workspaceId, events) => void delivered.push({ threadId, workspaceId, events }) };
  return { sink, delivered };
}

it("a release goes to the thread's conductor when its workspace has one; a failed lookup tells the thread itself", async () => {
  for (const lookup of ["found", "failed"] as const) {
    ghMock.mockReset();
    const { bb, harness } = host();
    const { sink, delivered } = conductorSink(async () => {
      if (lookup === "failed") throw new Error("HTTP 503");
      return "ws1";
    });
    const { watchers } = load(bb, releaseConfig, true, sink);
    await bb.storage.kv.set("releaseWaiters", { [`t1@${PROJECT}`]: waiter("t1") });
    await bb.storage.kv.set("seenReleases", { [REPO]: 1 });
    answerGh({
      "pr list": () => JSON.stringify([mergedPr(11, Date.now() - 60_000)]),
      "run list": () => JSON.stringify([run("completed", "success")]),
    });
    await watchers.checkReleases();
    if (lookup === "found") {
      expect(sent(harness)).toEqual([]);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({ threadId: "t1", workspaceId: "ws1", events: [{ kind: "release" }] });
      expect(delivered[0]!.events[0]!.text).toMatch(/^released: Release v1\.11/);
    } else {
      expect(delivered).toEqual([]);
      expect(sent(harness).map((message) => message.threadId)).toEqual(["t1"]);
    }
    expect(await bb.storage.kv.get("releaseWaiters")).toEqual({});
  }
});

it("the release schedule doesn't read GitHub when nobody waits or nothing is configured", async () => {
  const { bb, harness } = host();
  load(bb);
  await harness.runSchedule("release-watch");
  expect(ghMock).not.toHaveBeenCalled();

  const other = host();
  load(other.bb, {});
  await other.bb.storage.kv.set("releaseWaiters", { [`t1@${PROJECT}`]: waiter("t1") });
  await other.harness.runSchedule("release-watch");
  expect(ghMock).not.toHaveBeenCalled();
});

it("a release check still running at reload stops without touching the old plugin handle", async () => {
  const { bb, harness } = host();
  const { watchers } = load(bb);
  await bb.storage.kv.set("releaseWaiters", { [`t1@${PROJECT}`]: waiter("t1") });
  await bb.storage.kv.set("seenReleases", { [REPO]: 1 });
  let answer!: (json: string) => void;
  let signal: AbortSignal | undefined;
  answerGh({
    "pr list": (_, options) => {
      signal = options.signal;
      return new Promise<string>((resolve) => (answer = resolve));
    },
    // The real gh is killed by the aborted signal.
    "run list": (_, options) => (options.signal?.aborted ? Promise.reject(new Error("gh: aborted")) : JSON.stringify([run("completed", "success")])),
  });

  const checking = watchers.checkReleases();
  await vi.waitFor(() => expect(signal).toBeDefined());
  expect(signal!.aborted).toBe(false);
  await harness.lifecycle.dispose();
  expect(signal!.aborted).toBe(true);
  answer(JSON.stringify([mergedPr(11, Date.now() - 60_000)]));
  await expect(checking).resolves.toBeUndefined();
  expect(sent(harness)).toEqual([]);
});

// --- release waits from replies -------------------------------------------------

it("a reply that waits for a release registers the thread; a later status report without one clears it", async () => {
  const { bb, harness } = host();
  load(bb);
  answerGh({ "pr list": () => JSON.stringify([mergedPr(10, Date.now() - 86_400_000)]) });
  await harness.emitThreadEvent("thread.idle", { thread: thread("t1"), lastAssistantText: "Merged. This goes out with the next release." });
  expect(Object.keys((await bb.storage.kv.get("releaseWaiters"))!)).toEqual([`t1@${PROJECT}`]);

  await harness.emitThreadEvent("thread.idle", {
    thread: thread("t1"),
    lastAssistantText: "**Goal:** Fix login\n**Done:** Shipped and verified.\n**Next:** Nothing.\n**Blocked:** None",
  });
  expect(await bb.storage.kv.get("releaseWaiters")).toEqual({});
});

// --- CI watcher -------------------------------------------------------------------

const ciWatch = (threadId: string, pr: number, fields: Partial<CiWatch> = {}): CiWatch => ({
  threadId,
  repo: REPO,
  pr,
  watchFor: "checks",
  since: Date.now() - 60_000,
  headSha: null,
  ...fields,
});
const greenPr = JSON.stringify({
  state: "OPEN",
  headRefOid: "abc1234def",
  url: "https://github.com/acme/web-app/pull/5",
  statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
  reviews: [],
  comments: [],
});

it("an archived thread's CI watch is dropped on the next cycle without reading GitHub", async () => {
  const { bb, harness } = host({ threads: { t1: thread("t1", { archivedAt: 1 }), t2: thread("t2") } });
  const { watchers } = load(bb, {});
  await bb.storage.kv.set("ciWatches", { a: ciWatch("t1", 5), b: ciWatch("t2", 6) });
  answerGh({ "pr view": () => greenPr, "api user": () => "alex" });

  await harness.runSchedule("ci-watch");
  expect(ghMock.mock.calls.filter(([args]) => args[0] === "pr").map(([args]) => args[2])).toEqual(["6"]);
  expect(await bb.storage.kv.get("ciWatches")).toEqual({});
  expect(sent(harness).map((message) => message.threadId)).toEqual(["t2"]);
});

it("a failed thread lookup doesn't stop the watch: the PR is still read and reported", async () => {
  const { bb, harness } = host();
  harness.sdk.stub("threads.get", async () => Promise.reject(new Error("HTTP 503: Service Unavailable")));
  const { watchers } = load(bb, {});
  await bb.storage.kv.set("ciWatches", { a: ciWatch("t1", 5) });
  answerGh({ "pr view": () => greenPr, "api user": () => "alex" });

  await watchers.checkCi();
  expect(sent(harness)[0]!.text).toContain("CI is green on web-app#5");
  expect(await bb.storage.kv.get("ciWatches")).toEqual({});
});

it("checks asked for at once share one run, and the schedule skips while one is running", async () => {
  const { bb, harness } = host();
  const { watchers } = load(bb, {});
  await bb.storage.kv.set("ciWatches", { a: ciWatch("t1", 5) });
  let answer!: (json: string) => void;
  answerGh({ "pr view": () => new Promise<string>((resolve) => (answer = resolve)), "api user": () => "alex" });

  const first = watchers.checkCi();
  const second = watchers.checkCi(true);
  await vi.waitFor(() => expect(answer).toBeDefined());
  await harness.runSchedule("ci-watch");
  answer(greenPr);
  await Promise.all([first, second]);
  expect(ghMock.mock.calls.filter(([args]) => args[0] === "pr")).toHaveLength(1);
  expect(sent(harness)).toHaveLength(1);
});

it("green CI goes to the thread's conductor instead of the worker when its workspace has one", async () => {
  const { bb, harness } = host();
  const { sink, delivered } = conductorSink(async () => "ws1");
  const { watchers } = load(bb, {}, true, sink);
  await bb.storage.kv.set("ciWatches", { a: ciWatch("t1", 5) });
  answerGh({ "pr view": () => greenPr, "api user": () => "alex" });

  await watchers.checkCi();
  expect(sent(harness)).toEqual([]);
  expect(delivered.map((entry) => entry.workspaceId)).toEqual(["ws1"]);
  expect(delivered[0]!.events.map((event) => event.text).join("\n")).toContain("CI is green on web-app#5");
  expect(await bb.storage.kv.get("ciWatches")).toEqual({});
});

it("the CI schedule doesn't read GitHub when nothing is watched", async () => {
  const { bb, harness } = host();
  load(bb, {});
  await harness.runSchedule("ci-watch");
  expect(ghMock).not.toHaveBeenCalled();
});

it("a CI check still running at reload ends quietly, and the next load still has the watch", async () => {
  const { bb, harness } = host();
  const { watchers } = load(bb, {});
  await bb.storage.kv.set("ciWatches", { a: ciWatch("t1", 5) });
  let signal: AbortSignal | undefined;
  answerGh({
    "pr view": (_, options) => {
      signal = options.signal;
      return new Promise<string>((_, reject) => options.signal?.addEventListener("abort", () => reject(new Error("gh: aborted"))));
    },
    "api user": () => "alex",
  });

  const checking = watchers.checkCi();
  await vi.waitFor(() => expect(signal).toBeDefined());
  let next!: ReturnType<typeof load>;
  const reloaded = await harness.lifecycle.reload((nextBb) => void (next = load(nextBb, {})));
  await expect(checking).resolves.toBeUndefined();
  expect(Object.keys((await reloaded.bb.storage.kv.get("ciWatches"))!)).toEqual(["a"]);
  expect(await next.watchers.wakeupsFor("t1")).toEqual([{ kind: "ci", key: "a", label: "web-app#5 checks" }]);
  await reloaded.harness.lifecycle.dispose();
});

it("a schedule firing after reload does nothing on the old handle", async () => {
  const { bb, harness } = host();
  load(bb);
  await bb.storage.kv.set("ciWatches", { a: ciWatch("t1", 5) });
  await bb.storage.kv.set("releaseWaiters", { [`t1@${PROJECT}`]: waiter("t1") });
  const [ci, release] = ["ci-watch", "release-watch"].map((name) => harness.registrations.schedules.find((schedule) => schedule.name === name)!);
  await harness.lifecycle.dispose();
  await expect(Promise.resolve(ci!.fn())).resolves.toBeUndefined();
  await expect(Promise.resolve(release!.fn())).resolves.toBeUndefined();
  expect(ghMock).not.toHaveBeenCalled();
});

it("watching CI finds the PR from the thread's branch, and refuses one that's already merged", async () => {
  const { bb, harness } = host({ threads: { t1: thread("t1", { environmentId: "env1" }) } });
  harness.sdk.stub("environments.get", async () => ({ id: "env1", branchName: "fix-login" }));
  const { watchers, changes } = load(bb, {});
  let state = "OPEN";
  answerGh({
    "pr view": (args) => JSON.stringify(args[2] === "fix-login" ? { number: 7 } : { state, title: "Fix login", createdAt: "2026-11-01T00:00:00Z" }),
  });

  const watch = await watchers.watchCi("t1", {});
  expect(watch).toMatchObject({ threadId: "t1", repo: REPO, pr: 7, watchFor: "both" });
  expect(Object.keys((await bb.storage.kv.get("ciWatches"))!)).toEqual([`t1:${REPO}#7`]);
  expect(changes()).toBe(1);

  state = "MERGED";
  await expect(watchers.watchCi("t1", { pr: 8 })).rejects.toThrow(/already merged/);
});

// --- archiving and auto-continue ------------------------------------------------

it("archiving a thread drops its auto-continue, release waits and CI watches, and nobody else's", async () => {
  const { bb, harness } = host();
  const { changes } = load(bb);
  await bb.storage.kv.set("autoContinue", { t1: { resetsAt: 1, queuedMessageId: null }, t2: { resetsAt: 1, queuedMessageId: null } });
  await bb.storage.kv.set("releaseWaiters", { [`t1@${PROJECT}`]: waiter("t1"), "t1@billing": { ...waiter("t1"), projectName: "billing" }, [`t2@${PROJECT}`]: waiter("t2") });
  await bb.storage.kv.set("ciWatches", { a: ciWatch("t1", 5), b: ciWatch("t1", 6), c: ciWatch("t2", 7) });

  const { errors } = await harness.emitThreadEvent("thread.archived", { thread: thread("t1", { archivedAt: 1 }) });
  expect(errors).toEqual([]);
  expect(Object.keys((await bb.storage.kv.get("autoContinue"))!)).toEqual(["t2"]);
  expect(Object.keys((await bb.storage.kv.get("releaseWaiters"))!)).toEqual([`t2@${PROJECT}`]);
  expect(Object.keys((await bb.storage.kv.get("ciWatches"))!)).toEqual(["c"]);
  expect(changes()).toBe(1);
});

const LIMIT = "You've hit your session limit · resets 10pm";

it("a session limit schedules one continue after the reset; resuming first takes it back", async () => {
  const { bb, harness } = host();
  const { watchers } = load(bb);
  const resetsAt = parseLimitHit(LIMIT)!.resetsAt;
  await harness.emitThreadEvent("thread.idle", { thread: thread("t1"), lastAssistantText: LIMIT });
  await harness.emitThreadEvent("thread.idle", { thread: thread("t1"), lastAssistantText: LIMIT });
  const sends = harness.sdk.callsTo("threads.send") as Array<[{ sendAt?: number; input: Array<{ text: string }> }]>;
  expect(sends).toHaveLength(1);
  expect(sends[0]![0].input[0]!.text).toBe("continue");
  expect(sends[0]![0].sendAt).toBe(resetsAt + 90_000);
  expect(await watchers.autoContinueAt("t1")).toBe(resetsAt + 90_000);

  await harness.emitThreadEvent("thread.active", { thread: thread("t1", { status: "active" }) });
  expect(await watchers.autoContinueAt("t1")).toBeNull();
  expect(harness.sdk.callsTo("threads.queuedMessages.delete")).toEqual([[{ threadId: "t1", queuedMessageId: "q1" }]]);
});

it("no continue is scheduled when auto-continue is off, or for a subthread", async () => {
  const off = host();
  load(off.bb, releaseConfig, false);
  await off.harness.emitThreadEvent("thread.idle", { thread: thread("t1"), lastAssistantText: LIMIT });
  expect(off.harness.sdk.callsTo("threads.send")).toEqual([]);

  const sub = host();
  load(sub.bb);
  await sub.harness.emitThreadEvent("thread.idle", { thread: thread("t2", { parentThreadId: "t1" }), lastAssistantText: LIMIT });
  expect(sub.harness.sdk.callsTo("threads.send")).toEqual([]);
});

// --- backfill service -----------------------------------------------------------

it("the backfill moves old waiter keys, registers threads already waiting once, and stops on reload", async () => {
  const { bb, harness } = host();
  harness.sdk.stub("threads.list", async ({ offset }: { offset: number }) =>
    offset > 0
      ? []
      : [thread("t1", { status: "idle" }), thread("t2", { status: "active" }), thread("t3", { status: "idle", parentThreadId: "t1" }), thread("t4", { status: "idle" })],
  );
  harness.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
    output: threadId === "t4" ? "All done." : "Merged; waiting for the next release.",
  }));
  answerGh({ "pr list": () => JSON.stringify([mergedPr(10, Date.now() - 86_400_000)]) });
  load(bb);
  await bb.storage.kv.set("releaseWaiters", { old: waiter("t9") });

  const service = harness.runService("release-backfill");
  await vi.waitFor(async () => expect(await bb.storage.kv.get("releaseBackfill")).toBe(1));
  expect(Object.keys((await bb.storage.kv.get("releaseWaiters"))!).sort()).toEqual([`t1@${PROJECT}`, `t9@${PROJECT}`]);
  // Only idle top-level threads are read.
  expect(harness.sdk.callsTo("threads.output").map(([input]) => (input as { threadId: string }).threadId)).toEqual(["t1", "t4"]);

  service.controller.abort();
  await expect(service.done).resolves.toBeUndefined();

  // Done once: the next start doesn't read every thread again.
  const again = harness.runService("release-backfill");
  await new Promise((resolve) => setTimeout(resolve, 10));
  again.controller.abort();
  await again.done;
  expect(harness.sdk.callsTo("threads.output")).toHaveLength(2);
});
