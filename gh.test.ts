import assert from "node:assert/strict";
import { test } from "node:test";
import { ghError, GH_MISSING, isTransient, withRetries, type GhError } from "./gh.ts";
import { onBatchFailure } from "./prs.ts";

const execError = (message: string, fields: Record<string, unknown> = {}) => Object.assign(new Error(message), fields);
const noWait = async () => undefined;

test("GitHub 5xx, network blips and our own timeouts are transient", () => {
  assert.equal(isTransient(execError("Command failed"), "gh: HTTP 502\n"), true);
  assert.equal(isTransient(execError("Command failed"), "HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)"), true);
  assert.equal(isTransient(execError("read ECONNRESET"), ""), true);
  assert.equal(isTransient(execError("Command failed", { killed: true, signal: "SIGTERM" }), ""), true);
});

test("auth, permission and not-found errors are not transient", () => {
  assert.equal(isTransient(execError("Command failed"), "HTTP 401: Bad credentials"), false);
  assert.equal(isTransient(execError("Command failed"), "GraphQL: Could not resolve to a Repository with the name 'acme/gone'."), false);
  assert.equal(isTransient(execError("Command failed"), "HTTP 404: Not Found"), false);
});

test("ghError marks transient and aborted failures, and explains a missing gh", () => {
  assert.equal(ghError("gh", execError("x"), "gh: HTTP 502", 400).transient, true);
  assert.equal(ghError("gh", execError("x", { name: "AbortError", code: "ABORT_ERR" }), "", 400).aborted, true);
  assert.equal(ghError("gh", execError("spawn gh ENOENT", { code: "ENOENT" }), "", 400).message, GH_MISSING);
});

test("a transient failure is retried, then succeeds", async () => {
  let calls = 0;
  const result = await withRetries(
    async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("gh: HTTP 502"), { transient: true });
      return "ok";
    },
    { wait: noWait },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("retries stop after the limit, and permanent failures aren't retried", async () => {
  let calls = 0;
  await assert.rejects(
    withRetries(
      async () => {
        calls += 1;
        throw Object.assign(new Error("gh: HTTP 504"), { transient: true });
      },
      { retries: 2, wait: noWait },
    ),
    /HTTP 504/,
  );
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(
    withRetries(
      async () => {
        calls += 1;
        throw new Error("HTTP 401: Bad credentials");
      },
      { wait: noWait },
    ),
  );
  assert.equal(calls, 1);
});

test("an aborted signal stops before the next attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    withRetries(
      async () => {
        calls += 1;
        controller.abort();
        throw Object.assign(new Error("gh: HTTP 502"), { transient: true });
      },
      { signal: controller.signal, wait: noWait },
    ),
    (error: GhError) => error.aborted === true,
  );
  assert.equal(calls, 1);
});

test("a GitHub outage stops a PR refresh instead of asking repo by repo", () => {
  assert.equal(onBatchFailure(Object.assign(new Error("gh graphql: HTTP 502"), { transient: true })), "stop");
  assert.equal(onBatchFailure(Object.assign(new Error("gh: aborted"), { aborted: true })), "stop");
  assert.equal(onBatchFailure(new Error(GH_MISSING)), "stop");
  assert.equal(onBatchFailure(new Error("gh graphql: HTTP 401: Bad credentials")), "stop");
  assert.equal(onBatchFailure(new Error("gh graphql: Could not resolve to a Repository with the name 'acme/gone'.")), "split");
});
