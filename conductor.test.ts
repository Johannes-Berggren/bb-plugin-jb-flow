import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createConductor, type ConductorDeps } from "./conductor.ts";
import { createConductorStore } from "./conductor-store.ts";
import { MIGRATIONS } from "./migrations.ts";
import type { WorkspaceState } from "./workspaces.ts";

const T0 = Date.parse("2026-03-02T09:00:00Z");
const MINUTE = 60_000;

type FakeThread = {
  id: string;
  projectId: string;
  sectionId: string | null;
  parentThreadId: string | null;
  status: string;
  title: string;
  titleFallback: string | null;
  visibility: "visible" | "hidden";
  lastReadAt: number | null;
  latestAttentionAt: number | null;
  createdAt: number;
  hasPendingInteraction: boolean;
  queuedWork: string;
  archivedAt: number | null;
  deletedAt: number | null;
};

const thread = (id: string, projectId: string, fields: Partial<FakeThread> = {}): FakeThread => ({
  id,
  projectId,
  sectionId: null,
  parentThreadId: null,
  status: "idle",
  title: `Thread ${id}`,
  titleFallback: null,
  visibility: "visible",
  lastReadAt: null,
  latestAttentionAt: T0,
  createdAt: T0 - 60 * MINUTE,
  hasPendingInteraction: false,
  queuedWork: "none",
  archivedAt: null,
  deletedAt: null,
  ...fields,
});

const workspaceState: WorkspaceState = {
  workspaces: [
    { id: "ws", name: "Web", projectIds: ["proj_web"], sectionIds: [], pluginIds: [], sectionOrder: [] },
    { id: "other", name: "Api", projectIds: ["proj_api"], sectionIds: [], pluginIds: [], sectionOrder: [] },
  ],
  threadWorkspaces: {},
};

