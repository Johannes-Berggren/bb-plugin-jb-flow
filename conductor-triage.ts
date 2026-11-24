import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { asksUser } from "./awaiting.ts";
import { mergeIntent } from "./autopilot.ts";
import type { TriageGroup } from "./conductor-model.ts";
import type { BallState, NowFlow } from "./now-model.ts";
import type { PrStatus } from "./prs";
import type { ListedThread } from "./thread-cache";
import type { StatusReport, ThreadStatus } from "./thread-status.ts";

export const threadTitle = (thread: ListedThread) => thread.title ?? thread.titleFallback ?? thread.id;
export const openPrs = (prs: readonly PrStatus[]) => prs.filter((pr) => pr.state === "open" || pr.state === "draft");

export function currentReport(status: ThreadStatus | null): StatusReport | null {
  const report = status?.report;
  return report && report.capturedAt === status.latestAt ? report : null;
}

export function reportedBlocker(report: StatusReport | null): string | null {
  const blocked = report?.blocked.trim();
  return blocked && !/^(?:none|nothing|no|n\/?a|-)\.?$/i.test(blocked) ? blocked : null;
}

const COMPLETED = /^(?:nothing (?:pending|left|else|more|to do)|no (?:next steps?|further steps?|follow-?ups?)|all done)(?: (?:on my side|after that))?[.!]?$/i;

export function reportsCompletion(report: StatusReport | null, reply: string, afterMerge = false): boolean {
  const next = report?.next ?? /^\s*(?:[-*]\s+)?\*{0,2}Next:\*{0,2}\s*(.+)$/im.exec(reply)?.[1];
  const [first, ...rest] = (next ?? "").trim().split(/\s*[;.]\s+(?=\S)/);
  const completed = COMPLETED.test(first ?? "") && rest.every((line) => COMPLETED.test(line)) ||
    afterMerge && rest.length === 1 && mergeIntent(first) && COMPLETED.test(rest[0]!);
  return completed && !reportedBlocker(report) && !report?.doingNow && !report?.steps?.items.length &&
    !asksUser(reply) && !/(?:\?\s*$|\bif you(?:['’]d)? (?:want|like|prefer)\b)/i.test(reply.slice(-900));
}

export function isSnoozed(thread: ListedThread, byId: ReadonlyMap<string, ListedThread>, sectionId: string | null): boolean {
  if (sectionId === null) return false;
  const seen = new Set<string>();
  for (let current: ListedThread | undefined = thread; current && !seen.has(current.id); current = byId.get(current.parentThreadId ?? "")) {
    if (current.sectionId === sectionId) return true;
    seen.add(current.id);
  }
  return false;
}

export function hasActiveWork(thread: ListedThread): boolean {
  return ["active", "starting", "stopping", "pending"].includes(thread.status) ||
    ["active", "starting", "stopping", "pending", "provisioning", "waiting-for-host"].includes(thread.runtime.displayStatus) ||
    Object.values(thread.activity).some((count) => count > 0);
}

export function archiveHold(thread: ListedThread, flow: NowFlow, snoozed: boolean, prs: readonly PrStatus[]): string | null {
  const id = thread.id;
  if (hasActiveWork(thread) || thread.queuedWork !== "none") return "has active or queued work";
  if (thread.hasPendingInteraction || thread.status === "error") return "needs input or has a failed turn";
  if (prs.length > 0) return "has an open PR";
  if (snoozed || id in flow.watching || id in flow.waitingOthers) return "is waiting for a follow-up";
  if (id in flow.awaiting || id in flow.readyToGo || id in flow.promised) return "has a pending next step";
  if (thread.pinnedAt !== null || id in flow.focused || id in flow.due) return "is pinned, in Focus, or has a deadline";
  return null;
}

export function triageGroup(ball: BallState, thread: ListedThread, snoozed: boolean, status: ThreadStatus | null, hold: string | null): TriageGroup {
  if (thread.hasPendingInteraction) return "needs-you";
  if (thread.queuedWork === "failed" || ball === "blocked" || ball === "stalled") return "stuck";
  if (ball === "running" || hasActiveWork(thread)) return "running";
  if (snoozed || ball === "watched" || ball === "others") return "waiting";
  if (ball === "yours" || ball === "go" || ball === "pr") return "needs-you";
  const report = currentReport(status);
  if (reportedBlocker(report)) return "stuck";
  return !hold && report && reportsCompletion(report, status?.latest ?? "") ? "archive-candidate" : "open";
}

/** The same relationships BB follows when archiving, including hidden forks and dependents. */
export function archiveTrees(threads: readonly ListedThread[]): (root: ListedThread) => ListedThread[] {
  const children = new Map<string, ListedThread[]>();
  for (const thread of threads) {
    if (thread.deletedAt !== null) continue;
    for (const parent of new Set([thread.parentThreadId, thread.lifecycleOwnerThreadId, thread.visibility === "hidden" ? thread.sourceThreadId : null])) {
      if (parent === null) continue;
      const siblings = children.get(parent);
      if (siblings) siblings.push(thread);
      else children.set(parent, [thread]);
    }
  }
  return (root) => {
    const seen = new Set<string>();
    const pending = [root];
    const live: ListedThread[] = [];
    for (const thread of pending) {
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      if (thread.archivedAt === null) live.push(thread);
      for (const child of children.get(thread.id) ?? []) pending.push(child);
    }
    return live;
  };
}

const gitStatus = z.object({
  outcome: z.string(),
  workspace: z.object({ workingTree: z.object({ hasUncommittedChanges: z.boolean() }) }).optional(),
});

/** A managed workspace can be removed once its last live thread is archived. */
export async function workspaceArchiveHold(bb: BbPluginApi, environmentId: string): Promise<string | null> {
  try {
    const environment = await bb.sdk.environments.get({ environmentId });
    if (!environment.managed || environment.workspaceProvisionType === "unmanaged") return null;
    if (environment.status !== "ready" || environment.lifecycle.phase !== "active") return "its workspace is unavailable";
    if (environment.isGitRepo) {
      const status = await bb.sdk.plugins.callRpc({ pluginId: "bb--git", method: "workspaceStatus", input: { environmentId }, outputSchema: gitStatus });
      if (status.outcome !== "available" || !status.workspace) return "its Git workspace could not be checked";
      return status.workspace.workingTree.hasUncommittedChanges ? "its workspace has uncommitted changes" : null;
    }
    if (!environment.path) return "its managed folder could not be checked";
    const { paths, truncated } = await bb.sdk.files.listPaths({
      hostId: environment.hostId, path: environment.path, limit: 1,
      includeHidden: true, includeFiles: true, includeDirectories: true,
    });
    return paths.length > 0 || truncated ? "its managed folder still contains files or directories" : null;
  } catch {
    return "its workspace could not be checked";
  }
}
