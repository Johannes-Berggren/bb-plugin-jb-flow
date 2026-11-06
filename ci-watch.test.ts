import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCiChanges,
  CI_TIMEOUT_MS,
  evaluateWatch,
  isGoneError,
  visibleChange,
  isThreadGone,
  MAX_SEND_FAILURES,
  REVIEW_RECHECK_MS,
  REVIEW_TIMEOUT_MS,
  runCiCycle,
  type CiCycle,
  type CiWatch,
  type PrState,
} from "./ci-watch.ts";

const T0 = Date.parse("2026-03-02T09:00:00Z");
const HOUR = 3_600_000;

const watch = (fields: Partial<CiWatch> = {}): CiWatch => ({
  threadId: "thr_a",
  repo: "acme/web-app",
  pr: 12,
  watchFor: "both",
  since: T0,
  headSha: "aaaaaaa1",
  ...fields,
});

const green = { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" };
const pending = { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null };

const prState = (fields: Partial<PrState> = {}): PrState => ({
  state: "OPEN",
  headRefOid: "aaaaaaa1",
  url: "https://github.com/acme/web-app/pull/12",
  statusCheckRollup: [],
  reviews: [],
  comments: [],
  ...fields,
});

const review = (at: number, login = "alex", state = "APPROVED") => ({
  author: { login },
  state,
  body: "",
  submittedAt: new Date(at).toISOString(),
});

const noLog = async () => "";

/** A runCiCycle with working fakes; override what a test is about. */
function cycle(watches: Record<string, CiWatch>, pr: PrState, fields: Partial<CiCycle> = {}) {
  const sent: Array<{ threadId: string; text: string }> = [];
  const warnings: string[] = [];
  const config: CiCycle = {
    watches,
    now: () => T0,
    threadState: async () => "idle",
    readPr: async () => pr,
    me: async () => "me",
    failedLog: noLog,
    send: async (threadId, text) => {
      sent.push({ threadId, text });
    },
    threadGone: async () => false,
    warn: (message) => warnings.push(message),
    ...fields,
  };
  return { config, sent, warnings };
}

test("checks finishing reports once and keeps listening for reviews", async () => {
  const result = await evaluateWatch(watch(), prState({ statusCheckRollup: [green] }), T0 + HOUR, "me", noLog);
  assert.equal(result.report, true);
  assert.equal(result.done, false);
  assert.equal(result.watch.watchFor, "reviews");
  assert.equal(result.watch.quiet, true);
  assert.match(result.notes[0]!, /CI is green on web-app#12/);
});

test("a review watch outlasts the 3-hour CI limit", async () => {
  // This watch used to end here, silently, so a review arriving later woke nothing.
  const quiet = watch({ watchFor: "reviews", quiet: true });
  const result = await evaluateWatch(quiet, prState(), T0 + CI_TIMEOUT_MS + HOUR, "me", noLog);
  assert.equal(result.done, false);
  assert.equal(result.report, false);
});

test("a review arriving a day later wakes the thread", async () => {
  const quiet = watch({ watchFor: "reviews", quiet: true });
  const now = T0 + 24 * HOUR;
  const result = await evaluateWatch(quiet, prState({ reviews: [review(now - 1000)] }), now, "me", noLog);
  assert.equal(result.done, true);
  assert.match(result.notes[0]!, /Review from alex: APPROVED/);
});

test("a review watch that expires says so", async () => {
  const quiet = watch({ watchFor: "reviews", quiet: true });
  const result = await evaluateWatch(quiet, prState(), T0 + REVIEW_TIMEOUT_MS + 1, "me", noLog);
  assert.equal(result.done, true);
  assert.equal(result.report, true);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0]!, /No review on web-app#12 after 7 days; stopped watching/);
});

test("a checks watch still ends at 3 hours", async () => {
  const stuck = prState({ statusCheckRollup: [pending] });
  const result = await evaluateWatch(watch({ watchFor: "checks" }), stuck, T0 + CI_TIMEOUT_MS + 1, "me", noLog);
  assert.equal(result.done, true);
  assert.match(result.notes[0]!, /after 3 hours/);
});

test("a new push restarts the wait but keeps reviews from before it", async () => {
  const now = T0 + 2 * HOUR;
  const pr = prState({ headRefOid: "bbbbbbb2", statusCheckRollup: [pending], reviews: [review(T0 + HOUR)] });
  const result = await evaluateWatch(watch(), pr, now, "me", noLog);
  assert.equal(result.watch.since, now);
  assert.equal(result.watch.headSha, "bbbbbbb2");
  assert.ok(result.notes.some((note) => note.includes("Review from alex")), "the review before the push is reported");
});

test("your own and bot reviews don't wake the thread", async () => {
  const now = T0 + HOUR;
  const pr = prState({ reviews: [review(now - 1, "me"), review(now - 1, "codecov"), review(now - 1, "ci[bot]")] });
  const result = await evaluateWatch(watch({ watchFor: "reviews" }), pr, now, "me", noLog);
  assert.equal(result.report, false);
});

test("evaluating leaves the stored watch untouched, so a failed send can retry", async () => {
  const stored = watch();
  const frozen = structuredClone(stored);
  await evaluateWatch(stored, prState({ statusCheckRollup: [green] }), T0 + HOUR, "me", noLog);
  assert.deepEqual(stored, frozen);
});

test("a sent message removes a finished watch", async () => {
  const { config, sent } = cycle({ k: watch({ watchFor: "checks" }) }, prState({ statusCheckRollup: [green] }));
  const changes = await runCiCycle(config);
  assert.equal(sent.length, 1);
  assert.equal(changes.get("k"), null);
});

test("a failed send keeps the watch, and the next cycle delivers the same news", async () => {
  const stored = { k: watch({ watchFor: "checks" }) };
  const pr = prState({ statusCheckRollup: [green] });

  const failing = cycle(stored, pr, {
    send: async () => {
      throw new Error("HTTP 503: try again");
    },
  });
  const first = await runCiCycle(failing.config);
  assert.equal(first.get("k")?.sendFailures, 1);
  assert.equal(first.get("k")?.watchFor, "checks", "state from before the failed send");
  assert.match(failing.warnings.join(), /ci notify/);

  const snapshot = { k: stored.k };
  const after = { k: { ...stored.k } };
  applyCiChanges(after, snapshot, first);

  const working = cycle(after, pr);
  const second = await runCiCycle(working.config);
  assert.equal(working.sent.length, 1);
  assert.match(working.sent[0]!.text, /CI is green/);
  assert.equal(second.get("k"), null);
});

test("a failed send for a thread that's gone drops the watch", async () => {
  const { config } = cycle({ k: watch({ watchFor: "checks" }) }, prState({ statusCheckRollup: [green] }), {
    send: async () => {
      throw new Error("HTTP 409: Thread is archived");
    },
    threadGone: async () => true,
  });
  assert.equal((await runCiCycle(config)).get("k"), null);
});

test("a message that can never be sent is given up on eventually", async () => {
  const stuck = watch({ watchFor: "checks", sendFailures: MAX_SEND_FAILURES - 1 });
  const { config, warnings } = cycle({ k: stuck }, prState({ statusCheckRollup: [green] }), {
    send: async () => {
      throw new Error("HTTP 500");
    },
  });
  assert.equal((await runCiCycle(config)).get("k"), null);
  assert.match(warnings.join(), /dropped after 30 failed sends/);
});

test("a busy thread's watches wait, with nothing read or sent", async () => {
  let reads = 0;
  const { config, sent } = cycle({ k: watch() }, prState({ statusCheckRollup: [green] }), {
    threadState: async () => "busy",
    readPr: async () => {
      reads += 1;
      return prState();
    },
  });
  assert.equal((await runCiCycle(config)).size, 0);
  assert.equal(reads, 0);
  assert.equal(sent.length, 0);
});

test("review-only watches read GitHub at most every 10 minutes", async () => {
  let reads = 0;
  const quiet = watch({ watchFor: "reviews", quiet: true, lastCheckedAt: T0 });
  const readPr = async () => {
    reads += 1;
    return prState();
  };
  await runCiCycle(cycle({ k: quiet }, prState(), { readPr, now: () => T0 + 2 * 60_000 }).config);
  assert.equal(reads, 0, "too soon");
  await runCiCycle(cycle({ k: quiet }, prState(), { readPr, now: () => T0 + REVIEW_RECHECK_MS }).config);
  assert.equal(reads, 1, "due");
  await runCiCycle(cycle({ k: quiet }, prState(), { readPr, now: () => T0 + 1000, force: true }).config);
  assert.equal(reads, 2, "check-now ignores the spacing");
});

test("checks watches are still read every cycle", async () => {
  let reads = 0;
  const { config } = cycle({ k: watch({ lastCheckedAt: T0 }) }, prState(), {
    now: () => T0 + 60_000,
    readPr: async () => {
      reads += 1;
      return prState({ statusCheckRollup: [pending] });
    },
  });
  await runCiCycle(config);
  assert.equal(reads, 1);
});

test("one failed GitHub read doesn't end an old review watch", async () => {
  // Older than the CI limit: under a single limit, one blip would have dropped it.
  const old = watch({ watchFor: "reviews", quiet: true });
  const { config, sent } = cycle({ k: old }, prState(), {
    now: () => T0 + 24 * HOUR,
    readPr: async () => {
      throw new Error("gh: HTTP 502");
    },
  });
  const changes = await runCiCycle(config);
  assert.equal(sent.length, 0);
  assert.notEqual(changes.get("k"), null);
});

test("a watch GitHub can't read past its limit ends with a message", async () => {
  const { config, sent } = cycle({ k: watch({ watchFor: "checks" }) }, prState(), {
    now: () => T0 + CI_TIMEOUT_MS + 1,
    readPr: async () => {
      throw new Error("gh: HTTP 404");
    },
  });
  assert.equal((await runCiCycle(config)).get("k"), null);
  assert.match(sent[0]!.text, /Couldn't read web-app#12 from GitHub; stopped watching/);
});

test("a thread gets one message for all its PRs, counting what's still watched", async () => {
  const { config, sent } = cycle(
    {
      a: watch({ pr: 1, watchFor: "checks" }),
      b: watch({ pr: 2 }),
    },
    prState({ statusCheckRollup: [green] }),
  );
  await runCiCycle(config);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /web-app#1/);
  assert.match(sent[0]!.text, /web-app#2/);
  assert.match(sent[0]!.text, /Still watching 1 PR;/);
});

test("a watch registered again during the cycle survives it", () => {
  const seen = watch({ watchFor: "checks" });
  // The message woke the agent, which asked for a new watch on the new push.
  const stored = { k: watch({ since: T0 + HOUR }) };
  applyCiChanges(stored, { k: seen }, new Map([["k", null]]));
  assert.equal(stored.k.since, T0 + HOUR);
});

test("applying changes removes and updates only what the cycle saw", () => {
  const seen = { gone: watch(), kept: watch({ pr: 2 }) };
  const stored = { gone: watch(), kept: watch({ pr: 2 }), added: watch({ pr: 3 }) } as Record<string, CiWatch>;
  applyCiChanges(stored, seen, new Map<string, CiWatch | null>([
    ["gone", null],
    ["kept", watch({ pr: 2, lastCheckedAt: T0 })],
  ]));
  assert.deepEqual(Object.keys(stored).sort(), ["added", "kept"]);
  assert.equal(stored.kept!.lastCheckedAt, T0);
});

test("only proof counts as a thread being gone", async () => {
  const fail = (message: string) => async () => {
    throw new Error(message);
  };
  assert.equal(await isThreadGone(async () => ({ archivedAt: 1, deletedAt: null })), true);
  assert.equal(await isThreadGone(async () => ({ archivedAt: null, deletedAt: 1 })), true);
  assert.equal(await isThreadGone(async () => ({ archivedAt: null, deletedAt: null })), false);
  assert.equal(await isThreadGone(fail("BbHttpError: HTTP 404: Not found")), true);
  assert.equal(await isThreadGone(fail("BbHttpError: HTTP 503: Unavailable")), false);
  assert.equal(await isThreadGone(fail("socket hang up")), false);
  assert.equal(await isThreadGone(fail("BbHttpError: HTTP 409: Thread is archived")), true);
  assert.equal(await isThreadGone(fail("BbHttpError: HTTP 409: Conflict")), false);
});

test("409 counts as gone only when bb says the thread is archived or deleted", () => {
  assert.equal(isGoneError(new Error("BbHttpError: HTTP 409: Thread is archived")), true);
  assert.equal(isGoneError(Object.assign(new Error("Thread is archived"), { status: 409 })), true);
  assert.equal(isGoneError(new Error("BbHttpError: HTTP 409: Version conflict")), false);
});

test("an archived thread's watches are all dropped without reading GitHub", async () => {
  let reads = 0;
  const watches = {
    a: watch({ pr: 1 }),
    b: watch({ pr: 2, watchFor: "reviews" }),
    other: watch({ threadId: "thr_other", pr: 3 }),
  };
  const { config, sent } = cycle(watches, prState(), {
    threadState: async (threadId) => (threadId === "thr_other" ? "busy" : "gone"),
    readPr: async () => {
      reads += 1;
      return prState();
    },
  });
  const changes = await runCiCycle(config);
  assert.equal(changes.get("a"), null);
  assert.equal(changes.get("b"), null);
  assert.equal(changes.has("other"), false);
  assert.equal(reads, 0);
  assert.equal(sent.length, 0);
});

test("a failed send to a thread that's gone drops its other watches too", async () => {
  const watches = {
    done: watch({ pr: 1, watchFor: "checks" }),
    // Spaced out this cycle, so it isn't staged with the first.
    later: watch({ pr: 2, watchFor: "reviews", lastCheckedAt: T0 - 60_000 }),
  };
  const { config } = cycle(watches, prState({ statusCheckRollup: [green] }), {
    send: async () => {
      throw new Error("HTTP 409: Thread is archived");
    },
    threadGone: async () => true,
  });
  const changes = await runCiCycle(config);
  assert.equal(changes.get("done"), null);
  assert.equal(changes.get("later"), null);
});

test("PRs are read a few at a time, and every watch is still handled", async () => {
  let running = 0;
  let peak = 0;
  const watches = Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [`k${index}`, watch({ threadId: `thr_${index}`, pr: index + 1, watchFor: "checks" })]),
  );
  const { config, sent } = cycle(watches, prState(), {
    concurrency: 3,
    readPr: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return prState({ statusCheckRollup: [green] });
    },
  });
  const changes = await runCiCycle(config);
  assert.equal(peak, 3);
  assert.equal(sent.length, 9);
  for (const key of Object.keys(watches)) assert.equal(changes.get(key), null);
});

test("only a removed watch or a new kind of wait counts as a visible change", () => {
  const seen = { k: watch() };
  assert.equal(visibleChange(seen, new Map([["k", { ...seen.k, lastCheckedAt: T0 }]])), false);
  assert.equal(visibleChange(seen, new Map([["k", { ...seen.k, watchFor: "reviews" as const, quiet: true }]])), true);
  assert.equal(visibleChange(seen, new Map([["k", null]])), true);
});
