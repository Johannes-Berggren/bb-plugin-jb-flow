// The RPC contract between the server and the app, and the shapes it sends.
// server.ts registers the handlers; the app imports these types through it.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { workspaceSchema, workspaceStateSchema } from "./workspaces";
import { threadStatusSchema } from "./thread-status";
import { leftoverSchema } from "./leftovers";
import { focusReportSchema } from "./focus";
import { prStatusSchema } from "./prs";
import { unreleasedSchema } from "./unreleased";
import { machinesSchema } from "./machines";
import { devRunSchema, repoCommandSchema, repoScriptSchema } from "./repo-commands";
import { briefingItemSchema, TRIAGE_GROUP_KEYS } from "./conductor-model";

const snoozeSchema = z.object({
  until: z.number(),
  note: z.string().nullable(),
  fromSectionId: z.string().nullable(),
  snoozedAt: z.number(),
  /** The wake has begun: the thread may have left Snoozed, and its note may still be unsent. */
  wakeStarted: z.boolean().optional(),
  /** Failed attempts to send the note. */
  noteFailures: z.number().optional(),
});
export type Snooze = z.infer<typeof snoozeSchema>;

const digestItemSchema = z.object({
  threadId: z.string(),
  projectId: z.string(),
  title: z.string(),
  idleDays: z.number(),
  summary: z.string(),
});
export type DigestItem = z.infer<typeof digestItemSchema>;
export type Digest = { generatedAt: number; items: DigestItem[] };

const stateSchema = z.object({
  projectShortNames: z.record(z.string(), z.string()),
  stripProjectPrefixes: z.array(z.string()),
  /** Idle threads whose last agent message hands the next move to you (thread id → since). */
  awaiting: z.record(z.string(), z.number()),
  /** Idle threads whose agent promised to report back by itself (thread id → since). */
  promised: z.record(z.string(), z.number()),
  /** Idle threads whose next step is someone else's (thread id → since). */
  waitingOthers: z.record(z.string(), z.number()),
  /** Idle threads whose agent offers steps and only needs a go (thread id → since). */
  readyToGo: z.record(z.string(), z.number()),
  /** Your order for non-lane sections (section ids); unlisted ones follow by creation. */
  sectionOrder: z.array(z.string()),
  /** Lane → section id, pinned so renaming a lane's section keeps its role. */
  /** Which machine each thread runs on, for the sidebar's machine filter. */
  machines: machinesSchema,
  laneSections: z.object({ priority: z.string(), waiting: z.string(), later: z.string(), low: z.string() }).partial(),
  /** Per section (section key → project id): where "New thread here" starts threads. */
  sectionProjects: z.record(z.string(), z.string()),
  /** Per thread: every PR it created (any repo), stack-ordered. */
  threadPrs: z.record(z.string(), z.array(prStatusSchema)),
  /** Running threads: run start and last event, for elapsed time and stuck detection. */
  running: z.record(z.string(), z.object({ since: z.number(), lastEventAt: z.number() })),
  /** Per thread: what the plugin is waiting on for it (CI, release, auto-continue). */
  watching: z.record(z.string(), z.object({ kind: z.enum(["ci", "release", "continue"]), label: z.string() })),
  snoozedSectionId: z.string().nullable(),
  snoozes: z.record(z.string(), snoozeSchema),
  tags: z.record(z.string(), z.array(z.string())),
  /** Threads you marked as Focus (thread id → when). They keep their section. */
  focused: z.record(z.string(), z.number()),
  /** Deadlines (thread id → date, why, and who set it). */
  due: z.record(z.string(), z.object({ at: z.number(), reason: z.string().nullable(), source: z.enum(["agent", "you"]), setAt: z.number() })),
});
export type FlowState = z.infer<typeof stateSchema>;

const conductorStatusSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  active: z.boolean(),
  threadId: z.string().nullable(),
  open: z.number(),
  undelivered: z.number(),
  lastWakeAt: z.number().optional(),
  projectId: z.string().optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
});
export type ConductorStatus = z.infer<typeof conductorStatusSchema>;
const conductorPageSchema = z.object({
  workspaceId: z.string(),
  threadId: z.string().nullable(),
  threadStatus: z.string().nullable(),
  active: z.boolean(),
  log: z.array(z.object({ id: z.number(), at: z.number(), kind: z.string(), threadId: z.string().nullable(), text: z.string() })),
  open: z.number(),
  lastWakeAt: z.number().nullable(),
});
export type ConductorPage = z.infer<typeof conductorPageSchema>;
const fleetRowSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  parentTitle: z.string().nullable(),
  projectId: z.string(),
  state: z.string(),
  group: z.enum(TRIAGE_GROUP_KEYS),
  reason: z.string(),
  needsYou: z.boolean(),
  unread: z.boolean(),
  prs: z.array(z.object({ repo: z.string(), number: z.number(), attention: z.string(), url: z.string() })),
  next: z.string().nullable(),
  blocked: z.string().nullable(),
});
export type ConductorFleetRow = z.infer<typeof fleetRowSchema>;
const conductorBriefSchema = z.object({ workspaceId: z.string(), threadId: z.string(), at: z.number(), item: briefingItemSchema });
export type ConductorBrief = z.infer<typeof conductorBriefSchema>;
const conductorFeedSchema = z.object({
  since: z.number(),
  merged: z.number(),
  archived: z.number(),
  forwarded: z.number(),
  refused: z.number(),
  wakeupsSpared: z.number(),
  tokensSpared: z.number(),
  entries: z.array(
    z.object({
      id: z.number(),
      at: z.number(),
      kind: z.string(),
      workspaceId: z.string(),
      workspace: z.string(),
      threadId: z.string().nullable(),
      title: z.string(),
      text: z.string(),
      savedTokens: z.number().nullable(),
    }),
  ),
});
export type ConductorFeed = z.infer<typeof conductorFeedSchema>;

