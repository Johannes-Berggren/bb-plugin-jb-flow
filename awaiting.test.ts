import assert from "node:assert/strict";
import { test } from "node:test";
import { asksUser } from "./awaiting.ts";

test("hands-off messages count as your move", () => {
  assert.ok(asksUser("I've reopened the decision board. Use \"Copy this instead\" and paste the text here."));
  assert.ok(asksUser("Both are ready. Reply **go** for all, or **go 1,3**."));
  assert.ok(asksUser("Want me to open the PR?"));
  assert.ok(asksUser("**Blocked:** Waiting for release (last: v6.100.0)."));
});

test("wrapped-up messages don't", () => {
  assert.ok(!asksUser("Merged #9995 into dev and closed T-10600. Everything in this thread is done."));
  assert.ok(!asksUser("All 16 checks passed and the PR is merged."));
});
