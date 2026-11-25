import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { listEnvironmentPages, listLiveThreads } from "./thread-list.ts";

type Row = { id: string; archivedAt: number | null };
type Args = { archived?: boolean; limit: number; offset: number; sectionId?: string };

/** A fake threads.list that honours archived, limit, offset and sectionId, as the real route does. */
function fakeBb(rows: Row[], calls: Args[] = []) {
  return {
    sdk: {
      threads: {
        async list(args: Args) {
          calls.push(args);
          return rows
            .filter((row) => args.archived === undefined || args.archived === (row.archivedAt !== null))
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

type Env = { id: string };
type EnvArgs = { limit: number; offset: number };

test("environments are read page by page, never above 500 a page", async () => {
  const rows: Env[] = Array.from({ length: 1203 }, (_, index) => ({ id: `env-${index}` }));
  const calls: EnvArgs[] = [];
  const bb = {
    sdk: {
      environments: {
        async list(args: EnvArgs) {
          calls.push(args);
          if (args.limit > 500) throw new Error("400: limit above 500");
          return rows.slice(args.offset, args.offset + args.limit);
        },
      },
    },
  };
  assert.equal((await listEnvironmentPages(bb)).length, 1203);
  assert.deepEqual(calls, [
    { limit: 500, offset: 0 },
    { limit: 500, offset: 500 },
    { limit: 500, offset: 1000 },
  ]);
});

test("every threads.list and environments.list call outside the pagers passes a limit of 500 or less", () => {
  // bb caps these routes: no limit means at most 200 rows, and a limit above 500 is a 400.
  const files = execFileSync("git", ["ls-files", "*.ts", "*.tsx"], { encoding: "utf8" })
    .split("\n")
    .filter((file) => file && !/\.test\.tsx?$/.test(file) && file !== "thread-list.ts");
  const problems: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\b(?:threads|environments)\.list\(([^)]*)\)/g)) {
      const limit = /\blimit:\s*(\d+)/.exec(match[1] ?? "");
      if (!limit || Number(limit[1]) > 500) problems.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(problems, []);
});
