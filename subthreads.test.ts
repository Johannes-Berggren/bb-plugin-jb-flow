import assert from "node:assert/strict";
import { test } from "node:test";
import { arrowAction, childrenByParent, descendants, foldKey, pruneFolds, rootIds, subthreadRows, topLevel, treesOf, withMatches } from "./subthreads.ts";

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

const familyTree = () => {
  const threads = [node("root"), node("a", "root"), node("a1", "a"), node("a2", "a"), node("b", "root"), node("solo")];
  const children = childrenByParent(threads);
  return { children, trees: treesOf(topLevel(threads), children) };
};

test("each row's tree holds the row, then everything under it", () => {
  const { trees } = familyTree();
  assert.deepEqual([...trees.keys()], ["root", "solo"]);
  assert.deepEqual(ids(trees.get("root")!), ["root", "a", "a1", "a2", "b"]);
  assert.deepEqual(ids(trees.get("solo")!), ["solo"]);
});

test("every thread knows the row it sits under", () => {
  const roots = rootIds(familyTree().trees);
  assert.equal(roots.get("a1"), "root");
  assert.equal(roots.get("root"), "root");
  assert.equal(roots.get("solo"), "solo");
});

test("a filter shows a matching subthread with the threads above it, and nothing else", () => {
  const shown = withMatches(familyTree().trees, (thread) => thread.id === "a2");
  assert.deepEqual([...shown].sort(), ["a", "a2", "root"]);
});

test("a filter that matches only a row shows none of its subthreads", () => {
  const { trees, children } = familyTree();
  const shown = withMatches(trees, (thread) => thread.id === "root");
  assert.deepEqual([...shown], ["root"]);
  assert.deepEqual(subthreadRows("root", children, open, shown), []);
});

test("subthread rows keep to a filter's matches, with their depth", () => {
  const { trees, children } = familyTree();
  const shown = withMatches(trees, (thread) => thread.id === "a1" || thread.id === "b");
  assert.deepEqual(
    subthreadRows("root", children, open, shown).map((row) => [row.thread.id, row.depth]),
    [["a", 1], ["a1", 2], ["b", 1]],
  );
});

test("fold state of threads that are gone is pruned, the rest is kept", () => {
  const stored = { [foldKey("kept")]: true, [foldKey("gone")]: false, "lane:active": true };
  assert.deepEqual(pruneFolds(stored, (id) => id === "kept"), { [foldKey("kept")]: true, "lane:active": true });
  assert.equal(pruneFolds({ [foldKey("kept")]: true, "lane:low": false }, (id) => id === "kept"), null);
});

test("← folds open subthreads, then moves to the parent; → unfolds", () => {
  const open = { folded: false };
  const folded = { folded: true };
  assert.equal(arrowAction("ArrowLeft", { subthreads: open, hasParent: true }), "fold");
  assert.equal(arrowAction("ArrowLeft", { subthreads: folded, hasParent: true }), "parent");
  assert.equal(arrowAction("ArrowLeft", { subthreads: undefined, hasParent: true }), "parent");
  assert.equal(arrowAction("ArrowLeft", { subthreads: undefined, hasParent: false }), null);
  assert.equal(arrowAction("ArrowLeft", { subthreads: folded, hasParent: false }), null);
  assert.equal(arrowAction("ArrowRight", { subthreads: folded, hasParent: true }), "unfold");
  assert.equal(arrowAction("ArrowRight", { subthreads: open, hasParent: false }), null);
  assert.equal(arrowAction("ArrowRight", { subthreads: undefined, hasParent: true }), null);
});
