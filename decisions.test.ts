import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDecisionOptions } from "./decisions.ts";

test("parses a trailing decision list with a recommendation", () => {
  const options = parseDecisionOptions(
    "Both work.\n\n> **Decision needed:** which import path?\n> 1. **Keep sheets as-is** — fastest (recommended)\n> 2. Normalize columns — cleaner\n>\n> Reply with the number.\n\n_2026-10-04 11:15 CEST_",
  );
  assert.deepEqual(options.map((option) => [option.n, option.recommended]), [[1, true], [2, false]]);
  assert.equal(options[0]!.text, "Keep sheets as-is — fastest");
});

test("ignores lists that aren't at the end, or aren't choices", () => {
  assert.deepEqual(parseDecisionOptions("Steps:\n1. a\n2. b\n\nThen I merged it and everything is done. Lots more text here.\nMore.\nMore.\nMore.\nMore.\nMore.\nMore."), []);
  assert.deepEqual(parseDecisionOptions("Only one:\n1. this"), []);
});

test("preserves longer reply choices for the multiline cards while bounding output", () => {
  const text = "Build the next section and validate the result with the existing measurement before proceeding to the final review";
  assert.equal(parseDecisionOptions(`Choose an approach?\n1. ${text} (recommended)\n2. Stop here`)[0]?.text, text);
  assert.equal(parseDecisionOptions(`Choose an approach?\n1. ${"x".repeat(600)} (recommended)\n2. Stop here`)[0]?.text.length, 500);
});
