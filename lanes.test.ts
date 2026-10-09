import assert from "node:assert/strict";
import { test } from "node:test";
import { matchLanes } from "./lanes.ts";

const sections = [
  { id: "a", name: "⭐ Priority" },
  { id: "b", name: "Waiting for others" },
  { id: "c", name: "Pick up later" },
  { id: "d", name: "Low priority" },
];

test("first match is by name", () => {
  assert.deepEqual(matchLanes(sections, {}), { priority: "a", waiting: "b", later: "c", low: "d" });
});

test("a pinned lane survives a rename", () => {
  const renamed = sections.map((section) => (section.id === "d" ? { ...section, name: "Someday" } : section));
  assert.equal(matchLanes(renamed, { low: "d" }).low, "d");
});

test("a deleted pin is matched again, never stealing another lane's section", () => {
  const result = matchLanes(sections, { low: "gone", priority: "d" });
  assert.equal(result.priority, "d");
  assert.equal(result.low, undefined);
});

test("only whole lane names match", () => {
  const others = [
    { id: "x", name: "Priority customers" },
    { id: "y", name: "Waiting on legal" },
    { id: "z", name: "🔥 Priority" },
    { id: "w", name: "Waiting" },
  ];
  assert.deepEqual(matchLanes(others, {}), { priority: "z", waiting: "w" });
});
