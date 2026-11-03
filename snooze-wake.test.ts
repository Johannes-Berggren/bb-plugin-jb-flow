import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_NOTE_FAILURES, wakeDueSnoozes, type SnoozeRecord, type WakeDeps } from "./snooze-wake.ts";

const NOW = 1_000_000;
const SNOOZED = "sec_snoozed";

const record = (fields: Partial<SnoozeRecord> = {}): SnoozeRecord => ({ until: NOW - 1, note: null, snoozedAt: 500, ...fields });

/** A fake bb whose thread sits in Snoozed until restored, as the real one does. */
function fake(fields: Partial<WakeDeps<SnoozeRecord>> = {}, sectionId: string | null = SNOOZED) {
  const calls: string[] = [];
  const thread = { sectionId, archivedAt: null as number | null };
  const deps: WakeDeps<SnoozeRecord> = {
    now: () => NOW,
    snoozedSectionId: SNOOZED,
    getThread: async () => thread,
    isGoneError: (error) => String(error).includes("HTTP 404"),
    markStarted: async () => {
      calls.push("started");
    },
    restore: async () => {
      calls.push("restore");
      thread.sectionId = "sec_old";
    },
    sendNote: async (_, note) => {
      calls.push(`note:${note}`);
    },
    warn: () => undefined,
    ...fields,
  };
  return { deps, calls, thread };
}

test("a due snooze comes back and sends its note", async () => {
  const { deps, calls } = fake();
  const result = await wakeDueSnoozes({ t: record({ note: "Check on Sam" }) }, deps);
  assert.deepEqual(calls, ["started", "restore", "note:Check on Sam"]);
  assert.equal(result.woken, 1);
  assert.equal(result.done.get("t"), 500);
});

test("a due snooze without a note just comes back", async () => {
  const { deps, calls } = fake();
  const result = await wakeDueSnoozes({ t: record() }, deps);
  assert.deepEqual(calls, ["started", "restore"]);
  assert.equal(result.done.size, 1);
});

test("a snooze that isn't due stays, untouched", async () => {
  const { deps, calls } = fake();
  const result = await wakeDueSnoozes({ t: record({ until: NOW + 1, note: "Later" }) }, deps);
  assert.deepEqual(calls, []);
  assert.equal(result.done.size, 0);
  assert.equal(result.woken, 0);
});

test("a thread moved out of Snoozed by hand ends its snooze, without its note", async () => {
  const { deps, calls } = fake({}, "sec_other");
  const result = await wakeDueSnoozes({ t: record({ note: "Check on Sam" }) }, deps);
  assert.deepEqual(calls, []);
  assert.equal(result.done.get("t"), 500);
});

test("an archived thread ends its snooze, without its note", async () => {
  const { deps, calls, thread } = fake();
  thread.archivedAt = 1;
  const result = await wakeDueSnoozes({ t: record({ note: "Check on Sam" }) }, deps);
  assert.deepEqual(calls, []);
  assert.equal(result.done.size, 1);
});

test("a failed lookup keeps the snooze; a thread that's gone ends it", async () => {
  const fail = (message: string) => ({
    getThread: async () => {
      throw new Error(message);
    },
  });
  const blip = await wakeDueSnoozes({ t: record({ note: "Check on Sam" }) }, fake(fail("HTTP 503")).deps);
  assert.equal(blip.done.size, 0);
  const gone = await wakeDueSnoozes({ t: record({ note: "Check on Sam" }) }, fake(fail("HTTP 404: Not found")).deps);
  assert.equal(gone.done.size, 1);
});

test("a failed note leaves the thread back in view, and the next check only resends the note", async () => {
  let attempt = 0;
  const { deps, calls } = fake({
    sendNote: async (_, note) => {
      attempt += 1;
      if (attempt === 1) throw new Error("HTTP 503");
      calls.push(`note:${note}`);
    },
  });
  const first = await wakeDueSnoozes({ t: record({ note: "Check on Sam" }) }, deps);
  assert.deepEqual(calls, ["started", "restore"], "the thread came back despite the failure");
  assert.equal(first.done.size, 0, "the record stays so the note can retry");
  assert.deepEqual(first.noteFailures.get("t"), { snoozedAt: 500, failures: 1 });

  // The thread has left Snoozed now, which must not read as "moved by hand".
  const second = await wakeDueSnoozes({ t: record({ note: "Check on Sam", wakeStarted: true, noteFailures: 1 }) }, deps);
  assert.deepEqual(calls, ["started", "restore", "note:Check on Sam"]);
  assert.equal(second.done.size, 1);
  assert.equal(second.woken, 0, "already counted when it came back");
});

test("a failed move is tried again, and the note waits for it", async () => {
  let attempt = 0;
  const { deps, calls } = fake({
    restore: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("HTTP 503");
      calls.push("restore");
    },
  });
  const first = await wakeDueSnoozes({ t: record({ note: "Check on Sam" }) }, deps);
  assert.deepEqual(calls, ["started"]);
  assert.equal(first.done.size, 0);
  assert.equal(first.woken, 0);

  await wakeDueSnoozes({ t: record({ note: "Check on Sam", wakeStarted: true }) }, deps);
  assert.deepEqual(calls, ["started", "restore", "note:Check on Sam"]);
});

test("a note that can never be sent is given up on", async () => {
  const warnings: string[] = [];
  const { deps } = fake(
    {
      sendNote: async () => {
        throw new Error("HTTP 500");
      },
      warn: (message) => warnings.push(message),
    },
    "sec_old",
  );
  const result = await wakeDueSnoozes({ t: record({ note: "Check on Sam", wakeStarted: true, noteFailures: MAX_NOTE_FAILURES - 1 }) }, deps);
  assert.equal(result.done.size, 1);
  assert.equal(result.noteFailures.size, 0);
  assert.match(warnings.join(), /gave up after 30 attempts/);
});

test("with no Snoozed section, a record not yet waking is stale", async () => {
  const { deps, calls } = fake({ snoozedSectionId: null }, "sec_old");
  const result = await wakeDueSnoozes({ t: record({ note: "Check on Sam" }) }, deps);
  assert.deepEqual(calls, []);
  assert.equal(result.done.size, 1);
});
