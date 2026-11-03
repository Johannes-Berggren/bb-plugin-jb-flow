import assert from "node:assert/strict";
import { test } from "node:test";
import { listLiveThreads } from "./thread-list.ts";

type Row = { id: string; archivedAt: number | null };
type Args = { archived: boolean; limit: number; offset: number; sectionId?: string };

/** A fake threads.list that honours archived, limit, offset and sectionId, as the real route does. */
function fakeBb(rows: Row[], calls: Args[] = []) {
  return {
    sdk: {
      threads: {
        async list(args: Args) {
          calls.push(args);
          return rows
            .filter((row) => (args.archived ? row.archivedAt !== null : row.archivedAt === null))
            .slice(args.offset, args.offset + args.limit);
        },
      },
    },
  };
}

const live = (count: number, prefix = "live"): Row[] =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, archivedAt: null }));
const archived = (count: number): Row[] =>
  Array.from({ length: count }, (_, index) => ({ id: `old-${index}`, archivedAt: 1 }));

test("live threads behind 500 archived rows are still found", async () => {
  const rows = [...archived(758), ...live(93)];
  const found = await listLiveThreads(fakeBb(rows));
  assert.equal(found.length, 93);
  assert.ok(found.every((thread) => thread.archivedAt === null));
});

test("more than one page of live threads comes back whole", async () => {
  const calls: Args[] = [];
  const found = await listLiveThreads(fakeBb(live(1203), calls));
  assert.equal(found.length, 1203);
  assert.deepEqual(calls.map((call) => call.offset), [0, 500, 1000]);
});

test("exactly one full page stops after the empty next page", async () => {
  const calls: Args[] = [];
  assert.equal((await listLiveThreads(fakeBb(live(500), calls))).length, 500);
  assert.equal(calls.length, 2);
});

test("a thread seen on two pages counts once", async () => {
  const shifted = {
    sdk: {
      threads: {
        async list({ offset }: { offset: number }) {
          // A row moved down between the two requests, so it's on both pages.
          if (offset === 0) return live(500);
          return [{ id: "live-499", archivedAt: null }, { id: "last", archivedAt: null }];
        },
      },
    },
  };
  assert.equal((await listLiveThreads(shifted)).length, 501);
});

test("filters reach every page", async () => {
  const calls: Args[] = [];
  await listLiveThreads(fakeBb(live(600), calls), { sectionId: "sec_1" });
  assert.deepEqual(calls.map((call) => call.sectionId), ["sec_1", "sec_1"]);
  assert.ok(calls.every((call) => call.archived === false));
});
