// The Conductor: one permanent, hidden agent thread per workspace that takes
// its workers' routine news (CI green, merges, releases, finished turns),
// does the routine steps itself and leaves the user one briefing.
//
// - Routed news lands in the conductor's inbox (conductor-store.ts), and a
//   minute schedule wakes the conductor with a batch once it's idle.
// - Its tools are offered to conductor threads only, and act only on threads
//   in the conductor's own workspace.
// - It's permanent: archiving it brings it back, and a deleted one is
//   respawned at the next wake-up, with its standing preferences.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { handBack } from "./awaiting.ts";
import { isGoneError } from "./ci-watch.ts";
import { gh as runGh } from "./gh.ts";
import {
  BRIEFING_KINDS,
  CONDUCTOR_ROLE,
  MEMORY_MAX,
  bootPrompt,
  briefingItemSchema,
  compactToday,
  conductorInstructions,
  conductorRecordSchema,
  failedRunIds,
  handBackEvent,
  mergeFlag,
  relayText,
  wakeDue,
  wakeMessage,
  type Briefing,
  type ConductorRecord,
} from "./conductor-model.ts";
import type { ConductorInboxEvent, ConductorSink } from "./conductor-routing.ts";
import type { ConductorStore, StoredConductorEvent } from "./conductor-store.ts";
import { ballState, reasonLabel, serverNowThread, type NowFlow } from "./now-model.ts";
import type { PrStatus } from "./prs";
import { parseStatusReport, type ThreadStatus } from "./thread-status.ts";
import { workspaceForThread, type WorkspaceState } from "./workspaces.ts";

type ListedThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
type ConfigureContext = Parameters<Parameters<BbPluginApi["agents"]["configure"]>[0]>[0];

export const CONDUCTOR_TOOLS = [
  "conductor_inbox",
  "fleet_status",
  "thread_brief",
  "merge_pr",
  "rerun_failed",
  "forward_to_thread",
  "thread_action",
  "post_briefing",
  "conductor_memory",
] as const;

/** Inbox kinds that describe a worker's turn; stale once the user has read the thread or it runs again. */
const HAND_BACK_KINDS = new Set(["needs-you", "ready", "finished", "input", "turn-failed"]);
const BUSY = new Set(["active", "starting", "stopping", "pending"]);
/** Inbox events and log entries older than this are forgotten. */
export const CONDUCTOR_RETENTION_MS = 14 * 24 * 3_600_000;

export type ConductorOptions = { enabled: boolean; batchMinutes: number; prompt: string };

export type ConductorDeps = {
  store: ConductorStore;
  /** The plugin settings, read synchronously (configure can't wait). */
  options: () => ConductorOptions;
  workspaces: () => Promise<WorkspaceState>;
  assignWorkspace: (threadId: string, workspaceId: string) => Promise<void>;
  /** Live, visible threads (cached briefly). */
  listThreads: () => Promise<ListedThread[]>;
  flow: () => Promise<NowFlow>;
  snoozedSection: () => Promise<string | null>;
  threadStatus: (threadId: string) => Promise<ThreadStatus | null>;
  prsByThread: () => Promise<Record<string, PrStatus[]>>;
  snooze: (threadId: string, when: string, note: string | null) => Promise<{ until: number }>;
  unsnooze: (threadId: string) => Promise<boolean>;
  archive: (threadIds: string[]) => Promise<{ archived: number; failed: string[] }>;
  focus: (threadId: string, focused: boolean) => Promise<boolean>;
  changed: () => void;
  gh?: (args: string[], timeout?: number) => Promise<string>;
  now?: () => number;
};

const RECORDS_KEY = "conductors";
const briefingKey = (workspaceId: string) => `conductorBriefing:${workspaceId}`;
const memoryKey = (workspaceId: string) => `conductorMemory:${workspaceId}`;
const RERUNS_KEY = "conductorReruns";

