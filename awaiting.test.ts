import assert from "node:assert/strict";
import { test } from "node:test";
import { asksUser, promisesFollowUp, waitsOnOthers } from "./awaiting.ts";

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
  assert.ok(!asksUser("I'm waiting on the fresh review I requested, and will pick it up when it arrives."));
  assert.ok(!asksUser("**Blocked:** Waiting for release (last: v6.100.0)."));
  assert.ok(!asksUser("The open item is whether they need an AI block. If they say yes, that's new development."));
  assert.ok(!asksUser("The prod apply is running in the background. I'll report when it finishes."));
  assert.ok(!asksUser("Shipped in v0.2.15. If switching shows on v0.2.15 still misbehaves, tell me what you did and what went wrong."));
  assert.ok(!asksUser("Main's CI is blocked until #1113 merges.\n\nWhen #1113 is green, I'll:\n1. Merge it.\n2. Bring #1110 up to date and merge it.\n3. Run the first release train."));
  assert.ok(asksUser("If you place one on dev with a throwaway password, I'll check the admin side."));
});

test("follow-up promises are detected, asks win", () => {
  assert.ok(promisesFollowUp("The prod apply is running in the background: 51,600 documents. I'll report when it finishes."));
  assert.ok(promisesFollowUp("Firebase is still issuing its certificate. I'm checking every 30 seconds for up to 30 minutes and will tell you when it's live."));
  assert.ok(promisesFollowUp("Still waiting on that CI result; will report when it lands."));
  assert.ok(!promisesFollowUp("I'll report when it finishes. Should I also merge #12?"));
  assert.ok(!promisesFollowUp("Merged and deployed. Nothing left to do."));
});

test("waiting on someone else", () => {
  assert.ok(waitsOnOthers("On #1136 and #1137, Knut is now the only pending reviewer. Their approvals are on older commits."));
  assert.ok(waitsOnOthers("Løvenskiold stays cancelled.\n\nOnce he sends the invoices, I can check that Xledger numbered them."));
  assert.ok(waitsOnOthers("Everything planned for BOAS is done. The next step depends on Nikolai: which tenant users get access."));
  assert.ok(waitsOnOthers("CI passed. I'm waiting on the fresh review I requested, and will pick it up when it arrives."));
  assert.ok(waitsOnOthers("The two invoices now show as drafts in billing. Håkon can push them to Xledger from there."));
  assert.ok(waitsOnOthers("Sent the reminder to Martin on Friday; still no reply from him."));
  assert.ok(!waitsOnOthers("Waiting for CI on #1191; I'll merge when it's green."));
  assert.ok(waitsOnOthers("Once Håkon confirms, say \"go\" and I'll switch the setup."), "relaying his answer is waiting on him");
  assert.ok(waitsOnOthers("4. I apply the remaining eight pairs.\n\nTell me when he replies, or paste his answer here."));
  assert.ok(waitsOnOthers("> 1. Rebase the contract.\n> 2. Cancel 11506 if he agrees.\n>\n> Reply **go** with his answer and I'll do both."));
  assert.ok(!waitsOnOthers("Should I merge #12 now?"), "a real ask to you");
  assert.ok(!waitsOnOthers("Merged and deployed. Nothing left to do."));
  assert.ok(!waitsOnOthers("The job is scheduled. It will check the numbers every night."));
});
