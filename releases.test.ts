import assert from "node:assert/strict";
import { test } from "node:test";
import { RELEASE_WAIT } from "./release-wait.ts";

test("release waits are recognised", () => {
  for (const text of [
    "All the document-count fixes are now on dev. They reach customers with the next release.",
    "Squash-merged #10123 into dev. CI passed before merge. Not yet released to production.",
    "Where #1145 is: merged and deployed to dev, but not on `main`.",
    "Invite follow-up fix ████████░░ #10140 on dev, next release",
    "**Blocked:** waiting for release (last: v1.1.16, 2026-10-05)",
    "Once it's released, the nightly reconciliation will pick it up.",
  ]) {
    assert.ok(RELEASE_WAIT.test(text), text);
  }
});

test("unrelated text isn't", () => {
  assert.ok(!RELEASE_WAIT.test("Merged #9995 and closed T-10600. Everything is done."));
  assert.ok(!RELEASE_WAIT.test("Released v6.104.0 to production; all checks passed."));
});
