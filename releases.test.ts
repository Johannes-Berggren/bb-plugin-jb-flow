import assert from "node:assert/strict";
import { test } from "node:test";
import { RELEASE_WAIT, releaseWaitEnded, releaseWaitStated } from "./release-wait.ts";

test("release waits are recognised", () => {
  for (const text of [
    "All the document-count fixes are now on dev. They reach customers with the next release.",
    "Squash-merged #10123 into dev. CI passed before merge. Not yet released to production.",
    "Where #1145 is: merged and deployed to dev, but not on `main`.",
    "Invite follow-up fix ████████░░ #10140 on dev, next release",
    "**Blocked:** waiting for release (last: v1.1.16, 2026-10-05)",
    "Once it's released, the nightly reconciliation will pick it up.",
    "⏳ #12 Fix invoices · awaiting release",
  ]) {
    assert.ok(RELEASE_WAIT.test(text), text);
  }
});

test("unrelated text isn't", () => {
  assert.ok(!RELEASE_WAIT.test("Merged #9995 and closed T-10600. Everything is done."));
  assert.ok(!RELEASE_WAIT.test("Released v6.104.0 to production; all checks passed."));
});

const report = (blocked: string, filler = "") =>
  [
    "**Goal:** Fix the invoice export.",
    "**Done:** Merged the fix.",
    "**Next:** Check the numbers.",
    ...(blocked ? [`**Blocked:** ${blocked}`] : []),
    filler,
  ].join("\n");

test("a Blocked line counts wherever it falls in a long report", () => {
  const long = report("Waiting for release (last: v1.2.3, 2026-03-01).", "\n### Progress\n" + "[██░░] Step\n".repeat(200));
  assert.ok(long.length > 1500, "the Blocked line is outside the tail");
  assert.equal(releaseWaitStated(long), true);
});

test("a release mentioned only far back in a plain reply doesn't count", () => {
  assert.equal(releaseWaitStated(`It ships in the next release.\n${"More detail. ".repeat(200)}`), false);
});

test("a report with no mention of a release ends the wait", () => {
  assert.equal(releaseWaitEnded(report("")), true);
  assert.equal(releaseWaitEnded(report("Waiting on Alex's review.")), true);
});

test("a report still waiting keeps the wait", () => {
  assert.equal(releaseWaitEnded(report("Waiting for release (last: v1.2.3, 2026-03-01).")), false);
  assert.equal(releaseWaitEnded(report("", "⏳ #12 Fix invoices · awaiting release")), false);
  assert.equal(releaseWaitEnded(report("", "✅ #12 merged, not released")), false);
});

test("a reply that isn't a report never ends a wait", () => {
  assert.equal(releaseWaitEnded("ok"), false);
  assert.equal(releaseWaitEnded("Done. Nothing else to do here."), false);
  assert.equal(releaseWaitEnded(""), false);
});
