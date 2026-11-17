import { test } from "node:test";
import assert from "node:assert/strict";
import {
  opensSwitcher,
  pushRecentWorkspace,
  startIndex,
  step,
  threadItems,
  workspaceItems,
  workspaceLabel,
} from "./tab-switcher-model.ts";

const thread = (id: string, updatedAt: number, changes: { isArchived?: boolean; isHidden?: boolean } = {}) => ({
  id,
  updatedAt,
  isArchived: false,
  isHidden: false,
  ...changes,
});

const threads = [thread("a", 1), thread("b", 5), thread("c", 3), thread("d", 4), thread("old", 0, { isArchived: true }), thread("sub", 9, { isHidden: true })];
const ids = (items: { id: string }[]) => items.map((item) => item.id);

test("current first, then the threads you viewed, then the rest by update", () => {
  assert.deepEqual(ids(threadItems(["c", "a"], threads, "a")), ["a", "c", "b", "d"]);
});

test("archived, hidden and unknown threads are left out", () => {
  assert.deepEqual(ids(threadItems(["old", "sub", "gone", "c"], threads, null)), ["c", "b", "d", "a"]);
});

test("no history falls back to the most recently updated", () => {
  assert.deepEqual(ids(threadItems([], threads, null)), ["b", "d", "c", "a"]);
});

test("a current thread that isn't in the list doesn't count", () => {
  assert.deepEqual(ids(threadItems(["c"], threads, "gone", 2)), ["c", "b"]);
});

test("the limit caps the list", () => {
  assert.equal(threadItems([], threads, null, 2).length, 2);
});

test("workspaces: selected, then recent, then the rest in top-bar order", () => {
  const order = ["w1", "w2", "w3", null, "unassigned"];
  assert.deepEqual(workspaceItems(["w3", null, "gone"], order, "w2"), ["w2", "w3", null, "w1", "unassigned"]);
  assert.deepEqual(workspaceItems([], order, null), [null, "w1", "w2", "w3", "unassigned"]);
});

test("pushRecentWorkspace moves a tab to the front without duplicates", () => {
  assert.deepEqual(pushRecentWorkspace(["w1", null, "w2"], null), [null, "w1", "w2"]);
  assert.deepEqual(pushRecentWorkspace(["w1", "w2"], "w3", 2), ["w3", "w1"]);
});

test("step wraps both ways", () => {
  assert.equal(step(0, -1, 4), 3);
  assert.equal(step(3, 1, 4), 0);
  assert.equal(step(1, 1, 4), 2);
  assert.equal(step(0, 1, 0), 0);
});

test("a fresh switcher starts on the one before the current", () => {
  assert.equal(startIndex(5), 1);
  assert.equal(startIndex(1), 0);
  assert.equal(startIndex(0), 0);
  // No current item first (a page that isn't a thread): start on the most recent.
  assert.equal(startIndex(5, false), 0);
});

test("labels for All, No workspace and named workspaces", () => {
  const workspaces = [{ id: "w1", name: "Web" }];
  assert.equal(workspaceLabel(null, workspaces), "All");
  assert.equal(workspaceLabel("unassigned", workspaces), "No workspace");
  assert.equal(workspaceLabel("w1", workspaces), "Web");
});

test("Ctrl+Tab opens threads, Ctrl+` workspaces; other modifiers don't", () => {
  const key = (key: string, code: string, changes = {}) => ({ key, code, ctrlKey: true, metaKey: false, altKey: false, ...changes });
  assert.equal(opensSwitcher(key("Tab", "Tab")), "threads");
  assert.equal(opensSwitcher(key("`", "Backquote")), "workspaces");
  assert.equal(opensSwitcher(key("Tab", "Tab", { metaKey: true })), null);
  assert.equal(opensSwitcher(key("Tab", "Tab", { altKey: true })), null);
  assert.equal(opensSwitcher(key("Tab", "Tab", { ctrlKey: false })), null);
  assert.equal(opensSwitcher(key("k", "KeyK")), null);
});
