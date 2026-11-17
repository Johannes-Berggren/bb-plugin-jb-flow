// Approve a plan and implement it on another model (the "Model choice on plan
// approval" setting). BB's plan card only approves on the model that wrote the
// plan, and a thread's model change normally waits for the next turn. An
// approved plan runs in the same turn, so the live session's model has to be
// switched by a steer, the only bb call that changes it mid-turn.
//
// The steer is sent before the approval. While the plan waits, bb can't take a
// prompt, so it queues the steer (waiting on the interaction) and sends it into
// the running turn itself the moment the approval is delivered. That lands the
// switch as early as bb allows, with no polling, and while the turn is still
// running, so it joins that turn instead of starting a new one. BB has no way
// to approve and switch in one step, so the first request after the approval
// may still go out on the planning model.
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

export async function approvePlan(sdk: Sdk, args: { threadId: string; model: string | null }): Promise<void> {
  const { threadId, model } = args;
  const plan = pendingPlan(await sdk.threads.interactions.list({ threadId }));
  if (!plan) throw new Error("No plan is waiting for approval on this thread.");
  const approve = () =>
    sdk.threads.interactions.resolve({
      threadId,
      interactionId: plan.id,
      resolution: { decision: "allow_once", grantedPermissions: null },
    });
  if (model === null) {
    await approve();
    return;
  }
  const name = (await threadModels(sdk, threadId)).models.find((option) => option.model === model)?.name ?? model;
  // Set first: bb checks the model against the provider's catalog, so a bad
  // choice fails before anything is sent or approved. It also keeps the model
  // for later turns, and the composer follows it.
  await sdk.threads.update({ threadId, model });
  // Steer while the plan still waits: bb queues it and delivers it into this
  // turn as soon as the approval goes through (see the header).
  const steer = await sdk.threads.send({
    threadId,
    mode: "steer-if-active",
    model,
    input: [
      { type: "text", text: `Switched to ${name} to implement the approved plan. Carry on.`, mentions: [] },
    ],
  });
  try {
    await approve();
  } catch (cause) {
    // Not approved: drop the held steer, or bb would send it once the plan is
    // settled some other way, possibly as a new turn.
    if (steer.delivery === "queued") {
      await sdk.threads.queuedMessages
        .delete({ threadId, queuedMessageId: steer.queuedMessage.id })
        .catch(() => undefined);
    }
    throw cause;
  }
}
