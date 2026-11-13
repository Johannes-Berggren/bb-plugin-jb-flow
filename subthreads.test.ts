import assert from "node:assert/strict";
import { test } from "node:test";
import { childrenByParent, descendants, subthreadRows, topLevel } from "./subthreads.ts";

const node = (id: string, parentThreadId: string | null = null) => ({ id, parentThreadId });
const ids = (rows: Array<{ id: string }>) => rows.map((thread) => thread.id);
const open = () => false;

test("only threads without a parent in the list get a row of their own", () => {
  const threads = [node("root"), node("child", "root"), node("grandchild", "child")];
  assert.deepEqual(ids(topLevel(threads)), ["root"]);
});

test("a thread whose parent isn't in the list stays at the top level", () => {
  assert.deepEqual(ids(topLevel([node("orphan", "archived-parent")])), ["orphan"]);
});

test("children keep the order they were given", () => {
  const children = childrenByParent([node("root"), node("b", "root"), node("a", "root")]);
  assert.deepEqual(ids(children.get("root")!), ["b", "a"]);
});

test("subthreads list depth first, with their depth", () => {
  const children = childrenByParent([node("root"), node("a", "root"), node("a1", "a"), node("b", "root")]);
  assert.deepEqual(
    subthreadRows("root", children, open).map((row) => [row.thread.id, row.depth]),
    [["a", 1], ["a1", 2], ["b", 1]],
  );
});

test("folding a thread hides everything under it, but not the thread itself", () => {
  const children = childrenByParent([node("root"), node("a", "root"), node("a1", "a"), node("b", "root")]);
  assert.deepEqual(ids(subthreadRows("root", children, (id) => id === "a").map((row) => row.thread)), ["a", "b"]);
  assert.deepEqual(subthreadRows("root", children, (id) => id === "root"), []);
});

test("a thread without children has no subthread rows", () => {
  assert.deepEqual(subthreadRows("lonely", childrenByParent([node("lonely")]), open), []);
});

test("a parent loop doesn't hang the list", () => {
  const children = childrenByParent([node("a", "b"), node("b", "a")]);
  assert.deepEqual(ids(descendants("a", children)), ["b"]);
});

test("descendants ignore folding", () => {
  const children = childrenByParent([node("root"), node("a", "root"), node("a1", "a")]);
  assert.deepEqual(ids(descendants("root", children)), ["a", "a1"]);
});
