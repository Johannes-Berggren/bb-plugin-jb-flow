// @vitest-environment node
// What the server registers (rpc methods, agent tools, CLI commands, schedules,
// thread event handlers) and how a few of its handlers behave, end to end
// against bb's fake plugin host. Written before server.ts was split into
// modules, so the split can be checked against the server as it was.
import { describe, expect, it } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const DAY = 86_400_000;

type Section = { id: string; name: string };

function thread(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: "proj_web",
    title: `Thread ${id}`,
    titleFallback: null,
    status: "idle",
    sectionId: null as string | null,
    parentThreadId: null,
    pinnedAt: null,
    archivedAt: null,
    deletedAt: null,
    visibility: "visible",
    hasPendingInteraction: false,
    latestAttentionAt: null,
    lastReadAt: null,
    createdAt: Date.now() - 30 * DAY,
    updatedAt: Date.now() - 30 * DAY,
    ...overrides,
  };
}

/** A fake host whose sections and threads behave like a small bb. */
function host(options: { settings?: Record<string, boolean | number | string>; threads?: ReturnType<typeof thread>[]; output?: string } = {}) {
  const sections: Section[] = [{ id: "sec_a", name: "Area" }];
  const threads = new Map((options.threads ?? []).map((entry) => [entry.id, { ...entry }]));
  const fake = createFakePluginHost({
    pluginId: "jb-flow",
    settings: options.settings ?? {},
    sdk: {
      projects: { list: async () => [] },
      threads: {
        list: async (args: { sectionId?: string; offset: number }) =>
          args.offset > 0 ? [] : [...threads.values()].filter((entry) => args.sectionId === undefined || entry.sectionId === args.sectionId),
        get: async ({ threadId }: { threadId: string }) => threads.get(threadId) ?? thread(threadId),
        update: async ({ threadId, sectionId }: { threadId: string; sectionId: string | null }) => {
          const current = threads.get(threadId) ?? thread(threadId);
          threads.set(threadId, { ...current, sectionId });
          return threads.get(threadId);
        },
        markUnread: async () => ({}),
        send: async () => ({}),
        stop: async () => ({}),
        open: async () => ({}),
        archive: async ({ threadId }: { threadId: string }) => ({ archivedThreadIds: [threadId] }),
        output: async () => ({ output: options.output ?? null }),
        conversationOutline: async () => ({
          items: [
            { role: "user", preview: "Ship the **billing** page" },
            { role: "assistant", preview: "Opened the PR   and waiting on review." },
          ],
        }),
        timeline: async () => ({ rows: [], timelinePage: { olderCursor: null } }),
      },
      threadSections: {
        list: async () => sections.map((section) => ({ ...section })),
        create: async ({ name }: { name: string }) => {
          const section = { id: `sec_${sections.length}`, name };
          sections.push(section);
          return section;
        },
      },
    } as never,
  });
  return { ...fake, sections, threads };
}

async function state(harness: ReturnType<typeof host>["harness"]) {
  return (await harness.callRpc("state_get", null)) as Record<string, unknown>;
}

