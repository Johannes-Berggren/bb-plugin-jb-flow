import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

/**
 * You've already answered: a message you sent waits in the thread's queue (behind
 * a running turn, or held by a concurrency limit). The ask is no longer on you.
 */
export const replyQueued = (thread: { queuedWork?: string }) => thread.queuedWork === "waiting";

/**
 * Blocked on you (prompt, permission, failure), or finished unread with a last
 * message that asks you something. Unread status updates don't count: they stay
 * in their section, in bold.
 */
export function needsMe(
  thread: Pick<PluginSidebarThread, "id" | "hasPendingInteraction" | "indicator" | "isUnread" | "status"> & { queuedWork?: string },
  awaiting: Record<string, number> | undefined,
): boolean {
  return (
    thread.hasPendingInteraction ||
    thread.indicator === "waiting-for-input" ||
    thread.indicator === "unread-error" ||
    (thread.isUnread && thread.status === "idle" && awaiting?.[thread.id] !== undefined && !replyQueued(thread))
  );
}
