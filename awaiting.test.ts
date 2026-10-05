import assert from "node:assert/strict";
import { test } from "node:test";
import { asksUser, promisesFollowUp } from "./awaiting.ts";

test("hands-off messages count as your move", () => {
  assert.ok(asksUser("I've reopened the decision board. Use \"Copy this instead\" and paste the text here."));
  assert.ok(asksUser("Both are ready. Reply **go** for all, or **go 1,3**."));
  assert.ok(asksUser("Want me to open the PR?"));
  assert.ok(asksUser("Complete any password prompts. Tell me whether the second command succeeds."));
  assert.ok(asksUser("Please name the exact Slack channel for the alerts."));
  assert.ok(asksUser("If you want, I can snooze this thread for 3 days."));
  assert.ok(asksUser('Once Håkon confirms, say "go" and I\'ll switch the setup.'));
  assert.ok(asksUser("Draft created in the Amesto thread. It remains unsent."));
  assert.ok(asksUser("Merging doesn't ship anything yet.\n\n1. Merge the three PRs now (recommended)\n2. Hold the merge\n3. You review first"));
  assert.ok(asksUser("Two things:\n> 1. **Check** the starts after login.\n> 2. **Clean up:** remove this worktree.\n\n*2026-10-04*"));
});

test("wrapped-up messages don't", () => {
  assert.ok(!asksUser("Merged #9995 into dev and closed T-10600. Everything in this thread is done."));
  assert.ok(!asksUser("All 16 checks passed and the PR is merged."));
  assert.ok(!asksUser("**Blocked:** Waiting for release (last: v6.100.0)."));
  assert.ok(!asksUser("The open item is whether they need an AI block. If they say yes, that's new development."));
  assert.ok(!asksUser("The prod apply is running in the background. I'll report when it finishes."));
});

test("follow-up promises are detected, asks win", () => {
  assert.ok(promisesFollowUp("The prod apply is running in the background: 51,600 documents. I'll report when it finishes."));
  assert.ok(promisesFollowUp("Firebase is still issuing its certificate. I'm checking every 30 seconds for up to 30 minutes and will tell you when it's live."));
  assert.ok(promisesFollowUp("Still waiting on that CI result; will report when it lands."));
  assert.ok(!promisesFollowUp("I'll report when it finishes. Should I also merge #12?"));
  assert.ok(!promisesFollowUp("Merged and deployed. Nothing left to do."));
});