/** A conductor over a fake bb: two worker threads, one per workspace. */
async function setup(options: { enabled?: boolean; ghFails?: boolean } = {}) {
  let clock = T0;
  const kv = new Map<string, unknown>();
  const tools = new Map<string, { execute: (params: unknown, ctx: { threadId: string }) => Promise<unknown> }>();
  const handlers = new Map<string, Array<(payload: unknown) => Promise<void> | void>>();
  const threads = new Map<string, FakeThread>([
    ["thr_a", thread("thr_a", "proj_web")],
    ["thr_b", thread("thr_b", "proj_api")],
  ]);
  const sent: Array<{ threadId: string; text: string; mode: string; compactFirst?: boolean }> = [];
  const spawns: Array<Record<string, unknown>> = [];
  const unarchived: string[] = [];
  const read: string[] = [];
  const ghCalls: string[][] = [];
  let spawnCount = 0;
  const bb = {
    pluginId: "jb-flow",
    log: { info() {}, warn() {}, error() {} },
    storage: {
      kv: {
        get: async (key: string) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
        set: async (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
        delete: async (key: string) => void kv.delete(key),
        list: async (prefix: string) => [...kv.keys()].filter((key) => key.startsWith(prefix)),
      },
    },
    agents: { registerTool: (tool: { name: string; execute: never }) => void tools.set(tool.name, tool) },
    events: {
      on: (name: string, handler: (payload: unknown) => void) => void handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    },
    background: { schedule: () => undefined },
    sdk: {
      projects: { list: async () => [{ id: "proj_web" }] },
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const found = threads.get(threadId);
          if (!found) throw Object.assign(new Error("HTTP 404: not found"), { status: 404 });
          return { ...found };
        },
        list: async ({ threadIds }: { threadIds?: string[] }) => [...threads.values()].filter((t) => !threadIds || threadIds.includes(t.id)),
        spawn: async (args: Record<string, unknown>) => {
          spawns.push(args);
          const id = `thr_conductor${++spawnCount}`;
          threads.set(id, thread(id, String(args.projectId), { visibility: "hidden", title: String(args.title) }));
          return { id };
        },
        send: async ({ threadId, input, mode, compactFirst }: { threadId: string; input: Array<{ text: string }>; mode: string; compactFirst?: boolean }) => {
          sent.push({ threadId, text: input[0]!.text, mode, ...(compactFirst ? { compactFirst } : {}) });
          return { delivery: "sent" };
        },
        unarchive: async ({ threadId }: { threadId: string }) => {
          unarchived.push(threadId);
          threads.get(threadId)!.archivedAt = null;
        },
        markRead: async ({ threadId }: { threadId: string }) => void read.push(threadId),
        markUnread: async () => undefined,
        output: async () => ({ output: "Done." }),
      },
    },
  } as unknown as BbPluginApi;

  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const store = createConductorStore(() => db as never);
  const settings = { enabled: options.enabled ?? true, batchMinutes: 10, prompt: "" };
  const deps: ConductorDeps = {
    store,
    options: () => settings,
    workspaces: async () => workspaceState,
    assignWorkspace: async () => undefined,
    listThreads: async () => [...threads.values()].filter((t) => t.visibility === "visible" && t.archivedAt === null) as never,
    flow: async () => ({ awaiting: {}, promised: {}, waitingOthers: {}, readyToGo: {}, watching: {}, threadPrs: {}, focused: {}, due: {} }),
    snoozedSection: async () => null,
    threadStatus: async () => null,
    prsByThread: async () => ({
      thr_a: [{ repo: "acme/web-app", number: 12, state: "open", attention: "ready_to_merge", title: "Fix export" }],
      thr_b: [{ repo: "acme/api", number: 3, state: "open", attention: "ready_to_merge", title: "Add route" }],
    }) as never,
    snooze: async () => ({ until: T0 + 3_600_000 }),
    unsnooze: async () => true,
    archive: async (ids) => ({ archived: ids.length, failed: [] }),
    focus: async (_id, focused) => focused,
    changed: () => undefined,
    gh: async (args) => {
      ghCalls.push(args);
      if (args[0] === "repo") return JSON.stringify({ viewerDefaultMergeMethod: "SQUASH" });
      if (options.ghFails) throw new Error("Pull request is not mergeable: the base branch policy prohibits the merge");
      return "";
    },
    now: () => clock,
  };
  const conductor = await createConductor(bb, deps);
  const fire = async (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload);
  };
  const call = (name: string, params: unknown, threadId: string) => tools.get(name)!.execute(params, { threadId });
  return {
    conductor,
    store,
    threads,
    sent,
    spawns,
    unarchived,
    read,
    ghCalls,
    settings,
    fire,
    call,
    advance: (ms: number) => (clock += ms),
  };
}

const errorText = (result: unknown) => {
  const value = result as { isError?: boolean; content?: Array<{ text: string }> };
  return value.isError ? value.content![0]!.text : null;
};

test("starting a conductor spawns one hidden thread in the workspace's project", async () => {
  const { conductor, spawns } = await setup();
  const { threadId } = await conductor.start("ws");
  assert.equal(threadId, "thr_conductor1");
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]!.visibility, "hidden");
  assert.equal(spawns[0]!.projectId, "proj_web");
  assert.deepEqual(spawns[0]!.pluginMetadata, { role: "conductor", workspaceId: "ws" });
  assert.ok(Number(spawns[0]!.sendAt) > T0, "its first turn waits until its id is known");
  await conductor.start("ws");
  assert.equal(spawns.length, 1, "starting again reuses the thread");
});

test("only the conductor gets the conductor tools", async () => {
  const { conductor } = await setup();
  const { threadId } = await conductor.start("ws");
  const base = { pluginMetadata: {}, origin: { kind: null, pluginId: null } };
  const own = conductor.configureFor({ ...base, thread: { id: threadId, title: null, parentThreadId: null, sourceThreadId: null } });
  assert.ok(own?.tools.includes("merge_pr"));
  assert.match(own!.instructions, /conductor of the "Web" workspace/);
  assert.equal(conductor.configureFor({ ...base, thread: { id: "thr_a", title: null, parentThreadId: null, sourceThreadId: null } }), null);
});