export const rpcContract = defineRpcContract({
  conductor_list: {
    input: z.null(),
    output: z.object({ enabled: z.boolean(), conductors: z.array(conductorStatusSchema) }),
  },
  conductor_page: { input: z.object({ workspaceId: z.string().min(1).max(80) }), output: conductorPageSchema },
  conductor_briefs: { input: z.null(), output: z.object({ briefs: z.array(conductorBriefSchema) }) },
  conductor_feed: { input: z.object({ since: z.number() }), output: conductorFeedSchema },
  conductor_fleet: { input: z.object({ workspaceId: z.string().min(1).max(80) }), output: z.array(fleetRowSchema) },
  conductor_start: {
    input: z.object({
      workspaceId: z.string().min(1).max(80),
      projectId: z.string().max(200).optional(),
      providerId: z.string().max(200).optional(),
      model: z.string().max(200).optional(),
    }),
    output: z.object({ threadId: z.string() }),
  },
  conductor_stop: { input: z.object({ workspaceId: z.string().min(1).max(80) }), output: z.object({ ok: z.boolean() }) },
  conductor_wake: { input: z.object({ workspaceId: z.string().min(1).max(80) }), output: z.object({ result: z.string() }) },
  workspaces_get: { input: z.null(), output: workspaceStateSchema },
  workspace_save: { input: workspaceSchema.extend({ id: z.string().nullable() }), output: workspaceSchema },
  workspace_remove: { input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) },
  workspace_assign: { input: z.object({ threadId: z.string(), workspaceId: z.string().nullable(), automatic: z.boolean() }), output: z.object({ ok: z.boolean() }) },
  state_get: { input: z.null(), output: stateSchema },
  auto_continue_get: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ enabled: z.boolean(), scheduledAt: z.number().nullable() }),
  },
  wakeups_get: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      autoContinue: z.object({ enabled: z.boolean(), scheduledAt: z.number().nullable() }),
      watches: z.array(z.object({ kind: z.enum(["ci", "release"]), key: z.string(), label: z.string() })),
    }),
  },
  wakeup_cancel: {
    input: z.object({ threadId: z.string(), kind: z.enum(["ci", "release"]), key: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  auto_continue_set: {
    input: z.object({ threadId: z.string(), enabled: z.boolean() }),
    output: z.object({ enabled: z.boolean(), scheduledAt: z.number().nullable() }),
  },
  snooze: {
    input: z.object({
      threadId: z.string(),
      when: z.string().min(1).max(64),
      note: z.string().max(2000).nullable(),
      /** `when` resolved in the browser's time zone; the server's may differ (bb Connect). */
      until: z.number().optional(),
    }),
    output: snoozeSchema,
  },
  unsnooze: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
  tags_set: {
    input: z.object({
      threadId: z.string(),
      tags: z.array(z.string().trim().min(1).max(40)).max(10),
    }),
    output: z.object({ tags: z.array(z.string()) }),
  },
  due_set: {
    /** `at` is resolved in the browser's time zone, as with snooze; null clears the date. */
    input: z.object({ threadId: z.string().min(1).max(200), at: z.number().nullable(), reason: z.string().max(300).nullable() }),
    output: z.object({ ok: z.boolean() }),
  },
  focus_set: {
    input: z.object({ threadId: z.string().min(1).max(200), focused: z.boolean() }),
    output: z.object({ focused: z.boolean() }),
  },
  digest_list: {
    input: z.object({ refresh: z.boolean() }),
    output: z.object({ generatedAt: z.number(), items: z.array(digestItemSchema) }),
  },
  digest_keep: {
    input: z.object({
      threadIds: z.array(z.string()).max(500),
      days: z.number().int().min(1).max(90),
    }),
    output: z.object({ kept: z.number() }),
  },
  archive: {
    input: z.object({ threadIds: z.array(z.string()).min(1).max(500) }),
    output: z.object({ archived: z.number(), failed: z.array(z.string()) }),
  },
  thread_status: { input: z.object({ threadId: z.string().min(1).max(200), refresh: z.boolean().default(true) }), output: threadStatusSchema.nullable() },
  thread_preview: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      goal: z.string(),
      done: z.string(),
      next: z.string(),
      blocked: z.string(),
      latest: z.string(),
      prompts: z.number(),
    }),
  },
  catch_up_card: {
    input: z.object({ threadId: z.string().min(1).max(200), since: z.number().nullable() }),
    output: z.object({
      since: z.object({
        turns: z.number(),
        yourPrompts: z.number(),
        otherPrompts: z.number(),
        more: z.boolean(),
        firstAt: z.number().nullable(),
      }),
    }),
  },
  thread_stop: { input: z.object({ threadId: z.string() }), output: z.object({ ok: z.boolean() }) },
  thread_watch_ci: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ watching: z.array(z.string()) }),
  },
  pr_link: {
    input: z.object({ threadId: z.string(), url: z.string(), remove: z.boolean() }),
    output: z.object({ ok: z.boolean() }),
  },
  pr_refresh: { input: z.null(), output: z.object({ ok: z.boolean() }) },
  next_needs_me: {
    input: z.object({ archiveThreadId: z.string().nullable() }),
    output: z.object({ opened: z.string().nullable() }),
  },
  /** The threads that need you, most urgent first: what "next" walks through. */
  needs_me_queue: { input: z.null(), output: z.object({ threadIds: z.array(z.string()) }) },
  plan_models: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      pending: z.boolean(),
      current: z.string().nullable(),
      models: z.array(z.object({ model: z.string(), name: z.string() })),
    }),
  },
  plan_approve: {
    input: z.object({ threadId: z.string(), model: z.string().min(1).nullable() }),
    output: z.object({ ok: z.boolean() }),
  },
  decision_options: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      mode: z.enum(["go", "choice", "multi"]),
      options: z.array(z.object({ n: z.number(), text: z.string(), recommended: z.boolean() })),
      /** One entry per list when the reply ends with several (a path forward and a decision); absent or one entry otherwise. */
      groups: z
        .array(
          z.object({
            mode: z.enum(["go", "choice", "multi"]),
            title: z.string(),
            label: z.string(),
            options: z.array(z.object({ n: z.number(), text: z.string(), recommended: z.boolean() })),
          }),
        )
        .optional(),
    }),
  },
  thread_reply: {
    // Room for a long status report prompt; bb takes far longer messages than this.
    input: z.object({ threadId: z.string(), text: z.string().min(1).max(20_000) }),
    output: z.object({ ok: z.boolean() }),
  },
  your_move: {
    input: z.null(),
    output: z.object({
      items: z.array(
        z.object({ threadId: z.string(), title: z.string(), projectId: z.string(), since: z.number(), ask: z.string() }),
      ),
    }),
  },
  unreleased: {
    input: z.object({ projectId: z.string(), refresh: z.boolean() }),
    output: unreleasedSchema,
  },
  leftovers_get: {
    input: z.object({ refresh: z.boolean() }),
    output: z.object({ checkedAt: z.number(), items: z.array(leftoverSchema) }),
  },
  leftovers_clean: {
    input: z.null(),
    output: z.object({ removed: z.array(z.string()), kept: z.array(z.string()) }),
  },
  section_order_set: {
    input: z.object({ order: z.array(z.string()).max(200) }),
    output: z.object({ ok: z.boolean() }),
  },
  section_project_set: {
    input: z.object({ section: z.string(), projectId: z.string().nullable() }),
    output: z.object({ ok: z.boolean() }),
  },
  focus_report: {
    input: focusReportSchema,
    output: z.object({ ok: z.boolean() }),
  },
  repo_status: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      projectName: z.string(),
      commands: z.array(repoCommandSchema),
      scripts: z.array(repoScriptSchema),
      scriptsError: z.string().nullable(),
      runs: z.array(devRunSchema),
    }),
  },
  repo_run: {
    input: z.object({ threadId: z.string(), commandId: z.string() }),
    output: devRunSchema,
  },
  repo_stop: {
    input: z.object({ threadId: z.string(), commandId: z.string() }),
    output: z.object({ stopped: z.boolean() }),
  },
  repo_config_get: {
    input: z.null(),
    output: z.object({
      defaults: z.record(z.string(), z.array(repoCommandSchema)),
      overrides: z.record(z.string(), z.array(repoCommandSchema)),
    }),
  },
  repo_config_set: {
    input: z.object({ projectName: z.string(), commands: z.array(repoCommandSchema).nullable() }),
    output: z.object({ ok: z.boolean() }),
  },
  migrate_areas: {
    input: z.object({
      sectionIds: z.array(z.string()).max(20),
      moveToSectionId: z.string().nullable(),
    }),
    output: z.object({ tagged: z.number() }),
  },
});
