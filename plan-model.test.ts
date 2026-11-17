import assert from "node:assert/strict";
import { test } from "node:test";
import { approvePlan, planModels } from "./plan-model.ts";

type Call = [string, unknown];

interface FakeOptions {
  plan?: boolean;
  updateFails?: boolean;
  resolveFails?: boolean;
  /** How bb answers the steer: held behind the waiting plan, or sent at once. */
  delivery?: "queued" | "sent";
}

function fakeSdk(options: FakeOptions = {}) {
  const calls: Call[] = [];
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
  /** The plan's status each time a message was sent. */
  const planStatusAtSend: string[] = [];
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
        planStatusAtSend.push(plan.status);
        return options.delivery === "sent"
          ? { ok: true, delivery: "sent" }
          : { ok: true, delivery: "queued", queuedMessage: { id: "qmsg_steer", waitingOn: { kind: "interaction" } } };
      },
      queuedMessages: {
        delete: async (args: unknown) => {
          calls.push(["queuedMessages.delete", args]);
        },
      },
      interactions: {
        list: async () => (options.plan === false ? [command] : [command, plan]),
        get: async (args: unknown) => {
          calls.push(["interactions.get", args]);
          return plan;
        },
        resolve: async (args: unknown) => {
          calls.push(["interactions.resolve", args]);
          if (options.resolveFails) throw new Error("Pending interaction not found");
          plan.status = "resolving";
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
  return { sdk: sdk as never, calls, planStatusAtSend };
}

const writes = (calls: Call[]) =>
  calls.map(([name]) => name).filter((name) => name !== "threads.get" && name !== "system.executionOptions");

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

test("sets the model, steers while the plan still waits, then approves", async () => {
  const { sdk, calls, planStatusAtSend } = fakeSdk();
  await approvePlan(sdk, { threadId: "thr_1", model: "acme-large" });
  // The steer goes out before the approval, so bb holds it behind the plan and
  // delivers it into the running turn as the approval lands. Nothing is sent
  // after the approval, so an idle thread can't get a turn from it.
  assert.deepEqual(writes(calls), ["threads.update", "threads.send", "interactions.resolve"]);
  assert.deepEqual(planStatusAtSend, ["pending"]);
  assert.deepEqual(calls.find(([name]) => name === "threads.update")?.[1], { threadId: "thr_1", model: "acme-large" });
  assert.deepEqual(calls.find(([name]) => name === "threads.send")?.[1], {
    threadId: "thr_1",
    mode: "steer-if-active",
    model: "acme-large",
    input: [{ type: "text", text: "Switched to Acme Large to implement the approved plan. Carry on.", mentions: [] }],
  });
  assert.deepEqual(calls.find(([name]) => name === "interactions.resolve")?.[1], {
    threadId: "thr_1",
    interactionId: "pint_plan",
    resolution: { decision: "allow_once", grantedPermissions: null },
  });
});

test("doesn't wait for the approval to be delivered", async () => {
  const { sdk, calls } = fakeSdk();
  await approvePlan(sdk, { threadId: "thr_1", model: "acme-large" });
  assert.ok(!calls.some(([name]) => name === "interactions.get"));
});

test("an approval that fails drops the held steer, so it can't start a turn later", async () => {
  const { sdk, calls } = fakeSdk({ resolveFails: true });
  await assert.rejects(approvePlan(sdk, { threadId: "thr_1", model: "acme-large" }), /not found/);
  assert.deepEqual(writes(calls), ["threads.update", "threads.send", "interactions.resolve", "queuedMessages.delete"]);
  assert.deepEqual(calls.find(([name]) => name === "queuedMessages.delete")?.[1], {
    threadId: "thr_1",
    queuedMessageId: "qmsg_steer",
  });
});

test("a failed approval leaves a steer bb already sent alone", async () => {
  const { sdk, calls } = fakeSdk({ resolveFails: true, delivery: "sent" });
  await assert.rejects(approvePlan(sdk, { threadId: "thr_1", model: "acme-large" }), /not found/);
  assert.ok(!calls.some(([name]) => name === "queuedMessages.delete"));
});

test("approving on the current model only approves", async () => {
  const { sdk, calls } = fakeSdk();
  await approvePlan(sdk, { threadId: "thr_1", model: null });
  assert.deepEqual(
    calls.map(([name]) => name),
    ["interactions.resolve"],
  );
});

test("a model the provider doesn't offer fails before anything is sent or approved", async () => {
  const { sdk, calls } = fakeSdk({ updateFails: true });
  await assert.rejects(approvePlan(sdk, { threadId: "thr_1", model: "nope" }), /not available/);
  assert.ok(!calls.some(([name]) => name === "interactions.resolve" || name === "threads.send"));
});

test("refuses when no plan waits", async () => {
  const { sdk, calls } = fakeSdk({ plan: false });
  await assert.rejects(approvePlan(sdk, { threadId: "thr_1", model: "acme-large" }), /No plan is waiting/);
  assert.deepEqual(calls, []);
});
