import assert from "node:assert/strict";
import { test } from "node:test";
import { orderStack, type PrStatus } from "./prs.ts";

const pr = (number: number, base: string, head: string, repo = "o/a"): PrStatus => ({
  repo, number, title: `#${number}`, url: "", state: "open", attention: "review_requested",
  base, head, stackedOn: null, checkedAt: 0,
});

test("stacked PRs are ordered base-first", () => {
  const ordered = orderStack([pr(3, "feat-b", "feat-c"), pr(1, "dev", "feat-a"), pr(2, "feat-a", "feat-b")]);
  assert.deepEqual(ordered.map((p) => [p.number, p.stackedOn]), [[1, null], [2, 1], [3, 2]]);
});

test("a dev→main release PR is not a stack parent", () => {
  const ordered = orderStack([pr(10, "main", "dev"), pr(11, "dev", "fix-x")]);
  assert.deepEqual(ordered.map((p) => p.stackedOn), [null, null]);
});

test("same branch names in different repos don't stack", () => {
  const ordered = orderStack([pr(1, "dev", "feat", "o/a"), pr(2, "feat", "feat-2", "o/b")]);
  assert.deepEqual(ordered.map((p) => p.stackedOn), [null, null]);
});
