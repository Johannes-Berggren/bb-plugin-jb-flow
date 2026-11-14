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
import { decide, followUpsAfterMerge, mergeIntent, nothingLeft } from "./autopilot.ts";
import { nextMove } from "./decisions.ts";
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
  briefFromThread,
  mergeFlag,
  relayText,
  wakeDue,
  wakeMessage,
  type Briefing,
  type BriefingContext,
  type BriefingItem,
  type ConductorRecord,
} from "./conductor-model.ts";
import type { ConductorInboxEvent, ConductorSink } from "./conductor-routing.ts";
import type { ConductorStore } from "./conductor-store.ts";
import { ballState, reasonLabel, serverNowThread, type NowFlow } from "./now-model.ts";
import type { PrStatus } from "./prs";
import type { ThreadStatus } from "./thread-status.ts";
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

/** What autopilot logs, for the "done for you" feed. */
export const AUTOPILOT_KINDS = ["auto-merged", "auto-archived", "absorbed", "forwarded", "merge-refused"] as const;
/** Entries that each spared a worker a wake-up. */
const SPARED_KINDS: ReadonlySet<string> = new Set(["auto-merged", "auto-archived", "absorbed"]);
/** Something the user did on the conductor page, so the conductor knows at its next wake-up. */
export const USER_ACTION = "user-action";
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
/** bb's own id for the Personal project, the one project whose threads get a plain folder. */
const PERSONAL_PROJECT_ID = "proj_personal";
const briefingKey = (workspaceId: string) => `conductorBriefing:${workspaceId}`;
const memoryKey = (workspaceId: string) => `conductorMemory:${workspaceId}`;
const RERUNS_KEY = "conductorReruns";
/** Briefing items the user has dealt with on the page: thread id → the briefing's `at`. */
const resolvedKey = (workspaceId: string) => `conductorResolved:${workspaceId}`;

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
  // Workers' hand-backs used to wake the conductor; their briefs now come from the workers' own
  // reports, so any still waiting from an earlier version would only cost a wake-up.
  try {
    deps.store.ackKinds(["needs-you", "ready", "finished", "input", "turn-failed"], now());
  } catch (error) {
    bb.log.warn(`conductor inbox cleanup: ${String(error)}`);
  }

  let saving: Promise<unknown> = Promise.resolve();
  function save(): Promise<void> {
    const run = saving.then(() => kv.set(RECORDS_KEY, records));
    saving = run.catch(() => undefined);
    return run;
  }
  async function refreshNames() {
    for (const workspace of (await deps.workspaces()).workspaces) names.set(workspace.id, workspace.name);
  }
  const log = (workspaceId: string, kind: string, threadId: string | null, text: string, savedTokens: number | null = null) => {
    try {
      deps.store.log(workspaceId, kind, threadId, text, now(), savedTokens);
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

  // --- autopilot ---------------------------------------------------------------
  // Routine PR news is handled here, without waking anyone: see autopilot.ts.

  /** The PRs autopilot merged itself ("owner/repo#n" → when), so their merge archives the thread. */
  const AUTO_MERGED_KEY = "autopilotMerged";

  async function mergePr(repo: string, number: number, headSha?: string): Promise<void> {
    const info = JSON.parse(await gh(["repo", "view", repo, "--json", "viewerDefaultMergeMethod"])) as { viewerDefaultMergeMethod?: string };
    // Only the commit that went green: a push since then waits for its own checks.
    await gh(["pr", "merge", String(number), "-R", repo, mergeFlag(info.viewerDefaultMergeMethod), ...(headSha ? ["--match-head-commit", headSha] : [])], 120_000);
  }

  /** What waking this thread costs: its last turn's tokens, when bb has them. */
  async function lastTurnTokens(threadId: string): Promise<number | null> {
    try {
      const [row] = await bb.sdk.threads.events.list({ threadId, types: ["thread/tokenUsage/updated"], order: "desc", limit: "1" });
      const total = (row as { data?: { tokenUsage?: { last?: { totalTokens?: unknown } } } } | undefined)?.data?.tokenUsage?.last?.totalTokens;
      return typeof total === "number" && total > 0 ? total : null;
    } catch {
      return null;
    }
  }

  const shortPr = (meta: { repo?: unknown; pr?: unknown }) =>
    typeof meta.repo === "string" && typeof meta.pr === "number" ? `${meta.repo.split("/")[1]}#${meta.pr}` : "the PR";

  /** One routed event: act on it, or leave it in the inbox for the conductor. */
  async function autopilot(threadId: string, workspaceId: string, event: ConductorInboxEvent, id: number): Promise<void> {
    const meta = (event.meta ?? {}) as { repo?: string; pr?: number; afterGreen?: "merge" | "continue" | "nothing"; headSha?: string };
    const [status, prs, merged] = await Promise.all([
      deps.threadStatus(threadId).catch(() => null),
      deps.prsByThread().catch(() => ({}) as Record<string, PrStatus[]>),
      kv.get<Record<string, number>>(AUTO_MERGED_KEY).then((value) => value ?? {}),
    ]);
    const own = prs[threadId] ?? [];
    const pr = own.find((candidate) => candidate.repo === meta.repo && candidate.number === meta.pr) ?? null;
    const key = `${meta.repo}#${meta.pr}`;
    const decision = decide({
      kind: event.kind,
      afterGreen: meta.afterGreen,
      mergeIntent: mergeIntent(status?.report?.next, status?.report?.doingNow, status?.latest),
      followUps: followUpsAfterMerge(status?.report?.next, status?.report?.doingNow, status?.latest),
      // A report's Next, or the "Next:" line of a reply that had no full report.
      nothingLeft: nothingLeft(status?.report?.next ?? /\bNext:\**\s*(.+)/i.exec(status?.latest ?? "")?.[1]),
      pr: pr ? { state: pr.state, attention: pr.attention } : null,
      otherOpenPrs: own.filter((candidate) => candidate !== pr && (candidate.state === "open" || candidate.state === "draft")).length,
    });
    const done = (kind: string, text: string, saved: number | null) => {
      deps.store.ack(workspaceId, [id], now());
      log(workspaceId, kind, threadId, text, saved);
      deps.changed();
    };
    switch (decision.action) {
      case "conductor":
        return; // stays in the inbox for its next wake-up
      case "record":
        return done("absorbed", `${event.text} (${decision.reason})`, await lastTurnTokens(threadId));
      case "forward":
        await bb.sdk.threads.send({
          threadId,
          mode: "queue-if-active",
          input: [{ type: "text", text: event.kind === "release" ? event.text : `[ci watcher] ${event.text}`, mentions: [] }],
        });
        // The worker merges and carries on itself: tell it in the words it was waiting for.
        return done("forwarded", `${event.text} (${decision.reason})`, null);
      case "merge": {
        if (typeof meta.repo !== "string" || typeof meta.pr !== "number") return;
        // The worker woke up meanwhile (you replied to it): it merges itself.
        const current = await bb.sdk.threads.get({ threadId }).catch(() => null);
        if (current && BUSY.has(current.status)) {
          return done("absorbed", `${event.text} (the worker is running, so it merges itself)`, null);
        }
        try {
          await mergePr(meta.repo, meta.pr, meta.headSha);
        } catch (error) {
          // Protection, a required review, a newer push: the conductor briefs the user.
          log(workspaceId, "merge-refused", threadId, `${shortPr(meta)}: ${String(error).slice(0, 300)}`);
          deps.store.add(workspaceId, threadId, [{ kind: "merge-refused", text: `Autopilot couldn't merge ${shortPr(meta)}: ${String(error).slice(0, 300)}`, meta }], now());
          deps.store.ack(workspaceId, [id], now());
          return;
        }
        for (const [old, at] of Object.entries(merged)) if (now() - at > 30 * 24 * 3_600_000) delete merged[old];
        merged[key] = now();
        await kv.set(AUTO_MERGED_KEY, merged);
        return done("auto-merged", `Merged ${shortPr(meta)} once it was green (${decision.reason}).`, await lastTurnTokens(threadId));
      }
      case "archive": {
        const result = await deps.archive([threadId]);
        if (result.failed.length > 0) return;
        return done("auto-archived", `${shortPr(meta)} merged and nothing else was open, so the thread is archived.`, await lastTurnTokens(threadId));
      }
    }
  }

  const sink: ConductorSink = {
    workspaceFor,
    deliver: async (threadId, workspaceId, events) => {
      for (const event of events) {
        // Stored first: a retried delivery finds it and does nothing twice.
        const id = deps.store.addOne(workspaceId, threadId, event, now());
        if (id === null) continue;
        await autopilot(threadId, workspaceId, event, id).catch((error) => {
          bb.log.warn(`autopilot ${threadId} ${event.kind}: ${String(error)}`);
        });
      }
    },
  };

  // --- lifecycle -------------------------------------------------------------

  async function spawn(workspaceId: string): Promise<string> {
    const record = records[workspaceId]!;
    const workspace = (await deps.workspaces()).workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} no longer exists.`);
    // bb's Personal project takes a plain folder; any other project would give the conductor a git checkout.
    const personal = await (async () => {
      try {
        const project = await bb.sdk.projects.get({ projectId: PERSONAL_PROJECT_ID });
        return project.kind === "personal" ? project.id : null;
      } catch {
        return null;
      }
    })();
    const projectId = record.projectId ?? personal ?? workspace.projectIds[0] ?? (await bb.sdk.projects.list())[0]?.id;
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

  // --- waking ----------------------------------------------------------------

  const titleCache = new Map<string, string>();
  async function titles(): Promise<(threadId: string) => string> {
    for (const thread of await deps.listThreads()) titleCache.set(thread.id, thread.title ?? thread.titleFallback ?? "");
    return (threadId) => titleCache.get(threadId) ?? "";
  }

  type WakeResult = "off" | "nothing" | "waiting" | "busy" | "woken";
  async function wake(workspaceId: string, force = false): Promise<WakeResult> {
    if (!active(workspaceId)) return "off";
    const events = deps.store.undelivered(workspaceId);
    // What you did on the conductor page rides along with the next wake-up but never causes one.
    const triggering = events.filter((event) => event.kind !== USER_ACTION);
    if (triggering.length === 0 && !force) return "nothing";
    const batchMs = Math.max(0, deps.options().batchMinutes) * 60_000;
    if (!force && !wakeDue(triggering[0]?.createdAt ?? null, now(), batchMs)) return "waiting";
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
    // Every wake-up marks the day: the first one of a day starts it compacted, or (the very
    // first) with a fresh conversation, so later ones that day leave it alone.
    records[workspaceId] = { ...record, lastWakeAt: now(), compactedOn: day };
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
  /** The workspace's threads for the page's Fleet tab, those that need the user first. */
  async function fleet(workspaceId: string): Promise<FleetRow[]> {
    const rows = (await fleetRows(workspaceId)).map(({ thread, ball, reason, status, prs }) => ({
      threadId: thread.id,
      title: thread.title ?? thread.titleFallback ?? "Untitled",
      projectId: thread.projectId,
      state: ball,
      reason,
      needsYou: NEEDS_YOU.has(ball),
      unread: thread.latestAttentionAt !== null && (thread.lastReadAt ?? 0) < thread.latestAttentionAt,
      prs: prs.map((pr) => ({ repo: pr.repo, number: pr.number, attention: pr.attention, url: pr.url })),
      next: status?.report?.next ?? null,
      blocked: status?.report?.blocked || null,
    }));
    return rows.sort((a, b) => Number(b.needsYou) - Number(a.needsYou));
  }
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
    "Merge a workspace thread's PR with the repo's default merge method, only when its worker said it merges once green and the worker isn't running. Never bypasses branch protection or required reviews: if GitHub refuses, the reason is returned; put it in the briefing.",
    z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).describe("owner/name"), number: z.number().int().positive() }),
    async ({ repo, number }, workspaceId) => {
      const { thread } = await prOwner(workspaceId, repo, number);
      // A running worker may be merging it this very moment: two merges race and confuse it.
      if (BUSY.has(thread.status)) throw new Error(`The worker on ${repo}#${number} is running; leave the merge to it.`);
      try {
        await mergePr(repo, number);
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
    "Leave the user the current briefing; it replaces the previous one on the conductor page. items: every thread that needs the user now (not only new ones), each with a headline (what you need from them, at most 8 words, e.g. \"Pick a chart library\"), a one- or two-sentence summary, your recommendation and the exact reply to send its worker if they agree. The page already shows each thread's goal, PRs, its numbered options and how long it has waited, so don't repeat those. handled: what you did since the last briefing.",
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

  /** The current briefing's items the user has already dealt with on the page. */
  async function resolved(workspaceId: string): Promise<Record<string, number>> {
    return (await kv.get<Record<string, number>>(resolvedKey(workspaceId))) ?? {};
  }

  /**
   * The user acting on a briefing card: their reply goes to the worker as theirs
   * (no conductor in between), the thread is marked read, the card is put away
   * and the conductor hears about it at its next wake-up.
   */
  async function cardAction(
    workspaceId: string,
    threadId: string,
    action: "go" | "reply" | "snooze" | "dismiss",
    options: { text?: string; until?: string } = {},
  ): Promise<string> {
    if (!records[workspaceId]) throw new Error("This workspace has no conductor.");
    const brief = (await workspaceBriefs(workspaceId)).find((candidate) => candidate.threadId === threadId);
    const item = brief?.item;
    const thread = await bb.sdk.threads.get({ threadId });
    const title = `"${thread.title ?? threadId}"`;
    let done: string;
    switch (action) {
      case "go":
      case "reply": {
        const text = (action === "go" ? item?.reply ?? "go" : options.text ?? "").trim();
        if (!text) throw new Error("Write a reply first.");
        await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
        await bb.sdk.threads.markRead({ threadId }).catch(() => undefined);
        done = `You sent ${title}: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
        break;
      }
      case "snooze": {
        if (!options.until) throw new Error("Say until when.");
        const record = await deps.snooze(threadId, options.until, null);
        done = `You snoozed ${title} until ${new Date(record.until).toLocaleString("en-GB")}.`;
        break;
      }
      case "dismiss":
        done = `You marked ${title} done on the briefing; leave it out unless something changes.`;
        break;
    }
    if (brief) {
      const all = await resolved(workspaceId);
      // Put away until the thread has news again; forget marks older than two weeks.
      for (const [id, at] of Object.entries(all)) if (now() - at > CONDUCTOR_RETENTION_MS) delete all[id];
      all[threadId] = brief.at;
      await kv.set(resolvedKey(workspaceId), all);
    }
    deps.store.add(workspaceId, threadId, [{ kind: USER_ACTION, text: done, meta: { at: now() } }], now());
    log(workspaceId, `you-${action}`, threadId, done);
    deps.changed();
    return done;
  }

  // The options parse reads the thread's last reply; redo it only when the thread changed.
  const optionsCache = new Map<string, { updatedAt: number; move: ReturnType<typeof nextMove> }>();
  /** What the page shows around one briefing item, from the thread itself. */
  async function contextFor(threadId: string, threads: ListedThread[], flow: NowFlow, prs: Record<string, PrStatus[]>): Promise<BriefingContext | null> {
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) return null;
    const status = await deps.threadStatus(threadId).catch(() => null);
    const move: ReturnType<typeof nextMove> = thread.status === "idle" ? await movesFor(thread) : { mode: "choice", options: [] };
    const due = flow.due[threadId];
    const report = status?.report;
    return {
      status: thread.status,
      waitingSince: flow.awaiting[threadId] ?? thread.latestAttentionAt ?? null,
      dueAt: due?.at ?? null,
      dueReason: due?.reason ?? null,
      goal: report?.goal || null,
      next: report?.next || null,
      blocked: report?.blocked || null,
      prs: (prs[threadId] ?? [])
        .filter((pr) => pr.state === "open" || pr.state === "draft")
        .map((pr) => ({ repo: pr.repo, number: pr.number, attention: pr.attention, url: pr.url, title: pr.title })),
      options: move.options,
      optionsMode: move.options.length > 0 ? move.mode : null,
    };
  }

  /**
   * The conductor's current brief for each thread that needs the user, for
   * Catch up and Now. A brief older than the thread's latest news is left out:
   * the conductor hasn't seen what happened since.
   */
  async function briefs(): Promise<Brief[]> {
    if (!deps.options().enabled) return [];
    const result: Brief[] = [];
    for (const workspaceId of Object.keys(records)) {
      if (active(workspaceId)) result.push(...(await workspaceBriefs(workspaceId)));
    }
    return result;
  }

  /**
   * What each thread in a workspace needs from you, built from the worker's own
   * words (its status report, or the options and question its reply ends with)
   * at no cost, with the conductor's own items, when it posted any, on top.
   * Briefs you've dealt with are left out until the thread has news again.
   */
  async function workspaceBriefs(workspaceId: string): Promise<Brief[]> {
    const [rows, current, done] = await Promise.all([fleetRows(workspaceId), briefing(workspaceId), resolved(workspaceId)]);
    const byThread = new Map<string, Brief>();
    for (const { thread, ball, status } of rows) {
      if (!["blocked", "yours", "go", "stalled"].includes(ball) || BUSY.has(thread.status)) continue;
      const latest = status?.latest ?? "";
      const move = await movesFor(thread);
      const pending = thread.hasPendingInteraction ? "input" : thread.status === "error" ? "failed" : null;
      const item = briefFromThread(thread.id, { ball, report: status?.report ?? null, latest, move, pending });
      if (item) byThread.set(thread.id, { workspaceId, threadId: thread.id, at: thread.latestAttentionAt ?? status?.latestAt ?? thread.createdAt, item });
    }
    // The conductor's judgement items, while they're newer than the thread's own news.
    const attention = new Map(rows.map(({ thread }) => [thread.id, thread.latestAttentionAt ?? thread.createdAt]));
    for (const item of current?.items ?? []) {
      const latest = attention.get(item.threadId);
      if (latest === undefined || latest > current!.at) continue;
      byThread.set(item.threadId, { workspaceId, threadId: item.threadId, at: current!.at, item });
    }
    return [...byThread.values()].filter((brief) => done[brief.threadId] !== brief.at);
  }

  // The options parse reads the thread's last reply; redo it only when the thread changed.
  async function movesFor(thread: ListedThread): Promise<ReturnType<typeof nextMove>> {
    const cached = optionsCache.get(thread.id);
    if (cached && cached.updatedAt === thread.updatedAt) return cached.move;
    const output = await bb.sdk.threads.output({ threadId: thread.id }).catch(() => ({ output: null }));
    const move = nextMove(output.output ?? "");
    optionsCache.set(thread.id, { updatedAt: thread.updatedAt, move });
    return move;
  }

  /** What autopilot did since `since`, every workspace, with totals: the "done for you" feed. */
  async function feed(since: number) {
    const entries = deps.store.feed(AUTOPILOT_KINDS, since, 200);
    const spared = entries.filter((entry) => SPARED_KINDS.has(entry.kind));
    const titles = new Map((await deps.listThreads()).map((thread) => [thread.id, thread.title ?? thread.titleFallback ?? ""]));
    const missing = [...new Set(entries.slice(0, 30).flatMap((entry) => (entry.threadId && !titles.has(entry.threadId) ? [entry.threadId] : [])))];
    await Promise.all(
      missing.map(async (threadId) => {
        const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
        if (thread) titles.set(threadId, thread.title ?? "");
      }),
    );
    return {
      since,
      merged: entries.filter((entry) => entry.kind === "auto-merged").length,
      archived: entries.filter((entry) => entry.kind === "auto-archived").length,
      forwarded: entries.filter((entry) => entry.kind === "forwarded").length,
      refused: entries.filter((entry) => entry.kind === "merge-refused").length,
      wakeupsSpared: spared.length,
      tokensSpared: spared.reduce((sum, entry) => sum + (entry.savedTokens ?? 0), 0),
      entries: entries.slice(0, 30).map((entry) => ({
        id: entry.id,
        at: entry.at,
        kind: entry.kind,
        workspaceId: entry.workspaceId,
        workspace: names.get(entry.workspaceId) ?? entry.workspaceId,
        threadId: entry.threadId,
        title: entry.threadId ? (titles.get(entry.threadId) ?? "") : "",
        text: entry.text,
        savedTokens: entry.savedTokens,
      })),
    };
  }

  /** Everything the conductor page shows for one workspace. */
  async function page(workspaceId: string) {
    const record = records[workspaceId] ?? null;
    const [current, open, thread] = await Promise.all([
      briefing(workspaceId),
      active(workspaceId) ? workspaceBriefs(workspaceId) : Promise.resolve([] as Brief[]),
      record?.threadId ? bb.sdk.threads.get({ threadId: record.threadId }).catch(() => null) : Promise.resolve(null),
    ]);
    const contexts: Record<string, BriefingContext> = {};
    const openItems = open.map((brief) => brief.item);
    const combined: Briefing | null =
      openItems.length > 0 || current
        ? { at: Math.max(current?.at ?? 0, ...open.map((brief) => brief.at)), items: openItems, handled: current?.handled ?? [], ...(current?.note ? { note: current.note } : {}) }
        : null;
    if (openItems.length > 0) {
      const [threads, flow, prs] = await Promise.all([deps.listThreads(), deps.flow(), deps.prsByThread()]);
      await Promise.all(
        openItems.map(async (item) => {
          const context = await contextFor(item.threadId, threads, flow, prs).catch(() => null);
          if (context) contexts[item.threadId] = context;
        }),
      );
    }
    return {
      workspaceId,
      contexts,
      threadId: record?.threadId ?? null,
      threadStatus: thread?.status ?? null,
      active: active(workspaceId),
      briefing: combined,
      resolved: [],
      log: deps.store.recentLog(workspaceId, 60),
      open: deps.store.open(workspaceId, 500).filter((event) => event.kind !== USER_ACTION).length,
      lastWakeAt: record?.lastWakeAt ?? null,
    };
  }

  async function status() {
    return Promise.all(
      Object.entries(records).map(async ([workspaceId, record]) => {
        const open = active(workspaceId) ? await workspaceBriefs(workspaceId) : [];
        return {
          workspaceId,
          name: names.get(workspaceId) ?? workspaceId,
          ...record,
          active: active(workspaceId),
          open: deps.store.open(workspaceId, 500).filter((event) => event.kind !== USER_ACTION).length,
          undelivered: deps.store.undelivered(workspaceId).length,
          /** Briefing items the user hasn't dealt with yet. */
          needsYou: open.length,
        };
      }),
    );
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
    briefs,
    feed,
    fleet,
    cardAction,
    page,
    inbox: (workspaceId: string) => deps.store.open(workspaceId),
    log: (workspaceId: string, limit?: number) => deps.store.recentLog(workspaceId, limit),
    prune: () => deps.store.prune(now() - CONDUCTOR_RETENTION_MS),
  };
}

export type Conductor = Awaited<ReturnType<typeof createConductor>>;

/** What one thread needs from you, for Catch up, Now and the conductor page. */
export type Brief = { workspaceId: string; threadId: string; at: number; item: BriefingItem };

export type FleetRow = {
  threadId: string;
  title: string;
  projectId: string;
  state: string;
  reason: string;
  needsYou: boolean;
  unread: boolean;
  prs: Array<{ repo: string; number: number; attention: string; url: string }>;
  next: string | null;
  blocked: string | null;
};
