import assert from "node:assert/strict";
import { test } from "node:test";
import { nextMove, parseDecisionOptions } from "./decisions.ts";

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

test("a list of steps is not a choice, even near the end", () => {
  const steps = [
    "Manual fallback:",
    "",
    "1. Acme pushes the order as Draft.",
    "2. Finance verifies customer, amount and delivery method in the ledger.",
    "3. Finance changes it to Ready to Invoice in the GUI.",
    "4. The read-only reconciliation detects the assigned invoice number.",
    "",
    "The current branch implements the unsupported promotion path, so it should not ship as written.",
    "",
    "> **Recommended:** remove the promotion endpoint and keep Draft creation.",
    ">",
    "> Write **go** and I'll make that change.",
  ].join("\n");
  assert.deepEqual(parseDecisionOptions(steps), []);
  // Still a trailing list for the "needs me" check.
  assert.equal(parseDecisionOptions("Two things:\n1. Check the login.\n2. Remove the worktree.", { strict: false }).length, 2);
});

test("a list is a choice when the intro asks, an option is recommended, or the outro asks for a number", () => {
  assert.equal(parseDecisionOptions("Which should I do?\n1. Merge now\n2. Wait for review").length, 2);
  assert.equal(parseDecisionOptions("Options:\n1. Merge now\n2. Wait for review").length, 2);
  assert.equal(parseDecisionOptions("Next:\n1. Merge now (recommended)\n2. Wait for review").length, 2);
  assert.equal(parseDecisionOptions("Two ways forward:\n1. Merge now\n2. Wait for review\n\nReply with the number.").length, 2);
  assert.equal(parseDecisionOptions("Two ways forward:\n1. Merge now\n2. Wait for review").length, 2);
  assert.deepEqual(parseDecisionOptions("Steps:\n1. Merge now\n2. Wait for review"), []);
});

test("next-step lists you pick from with go are choices", () => {
  assert.equal(parseDecisionOptions("> **Recommended:** 1\n> 1. Check the nightly run\n> 2. Try the staging app\n>\n> Reply **go** for all, or **go 1,3**.").length, 2);
  assert.equal(parseDecisionOptions("> **Reply `go` for the next slice:**\n>\n> 1. Slim the reads\n> 2. Run the probe").length, 2);
});

test("next move: a status report's steps, answered with go or a number", () => {
  const head = "**Goal:** Ship it\n**Done:** Merged the fix\n\n### Next steps\n> [!TIP]\n";
  const go = nextMove(
    head + "> **Path forward:** check it, then tidy\n> 1. Check the nightly run (recommended)\n> 2. Tidy the docs\n>\n> Reply **go** for all, or **go 1,3**.\n\n_2026-10-24 11:30 CEST_",
  );
  assert.deepEqual(go, {
    mode: "go",
    options: [
      { n: 1, text: "Check the nightly run", recommended: true },
      { n: 2, text: "Tidy the docs", recommended: false },
    ],
  });
  const choice = nextMove(head + "> **Decision needed:** which rollout?\n> 1. 10% today (recommended)\n> 2. Everyone on Monday\n>\n> Reply with the number.");
  assert.equal(choice.mode, "choice");
  assert.deepEqual(choice.options.map((option) => option.text), ["10% today", "Everyone on Monday"]);
});

test("next move without a report: a trailing list, go-list when it asks for go", () => {
  assert.equal(nextMove("> **Reply `go` for the next slice:**\n>\n> 1. Slim the reads\n> 2. Run the probe").mode, "go");
  assert.equal(nextMove("Two ways forward:\n1. Merge now\n2. Wait for review\n\nReply **go** for all, or **go 2**.").mode, "go");
  const choice = nextMove("Which should I do?\n1. Merge now\n2. Wait for review");
  assert.equal(choice.mode, "choice");
  assert.equal(choice.options.length, 2);
  assert.deepEqual(nextMove("All done, the PR is merged."), { mode: "choice", options: [] });
});

