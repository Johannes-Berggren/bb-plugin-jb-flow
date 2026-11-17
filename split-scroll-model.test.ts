import { test } from "node:test";
import assert from "node:assert/strict";
import { minPaneWidth, requiredSplitWidth, revealScrollLeft, splitColumns } from "./split-scroll-model.ts";

const pane = (x: number, width: number, y = 0, height = 1) => ({ rect: { x, y, width, height } });
const row = (...widths: number[]) => {
  let x = 0;
  return widths.map((width) => {
    const next = pane(x, width);
    x += width;
    return next;
  });
};

test("each column of the split gets the minimum width", () => {
  assert.equal(requiredSplitWidth(row(0.25, 0.25, 0.25, 0.25), 640), 2560);
  assert.equal(requiredSplitWidth(row(...Array.from({ length: 8 }, () => 0.125)), 640), 5120);
});

test("the width follows the number of columns, not their proportions, so a divider drag never changes it", () => {
  assert.equal(requiredSplitWidth(row(0.5, 0.3, 0.2), 600), 1800);
  assert.equal(requiredSplitWidth(row(0.2, 0.2, 0.2, 0.162, 0.238), 640), 3200);
  assert.equal(requiredSplitWidth(row(0.98, 0.02), 640), 1280);
});

test("panes stacked in a column count once", () => {
  // Two panes on top of each other: one column.
  assert.equal(splitColumns([pane(0, 1, 0, 0.5), pane(0, 1, 0.5, 0.5)]), 1);
  // A pane, a column of two, a pane: three columns.
  const nested = [pane(0, 0.3), pane(0.3, 0.4, 0, 0.5), pane(0.3, 0.4, 0.5, 0.5), pane(0.7, 0.3)];
  assert.equal(splitColumns(nested), 3);
  assert.equal(requiredSplitWidth(nested, 640), 1920);
  // Two rows of different lengths: the longer row decides.
  const rows = [pane(0, 0.5, 0, 0.5), pane(0.5, 0.5, 0, 0.5), pane(0, 1 / 3, 0.5, 0.5), pane(1 / 3, 1 / 3, 0.5, 0.5), pane(2 / 3, 1 / 3, 0.5, 0.5)];
  assert.equal(splitColumns(rows), 3);
});

test("a single pane and no panes don't scroll", () => {
  assert.equal(requiredSplitWidth(row(1), 640), null);
  assert.equal(requiredSplitWidth([], 640), null);
});

test("the minimum width setting is clamped and falls back to the default", () => {
  assert.equal(minPaneWidth(700), 700);
  assert.equal(minPaneWidth(10), 320);
  assert.equal(minPaneWidth(99999), 1600);
  assert.equal(minPaneWidth(undefined), 640);
  assert.equal(minPaneWidth("800"), 640);
  assert.equal(minPaneWidth(Number.NaN), 640);
});

test("a pane already in view leaves the strip where it is", () => {
  const view = { scrollWidth: 4000, clientWidth: 2000 };
  assert.equal(revealScrollLeft({ x: 0.25, width: 0.25, ...view, scrollLeft: 500 }), 500);
  assert.equal(revealScrollLeft({ x: 0, width: 0.5, ...view, scrollLeft: 0 }), 0);
});

test("a pane off to either side scrolls just far enough to show it whole", () => {
  const view = { scrollWidth: 4000, clientWidth: 2000 };
  // To the right: its right edge meets the right edge of the view.
  assert.equal(revealScrollLeft({ x: 0.75, width: 0.25, ...view, scrollLeft: 0 }), 2000);
  assert.equal(revealScrollLeft({ x: 0.5, width: 0.25, ...view, scrollLeft: 0 }), 1000);
  // To the left: its left edge meets the left edge of the view.
  assert.equal(revealScrollLeft({ x: 0.25, width: 0.25, ...view, scrollLeft: 2000 }), 1000);
});

test("a pane wider than the view shows its left edge, and nothing scrolls past the ends", () => {
  assert.equal(revealScrollLeft({ x: 0.2, width: 0.8, scrollWidth: 4000, clientWidth: 2000, scrollLeft: 0 }), 800);
  assert.equal(revealScrollLeft({ x: 0.5, width: 0.5, scrollWidth: 2000, clientWidth: 2000, scrollLeft: 0 }), 0);
  assert.equal(revealScrollLeft({ x: 0.9, width: 0.1, scrollWidth: 4000, clientWidth: 2000, scrollLeft: 0 }), 2000);
});