export async function createConductor(bb: BbPluginApi, deps: ConductorDeps) {
  const kv = bb.storage.kv;
  const now = deps.now ?? (() => Date.now());
  const gh = deps.gh ?? ((args: string[], timeout = 60_000) => runGh(args, { timeout }));

  // --- records --------------------------------------------------------------
  // In memory as well as in kv: configure() answers synchronously.
  const records: Record<string, ConductorRecord> = {};
  const byThread = new Map<string, string>();
  const names = new Map<string, string>();
  const memories = new Map<string, string>();
  const stored = z.record(z.string(), conductorRecordSchema).safeParse((await kv.get(RECORDS_KEY)) ?? {});
  Object.assign(records, stored.success ? stored.data : {});
  for (const [workspaceId, record] of Object.entries(records)) {
    if (record.threadId) byThread.set(record.threadId, workspaceId);
    memories.set(workspaceId, (await kv.get<string>(memoryKey(workspaceId))) ?? "");
  }
  await refreshNames().catch((error) => bb.log.warn(`conductor names: ${String(error)}`));

  let saving: Promise<unknown> = Promise.resolve();
  function save(): Promise<void> {
    const run = saving.then(() => kv.set(RECORDS_KEY, records));
    saving = run.catch(() => undefined);
    return run;
  }
  async function refreshNames() {
    for (const workspace of (await deps.workspaces()).workspaces) names.set(workspace.id, workspace.name);
  }
  const log = (workspaceId: string, kind: string, threadId: string | null, text: string) => {
    try {
      deps.store.log(workspaceId, kind, threadId, text, now());
    } catch (error) {
      bb.log.warn(`conductor log: ${String(error)}`);
    }
  };
  const active = (workspaceId: string) => deps.options().enabled && records[workspaceId]?.enabled === true;

  // --- which threads -------------------------------------------------------

  function conductorWorkspace(threadId: string): string | null {
    const workspaceId = byThread.get(threadId);
    return workspaceId !== undefined && active(workspaceId) ? workspaceId : null;
  }

  /** The workspace a (worker) thread belongs to, by the same rules as the tabs. */
  async function workspaceOf(threadId: string): Promise<string | null> {
    const threads = await deps.listThreads();
    const thread = threads.find((candidate) => candidate.id === threadId) ?? (await bb.sdk.threads.get({ threadId }));
    return workspaceForThread(thread, await deps.workspaces(), threads);
  }

  /** The workspace whose conductor hears this thread's routine news, or null. */
  async function workspaceFor(threadId: string): Promise<string | null> {
    if (!deps.options().enabled || byThread.has(threadId)) return null;
    if (!Object.values(records).some((record) => record.enabled && record.threadId !== null)) return null;
    const workspaceId = await workspaceOf(threadId);
    return workspaceId !== null && active(workspaceId) && records[workspaceId]!.threadId !== null ? workspaceId : null;
  }

  const sink: ConductorSink = {
    workspaceFor,
    deliver: async (threadId, workspaceId, events) => {
      deps.store.add(workspaceId, threadId, events, now());
    },
  };

  // --- lifecycle -------------------------------------------------------------

  async function spawn(workspaceId: string): Promise<string> {
    const record = records[workspaceId]!;
    const workspace = (await deps.workspaces()).workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} no longer exists.`);
    const projectId = record.projectId ?? workspace.projectIds[0] ?? (await bb.sdk.projects.list())[0]?.id;
    if (!projectId) throw new Error("Add a project to this workspace first; the conductor lives in one.");
    const memory = memories.get(workspaceId) ?? "";
    const base = {
      projectId,
      title: `Conductor · ${workspace.name}`,
      visibility: "hidden" as const,
      pluginMetadata: { role: CONDUCTOR_ROLE, workspaceId },
      prompt: bootPrompt(workspace.name) + (memory ? " Your standing preferences are in your instructions." : ""),
      // Its first turn waits a moment, so its id is known here before bb asks which tools it gets.
      sendAt: now() + 3_000,
      ...(record.providerId ? { providerId: record.providerId } : {}),
      ...(record.model ? { model: record.model } : {}),
    };
    let thread: { id: string };
    try {
      // A scratch folder of its own: a conductor has no code to check out.
      thread = await bb.sdk.threads.spawn({ ...base, environment: { type: "host", workspace: { type: "personal" } } });
    } catch (error) {
      bb.log.warn(`conductor ${workspaceId}: personal folder refused (${String(error)}); using the project's default`);
      thread = await bb.sdk.threads.spawn({ ...base, environment: { type: "project-default" } });
    }
    if (record.threadId) byThread.delete(record.threadId);
    byThread.set(thread.id, workspaceId);
    records[workspaceId] = { ...record, threadId: thread.id, createdAt: now() };
    delete records[workspaceId]!.lastWakeAt;
    await save();
    await deps.assignWorkspace(thread.id, workspaceId).catch((error) => bb.log.warn(`conductor assign: ${String(error)}`));
    log(workspaceId, "started", thread.id, `Conductor started in ${workspace.name}.`);
    deps.changed();
    return thread.id;
  }

  /** The conductor's thread, brought back from the archive or respawned if it's gone. */
  async function ensure(workspaceId: string): Promise<string> {
    const threadId = records[workspaceId]?.threadId ?? null;
    if (threadId === null) return spawn(workspaceId);
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.deletedAt !== null) return spawn(workspaceId);
      if (thread.archivedAt !== null) {
        await bb.sdk.threads.unarchive({ threadId });
        log(workspaceId, "restored", threadId, "Brought the conductor back from the archive.");
      }
      return threadId;
    } catch (error) {
      if (isGoneError(error)) return spawn(workspaceId);
      throw error;
    }
  }

  async function start(workspaceId: string, options: { projectId?: string; providerId?: string; model?: string } = {}) {
    if (!deps.options().enabled) throw new Error("Turn on Conductor in the JB Flow settings first.");
    const workspace = (await deps.workspaces()).workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error(`No workspace ${workspaceId}.`);
    names.set(workspaceId, workspace.name);
    const previous = records[workspaceId];
    records[workspaceId] = {
      ...(previous ?? { threadId: null }),
      enabled: true,
      ...Object.fromEntries(Object.entries(options).filter(([, value]) => value)),
    };
    await save();
    const threadId = await ensure(workspaceId);
    deps.changed();
    return { workspaceId, threadId };
  }

  /** Stops routing and waking. The thread stays, so starting again carries on where it left off. */
  async function stop(workspaceId: string) {
    const record = records[workspaceId];
    if (!record) return false;
    records[workspaceId] = { ...record, enabled: false };
    await save();
    log(workspaceId, "stopped", record.threadId, "Conductor stopped; workers hear their own news again.");
    deps.changed();
    return true;
  }

  bb.events.on("thread.archived", async ({ thread }) => {
    const workspaceId = conductorWorkspace(thread.id);
    if (workspaceId === null) return;
    await bb.sdk.threads
      .unarchive({ threadId: thread.id })
      .then(() => log(workspaceId, "restored", thread.id, "The conductor is permanent; it was brought back from the archive."))
      .catch((error) => bb.log.warn(`conductor unarchive: ${String(error)}`));
  });
  bb.events.on("thread.deleted", async ({ thread }) => {
    const workspaceId = byThread.get(thread.id);
    if (workspaceId === undefined) return;
    byThread.delete(thread.id);
    records[workspaceId] = { ...records[workspaceId]!, threadId: null };
    await save();
    log(workspaceId, "deleted", thread.id, "The conductor's thread was deleted; a new one starts at the next wake-up.");
  });

  // --- hand-backs ------------------------------------------------------------

  async function addHandBack(threadId: string, event: ConductorInboxEvent | null) {
    if (event === null) return;
    const workspaceId = await workspaceFor(threadId).catch(() => null);
    if (workspaceId !== null) deps.store.add(workspaceId, threadId, [event], now());
  }
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    if (byThread.has(thread.id) || thread.parentThreadId !== null || thread.visibility !== "visible" || !lastAssistantText) return;
    const report = parseStatusReport(lastAssistantText, 0);
    await addHandBack(thread.id, handBackEvent(handBack(lastAssistantText), lastAssistantText, report));
  });
  bb.events.on("interaction.pending", async ({ thread }) => {
    if (byThread.has(thread.id) || thread.parentThreadId !== null || thread.visibility !== "visible") return;
    await addHandBack(thread.id, { kind: "input", text: "Waiting for the user's input (a question or a permission)." });
  });
  bb.events.on("thread.failed", async ({ thread, error }) => {
    if (byThread.has(thread.id) || thread.parentThreadId !== null || thread.visibility !== "visible") return;
    await addHandBack(thread.id, { kind: "turn-failed", text: `The turn failed: ${(error ?? "no error message").slice(0, 280)}` });
  });

  // --- waking ----------------------------------------------------------------

  /** Hand-backs the user has read since, or whose thread is running again, need no conductor. */
  async function dropStale(workspaceId: string, events: StoredConductorEvent[]): Promise<StoredConductorEvent[]> {
    const handBacks = events.filter((event) => HAND_BACK_KINDS.has(event.kind));
    if (handBacks.length === 0) return events;
    const threads = new Map((await deps.listThreads()).map((thread) => [thread.id, thread]));
    const stale = handBacks.filter((event) => {
      const thread = threads.get(event.threadId);
      return !thread || BUSY.has(thread.status) || (thread.lastReadAt !== null && thread.lastReadAt >= event.createdAt);
    });
    if (stale.length === 0) return events;
    deps.store.ack(workspaceId, stale.map((event) => event.id), now());
    const gone = new Set(stale.map((event) => event.id));
    return events.filter((event) => !gone.has(event.id));
  }

  const titleCache = new Map<string, string>();
  async function titles(): Promise<(threadId: string) => string> {
    for (const thread of await deps.listThreads()) titleCache.set(thread.id, thread.title ?? thread.titleFallback ?? "");
    return (threadId) => titleCache.get(threadId) ?? "";
  }

  type WakeResult = "off" | "nothing" | "waiting" | "busy" | "woken";
  async function wake(workspaceId: string, force = false): Promise<WakeResult> {
    if (!active(workspaceId)) return "off";
    const events = await dropStale(workspaceId, deps.store.undelivered(workspaceId));
    if (events.length === 0 && !force) return "nothing";
    const batchMs = Math.max(0, deps.options().batchMinutes) * 60_000;
    if (!force && !wakeDue(events[0]?.createdAt ?? null, now(), batchMs)) return "waiting";
    const threadId = await ensure(workspaceId);
    const [row] = await bb.sdk.threads.list({ threadIds: [threadId], includeHidden: true });
    if (row && (BUSY.has(row.status) || row.hasPendingInteraction || row.queuedWork !== "none")) return "busy";
    if (events.length === 0) return "nothing";
    const record = records[workspaceId]!;
    const { compact, day } = compactToday(record, new Date(now()));
    await bb.sdk.threads.send({
      threadId,
      mode: "start",
      input: [{ type: "text", text: wakeMessage(events, await titles()), mentions: [] }],
      ...(compact ? { compactFirst: true } : {}),
    });
    deps.store.markDelivered(events.map((event) => event.id), now());
    records[workspaceId] = { ...record, lastWakeAt: now(), ...(compact ? { compactedOn: day } : {}) };
    await save();
    log(workspaceId, "woken", threadId, `Woken with ${events.length} event${events.length === 1 ? "" : "s"}${compact ? " (compacted first)" : ""}.`);
    return "woken";
  }

  let ticking: Promise<void> | null = null;
  /** One pass over every conductor; the minute schedule's body. Single flight. */
  function tick(): Promise<void> {
    ticking ??= (async () => {
      if (!deps.options().enabled) return;
      await refreshNames().catch(() => undefined);
      for (const workspaceId of Object.keys(records)) {
        await wake(workspaceId).catch((error) => {
          // A busy thread refuses "start"; the next minute tries again.
          if (!/already_active|409/.test(String(error))) bb.log.warn(`conductor ${workspaceId}: ${String(error)}`);
        });
      }
    })().finally(() => (ticking = null));
    return ticking;
  }
  bb.background.schedule("conductor-wake", "* * * * *", () => tick());

  // --- agent tools -----------------------------------------------------------

  type ToolContext = { threadId: string };
  type ToolResult = string | { content: Array<{ type: "text"; text: string }>; isError: true };
  const failure = (error: unknown): ToolResult => ({
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  });
  /** The calling conductor's workspace; any other thread is refused. */
  function callerWorkspace(ctx: ToolContext): string {
    const workspaceId = conductorWorkspace(ctx.threadId);
    if (workspaceId === null) throw new Error("Only a workspace's conductor can use this tool.");
    return workspaceId;
  }
  /** A thread the conductor may act on: in its workspace, and not a conductor. */
  async function target(workspaceId: string, threadId: string) {
    if (byThread.has(threadId)) throw new Error("That thread is a conductor.");
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    if (!thread || thread.deletedAt !== null) throw new Error(`No thread ${threadId}.`);
    const threads = await deps.listThreads();
    if (workspaceForThread(thread, await deps.workspaces(), threads) !== workspaceId) {
      throw new Error(`${threadId} isn't in this conductor's workspace.`);
    }
    return thread;
  }
  /** The workspace thread that owns a PR, so a conductor only merges or reruns its own workspace's PRs. */
  async function prOwner(workspaceId: string, repo: string, number: number) {
    const byThread = await deps.prsByThread();
    for (const [threadId, prs] of Object.entries(byThread)) {
      const pr = prs.find((candidate) => candidate.repo === repo && candidate.number === number);
      if (!pr) continue;
      const thread = await target(workspaceId, threadId).catch(() => null);
      if (thread) return { thread, pr };
    }
    throw new Error(`${repo}#${number} isn't linked to a thread in this workspace.`);
  }
  function tool<P extends z.ZodType>(
    name: (typeof CONDUCTOR_TOOLS)[number],
    description: string,
    parameters: P,
    run: (params: z.infer<P>, workspaceId: string, ctx: ToolContext) => Promise<string>,
  ) {
    bb.agents.registerTool({
      name,
      description,
      parameters,
      async execute(params: z.infer<P>, ctx: ToolContext): Promise<ToolResult> {
        try {
          return await run(params, callerWorkspace(ctx), ctx);
        } catch (error) {
          return failure(error);
        }
      },
    });
  }

  const threadIdParam = z.string().min(1).max(200).describe("The worker thread's id (thr_…)");

  tool(
    "conductor_inbox",
    "Your inbox: routine news about this workspace's threads that you haven't acknowledged. Pass ack with the ids of events you've handled.",
    z.object({ ack: z.array(z.number().int()).max(200).optional().describe("Event ids you've handled") }),
    async ({ ack }, workspaceId) => {
      const acked = ack?.length ? deps.store.ack(workspaceId, ack, now()) : 0;
      const open = deps.store.open(workspaceId, 100);
      const titleOf = await titles();
      const lines = open.map((event) => {
        const meta = event.meta as { repo?: string; pr?: number; afterGreen?: string };
        const pr = meta.repo ? ` · ${meta.repo}#${meta.pr}` : "";
        const intent = meta.afterGreen ? ` · after_green: ${meta.afterGreen}` : "";
        return `#${event.id} [${event.kind}] "${titleOf(event.threadId)}" (${event.threadId})${pr}${intent} — ${event.text}`;
      });
      return `${acked ? `Acknowledged ${acked}. ` : ""}${open.length === 0 ? "Inbox empty." : `${open.length} open:\n${lines.join("\n")}`}`;
    },
  );

  async function fleetRows(workspaceId: string) {
    const [threads, state, flow, snoozedSection, prs] = await Promise.all([
      deps.listThreads(),
      deps.workspaces(),
      deps.flow(),
      deps.snoozedSection(),
      deps.prsByThread(),
    ]);
    const at = now();
    const rows = [];
    for (const thread of threads) {
      if (thread.parentThreadId !== null || byThread.has(thread.id)) continue;
      if (workspaceForThread(thread, state, threads) !== workspaceId) continue;
      const nowThread = serverNowThread(thread, snoozedSection !== null && thread.sectionId === snoozedSection);
      const ball = ballState(nowThread, flow, at);
      const due = flow.due[thread.id]?.at ?? null;
      const reason = reasonLabel({ thread: nowThread, state: ball, focused: thread.id in flow.focused, since: nowThread.attentionAt, dueAt: due }, flow, at);
      const status = await deps.threadStatus(thread.id).catch(() => null);
      rows.push({ thread, ball, reason, status, prs: (prs[thread.id] ?? []).filter((pr) => pr.state === "open" || pr.state === "draft") });
    }
    return rows;
  }

  const NEEDS_YOU = new Set(["blocked", "yours", "stalled", "pr", "go"]);
  tool(
    "fleet_status",
    "Every thread in this workspace: who holds the next move, unread, its open PRs and the Next/Blocked of its last status report. needs_you_only narrows it to threads waiting on the user or with an actionable PR.",
    z.object({ needs_you_only: z.boolean().optional() }),
    async ({ needs_you_only }, workspaceId) => {
      const rows = (await fleetRows(workspaceId)).filter((row) => !needs_you_only || NEEDS_YOU.has(row.ball));
      if (rows.length === 0) return needs_you_only ? "Nothing needs the user." : "No threads in this workspace.";
      return rows
        .map(({ thread, reason, status, prs }) => {
          const unread = thread.latestAttentionAt !== null && (thread.lastReadAt ?? 0) < thread.latestAttentionAt ? " · unread" : "";
          const prText = prs.length ? ` · PRs: ${prs.map((pr) => `${pr.repo}#${pr.number} [${pr.attention}]`).join(", ")}` : "";
          const report = status?.report;
          const next = report ? `${report.blocked ? ` · Blocked: ${report.blocked.slice(0, 160)}` : ""}${report.next ? ` · Next: ${report.next.slice(0, 160)}` : ""}` : "";
          return `${thread.id} · "${thread.title ?? thread.titleFallback ?? "Untitled"}" · ${reason}${unread}${prText}${next}`;
        })
        .join("\n");
    },
  );

  tool(
    "thread_brief",
    "One worker thread in detail: its last status report, the end of its last reply, its PRs and who holds the next move.",
    z.object({ thread_id: threadIdParam }),
    async ({ thread_id }, workspaceId) => {
      const thread = await target(workspaceId, thread_id);
      const [status, output, prs] = await Promise.all([
        deps.threadStatus(thread.id),
        bb.sdk.threads.output({ threadId: thread.id }).catch(() => ({ output: null })),
        deps.prsByThread(),
      ]);
      const report = status?.report;
      const reply = (output.output ?? "").trim();
      return [
        `"${thread.title ?? "Untitled"}" (${thread.id}) · ${thread.status}`,
        report ? `Goal: ${report.goal}\nDone: ${report.done}\nNext: ${report.next}${report.blocked ? `\nBlocked: ${report.blocked}` : ""}` : "No status report.",
        `PRs: ${(prs[thread.id] ?? []).map((pr) => `${pr.repo}#${pr.number} ${pr.state} [${pr.attention}] ${pr.title}`).join("; ") || "none"}`,
        `Last reply (end):\n${reply.length > 1500 ? `…${reply.slice(-1500)}` : reply || "(none)"}`,
      ].join("\n\n");
    },
  );

  tool(
    "merge_pr",
    "Merge a workspace thread's PR with the repo's default merge method. Never bypasses branch protection or required reviews: if GitHub refuses, the reason is returned; put it in the briefing.",
    z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).describe("owner/name"), number: z.number().int().positive() }),
    async ({ repo, number }, workspaceId) => {
      const { thread } = await prOwner(workspaceId, repo, number);
      const info = JSON.parse(await gh(["repo", "view", repo, "--json", "viewerDefaultMergeMethod"])) as { viewerDefaultMergeMethod?: string };
      try {
        await gh(["pr", "merge", String(number), "-R", repo, mergeFlag(info.viewerDefaultMergeMethod)], 120_000);
      } catch (error) {
        log(workspaceId, "merge-refused", thread.id, `${repo}#${number}: ${String(error).slice(0, 300)}`);
        throw new Error(`GitHub didn't merge ${repo}#${number}: ${error instanceof Error ? error.message : String(error)}`);
      }
      log(workspaceId, "merged", thread.id, `Merged ${repo}#${number}.`);
      return `Merged ${repo}#${number}.`;
    },
  );

  tool(
    "rerun_failed",
    "Rerun the failed GitHub Actions jobs of a workspace thread's PR. Once per commit: a second failure on the same commit is real.",
    z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive() }),
    async ({ repo, number }, workspaceId) => {
      const { thread } = await prOwner(workspaceId, repo, number);
      const pr = JSON.parse(await gh(["pr", "view", String(number), "-R", repo, "--json", "headRefOid,statusCheckRollup"])) as {
        headRefOid: string;
        statusCheckRollup: Array<{ conclusion?: string | null; state?: string; detailsUrl?: string; targetUrl?: string }>;
      };
      const key = `${repo}#${number}@${pr.headRefOid}`;
      const reruns = (await kv.get<Record<string, number>>(RERUNS_KEY)) ?? {};
      if (reruns[key] !== undefined) throw new Error(`Already reran ${repo}#${number} once on ${pr.headRefOid.slice(0, 7)}; treat this failure as real.`);
      const runs = failedRunIds(pr.statusCheckRollup);
      if (runs.length === 0) throw new Error(`No failed Actions runs on ${repo}#${number}.`);
      for (const run of runs) await gh(["run", "rerun", run, "-R", repo, "--failed"]);
      // Keep a month of these; a commit isn't rerun after that anyway.
      for (const [old, at] of Object.entries(reruns)) if (now() - at > 30 * 24 * 3_600_000) delete reruns[old];
      reruns[key] = now();
      await kv.set(RERUNS_KEY, reruns);
      log(workspaceId, "rerun", thread.id, `Reran ${runs.length} failed run(s) on ${repo}#${number}.`);
      return `Reran ${runs.length} failed run(s) on ${repo}#${number}. A wait_for_ci watch on the worker reports the result.`;
    },
  );

  tool(
    "forward_to_thread",
    "Send a worker thread an instruction: something it must act on, or the user's reply relayed. It runs a turn in that thread. mark_read clears it from the user's unread list.",
    z.object({
      thread_id: threadIdParam,
      message: z.string().min(1).max(8000),
      mark_read: z.boolean().optional().describe("Mark the thread read (the user answered it through you)"),
    }),
    async ({ thread_id, message, mark_read }, workspaceId) => {
      const thread = await target(workspaceId, thread_id);
      if (thread.archivedAt !== null) throw new Error(`${thread_id} is archived; unarchive it with thread_action first.`);
      await bb.sdk.threads.send({ threadId: thread.id, mode: "queue-if-active", input: [{ type: "text", text: relayText(message), mentions: [] }] });
      if (mark_read) await bb.sdk.threads.markRead({ threadId: thread.id }).catch(() => undefined);
      log(workspaceId, "forwarded", thread.id, message.slice(0, 300));
      deps.changed();
      return `Sent to "${thread.title ?? thread.id}".`;
    },
  );

  tool(
    "thread_action",
    "Act on a worker thread: snooze (until: 2h, tomorrow, mon, 3d or YYYY-MM-DD; optional note sent to it on wake-up), unsnooze, archive, unarchive, mark_read, mark_unread, focus, unfocus.",
    z.object({
      thread_id: threadIdParam,
      action: z.enum(["snooze", "unsnooze", "archive", "unarchive", "mark_read", "mark_unread", "focus", "unfocus"]),
      until: z.string().max(40).optional(),
      note: z.string().max(1000).optional(),
    }),
    async ({ thread_id, action, until, note }, workspaceId) => {
      const thread = await target(workspaceId, thread_id);
      const title = `"${thread.title ?? thread.id}"`;
      let done: string;
      switch (action) {
        case "snooze": {
          if (!until) throw new Error("Say until when: 2h, tomorrow, mon, 3d or YYYY-MM-DD.");
          const record = await deps.snooze(thread.id, until, note ?? null);
          done = `Snoozed ${title} until ${new Date(record.until).toLocaleString("en-GB")}.`;
          break;
        }
        case "unsnooze":
          done = (await deps.unsnooze(thread.id)) ? `Woke ${title}.` : `${title} wasn't snoozed.`;
          break;
        case "archive": {
          const result = await deps.archive([thread.id]);
          if (result.failed.length > 0) throw new Error(`Couldn't archive ${title}.`);
          done = `Archived ${title}.`;
          break;
        }
        case "unarchive":
          await bb.sdk.threads.unarchive({ threadId: thread.id });
          done = `Unarchived ${title}.`;
          break;
        case "mark_read":
          await bb.sdk.threads.markRead({ threadId: thread.id });
          done = `Marked ${title} read.`;
          break;
        case "mark_unread":
          await bb.sdk.threads.markUnread({ threadId: thread.id });
          done = `Marked ${title} unread.`;
          break;
        case "focus":
        case "unfocus":
          await deps.focus(thread.id, action === "focus");
          done = `${action === "focus" ? "Focused" : "Unfocused"} ${title}.`;
          break;
      }
      log(workspaceId, action, thread.id, done);
      deps.changed();
      return done;
    },
  );

  tool(
    "post_briefing",
    "Leave the user the current briefing; it replaces the previous one on the conductor page. items: every thread that needs the user now (not only new ones), each with a short summary, your recommendation and the exact reply to send its worker if they agree. handled: what you did since the last briefing.",
    z.object({
      items: z.array(briefingItemSchema.extend({ kind: z.enum(BRIEFING_KINDS) })).max(40),
      handled: z.array(z.object({ threadId: z.string().max(200).nullable(), what: z.string().min(1).max(300) })).max(60).optional(),
      note: z.string().max(1000).optional(),
    }),
    async ({ items, handled, note }, workspaceId) => {
      const known = new Set((await fleetRows(workspaceId)).map((row) => row.thread.id));
      const kept = items.filter((item) => known.has(item.threadId));
      const briefing: Briefing = { at: now(), items: kept, handled: handled ?? [], ...(note ? { note } : {}) };
      await kv.set(briefingKey(workspaceId), briefing);
      log(workspaceId, "briefing", null, `${kept.length} item${kept.length === 1 ? "" : "s"} for the user, ${briefing.handled.length} handled.`);
      deps.changed();
      const dropped = items.length - kept.length;
      return `Briefing posted: ${kept.length} item(s).${dropped ? ` ${dropped} item(s) skipped: their threads aren't open threads in this workspace.` : ""}`;
    },
  );

  tool(
    "conductor_memory",
    `Your standing preferences for this workspace, kept across sessions and included in your instructions (up to ${MEMORY_MAX} characters). Call without set to read them; set replaces them.`,
    z.object({ set: z.string().max(MEMORY_MAX).optional() }),
    async ({ set }, workspaceId) => {
      if (set !== undefined) {
        await kv.set(memoryKey(workspaceId), set);
        memories.set(workspaceId, set);
        log(workspaceId, "memory", null, "Updated standing preferences.");
        return "Saved. They're in your instructions from your next session on.";
      }
      return memories.get(workspaceId) || "No standing preferences yet.";
    },
  );

  /** What configure() returns for a conductor thread, or null for any other thread. */
  function configureFor(ctx: Pick<ConfigureContext, "thread" | "pluginMetadata" | "origin">) {
    let workspaceId = conductorWorkspace(ctx.thread.id);
    // Spawned this moment, before its id was stored: bb sets origin, which no agent can change.
    const meta = ctx.pluginMetadata as { role?: unknown; workspaceId?: unknown };
    if (workspaceId === null && ctx.origin.pluginId === bb.pluginId && meta.role === CONDUCTOR_ROLE && typeof meta.workspaceId === "string" && active(meta.workspaceId)) {
      workspaceId = meta.workspaceId;
    }
    if (workspaceId === null) return null;
    const options = deps.options();
    return {
      tools: [...CONDUCTOR_TOOLS],
      skills: [],
      instructions: conductorInstructions(names.get(workspaceId) ?? "this", options.prompt, memories.get(workspaceId) ?? ""),
    };
  }

  async function briefing(workspaceId: string): Promise<Briefing | null> {
    return (await kv.get<Briefing>(briefingKey(workspaceId))) ?? null;
  }

  function status() {
    return Object.entries(records).map(([workspaceId, record]) => ({
      workspaceId,
      name: names.get(workspaceId) ?? workspaceId,
      ...record,
      active: active(workspaceId),
      open: deps.store.open(workspaceId, 500).length,
      undelivered: deps.store.undelivered(workspaceId).length,
    }));
  }

  return {
    sink,
    configureFor,
    isConductor: (threadId: string) => byThread.has(threadId),
    start,
    stop,
    wake,
    tick,
    status,
    briefing,
    inbox: (workspaceId: string) => deps.store.open(workspaceId),
    log: (workspaceId: string, limit?: number) => deps.store.recentLog(workspaceId, limit),
    prune: () => deps.store.prune(now() - CONDUCTOR_RETENTION_MS),
  };
}

export type Conductor = Awaited<ReturnType<typeof createConductor>>;
