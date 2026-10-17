import type {
  ComposerSelection,
  PluginComposerScope,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { Provider, Snapshot } from "./contract";
import { accountStatus, remaining, STATUS_LABEL } from "./model";

export function lifeboatProvider(providerId?: string): Provider | null {
  return providerId === "claude-code"
    ? "claude"
    : providerId === "codex"
      ? "codex"
      : null;
}
export function composerTarget(
  scope: PluginComposerScope,
  selection: ComposerSelection | null,
  threads: readonly PluginSidebarThread[],
) {
  const thread =
    scope.kind === "new-thread"
      ? undefined
      : threads.find((thread) => thread.id === scope.threadId);
  const provider = lifeboatProvider(
    selection?.providerId ?? thread?.providerId,
  );
  if (scope.kind !== "new-thread")
    return { provider, hostId: thread?.host?.id ?? null };
  const environment = selection?.environment;
  let hostId: string | null = null;
  if (environment?.type === "host") hostId = environment.hostId ?? null;
  if (
    environment?.type === "provider" &&
    environment.machine?.type === "existing"
  )
    hostId = environment.machine.hostId;
  if (environment?.type === "reuse")
    hostId =
      threads.find(
        (thread) => thread.environment?.id === environment.environmentId,
      )?.host?.id ?? null;
  // A project default/new machine has no resolved host here. Never borrow a
  // different Mac's account numbers while the composer resolves its selection.
  return { provider, hostId };
}
export function capacitySummary(
  snapshot: Snapshot | null,
  provider: Provider,
  now: number,
  unavailable = false,
) {
  const active =
    snapshot?.accounts.filter(
      (account) => account.provider === provider && account.isActive,
    ) ?? [];
  const account = active.length === 1 ? active[0] : null;
  const status = account
    ? accountStatus(account, now, snapshot?.issues[account.id])
    : "unknown";
  const trusted =
    !unavailable &&
    (status === "ready" || status === "near-limit" || status === "limited");
  const value = account && trusted ? remaining(account) : null;
  return {
    account,
    status,
    value,
    text: unavailable
      ? "Unavailable"
      : value !== null
        ? `${Math.round(value)}% left`
        : account
          ? STATUS_LABEL[status]
          : "Confirm CLI login",
  };
}
