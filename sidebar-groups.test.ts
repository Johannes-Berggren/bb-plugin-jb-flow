import assert from "node:assert/strict";
import { test } from "node:test";
import { groupBySection, quietFor, sortRows } from "./sidebar-groups.ts";

const row = (id: string, createdAt: number, updatedAt: number) => ({ id, createdAt, updatedAt });
const ids = (rows: Array<{ id: string }>) => rows.map((thread) => thread.id);

test("rows sort by last activity unless creation order is on", () => {
  const rows = [row("older-busy", 1, 30), row("newer-quiet", 2, 20), row("newest", 3, 10)];
  assert.deepEqual(ids(sortRows(rows, false)), ["older-busy", "newer-quiet", "newest"]);
  assert.deepEqual(ids(sortRows(rows, true)), ["newest", "newer-quiet", "older-busy"]);
});

test("activity on a thread doesn't move it in creation order", () => {
  const before = [row("a", 1, 10), row("b", 2, 20)];
  const after = [row("a", 1, 99), row("b", 2, 20)];
  assert.deepEqual(ids(sortRows(before, true)), ids(sortRows(after, true)));
});

test("sorting leaves the input alone", () => {
  const rows = [row("a", 1, 10), row("b", 2, 20)];
  sortRows(rows, true);
  assert.deepEqual(ids(rows), ["a", "b"]);
});

test("reading a thread doesn't make it any less quiet", () => {
  assert.equal(quietFor({ latestAttentionAt: 100, updatedAt: 950 }, 1000), 900);
});

test("a thread that never asked for attention counts from its last update", () => {
  assert.equal(quietFor({ latestAttentionAt: null, updatedAt: 950 }, 1000), 50);
});

const member = (id: string, section: string) => ({ id, section });

test("a filter's matches follow your section order, without empty sections", () => {
  const members = [member("a", "later"), member("b", "active"), member("c", "later")];
  const { sections, loose } = groupBySection(members, ["priority", "active", "later"], (thread) => thread.section);
  assert.deepEqual(
    sections.map((group) => [group.key, ids(group.threads)]),
    [
      ["active", ["b"]],
      ["later", ["a", "c"]],
    ],
  );
  assert.deepEqual(loose, []);
});

test("a match in an unknown section isn't dropped, and no thread shows twice", () => {
  const members = [member("a", "active"), member("b", "deleted-section")];
  const { sections, loose } = groupBySection(members, ["active"], (thread) => thread.section);
  assert.deepEqual(ids(loose), ["b"]);
  const shown = [...sections.flatMap((group) => ids(group.threads)), ...ids(loose)];
  assert.deepEqual(shown.sort(), ["a", "b"]);
});
