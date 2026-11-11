import assert from "node:assert/strict";
import { test } from "node:test";
import { approvePlan, planModels } from "./plan-model.ts";

type Call = [string, unknown];

function fakeSdk(options: { plan?: boolean; updateFails?: boolean; resolvesAfterPolls?: number } = {}) {
  const calls: Call[] = [];
  let polls = 0;
  const plan = {
    id: "pint_plan",
    status: "pending",
    payload: { kind: "approval", subject: { kind: "plan" } },
  };
  const command = {
    id: "pint_command",
    status: "pending",
    payload: { kind: "approval", subject: { kind: "command" } },
  };
  const sdk = {
    threads: {
      get: async (args: unknown) => {
        calls.push(["threads.get", args]);
        return { providerId: "acme-agent", projectId: "proj_1", environmentId: "env_1" };
      },
      defaultExecutionOptions: async () => ({ model: "acme-small" }),
      update: async (args: unknown) => {
        calls.push(["threads.update", args]);
        if (options.updateFails) throw new Error('Model "nope" is not available');
      },
      send: async (args: unknown) => {
        calls.push(["threads.send", args]);
      },
      interactions: {
        list: async () => (options.plan === false ? [command] : [command, plan]),
        get: async () => {
          polls += 1;
          return { ...plan, status: polls > (options.resolvesAfterPolls ?? 0) ? "resolved" : "resolving" };
        },
        resolve: async (args: unknown) => {
          calls.push(["interactions.resolve", args]);
        },
      },
    },
    system: {
      executionOptions: async (args: unknown) => {
        calls.push(["system.executionOptions", args]);
        return {
          modelLoadError: null,
          models: [
            { model: "acme-small", displayName: "Acme Small" },
            { model: "acme-large", displayName: "Acme Large" },
          ],
        };
      },
    },
  };
  return { sdk: sdk as never, calls };
}

const fast = { timeoutMs: 1_000, pollMs: 1 };

test("lists the thread provider's models while a plan waits", async () => {
  const { sdk, calls } = fakeSdk();
  assert.deepEqual(await planModels(sdk, "thr_1"), {
    pending: true,
    current: "acme-small",
    models: [
      { model: "acme-small", name: "Acme Small" },
      { model: "acme-large", name: "Acme Large" },
    ],
  });
  assert.deepEqual(calls.find(([name]) => name === "system.executionOptions")?.[1], {
    providerId: "acme-agent",
    environmentId: "env_1",
  });
});

test("reports nothing to offer when no plan waits", async () => {
  const { sdk } = fakeSdk({ plan: false });
  assert.deepEqual(await planModels(sdk, "thr_1"), { pending: false, current: null, models: [] });
});

test("sets the model, approves, then steers the turn on that model once the approval is delivered", async () => {
  const { sdk, calls } = fakeSdk({ resolvesAfterPolls: 3 });
  await approvePlan(sdk, { threadId: "thr_1", model: "acme-large" }, fast);
  const order = calls.map(([name]) => name).filter((name) => name !== "threads.get" && name !== "system.executionOptions");
  assert.deepEqual(order, ["threads.update", "interactions.resolve", "threads.send"]);
  assert.deepEqual(calls.find(([name]) => name === "threads.update")?.[1], { threadId: "thr_1", model: "acme-large" });
  assert.deepEqual(calls.find(([name]) => name === "interactions.resolve")?.[1], {
    threadId: "thr_1",
    interactionId: "pint_plan",
    resolution: { decision: "allow_once", grantedPermissions: null },
  });
  assert.deepEqual(calls.find(([name]) => name === "threads.send")?.[1], {
    threadId: "thr_1",
    mode: "steer-if-active",
    model: "acme-large",
    input: [{ type: "text", text: "Switched to Acme Large to implement the approved plan. Carry on.", mentions: [] }],
  });
});

test("approving on the current model only approves", async () => {
  const { sdk, calls } = fakeSdk();
  await approvePlan(sdk, { threadId: "thr_1", model: null }, fast);
  assert.deepEqual(
    calls.map(([name]) => name),
    ["interactions.resolve"],
  );
});

test("a model the provider doesn't offer fails before anything is approved", async () => {
  const { sdk, calls } = fakeSdk({ updateFails: true });
  await assert.rejects(approvePlan(sdk, { threadId: "thr_1", model: "nope" }, fast), /not available/);
  assert.ok(!calls.some(([name]) => name === "interactions.resolve" || name === "threads.send"));
});

test("refuses when no plan waits", async () => {
  const { sdk, calls } = fakeSdk({ plan: false });
  await assert.rejects(approvePlan(sdk, { threadId: "thr_1", model: "acme-large" }, fast), /No plan is waiting/);
  assert.deepEqual(calls, []);
});