test("a just-spawned conductor is known by its origin, which an agent can't fake", async () => {
  const { conductor } = await setup();
  await conductor.start("ws");
  const thread = { id: "thr_new", title: null, parentThreadId: null, sourceThreadId: null };
  const pluginMetadata = { role: "conductor", workspaceId: "ws" };
  assert.ok(conductor.configureFor({ thread, pluginMetadata, origin: { kind: null, pluginId: "jb-flow" } }));
  assert.equal(conductor.configureFor({ thread, pluginMetadata, origin: { kind: null, pluginId: null } }), null);
});

test("with the setting off, nothing is routed and no thread gets the tools", async () => {
  const { conductor, settings } = await setup();
  const { threadId } = await conductor.start("ws");
  settings.enabled = false;
  assert.equal(await conductor.sink.workspaceFor("thr_a"), null);
  const base = { pluginMetadata: {}, origin: { kind: null, pluginId: null } };
  assert.equal(conductor.configureFor({ ...base, thread: { id: threadId, title: null, parentThreadId: null, sourceThreadId: null } }), null);
  await assert.rejects(conductor.start("other"), /Turn on Conductor/);
});

test("news is routed only for threads in a workspace with a running conductor", async () => {
  const { conductor } = await setup();
  assert.equal(await conductor.sink.workspaceFor("thr_a"), null, "no conductor yet");
  const { threadId } = await conductor.start("ws");
  assert.equal(await conductor.sink.workspaceFor("thr_a"), "ws");
  assert.equal(await conductor.sink.workspaceFor("thr_b"), null, "its workspace has no conductor");
  assert.equal(await conductor.sink.workspaceFor(threadId), null, "a conductor's own news isn't routed to itself");
  await conductor.stop("ws");
  assert.equal(await conductor.sink.workspaceFor("thr_a"), null, "stopped");
});