describe("server surface", () => {
  it("registers the same rpc methods, tools, CLI commands, schedules and event handlers", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    const { registrations } = harness;
    expect([...registrations.rpcMethods].sort()).toMatchInlineSnapshot(`
      [
        "archive",
        "auto_continue_get",
        "auto_continue_set",
        "catch_up_card",
        "conductor_briefs",
        "conductor_feed",
        "conductor_fleet",
        "conductor_list",
        "conductor_page",
        "conductor_start",
        "conductor_stop",
        "conductor_wake",
        "decision_options",
        "digest_keep",
        "digest_list",
        "due_set",
        "focus_report",
        "focus_set",
        "leftovers_clean",
        "leftovers_get",
        "migrate_areas",
        "next_needs_me",
        "plan_approve",
        "plan_models",
        "pr_link",
        "pr_refresh",
        "repo_config_get",
        "repo_config_set",
        "repo_run",
        "repo_status",
        "repo_stop",
        "section_order_set",
        "section_project_set",
        "snooze",
        "state_get",
        "tags_set",
        "thread_preview",
        "thread_reply",
        "thread_status",
        "thread_stop",
        "thread_watch_ci",
        "unreleased",
        "unsnooze",
        "wakeup_cancel",
        "wakeups_get",
        "workspace_assign",
        "workspace_remove",
        "workspace_save",
        "workspaces_get",
        "your_move",
      ]
    `);
    expect(registrations.agentTools.map((tool) => tool.name)).toMatchInlineSnapshot(`
      [
        "snooze_thread",
        "wait_for_ci",
        "pr_status",
        "set_thread_due",
        "conductor_inbox",
        "fleet_status",
        "thread_brief",
        "merge_pr",
        "rerun_failed",
        "forward_to_thread",
        "thread_action",
        "post_briefing",
        "conductor_memory",
      ]
    `);
    expect(registrations.cli?.name).toBe("jb-flow");
    expect(registrations.cli?.commands.map((command) => command.name)).toMatchInlineSnapshot(`
      [
        "workspaces",
        "snooze",
        "due",
        "unsnooze",
        "snoozed",
        "wake-now",
        "leftovers",
        "deck",
        "pr-radar",
        "your-move",
        "focus-clients",
        "focused",
        "decisions",
        "stop",
        "tell",
        "needs-me",
        "next",
        "now",
        "wait-ci",
        "prs",
        "pr-link",
        "watches",
        "release-wait",
        "check-now",
        "repo",
        "repo-run",
        "repo-stop",
        "repo-config",
        "digest",
        "conductor",
      ]
    `);
    expect(registrations.schedules.map((schedule) => `${schedule.name} ${schedule.cron}`)).toMatchInlineSnapshot(`
      [
        "pr-refresh */3 * * * *",
        "release-watch */3 * * * *",
        "ci-watch */2 * * * *",
        "leftover-worktrees 0 8 * * 1",
        "wake-snoozed * * * * *",
        "stale-digest 0 8 * * 1-5",
        "conductor-wake * * * * *",
      ]
    `);
    expect(
      Object.fromEntries(Object.entries(registrations.threadEventHandlers).filter(([, count]) => count > 0)),
    ).toMatchInlineSnapshot(`
      {
        "experimental_thread.events": 1,
        "thread.active": 4,
        "thread.archived": 6,
        "thread.deleted": 4,
        "thread.failed": 1,
        "thread.idle": 7,
      }
    `);
  });

  it("gives a worker thread its tools and the hand-back instructions", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    const config = await harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "thr_a" } }));
    expect(config.tools.map((tool) => tool.name)).toMatchInlineSnapshot(`
      [
        "snooze_thread",
        "wait_for_ci",
        "pr_status",
        "set_thread_due",
      ]
    `);
    expect(config.instructions).toContain("**Goal:**");
  });

  it("prints the CLI usage", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    const result = await harness.runCli(["help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatchInlineSnapshot(`
      "Usage:
        bb jb-flow snooze <thread-id|--self> <when> [--note <text>]
        bb jb-flow unsnooze <thread-id|--self>
        bb jb-flow due <thread-id|--self> <when|none> [--reason <text>]
        bb jb-flow snoozed [--json]
        bb jb-flow wake-now
        bb jb-flow digest [--refresh] [--json]
        bb jb-flow focused [--json]                          The thread focused in BB
        bb jb-flow stop [<thread-id>|--focused]
        bb jb-flow tell <text…> [--thread <id>]              Send a message (default: focused thread)
        bb jb-flow needs-me [--json]                         Threads waiting on you
        bb jb-flow next                                      Open the next thread that needs you
        bb jb-flow wait-ci [--pr <n>] [--repo owner/name] [--for checks|reviews|both] [--after-green merge|continue|nothing] [--self|<thread-id>]
        bb jb-flow watches [--json]                          Auto-continues, release waiters, CI watches
        bb jb-flow conductor [status|start|stop|wake|inbox|briefing|log] [<workspace-id>] [--json]
        bb jb-flow prs [--self|<thread-id>] [--json]         PRs a thread created (all repos, stack order)
        bb jb-flow pr-link <pr-url> [--self|<thread-id>] [--remove]
        bb jb-flow release-wait [--self|<thread-id>]         Wake this thread on the next release
        bb jb-flow check-now                                 Run the release and CI checks immediately
        bb jb-flow repo [--self|<thread-id>]                 List repo commands and runs
        bb jb-flow repo-run <command-id> [--self|<thread-id>]
        bb jb-flow repo-stop <command-id> [--self|<thread-id>]
        bb jb-flow repo-config <project-name> <json|reset>

      <when>: 30m, 2h, 3d, 1w, today, tonight, tomorrow, mon…sun, next-week, YYYY-MM-DD, YYYY-MM-DDTHH:MM"
    `);
  });
});

describe("server handlers", () => {
  it("snoozes into a new Snoozed section and wakes back into the old one", async () => {
    const { bb, harness, threads, sections } = host({ threads: [thread("thr_a", { sectionId: "sec_a" })] });
    await plugin(bb);
    const record = (await harness.callRpc("snooze", { threadId: "thr_a", when: "2d", note: "check the review" })) as Record<string, unknown>;
    expect(record).toMatchObject({ note: "check the review", fromSectionId: "sec_a" });
    const snoozed = sections.find((section) => section.name === "😴 Snoozed")!;
    expect(threads.get("thr_a")?.sectionId).toBe(snoozed.id);
    const after = await state(harness);
    expect(after.snoozedSectionId).toBe(snoozed.id);
    expect(Object.keys(after.snoozes as object)).toEqual(["thr_a"]);
    const listed = await harness.runCli(["snoozed", "--json"]);
    expect(Object.keys(JSON.parse(listed.stdout))).toEqual(["thr_a"]);
    expect(await harness.callRpc("unsnooze", { threadId: "thr_a" })).toEqual({ removed: true });
    expect(threads.get("thr_a")?.sectionId).toBe("sec_a");
    expect(await harness.callRpc("unsnooze", { threadId: "thr_a" })).toEqual({ removed: false });
  });

  it("wakes a due snooze on the minute schedule and sends its note", async () => {
    const { bb, harness, threads, sections } = host();
    sections.push({ id: "sec_snz", name: "😴 Snoozed" });
    threads.set("thr_a", thread("thr_a", { sectionId: "sec_snz" }));
    await bb.storage.kv.set("snoozes", {
      thr_a: { until: Date.now() - 1000, note: "look again", fromSectionId: "sec_a", snoozedAt: Date.now() - DAY },
    });
    await plugin(bb);
    await harness.runSchedule("wake-snoozed");
    expect(threads.get("thr_a")?.sectionId).toBe("sec_a");
    expect(harness.sdk.callsTo("threads.markUnread")).toEqual([[{ threadId: "thr_a" }]]);
    expect(JSON.stringify(harness.sdk.callsTo("threads.send"))).toContain("⏰ Snooze reminder: look again");
    expect(await bb.storage.kv.get("snoozes")).toEqual({});
    expect((await harness.runCli(["wake-now"])).stdout).toBe("Woke 0 thread(s).");
  });

  it("stores tags, section order and section projects in the state", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    expect(await harness.callRpc("tags_set", { threadId: "thr_a", tags: ["billing", "billing", "api"] })).toEqual({ tags: ["billing", "api"] });
    await harness.callRpc("section_order_set", { order: ["sec_b", "sec_a"] });
    await harness.callRpc("section_project_set", { section: "sec_a", projectId: "proj_web" });
    await harness.callRpc("section_project_set", { section: "sec_b", projectId: "proj_api" });
    await harness.callRpc("section_project_set", { section: "sec_b", projectId: null });
    const after = await state(harness);
    expect(after).toMatchObject({ tags: { thr_a: ["billing", "api"] }, sectionOrder: ["sec_b", "sec_a"], sectionProjects: { sec_a: "proj_web" } });
    expect(Object.keys(after).sort()).toMatchInlineSnapshot(`
      [
        "awaiting",
        "due",
        "focused",
        "laneSections",
        "machines",
        "projectShortNames",
        "promised",
        "readyToGo",
        "running",
        "sectionOrder",
        "sectionProjects",
        "snoozedSectionId",
        "snoozes",
        "stripProjectPrefixes",
        "tags",
        "threadPrs",
        "waitingOthers",
        "watching",
      ]
    `);
  });

  it("turns a section into a tag", async () => {
    const { bb, harness, threads } = host({ threads: [thread("thr_a", { sectionId: "sec_a" })] });
    await plugin(bb);
    expect(await harness.callRpc("migrate_areas", { sectionIds: ["sec_a"], moveToSectionId: null })).toEqual({ tagged: 1 });
    expect((await state(harness)).tags).toEqual({ thr_a: ["Area"] });
    expect(threads.get("thr_a")?.sectionId).toBeNull();
  });

  it("forgets an archived thread's tags", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    await harness.callRpc("tags_set", { threadId: "thr_a", tags: ["billing"] });
    await harness.emitThreadEvent("thread.archived", { thread: { id: "thr_a" } } as never);
    expect((await state(harness)).tags).toEqual({});
  });

  it("builds the stale digest, keeps threads out of it and archives them", async () => {
    const { bb, harness } = host({ threads: [thread("thr_a"), thread("thr_b"), thread("thr_new", { updatedAt: Date.now() })] });
    await plugin(bb);
    const digest = (await harness.callRpc("digest_list", { refresh: true })) as { items: Array<Record<string, unknown>> };
    expect(digest.items).toMatchInlineSnapshot(`
      [
        {
          "idleDays": 30,
          "projectId": "proj_web",
          "summary": "Opened the PR and waiting on review.",
          "threadId": "thr_a",
          "title": "Thread thr_a",
        },
        {
          "idleDays": 30,
          "projectId": "proj_web",
          "summary": "Opened the PR and waiting on review.",
          "threadId": "thr_b",
          "title": "Thread thr_b",
        },
      ]
    `);
    expect(await harness.callRpc("digest_keep", { threadIds: ["thr_a"], days: 3 })).toEqual({ kept: 1 });
    const kept = (await harness.callRpc("digest_list", { refresh: false })) as { items: Array<{ threadId: string }> };
    expect(kept.items.map((item) => item.threadId)).toEqual(["thr_b"]);
    expect(await harness.callRpc("archive", { threadIds: ["thr_b"] })).toEqual({ archived: 1, failed: [] });
    const cleared = (await harness.callRpc("digest_list", { refresh: false })) as { items: unknown[] };
    expect(cleared.items).toEqual([]);
    const cli = await harness.runCli(["digest"]);
    expect(cli.stdout).toMatch(/^0 stale thread\(s\), generated /);
  });

  it("runs the morning digest schedule", async () => {
    const { bb, harness } = host({ threads: [thread("thr_a")] });
    await plugin(bb);
    await harness.runSchedule("stale-digest");
    expect(harness.logEntries.map((entry) => entry.message)).toContain("digest: 1 stale thread(s)");
  });

  it("switches auto-continue per thread", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    expect(await harness.callRpc("auto_continue_get", { threadId: "thr_a" })).toEqual({ enabled: false, scheduledAt: null });
    expect(await harness.callRpc("auto_continue_set", { threadId: "thr_a", enabled: true })).toEqual({ enabled: true, scheduledAt: null });
    expect(await harness.callRpc("wakeups_get", { threadId: "thr_a" })).toEqual({ autoContinue: { enabled: true, scheduledAt: null }, watches: [] });
    expect(await bb.storage.kv.get("autoContinueThreads")).toEqual({ thr_a: true });
  });

  it("sets and clears a deadline from the agent tool and the CLI", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    const set = await harness.callAgentTool("set_thread_due", { when: "2031-03-04", reason: "invoice" }, { threadId: "thr_a" });
    expect(String(set)).toMatch(/^Deadline set: /);
    expect((await state(harness)).due).toMatchObject({ thr_a: { reason: "invoice", source: "agent" } });
    const cleared = await harness.runCli(["due", "thr_a", "none"]);
    expect(cleared.stdout).toBe("Cleared the deadline on thr_a.");
    expect((await state(harness)).due).toEqual({});
  });

  it("answers the snooze and pr_status tools", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    expect(String(await harness.callAgentTool("snooze_thread", { when: "3d", note: "ping Sam" }, { threadId: "thr_a" }))).toMatch(
      /^Snoozed until .+ with reminder: ping Sam\.$/,
    );
    expect(await harness.callAgentTool("pr_status", {}, { threadId: "thr_a" })).toMatchInlineSnapshot(`"No PRs linked to this thread. PRs opened with gh pr create are linked automatically; others via \`bb jb-flow pr-link <url> --self\`."`);
  });

  it("previews a thread from its last reply and outline", async () => {
    const { bb, harness } = host({
      output: "**Goal:** Ship [billing](https://example.com)\n**Done:** Opened the PR\n**Next:** Merge it\nThe page is up.\n1. Merge\n2. Wait",
    });
    await plugin(bb);
    expect(await harness.callRpc("thread_preview", { threadId: "thr_a" })).toMatchInlineSnapshot(`
      {
        "blocked": "",
        "done": "Opened the PR",
        "goal": "Ship billing",
        "latest": "The page is up. 1. Merge 2. Wait",
        "next": "Merge it",
        "prompts": 1,
      }
    `);
    expect(await harness.callRpc("decision_options", { threadId: "thr_a" })).toMatchInlineSnapshot(`
      {
        "mode": "choice",
        "options": [],
      }
    `);
    expect(await harness.callRpc("catch_up_card", { threadId: "thr_a", since: null })).toMatchInlineSnapshot(`
      {
        "since": {
          "firstAt": null,
          "more": false,
          "otherPrompts": 0,
          "turns": 0,
          "yourPrompts": 0,
        },
      }
    `);
  });

  it("answers the read-only CLI commands", async () => {
    const { bb, harness } = host({ threads: [thread("thr_a", { status: "error" }), thread("thr_b")] });
    await plugin(bb);
    const run = async (...argv: string[]) => {
      const result = await harness.runCli(argv);
      return `${result.exitCode} ${result.stdout || result.stderr}`;
    };
    expect(await run("watches")).toMatchInlineSnapshot(`"0 Nothing watched."`);
    expect(await run("your-move", "--json")).toMatchInlineSnapshot(`"0 {"count":0,"items":[]}"`);
    expect(await run("now", "--json")).toMatchInlineSnapshot(`"0 {"count":1,"threads":[{"id":"thr_a","title":"Thread thr_a","state":"blocked","reason":"failed · 30d","focused":false,"dueAt":null}],"moving":[]}"`);
    expect(await run("needs-me", "--json")).toMatchInlineSnapshot(`"0 {"count":1,"threads":[{"id":"thr_a","title":"Thread thr_a","status":"error"}]}"`);
    expect(await run("pr-radar", "--json")).toMatchInlineSnapshot(`"0 {"broken":[],"ready":[]}"`);
    expect(await run("conductor")).toMatchInlineSnapshot(`"0 No conductors. Turn on Conductor in the settings, then: bb jb-flow conductor start <workspace-id>"`);
    expect(await run("focused")).toMatchInlineSnapshot(`"1 No focused thread."`);
    expect(await run("deck")).toMatchInlineSnapshot(`"0 {"version":1,"focused":{"threadId":null,"title":null,"status":null,"options":[],"workspace":null},"needsMe":{"count":1},"yourMove":{"count":0,"oldestSince":null},"prRadar":{"broken":0,"ready":0},"now":{"count":1,"top":{"id":"thr_a","title":"Thread thr_a","state":"blocked","reason":"failed · 30d","focused":false,"dueAt":null}}}"`);
    expect(await run("workspaces")).toMatchInlineSnapshot(`"0 {"workspaces":[],"threadWorkspaces":{}}"`);
    expect(await run("nonsense")).toContain("Usage:");
    const classify = JSON.parse((await harness.runCli(["classify"])).stdout) as Array<Record<string, unknown>>;
    expect(classify.map(({ id, group, section }) => ({ id, group, section }))).toMatchInlineSnapshot(`
      [
        {
          "group": "needs-me",
          "id": "thr_a",
          "section": "Active",
        },
        {
          "group": "done",
          "id": "thr_b",
          "section": "Active",
        },
      ]
    `);
  });

  it("the deck snapshot names the focused thread's workspace and its color", async () => {
    const focusedThread = thread("thr_a");
    const { bb, harness } = host({ threads: [focusedThread] });
    await bb.storage.kv.set("workspaces", [
      { id: "acme", name: "Acme", projectIds: [focusedThread.projectId], sectionIds: [], pluginIds: [], sectionOrder: [], color: "teal" },
    ]);
    await plugin(bb);
    await harness.callRpc("focus_report", { clientId: "c1", threadId: "thr_a", windowFocused: true, interactedAt: Date.now(), origin: "http://localhost", userAgent: "test" });
    const deck = JSON.parse((await harness.runCli(["deck"])).stdout) as { focused: { threadId: string; workspace: unknown } };
    expect(deck.focused.threadId).toBe("thr_a");
    // The color by name for BB's own styles, and as sRGB for a key that can't read them.
    expect(deck.focused.workspace).toEqual({ id: "acme", name: "Acme", color: "teal", hex: "#47c7c7" });
  });

  it("opens the next thread that needs you", async () => {
    const { bb, harness } = host({ threads: [thread("thr_a", { status: "error" })] });
    await plugin(bb);
    expect(await harness.callRpc("next_needs_me", { archiveThreadId: null })).toEqual({ opened: "thr_a" });
    expect(harness.sdk.callsTo("threads.open")).toEqual([[{ threadId: "thr_a", file: null }]]);
  });

  it("lists the conductor rpc state while the setting is on", async () => {
    const { bb, harness } = host({ settings: { conductor: true } });
    await plugin(bb);
    expect(await harness.callRpc("conductor_briefs", null)).toEqual({ briefs: [] });
    expect(await harness.callRpc("conductor_list", null)).toEqual({ enabled: true, conductors: [] });
  });
});
