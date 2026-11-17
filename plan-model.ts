// Approve a plan and implement it on another model (the "Model choice on plan
// approval" setting). BB's plan card only approves on the model that wrote the
// plan, and a thread's model change normally waits for the next turn. Here the
// plan is approved, the thread's model is set, and the running turn is steered
// with the chosen model: a steer switches the live session's model, so the
// implementation itself runs on it. Works for any provider whose plans need
// approval, with that provider's own models.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Sdk = Pick<BbPluginApi["sdk"], "threads" | "system">;
type Interaction = Awaited<ReturnType<Sdk["threads"]["interactions"]["get"]>>;

export interface PlanModelOption {
  model: string;
  name: string;
}

export interface PlanModels {
  /** A plan on this thread is waiting for approval. */
  pending: boolean;
  /** The model the thread is on now, when known. */
  current: string | null;
  /** Models offered by the thread's provider; empty when they can't be listed. */
  models: PlanModelOption[];
}

export function pendingPlan(interactions: readonly Interaction[]): Interaction | undefined {
  return interactions.find(
    (interaction) =>
      interaction.status === "pending" &&
      interaction.payload.kind === "approval" &&
      interaction.payload.subject.kind === "plan",
  );
}

export async function planModels(sdk: Sdk, threadId: string): Promise<PlanModels> {
  const interactions = await sdk.threads.interactions.list({ threadId });
  if (!pendingPlan(interactions)) return { pending: false, current: null, models: [] };
  return { pending: true, ...(await threadModels(sdk, threadId)) };
}

async function threadModels(sdk: Sdk, threadId: string): Promise<Omit<PlanModels, "pending">> {
  const thread = await sdk.threads.get({ threadId });
  const [options, defaults] = await Promise.all([
    sdk.system
      // The environment when there is one, else the project: bb lists no
      // models when given both.
      .executionOptions(
        thread.environmentId
          ? { providerId: thread.providerId, environmentId: thread.environmentId }
          : { providerId: thread.providerId, projectId: thread.projectId },
      )
      .catch(() => null),
    sdk.threads.defaultExecutionOptions({ threadId }).catch(() => null),
  ]);
  const models =
    options && options.modelLoadError === null
      ? options.models.map((model) => ({ model: model.model, name: model.displayName || model.model }))
      : [];
  return { current: defaults?.model ?? null, models };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until bb has delivered the approval, so the steer isn't held behind it. */
async function settled(sdk: Sdk, threadId: string, interactionId: string, timeoutMs: number, pollMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await sdk.threads.interactions.get({ threadId, interactionId }).catch(() => null);
    if (current && current.status !== "pending" && current.status !== "resolving") return;
    await sleep(pollMs);
  }
}

export async function approvePlan(
  sdk: Sdk,
  args: { threadId: string; model: string | null },
  timing: { timeoutMs: number; pollMs: number } = { timeoutMs: 15_000, pollMs: 250 },
): Promise<void> {
  const { threadId, model } = args;
  const plan = pendingPlan(await sdk.threads.interactions.list({ threadId }));
  if (!plan) throw new Error("No plan is waiting for approval on this thread.");
  const name =
    model === null ? null : ((await threadModels(sdk, threadId)).models.find((option) => option.model === model)?.name ?? model);
  // Set first: bb checks the model against the provider's catalog, so a bad
  // choice fails before anything is approved. It also keeps the model for
  // later turns, and the composer follows it.
  if (model !== null) await sdk.threads.update({ threadId, model });
  await sdk.threads.interactions.resolve({
    threadId,
    interactionId: plan.id,
    resolution: { decision: "allow_once", grantedPermissions: null },
  });
  if (model === null) return;
  await settled(sdk, threadId, plan.id, timing.timeoutMs, timing.pollMs);
  await sdk.threads.send({
    threadId,
    mode: "steer-if-active",
    model,
    input: [
      { type: "text", text: `Switched to ${name} to implement the approved plan. Carry on.`, mentions: [] },
    ],
  });
}