test("tools refuse other callers and threads outside the conductor's workspace", async () => {
  const { conductor, call, sent, read } = await setup();
  const { threadId } = await conductor.start("ws");
  assert.match(errorText(await call("forward_to_thread", { thread_id: "thr_a", message: "go" }, "thr_a"))!, /Only a workspace's conductor/);
  assert.match(errorText(await call("forward_to_thread", { thread_id: "thr_b", message: "go" }, threadId))!, /isn't in this conductor's workspace/);
  assert.equal(errorText(await call("forward_to_thread", { thread_id: "thr_a", message: "Merge it.", mark_read: true }, threadId)), null);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /^\[conductor\] Merge it\./);
  assert.match(sent[0]!.text, /don't message the conductor back/);
  assert.deepEqual(read, ["thr_a"]);
});

test("merge_pr merges only this workspace's PRs, with the repo's method and no bypass", async () => {
  const { conductor, call, ghCalls } = await setup();
  const { threadId } = await conductor.start("ws");
  assert.equal(await call("merge_pr", { repo: "acme/web-app", number: 12 }, threadId), "Merged acme/web-app#12.");
  const merge = ghCalls.find((args) => args[0] === "pr")!;
  assert.deepEqual(merge, ["pr", "merge", "12", "-R", "acme/web-app", "--squash"]);
  assert.ok(!ghCalls.flat().includes("--admin"));
  assert.match(errorText(await call("merge_pr", { repo: "acme/api", number: 3 }, threadId))!, /isn't linked to a thread in this workspace/);
  assert.deepEqual(conductor.log("ws").map((entry) => entry.kind).slice(0, 1), ["merged"]);
});

test("a merge GitHub refuses comes back as the reason, and is logged", async () => {
  const { conductor, call } = await setup({ ghFails: true });
  const { threadId } = await conductor.start("ws");
  assert.match(errorText(await call("merge_pr", { repo: "acme/web-app", number: 12 }, threadId))!, /base branch policy/);
  assert.equal(conductor.log("ws")[0]!.kind, "merge-refused");
});

test("archiving a conductor brings it straight back", async () => {
  const { conductor, fire, unarchived, threads } = await setup();
  const { threadId } = await conductor.start("ws");
  threads.get(threadId)!.archivedAt = T0;
  await fire("thread.archived", { thread: threads.get(threadId) });
  assert.deepEqual(unarchived, [threadId]);
  await fire("thread.archived", { thread: threads.get("thr_a") });
  assert.deepEqual(unarchived, [threadId], "workers stay archived");
});

test("a deleted conductor is respawned at the next wake-up", async () => {
  const { conductor, fire, threads, spawns, advance } = await setup();
  const { threadId } = await conductor.start("ws");
  threads.get(threadId)!.deletedAt = T0;
  await fire("thread.deleted", { thread: threads.get(threadId) });
  await conductor.sink.deliver("thr_a", "ws", [{ kind: "merged", text: "PR web-app#12 is now merged." }]);
  advance(11 * 60_000);
  assert.equal(await conductor.wake("ws"), "woken");
  assert.equal(spawns.length, 2);
});

test("a wake-up waits for the batch window and for an idle conductor, then carries everything once", async () => {
  const { conductor, sent, threads, advance } = await setup();
  const { threadId } = await conductor.start("ws");
  await conductor.sink.deliver("thr_a", "ws", [{ kind: "green", text: "✅ CI is green on web-app#12 (abc1234): 3 checks passed.", meta: { repo: "acme/web-app", pr: 12, afterGreen: "merge" } }]);
  advance(MINUTE);
  await conductor.sink.deliver("thr_a", "ws", [{ kind: "merged", text: "PR web-app#11 is now merged." }]);
  assert.equal(await conductor.wake("ws"), "waiting");
  advance(10 * MINUTE);
  threads.get(threadId)!.status = "active";
  assert.equal(await conductor.wake("ws"), "busy");
  threads.get(threadId)!.status = "idle";
  assert.equal(await conductor.wake("ws"), "woken");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.mode, "start");
  assert.match(sent[0]!.text, /^\[conductor inbox\] 2 new events:/);
  assert.match(sent[0]!.text, /\[green\] "Thread thr_a" \(thr_a\) · acme\/web-app#12 · after_green: merge/);
  assert.equal(await conductor.wake("ws"), "nothing", "delivered events aren't sent again");
});

test("hand-backs the user has read since don't wake the conductor", async () => {
  const { conductor, fire, threads, sent, store, advance } = await setup();
  await conductor.start("ws");
  await fire("thread.idle", { thread: threads.get("thr_a"), lastAssistantText: "Which option do you want? 1. A 2. B" });
  assert.equal(store.open("ws").length, 1);
  advance(11 * MINUTE);
  threads.get("thr_a")!.lastReadAt = T0 + 5 * MINUTE;
  assert.equal(await conductor.wake("ws"), "nothing");
  assert.equal(sent.length, 0);
  assert.equal(store.open("ws").length, 0, "acknowledged as seen");
});

test("a hand-back that waits on someone else isn't news for the conductor", async () => {
  const { conductor, fire, threads, store } = await setup();
  await conductor.start("ws");
  await fire("thread.idle", { thread: threads.get("thr_a"), lastAssistantText: "Waiting for Sam to review the PR before I continue." });
  await fire("thread.idle", { thread: threads.get("thr_b"), lastAssistantText: "Which option do you want?" });
  assert.equal(store.open("ws").length, 0);
  assert.equal(store.open("other").length, 0);
});

test("the first wake-up of a day compacts the conductor first", async () => {
  const { conductor, sent, advance } = await setup();
  await conductor.start("ws");
  await conductor.sink.deliver("thr_a", "ws", [{ kind: "merged", text: "one" }]);
  advance(11 * MINUTE);
  await conductor.wake("ws");
  assert.equal(sent[0]!.compactFirst, undefined, "its very first wake-up has nothing to compact");
  await conductor.sink.deliver("thr_a", "ws", [{ kind: "merged", text: "two" }]);
  advance(24 * 60 * MINUTE);
  await conductor.wake("ws");
  assert.equal(sent[1]!.compactFirst, true);
  await conductor.sink.deliver("thr_a", "ws", [{ kind: "merged", text: "three" }]);
  advance(11 * MINUTE);
  await conductor.wake("ws");
  assert.equal(sent[2]!.compactFirst, undefined, "once a day");
});

test("a briefing keeps only items for open threads in the workspace", async () => {
  const { conductor, call } = await setup();
  const { threadId } = await conductor.start("ws");
  const result = await call(
    "post_briefing",
    {
      items: [
        { threadId: "thr_a", kind: "decision", summary: "Pick a chart library", recommendation: "Option 2", reply: "2" },
        { threadId: "thr_b", kind: "ready", summary: "Not ours" },
      ],
      handled: [{ threadId: "thr_a", what: "Merged acme/web-app#11" }],
    },
    threadId,
  );
  assert.match(String(result), /1 item\(s\)\. 1 item\(s\) skipped/);
  const briefing = await conductor.briefing("ws");
  assert.deepEqual(briefing?.items.map((item) => item.threadId), ["thr_a"]);
  assert.equal(briefing?.handled.length, 1);
});

test("standing preferences are kept and put in the instructions", async () => {
  const { conductor, call } = await setup();
  const { threadId } = await conductor.start("ws");
  await call("conductor_memory", { set: "Always merge dependency bumps." }, threadId);
  const base = { pluginMetadata: {}, origin: { kind: null, pluginId: null } };
  const config = conductor.configureFor({ ...base, thread: { id: threadId, title: null, parentThreadId: null, sourceThreadId: null } });
  assert.match(config!.instructions, /Always merge dependency bumps\./);
});

test("Go on a card sends the reply as the user's, marks the thread read and puts the card away", async () => {
  const { conductor, call, sent, read, store, advance } = await setup();
  const { threadId } = await conductor.start("ws");
  await call("post_briefing", { items: [{ threadId: "thr_a", kind: "decision", summary: "Pick one", reply: "2" }] }, threadId);
  await conductor.cardAction("ws", "thr_a", "go");
  assert.deepEqual(sent.map((message) => [message.threadId, message.text]), [["thr_a", "2"]], "no [conductor] prefix: it's the user's answer");
  assert.deepEqual(read, ["thr_a"]);
  const page = await conductor.page("ws");
  assert.deepEqual(page.resolved, ["thr_a"]);
  assert.equal((await conductor.status())[0]!.needsYou, 0);
  assert.equal(store.open("ws")[0]!.kind, "user-action");
  advance(60 * MINUTE);
  assert.equal(await conductor.wake("ws"), "nothing", "what the user did rides along but never wakes it");
});

test("a new briefing brings back a card only if the conductor lists it again", async () => {
  const { conductor, call, advance } = await setup();
  const { threadId } = await conductor.start("ws");
  await call("post_briefing", { items: [{ threadId: "thr_a", kind: "fyi", summary: "Heads up" }] }, threadId);
  await conductor.cardAction("ws", "thr_a", "dismiss");
  advance(MINUTE);
  await call("post_briefing", { items: [{ threadId: "thr_a", kind: "blocked", summary: "Now it's blocked" }] }, threadId);
  assert.deepEqual((await conductor.page("ws")).resolved, []);
  assert.equal((await conductor.status())[0]!.needsYou, 1);
});
