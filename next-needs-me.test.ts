import assert from "node:assert/strict";
import { test } from "node:test";
import { nextNeedsMe, type NextNeedsMeDeps } from "./next-needs-me.ts";

/** A fake bb that logs every call in order. */
function fake(fields: Partial<NextNeedsMeDeps> & { next?: string | null; pinnedAt?: number | null } = {}) {
  const calls: string[] = [];
  const deps: NextNeedsMeDeps = {
    nextThread: async (current, skip) => {
      calls.push(`next:${current}:${skip}`);
      return fields.next === undefined ? "b" : fields.next;
    },
    focusedThreadId: () => "focused",
    getThread: async (threadId) => {
      calls.push(`get:${threadId}`);
      return { pinnedAt: fields.pinnedAt ?? null };
    },
    archive: async (threadId) => {
      calls.push(`archive:${threadId}`);
    },
    open: async (threadId) => {
      calls.push(`open:${threadId}`);
    },
    ...fields,
  };
  return { deps, calls };
}

test("archives the thread and opens the next one, worked out before the archive", async () => {
  const { deps, calls } = fake();
  assert.deepEqual(await nextNeedsMe("a", deps), { opened: "b" });
  assert.deepEqual(calls, ["next:a:a", "get:a", "archive:a", "open:b"]);
});

test("a pinned thread isn't archived, but the next one still opens", async () => {
  const { deps, calls } = fake({ pinnedAt: 1_000 });
  assert.deepEqual(await nextNeedsMe("a", deps), { opened: "b" });
  assert.deepEqual(calls, ["next:a:a", "get:a", "open:b"]);
});

test("with no next thread, the thread is still archived and nothing opens", async () => {
  const { deps, calls } = fake({ next: null });
  assert.deepEqual(await nextNeedsMe("a", deps), { opened: null });
  assert.deepEqual(calls, ["next:a:a", "get:a", "archive:a"]);
});

test("a failed thread lookup doesn't stop it: the thread is archived and the next one opens", async () => {
  const { deps, calls } = fake({
    getThread: async () => {
      throw new Error("HTTP 503");
    },
  });
  assert.deepEqual(await nextNeedsMe("a", deps), { opened: "b" });
  assert.deepEqual(calls, ["next:a:a", "archive:a", "open:b"]);
});

test("without a thread to archive, it moves on from the focused thread and archives nothing", async () => {
  const { deps, calls } = fake();
  assert.deepEqual(await nextNeedsMe(null, deps), { opened: "b" });
  assert.deepEqual(calls, ["next:focused:null", "open:b"]);
});
