import { test } from "node:test";
import assert from "node:assert/strict";
import { minPaneWidth, requiredSplitWidth, revealScrollLeft } from "./split-scroll-model.ts";

const row = (...widths: number[]) => {
  let x = 0;
  return widths.map((width) => {
    const pane = { rect: { x, width } };
    x += width;
    return pane;
  });
};

test("the strip is as wide as the narrowest pane needs", () => {
  assert.equal(requiredSplitWidth(row(0.25, 0.25, 0.25, 0.25), 640), 2560);
  // Uneven panes keep their proportions: the narrowest one reaches the minimum.
  assert.equal(requiredSplitWidth(row(0.5, 0.3, 0.2), 600), 3000);
  // Two panes stacked in one column are both full width.
  assert.equal(requiredSplitWidth([{ rect: { x: 0, width: 1 } }, { rect: { x: 0, width: 1 } }], 640), 640);
});

test("a single pane, no panes and broken fractions don't scroll", () => {
  assert.equal(requiredSplitWidth(row(1), 640), null);
  assert.equal(requiredSplitWidth([], 640), null);
  assert.equal(requiredSplitWidth(row(0.5, 0), 640), null);
  assert.equal(requiredSplitWidth(row(0.5, Number.NaN), 640), null);
});

test("a sliver in a nested split can't ask for more than eight panes' worth", () => {
  assert.equal(requiredSplitWidth(row(0.98, 0.02), 640), 5120);
  assert.equal(requiredSplitWidth(row(...Array.from({ length: 8 }, () => 0.125)), 640), 5120);
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