test("next move: a list that asks for several numbers is answered with several", () => {
  const callout = [
    "> [!TIP]",
    "> **Decision needed:** which should I set up?",
    "> 1. Rule in the contributing guide · agents follow it straight away (recommended)",
    "> 2. CI check, warning only for two weeks · a backstop for everyone (recommended)",
    "> 3. Weekly flag list · keeps flags from drifting",
    "> 4. Draft a note to Alex and Sam for you to send",
    ">",
    "> Reply with the numbers, e.g. **1,2,4**.",
  ].join("\n");
  // Inside a status report, and as a bare list.
  const report = nextMove(`**Goal:** Keep flags tidy\n**Done:** Compared the options\n\n### Next steps\n${callout}\n\n_2026-11-10 09:55 CET_`);
  assert.equal(report.mode, "multi");
  assert.deepEqual(report.options.filter((option) => option.recommended).map((option) => option.n), [1, 2]);
  const bare = nextMove(`The call is yours.\n\n${callout}`);
  assert.equal(bare.mode, "multi");
  assert.equal(bare.options.length, 4);
  for (const ask of ["Pick one or more:", "Which apply? Select all that apply.", "Choose any combination:"]) {
    assert.equal(nextMove(`${ask}\n1. Merge now\n2. Wait for review\n3. Tidy the docs`).mode, "multi", ask);
  }
  assert.equal(nextMove("Two ways forward:\n1. Merge now\n2. Wait for review\n\nReply with one or more numbers, e.g. 1,2.").mode, "multi");
});

test("next move: one number, go, and earlier prose stay as they were", () => {
  assert.equal(nextMove("Which should I do?\n1. Merge now\n2. Wait for review\n\nReply with the number.").mode, "choice");
  assert.equal(nextMove("Which should I do?\n1. Merge now\n2. Wait for review\n\nReply **go** for all, or **go 1,3**.").mode, "go");
  // "several" belongs to the prose, not to the list.
  const prose = "Several checks failed and multiple jobs need numbers.\n\nWhich should I do?\n1. Merge now\n2. Wait for review";
  assert.equal(nextMove(prose).mode, "choice");
  // Plural asks are still choices for the parser the deck and palette use.
  assert.equal(parseDecisionOptions("Two ways forward:\n1. Merge now\n2. Wait for review\n\nReply with the numbers.").length, 2);
});

test("a choice word used in passing doesn't make a plain list a choice", () => {
  // "reply" and "which" here aren't asking anything.
  const open = "With the reply to Olai sent, there's nothing left to do this session. Two things remain open.\n\n1. **Weekly audit check:** runs Monday.\n2. **One SSO connection:** your call.\n\n<sub>2026-09-29 21:42 CEST</sub>";
  assert.deepEqual(nextMove(open).options, []);
  assert.deepEqual(parseDecisionOptions("Beyond #8438, which you already knew about, the scan surfaced four you didn't:\n1. #8443 injects the token\n2. #8432 accepts any code"), []);
  // The asking forms still count.
  assert.equal(parseDecisionOptions("Which one?\n1. Merge now\n2. Wait for review").length, 2);
  assert.equal(parseDecisionOptions("Done with the fix. Which do you want next:\n1. Merge now\n2. Wait for review").length, 2);
  assert.equal(nextMove('> **Optional, reply "go" to run either:**\n> 1. Run the check\n> 2. Run it in a subagent').mode, "go");
});

test("a list followed by a new section isn't the message's ending", () => {
  const text = "Pick one:\n1. Merge now\n2. Wait for review\n\n## Also\n\nThe deploy is still pending.";
  assert.deepEqual(parseDecisionOptions(text), []);
  assert.deepEqual(parseDecisionOptions(text, { strict: false }), []);
});

test("option text keeps names: underscores inside words, # and > mid-text", () => {
  const options = "> 1. Delete seven, keep `TAURI_SIGNING_PRIVATE_KEY` until PR #64 lands (recommended)\n> 2. Move a -> b, _then_ stop\n>\n> Reply with the number.";
  const expected = ["Delete seven, keep TAURI_SIGNING_PRIVATE_KEY until PR #64 lands", "Move a -> b, then stop"];
  // A bare decision, and the same options in a status report's Next steps.
  assert.deepEqual(nextMove(`> **Decision needed:** which?\n${options}`).options.map((option) => option.text), expected);
  const report = nextMove(`**Goal:** Tidy secrets\n**Done:** Checked them\n\n### Next steps\n> [!TIP]\n> **Decision needed:** which?\n${options}\n\n_2026-11-14 10:00 CET_`);
  assert.deepEqual(report.options.map((option) => option.text), expected);
});
