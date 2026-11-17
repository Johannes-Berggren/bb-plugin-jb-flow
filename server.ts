import { createWorkspaceStorage } from "./workspace-storage";
import { workspaceSchema } from "./workspaces";
import { createThreadStatus } from "./thread-status";
import { handBackInstructions } from "./status-prompt";
// jb-flow: snooze threads until a date, a daily stale-thread digest, and the
// state behind the Triage thread list in app.tsx.
//
// State lives in bb.storage.kv because thread plugin metadata is not part of
// thread list rows; the sidebar needs every snooze and tag in one read.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createActivity } from "./activity";
import { createAwaiting } from "./awaiting";
import { createLeftovers } from "./leftovers";
import { createNowStore } from "./now-store";
import { createFocus, needsAttention } from "./focus";
import { createPrTracker } from "./prs";
import { createUnreleased } from "./unreleased";
import { createMachines } from "./machines";
import { createRepoCommands, repoCommandSchema } from "./repo-commands";
import { loadLocalConfig, readLocalConfigFile } from "./local-config";
import { createChanges } from "./changes";
import { createThreadLists } from "./thread-cache";
import { createSnoozes, registerSnoozeTool } from "./snooze";
import { createStaleDigest } from "./stale-digest";
import { autoContinueOverridesFor, createWakeups } from "./wakeups";
import { createPrCi, registerPrTools } from "./pr-ci";
import { createNowQueue, registerDueFromStatus, registerDueTool } from "./now-queue";
import { createDeck } from "./deck";
import { createTriageState } from "./triage-state";
import { threadPreviewRpc } from "./thread-preview";
import { createConductorWiring } from "./conductor-wiring";
import { formatDue, formatWhen, parseDue } from "./when";
import { AFTER_GREEN } from "./conductor-routing";
import { createConductor } from "./conductor";
import { createConductorStore } from "./conductor-store";
import { migrate } from "./migrations";
import { quietFor } from "./sidebar-groups";
import { listLiveThreads } from "./thread-list";
import { createWatchers } from "./watchers";
import { approvePlan, planModels } from "./plan-model";
import { rpcContract } from "./rpc-contract";

export { rpcContract } from "./rpc-contract";
export type {
  ConductorBrief,
  ConductorFeed,
  ConductorFleetRow,
  ConductorPage,
  ConductorStatus,
  DigestItem,
  FlowState,
  Snooze,
} from "./rpc-contract";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    workspaces: {
      type: "boolean",
      label: "Workspaces",
      description:
        "Tabs across the top of BB that group projects, threads, sections and plugin tools. Off shows everything as before.",
      default: true,
    },
    workspaceSwipe: {
      type: "boolean",
      label: "Swipe between workspaces",
      description: "Swipe sideways with two fingers on the sidebar to move to the next or previous workspace tab. The sidebar slides as the workspace changes.",
      default: false,
    },
    countSnoozedInTabs: {
      type: "boolean",
      label: "Count snoozed threads in workspace tabs",
      description: "The number on each workspace tab includes threads that are snoozed. Off counts only threads that aren't snoozed.",
      default: false,
    },
    palette: {
      type: "boolean",
      label: "⌘K opens the JB Flow palette",
      description:
        "BB's Search threads key (⌘K unless you changed it) opens a palette that also finds messages, PRs, workspaces and projects, shows what needs you, and acts on any thread with Tab. BB's own search stays under Open quick palette → Search threads. Off gives the key back to BB.",
      default: true,
    },
    tabSwitcher: {
      type: "boolean",
      label: "Ctrl+Tab switches threads and workspaces",
      description:
        "Hold Ctrl and tap Tab to step back through the threads you viewed last; let go to open one. A quick Ctrl+Tab flips to the previous thread. Ctrl+` does the same for workspace tabs. Desktop app only: in a web browser, Ctrl+Tab belongs to the browser. Off leaves the keys alone.",
      default: true,
    },
    catchUp: {
      type: "boolean",
      label: "Catch up",
      description:
        "Go through unread threads one card at a time: mark read, keep unread, reply, snooze or archive. Adds a Catch up page with an unread count, a command (⌥⇧C), a palette action and a line on the home page. Off hides them.",
      default: true,
    },
    createdRowOrder: {
      type: "boolean",
      label: "Keep threads in creation order",
      description: "Triage list rows stay put, newest thread first, instead of moving to the top on new activity.",
      default: false,
    },
    nowQueue: {
      type: "boolean",
      label: "Now and Focus",
      description:
        "A ranked Now group at the top of the Triage list replaces Needs me: what's blocked on you, threads you mark as Focus (press f on a row) that are waiting on you, and threads with a deadline coming up (press d, or agents set one). Off restores Needs me.",
      default: true,
    },
    focusLimit: {
      type: "number",
      label: "Focus limit",
      description: "Focus only works while it's short. Marking more than this many threads asks you to drop one first, or keep them all.",
      default: 7,
    },
    polishShell: {
      type: "boolean",
      label: "Polish the entire BB interface",
      description: "Refine the sidebar, composer, conversation, panel tabs and menus across BB. Off restores BB's standard styling.",
      default: true,
    },
    highlightActivePane: {
      type: "boolean",
      label: "Frame the active split pane",
      description:
        "In split view, a frame marks the pane you're working in, and each pane shows its workspace's color (set under Workspaces). Off restores BB's standard panes.",
      default: true,
    },
    threadMonitor: {
      type: "boolean",
      label: "Thread monitor",
      description:
        "Keep the activity card visible when a thread is idle, with the agent's last status report (Just did, Next step, Goal), progress bars and an Update status button.",
      default: true,
    },
    statusPrompt: {
      type: "string",
      label: "Status report prompt",
      description:
        "What Update status sends to the agent. Leave empty for the built-in report: Goal, Done, Next, Blocked, then PR stack, progress bars, architecture changes and next steps. The monitor reads **Goal:**, **Done:**, **Next:**, **Blocked:** and a ### Progress block.",
      experimental_multiline: true,
      default: "",
    },
    autoStatus: {
      type: "boolean",
      label: "Status report at hand-back",
      description:
        "Ask agents to end replies that hand the thread back to you with the status report above, and to end questions with numbered options you can answer in one click, so the thread monitor stays current without Update status. Threads pick this up when their session next starts.",
      default: true,
    },
    staleDays: {
      type: "number",
      label: "Stale after (days)",
      description: "Unsectioned threads idle this long show up in the daily digest.",
      default: 7,
    },
    autoContinue: {
      type: "boolean",
      label: "Continue after usage-limit resets (default for threads)",
      description:
        "When Claude Code stops on a session limit, send \"continue\" 90 seconds after the limit resets. Each thread can switch it on or off in the thread monitor.",
      default: false,
    },
    expandPlans: {
      type: "boolean",
      label: "Expand plan reviews",
      description: "Plans awaiting approval open expanded. Drag the handle under a plan to set its height.",
      default: true,
    },
    planModelChoice: {
      type: "boolean",
      label: "Model choice on plan approval",
      description:
        "Adds a model menu next to Approve plan, so a plan can be implemented on another of the thread's models (for example plan on one model, build on another). The last choice is remembered.",
      default: true,
    },
    hideRepeatedChoices: {
      type: "boolean",
      label: "Hide options the reply buttons repeat",
      description:
        "When the reply buttons above the composer list the agent's numbered options, hide the same list in the agent's message. Off shows both.",
      default: true,
    },
    copyCode: {
      type: "boolean",
      label: "Copy buttons on code",
      description: "Hovering an inline code snippet in a chat message shows a button that copies it.",
      default: false,
    },
    conductor: {
      type: "boolean",
      label: "Conductor",
      description:
        "Routine PR news for a workspace's threads is handled for them: green PRs a worker said it would merge are merged, finished threads archived, and what each thread needs from you is headlined in Now from its own status report. A permanent agent thread per workspace takes the judgement calls. Start one per workspace under Settings → Conductors or on the Conductor page. The agent uses your quota, only when woken.",
      default: false,
    },
    conductorBatchMinutes: {
      type: "number",
      label: "Conductor: minutes to collect news before waking it",
      description: "A conductor is woken once the oldest unhandled news is this old, with everything that arrived meanwhile in one message. Fewer, larger batches use less quota.",
      default: 10,
    },
    conductorPrompt: {
      type: "string",
      label: "Conductor: your instructions",
      description: "Added to every conductor's instructions, e.g. which PRs it may merge on its own or when to leave a thread alone. Empty uses only the built-in role.",
      experimental_multiline: true,
      default: "",
    },
    advancedConfig: {
      type: "string",
      label: "Advanced config (JSON)",
      description:
        "releaseWatch, projectShortNames, stripProjectPrefixes and repoCommands, in the local.config.json format from the README. Reload the plugin after a change.",
      experimental_multiline: true,
      default: "",
    },
  });
  let { advancedConfig } = await settings.get();
  // A marketplace update replaces the plugin folder, and local.config.json with
  // it. Copy the file into the setting once, while it's still there.
  if (advancedConfig.trim() === "") {
    const file = readLocalConfigFile(bb);
    const used = Object.entries(file).filter(([, value]) => (Array.isArray(value) ? value.length : Object.keys(value).length) > 0);
    if (used.length > 0) {
      advancedConfig = JSON.stringify(Object.fromEntries(used), null, 2);
      await settings
        .experimental_set({ advancedConfig })
        .then(() => bb.log.info("copied local.config.json into the Advanced config setting; the file is no longer needed"))
        .catch((error) => bb.log.warn(`copying local.config.json failed: ${String(error)}`));
    }
  }
  const localConfig = loadLocalConfig(bb, advancedConfig);

  const { changed, bumpDeck, waitForDeckChange, deckVersion } = createChanges(bb);
  const threadLists = createThreadLists(bb);
  const { listAllActiveThreads, listThreadsCached } = threadLists;
  // A thread starting or stopping changes counts too: drop the cached list.
  const onThreadState = ({ thread }: { thread: { id: string } }) => {
    threadLists.invalidate();
    // Only a thread the cache doesn't know (new, or new environment) can change machines.
    machines.invalidateFor(thread.id);
    bumpDeck();
  };
  bb.events.on("thread.active", onThreadState);
  bb.events.on("thread.idle", onThreadState);

  const autoContinueOverrides = autoContinueOverridesFor(bb);

  // Late-bound: the awaiting tracker is created below.
  const focus = createFocus(bb, () => awaiting.all(), () => findSnoozedSection());
  const unreleased = createUnreleased(bb);
  const machines = createMachines(bb);
  const prTracker = createPrTracker(bb, changed);
  const conductorWiring = createConductorWiring(settings);
  const { conductorSink } = conductorWiring;
  const watchers = createWatchers(
    bb,
    localConfig.releaseWatch,
    async (threadId) => (await autoContinueOverrides())[threadId] ?? (await settings.get()).autoContinue,
    changed,
    async (threadId) => ((await prTracker.byThread())[threadId] ?? []).map(({ repo, state, mergedAt }) => ({ repo, state, mergedAt })),
    conductorSink,
  );
  const wakeups = createWakeups(bb, { settings, changed, watchers, autoContinueOverrides });
  const { watchingByThread } = wakeups;
  const prCi = createPrCi({ prTracker, watchers, listThreadsCached });
  const { watchThreadCi, prRadar } = prCi;
  const activity = createActivity(bb, changed);
  const threadStatus = createThreadStatus(bb, changed);
  const awaiting = createAwaiting(bb, changed);
  const nowStore = createNowStore(bb, changed);
  const snoozes = createSnoozes(bb, { changed, awaiting });
  const { getSnoozes, findSnoozedSection, snooze, unsnooze, wakeDue } = snoozes;
  const staleDigest = createStaleDigest(bb, { settings, changed, getSnoozes, listAllActiveThreads, conductor: conductorWiring.current });
  const { getKept, buildDigest, readDigest, archive } = staleDigest;
  registerDueFromStatus(bb, { settings, nowStore });
  const nowAndNext = createNowQueue(bb, { settings, awaiting, prTracker, nowStore, focus, findSnoozedSection, watchingByThread, listAllActiveThreads });
  const { currentNow, nextThread, yourMove } = nowAndNext;

  const repo = createRepoCommands(bb, changed, localConfig.repoCommands);
  const leftovers = createLeftovers(bb);

  // --- RPC ------------------------------------------------------------------

  const triage = createTriageState(bb, {
    localConfig,
    changed,
    awaiting,
    machines,
    prTracker,
    watchingByThread,
    findSnoozedSection,
    getSnoozes,
    nowStore,
    activity,
    getKept,
    autoContinueOverrides,
    listAllActiveThreads,
  });
  const { forgetThreads, pruneThreadData } = triage;

  const workspaces = createWorkspaceStorage(bb, changed);
  bb.rpc.register(rpcContract, {
    ...snoozes.rpc,
    ...staleDigest.rpc,
    ...wakeups.rpc,
    ...prCi.rpc,
    ...nowAndNext.rpc,
    ...triage.rpc,
    ...threadPreviewRpc(bb),
    ...conductorWiring.rpc,
    workspaces_get: () => workspaces.read(),
    workspace_save: (input) => workspaces.save(input),
    workspace_remove: async ({ id }) => { await workspaces.remove(id); return { ok: true }; },
    workspace_assign: async ({ threadId, workspaceId, automatic }) => { await workspaces.assign(threadId, workspaceId, automatic); return { ok: true }; },
    thread_status: ({ threadId, refresh }) => threadStatus.get(threadId, refresh),
    thread_stop: async ({ threadId }) => {
      await bb.sdk.threads.stop({ threadId });
      return { ok: true };
    },
    plan_models: ({ threadId }) => planModels(bb.sdk, threadId),
    plan_approve: async ({ threadId, model }) => {
      await approvePlan(bb.sdk, { threadId, model });
      return { ok: true };
    },
    thread_reply: async ({ threadId, text }) => {
      await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
      return { ok: true };
    },
    unreleased: ({ projectId, refresh }) => unreleased(projectId, refresh),
    leftovers_get: ({ refresh }) => leftovers.read(refresh),
    leftovers_clean: () => leftovers.clean(),
    focus_report: (input) => {
      const before = focus.focusedThreadId();
      focus.report(input);
      if (focus.focusedThreadId() !== before) bumpDeck();
      return { ok: true };
    },
    repo_status: ({ threadId }) => repo.status(threadId),
    repo_run: ({ threadId, commandId }) => repo.run(threadId, commandId),
    repo_stop: async ({ threadId, commandId }) => ({ stopped: await repo.stop(threadId, commandId) }),
    repo_config_get: () => repo.allCommands(),
    repo_config_set: async ({ projectName, commands }) => {
      await repo.setCommands(projectName, commands);
      return { ok: true };
    },
  });

  // --- schedules ------------------------------------------------------------

  bb.background.schedule("wake-snoozed", "* * * * *", async () => {
    const woken = await wakeDue();
    if (woken > 0) bb.log.info(`woke ${woken} snoozed thread(s)`);
  });
  bb.background.schedule("stale-digest", "0 8 * * 1-5", async () => {
    const digest = await buildDigest();
    bb.log.info(`digest: ${digest.items.length} stale thread(s)`);
    await pruneThreadData().catch((error) => bb.log.warn(`prune: ${String(error)}`));
    try {
      conductorWiring.current()?.prune();
    } catch (error) {
      bb.log.warn(`conductor prune: ${String(error)}`);
    }
  });

  bb.events.on("thread.archived", ({ thread }) => forgetThreads((threadId) => threadId === thread.id));

  // --- agent tool -----------------------------------------------------------

  registerSnoozeTool(bb, snooze);
  registerPrTools(bb, { prTracker, watchThreadCi });
  // configure() must answer synchronously, so keep the settings it reads at hand.
  let agentSettings = await settings.get();
  settings.onChange((next) => {
    agentSettings = next;
  });
  registerDueTool(bb, nowStore);
  migrate(bb);
  await conductorWiring.load(createConductor(bb, {
    store: createConductorStore(() => bb.storage.database()),
    options: () => ({
      enabled: agentSettings.conductor === true,
      batchMinutes: Number(agentSettings.conductorBatchMinutes) || 0,
      prompt: agentSettings.conductorPrompt ?? "",
    }),
    workspaces: () => workspaces.read(),
    assignWorkspace: (threadId, workspaceId) => workspaces.assign(threadId, workspaceId, false),
    listThreads: () => listThreadsCached(),
    flow: async () => {
      const [waiting, promised, waitingOthers, readyToGo, watching, threadPrs, focused, due] = await Promise.all([
        awaiting.all(),
        awaiting.promised(),
        awaiting.waitingOthers(),
        awaiting.readyToGo(),
        watchingByThread(),
        prTracker.byThread(),
        nowStore.all(),
        nowStore.dueAll(),
      ]);
      return { awaiting: waiting, promised, waitingOthers, readyToGo, watching, threadPrs, focused, due };
    },
    snoozedSection: () => findSnoozedSection(),
    threadStatus: (threadId) => threadStatus.get(threadId, false),
    prsByThread: () => prTracker.byThread(),
    snooze: (threadId, when, note) => snooze(threadId, when, note),
    unsnooze: (threadId) => unsnooze(threadId),
    archive: (threadIds) => archive(threadIds),
    focus: (threadId, focused) => nowStore.set(threadId, focused),
    changed,
  }));
  bb.agents.configure((context) => {
    // A conductor gets its own tools and role; every other thread, the usual ones.
    const asConductor = conductorWiring.current()?.configureFor(context);
    if (asConductor) return asConductor;
    return {
      tools: ["snooze_thread", "wait_for_ci", "pr_status", ...(agentSettings.nowQueue ? ["set_thread_due"] : [])],
      skills: [],
      ...(agentSettings.autoStatus && agentSettings.threadMonitor
        ? { instructions: handBackInstructions(agentSettings.statusPrompt, agentSettings.nowQueue) }
        : {}),
    };
  });

  // --- CLI ------------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb jb-flow snooze <thread-id|--self> <when> [--note <text>]",
    "  bb jb-flow unsnooze <thread-id|--self>",
    "  bb jb-flow due <thread-id|--self> <when|none> [--reason <text>]",
    "  bb jb-flow snoozed [--json]",
    "  bb jb-flow wake-now",
    "  bb jb-flow digest [--refresh] [--json]",
    "  bb jb-flow focused [--json]                          The thread focused in BB",
    "  bb jb-flow stop [<thread-id>|--focused]",
    "  bb jb-flow tell <text…> [--thread <id>]              Send a message (default: focused thread)",
    "  bb jb-flow needs-me [--json]                         Threads waiting on you",
    "  bb jb-flow next                                      Open the next thread that needs you",
    "  bb jb-flow wait-ci [--pr <n>] [--repo owner/name] [--for checks|reviews|both] [--after-green merge|continue|nothing] [--self|<thread-id>]",
    "  bb jb-flow watches [--json]                          Auto-continues, release waiters, CI watches",
    "  bb jb-flow conductor [status|start|stop|wake|inbox|briefing|log] [<workspace-id>] [--json]",
    "  bb jb-flow prs [--self|<thread-id>] [--json]         PRs a thread created (all repos, stack order)",
    "  bb jb-flow pr-link <pr-url> [--self|<thread-id>] [--remove]",
    "  bb jb-flow release-wait [--self|<thread-id>]         Wake this thread on the next release",
    "  bb jb-flow check-now                                 Run the release and CI checks immediately",
    "  bb jb-flow repo [--self|<thread-id>]                 List repo commands and runs",
    "  bb jb-flow repo-run <command-id> [--self|<thread-id>]",
    "  bb jb-flow repo-stop <command-id> [--self|<thread-id>]",
    "  bb jb-flow repo-config <project-name> <json|reset>",
    "",
    "<when>: 30m, 2h, 3d, 1w, today, tonight, tomorrow, mon…sun, next-week, YYYY-MM-DD, YYYY-MM-DDTHH:MM",
  ].join("\n");

  const { decisionsFor, deckSnapshot } = createDeck(bb, { settings, listThreadsCached, awaiting, prRadar, focus, findSnoozedSection, currentNow });

  bb.cli.register({
    name: "jb-flow",
    summary: "Snooze threads and review the stale-thread digest",
    commands: [
      { name: "workspaces", summary: "List workspaces or save/remove/assign using JSON", usage: 'bb jb-flow workspaces [save <json>|remove <id>|assign <thread-id> <workspace-id|unassigned|auto>]' },
      {
        name: "snooze",
        summary: "Snooze a thread until a time",
        usage: "bb jb-flow snooze <thread-id|--self> <when> [--note <text>]",
      },
      {
        name: "due",
        summary: "Set or clear a thread's deadline",
        usage: "bb jb-flow due <thread-id|--self> <when|none> [--reason <text>]",
      },
      {
        name: "unsnooze",
        summary: "Wake a snoozed thread now",
        usage: "bb jb-flow unsnooze <thread-id|--self>",
      },
      { name: "snoozed", summary: "List snoozed threads", usage: "bb jb-flow snoozed [--json]" },
      { name: "wake-now", summary: "Run the due-snooze check immediately", usage: "bb jb-flow wake-now" },
      { name: "leftovers", summary: "Worktree checkouts bb no longer tracks (--clean removes the merged ones)", usage: "bb jb-flow leftovers [--refresh] [--json] [--clean]" },
      { name: "deck", summary: "One JSON snapshot for the Stream Deck: focused thread, Needs me, Your move, PRs", usage: "bb jb-flow deck [--wait <version>]" },
      { name: "pr-radar", summary: "Threads with a PR to fix or merge (--open: jump to the next one)", usage: "bb jb-flow pr-radar [--json] [--open]" },
      { name: "your-move", summary: "Threads waiting on a decision from you, oldest first", usage: "bb jb-flow your-move [--json] [--open]" },
      { name: "focus-clients", summary: "Debug: the BB windows reporting focus, most recently used first", usage: "bb jb-flow focus-clients" },
      { name: "focused", summary: "Print the thread focused in BB", usage: "bb jb-flow focused [--json]" },
      { name: "decisions", summary: "Numbered options the focused thread is waiting on", usage: "bb jb-flow decisions [<thread-id>] [--json]" },
      { name: "stop", summary: "Stop a thread's run (default: focused)", usage: "bb jb-flow stop [<thread-id>|--focused]" },
      { name: "tell", summary: "Send a message to a thread (default: focused)", usage: "bb jb-flow tell <text…> [--thread <id>]" },
      { name: "needs-me", summary: "List threads waiting on you", usage: "bb jb-flow needs-me [--json]" },
      { name: "next", summary: "Open the next thread that needs you", usage: "bb jb-flow next" },
      { name: "now", summary: "List the Now queue in order, and what's Moving", usage: "bb jb-flow now [--json]" },
      { name: "wait-ci", summary: "Message a thread when its PR's CI finishes or reviews arrive", usage: "bb jb-flow wait-ci [--pr <n>] [--repo owner/name] [--for checks|reviews|both] [--after-green merge|continue|nothing] [--self|<thread-id>]" },
      { name: "prs", summary: "List the PRs a thread created, across repos, in stack order", usage: "bb jb-flow prs [--self|<thread-id>] [--json]" },
      { name: "pr-link", summary: "Link (or --remove) a PR to a thread", usage: "bb jb-flow pr-link <pr-url> [--self|<thread-id>] [--remove]" },
      { name: "watches", summary: "List auto-continues, release waiters and CI watches", usage: "bb jb-flow watches [--json]" },
      { name: "release-wait", summary: "Wake a thread on the next release", usage: "bb jb-flow release-wait [--self|<thread-id>]" },
      { name: "check-now", summary: "Run the release and CI checks immediately", usage: "bb jb-flow check-now" },
      { name: "repo", summary: "List repo commands and runs for a thread", usage: "bb jb-flow repo [--self|<thread-id>]" },
      { name: "repo-run", summary: "Run a repo command in the thread's terminal", usage: "bb jb-flow repo-run <command-id> [--self|<thread-id>]" },
      { name: "repo-stop", summary: "Stop a running repo command", usage: "bb jb-flow repo-stop <command-id> [--self|<thread-id>]" },
      { name: "repo-config", summary: "Set or reset a project's repo commands", usage: "bb jb-flow repo-config <project-name> <json|reset>" },
      {
        name: "digest",
        summary: "List stale unsectioned threads",
        usage: "bb jb-flow digest [--refresh] [--json]",
      },
      {
        name: "conductor",
        summary: "Workspace conductors: status, start, stop, wake, inbox, briefing, log",
        usage: "bb jb-flow conductor [status|start <workspace-id> [--project <id>] [--provider <id>] [--model <id>]|restart <workspace-id>|stop <workspace-id>|wake <workspace-id>|inbox <workspace-id>|briefing <workspace-id>|log <workspace-id>] [--json]",
      },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const refresh = argv.includes("--refresh");
      const noteIndex = argv.indexOf("--note");
      const note = noteIndex === -1 ? null : argv.slice(noteIndex + 1).join(" ");
      const reasonIndex = argv.indexOf("--reason");
      const reason = reasonIndex === -1 ? null : argv.slice(reasonIndex + 1).join(" ").trim() || null;
      const beforeText = Math.min(...[noteIndex, reasonIndex].map((index) => (index === -1 ? argv.length : index)));
      const positional = argv.slice(0, beforeText).filter(
        (arg) => arg !== "--json" && arg !== "--refresh",
      );
      const [command, ...args] = positional;
      const resolveThread = (value: string | undefined) =>
        value === "--self" ? ctx.threadId : value === "--focused" ? focus.focusedThreadId() ?? undefined : value;
      try {
        switch (command) {
          case "workspaces": {
            if (args[0] === "save") {
              const input = workspaceSchema.extend({ id: z.string().nullable() }).parse(JSON.parse(args.slice(1).join(" ")));
              return { exitCode: 0, stdout: JSON.stringify(await workspaces.save(input)) };
            }
            if (args[0] === "remove" && args[1]) await workspaces.remove(args[1]);
            else if (args[0] === "assign" && args[1] && args[2]) await workspaces.assign(args[1], ["auto", "unassigned"].includes(args[2]) ? null : args[2], args[2] === "auto");
            else if (args.length > 0) throw new Error("Use workspaces [save <json>|remove <id>|assign <thread-id> <workspace-id|unassigned|auto>]");
            return { exitCode: 0, stdout: JSON.stringify(await workspaces.read()) };
          }
          case "snooze": {
            const threadId = resolveThread(args[0]);
            const when = args.slice(1).join(" ");
            if (threadId === undefined || when === "") break;
            const record = await snooze(threadId, when, note);
            return {
              exitCode: 0,
              stdout: json
                ? JSON.stringify(record)
                : `Snoozed ${threadId} until ${formatWhen(record.until)}.`,
            };
          }
          case "due": {
            const threadId = resolveThread(args[0]);
            const when = args.slice(1).join(" ");
            if (threadId === undefined || when === "") break;
            const at = when.toLowerCase() === "none" ? null : parseDue(when);
            const { due } = await nowStore.setDue(threadId, at, at === null ? null : reason, "you");
            if (json) return { exitCode: 0, stdout: JSON.stringify(due) };
            return { exitCode: 0, stdout: at === null ? `Cleared the deadline on ${threadId}.` : `${threadId}: ${formatDue(at)} (${formatWhen(at)}).` };
          }
          case "unsnooze": {
            const threadId = resolveThread(args[0]);
            if (threadId === undefined) break;
            return (await unsnooze(threadId))
              ? { exitCode: 0, stdout: `Woke ${threadId}.` }
              : { exitCode: 1, stderr: `${threadId} is not snoozed.` };
          }
          case "snoozed": {
            const snoozes = Object.entries(await getSnoozes()).sort(
              (a, b) => a[1].until - b[1].until,
            );
            if (json) return { exitCode: 0, stdout: JSON.stringify(Object.fromEntries(snoozes)) };
            const lines = await Promise.all(
              snoozes.map(async ([threadId, record]) => {
                const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
                return `${formatWhen(record.until).padEnd(16)} ${threadId}  ${thread?.title ?? ""}${record.note ? `  — ${record.note}` : ""}`;
              }),
            );
            return { exitCode: 0, stdout: lines.length === 0 ? "Nothing snoozed." : lines.join("\n") };
          }
          case "wait-ci": {
            const prFlag = args.indexOf("--pr");
            const forFlag = args.indexOf("--for");
            const repoFlag = args.indexOf("--repo");
            const afterFlag = args.indexOf("--after-green");
            const positional = args.filter((arg, index) => {
              if (prFlag !== -1 && (index === prFlag || index === prFlag + 1)) return false;
              if (forFlag !== -1 && (index === forFlag || index === forFlag + 1)) return false;
              if (repoFlag !== -1 && (index === repoFlag || index === repoFlag + 1)) return false;
              if (afterFlag !== -1 && (index === afterFlag || index === afterFlag + 1)) return false;
              return true;
            });
            const threadId = resolveThread(positional[0] ?? "--self");
            if (threadId === undefined) break;
            const watchFor = forFlag === -1 ? undefined : z.enum(["checks", "reviews", "both"]).parse(args[forFlag + 1]);
            const watches = await watchThreadCi(threadId, {
              pr: prFlag === -1 ? undefined : Number(args[prFlag + 1]),
              watchFor,
              repo: repoFlag === -1 ? undefined : args[repoFlag + 1],
              afterGreen: afterFlag === -1 ? undefined : z.enum(AFTER_GREEN).parse(args[afterFlag + 1]),
            });
            return {
              exitCode: 0,
              stdout: `Watching ${watches.map((watch) => `${watch.repo}#${watch.pr}`).join(", ")} for ${watches[0]!.watchFor}; ${threadId} will be messaged.`,
            };
          }
          case "prs": {
            const threadId = resolveThread(args[0] ?? "--self");
            if (threadId === undefined) break;
            await prTracker.refreshThread(threadId);
            const prs = (await prTracker.byThread())[threadId] ?? [];
            if (json) return { exitCode: 0, stdout: JSON.stringify(prs) };
            const lines = prs.map(
              (pr) => `${pr.stackedOn !== null ? "  └ " : ""}${pr.repo}#${pr.number}  ${pr.attention.padEnd(17)} ${pr.title}`,
            );
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "No PRs linked." };
          }
          case "classify": {
            const snoozedSection = await findSnoozedSection();
            // Debug view: where each open thread lands in the triage sidebar, with
            // the tail of its last agent message to check the call against.
            const [threads, awaitingAll, byThread, watching, sections, promised, waitingOthers, readyToGo] = await Promise.all([
              listLiveThreads(bb),
              awaiting.all(),
              prTracker.byThread(),
              watchingByThread(),
              bb.sdk.threadSections.list(),
              awaiting.promised(),
              awaiting.waitingOthers(),
              awaiting.readyToGo(),
            ]);
            const sectionName = new Map(sections.map((section) => [section.id, section.name]));
            const rows = [];
            for (const thread of threads) {
              if (thread.archivedAt !== null || thread.visibility !== "visible" || thread.parentThreadId !== null) continue;
              const snoozed = snoozedSection !== null && thread.sectionId === snoozedSection;
              const busy = thread.status === "active" || thread.status === "starting";
              const prs = (byThread[thread.id] ?? []).map((pr) => `${pr.repo.split("/")[1]}#${pr.number}:${pr.attention}`);
              const open = (byThread[thread.id] ?? []).filter((pr) => pr.state === "open" || pr.state === "draft");
              const settled = (byThread[thread.id] ?? []).every((pr) => pr.state === "merged" || pr.state === "closed");
              const needs = !snoozed && needsAttention(thread, awaitingAll);
              const group = snoozed
                ? "snoozed"
                : needs
                ? "needs-me"
                : thread.pinnedAt
                  ? "pinned"
                  : busy
                    ? "running"
                    : promised[thread.id] !== undefined && !watching[thread.id] && quietFor(thread, Date.now()) > 3_600_000
                      ? "stalled"
                      : awaitingAll[thread.id] !== undefined
                      ? "your-move"
                      : readyToGo[thread.id] !== undefined
                      ? "ready"
                      : thread.sectionId === null &&
                          (waitingOthers[thread.id] !== undefined ||
                            (open.length > 0 && open.every((pr) => pr.attention === "review_requested")))
                        ? "waiting"
                      : thread.sectionId === null && !watching[thread.id] && settled && quietFor(thread, Date.now()) > 2 * 3_600_000
                        ? "done"
                        : "lane";
              const output = await bb.sdk.threads.output({ threadId: thread.id }).catch(() => ({ output: null }));
              rows.push({
                id: thread.id,
                title: thread.title,
                status: thread.status,
                section: thread.sectionId === null ? "Active" : sectionName.get(thread.sectionId) ?? thread.sectionId,
                group,
                awaiting: awaitingAll[thread.id] !== undefined,
                watching: watching[thread.id] ?? null,
                openPrs: open.map((pr) => `${pr.repo.split("/")[1]}#${pr.number}:${pr.attention}`),
                prs: prs.length,
                idleHours: Math.round(quietFor(thread, Date.now()) / 3_600_000),
                tail: (output.output ?? "").trim().slice(-1500),
              });
            }
            return { exitCode: 0, stdout: JSON.stringify(rows) };
          }
          case "leftovers": {
            if (argv.includes("--clean")) {
              const { removed, kept } = await leftovers.clean();
              return { exitCode: 0, stdout: `Removed ${removed.length}, kept ${kept.length}.\n${kept.map((path) => `  kept ${path}`).join("\n")}` };
            }
            const report = await leftovers.read(refresh);
            if (json) return { exitCode: 0, stdout: JSON.stringify(report) };
            const lines = report.items.map(
              (item) =>
                `${item.safe ? "safe" : "KEEP"}  ${item.repo.padEnd(28)} ${item.branch.padEnd(40)} ${item.pr ? `${item.pr} ${item.prState}` : "no PR"}${item.dirty ? ` · ${item.dirty} uncommitted` : ""}${item.nodeModules ? " · node_modules" : ""}`,
            );
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "No leftover worktrees." };
          }
          case "deck": {
            // --wait <version>: block (max 25s) until something changes, then answer.
            const waitIndex = argv.indexOf("--wait");
            if (waitIndex !== -1) await waitForDeckChange(Number(argv[waitIndex + 1]), 25_000);
            const version = deckVersion();
            return { exitCode: 0, stdout: JSON.stringify({ version, ...(await deckSnapshot()) }) };
          }
          case "pr-radar": {
            const { broken, ready } = await prRadar();
            if (argv.includes("--open")) {
              const focused = focus.focusedThreadId();
              const queue = [...broken, ...ready];
              const next = queue.find((item) => item.threadId !== focused) ?? queue[0];
              if (next === undefined) return { exitCode: 0, stdout: "No PR needs you." };
              await bb.sdk.threads.open({ threadId: next.threadId, file: null });
              return { exitCode: 0, stdout: `Opened ${next.threadId}  ${next.title} (${next.pr})` };
            }
            if (json) return { exitCode: 0, stdout: JSON.stringify({ broken, ready }) };
            const lines = [
              ...broken.map((item) => `fix    ${item.pr.padEnd(22)} ${item.title}`),
              ...ready.map((item) => `merge  ${item.pr.padEnd(22)} ${item.title}`),
            ];
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "No PR needs you." };
          }
          case "pr-link": {
            const remove = args.includes("--remove");
            const rest = args.filter((arg) => arg !== "--remove");
            const url = rest[0];
            const threadId = resolveThread(rest[1] ?? "--self");
            const match = url ? /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url) : null;
            if (!match || threadId === undefined) break;
            await prTracker.link(threadId, { repo: match[1]!, number: Number(match[2]) }, remove);
            return { exitCode: 0, stdout: `${remove ? "Unlinked" : "Linked"} ${match[1]}#${match[2]}.` };
          }
          case "conductor": {
            const conductor = conductorWiring.current();
            if (!conductor) throw new Error("The conductor isn't loaded.");
            const [action = "status", workspaceId] = args;
            const flag = (name: string) => {
              const index = args.indexOf(name);
              return index === -1 ? undefined : args[index + 1];
            };
            const out = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
            if (action === "status") {
              const all = await conductor.status();
              return out(
                all,
                all.length === 0
                  ? "No conductors. Turn on Conductor in the settings, then: bb jb-flow conductor start <workspace-id>"
                  : all
                      .map((entry) => `${entry.workspaceId}  ${entry.name}  ${entry.active ? "on" : "off"}  thread ${entry.threadId ?? "-"}  inbox ${entry.open} open, ${entry.undelivered} waiting`)
                      .join("\n"),
              );
            }
            if (!workspaceId) throw new Error(`Use conductor ${action} <workspace-id>; bb jb-flow workspaces lists them.`);
            switch (action) {
              case "start": {
                const result = await conductor.start(workspaceId, { projectId: flag("--project"), providerId: flag("--provider"), model: flag("--model") });
                return out(result, `Conductor for ${workspaceId}: ${result.threadId}`);
              }
              case "restart": {
                const result = await conductor.restart(workspaceId);
                return out(result, `Conductor for ${workspaceId}: ${result.threadId}${result.previous ? ` (archived ${result.previous})` : ""}`);
              }
              case "stop":
                return out({ stopped: await conductor.stop(workspaceId) }, `Stopped the conductor for ${workspaceId}; its thread stays.`);
              case "wake": {
                const result = await conductor.wake(workspaceId, true);
                return out({ result }, result);
              }
              case "inbox": {
                const events = conductor.inbox(workspaceId);
                return out(events, events.length === 0 ? "Inbox empty." : events.map((event) => `#${event.id} [${event.kind}] ${event.threadId} ${event.deliveredAt ? "sent" : "waiting"} · ${event.text}`).join("\n"));
              }
              case "briefing": {
                const briefing = await conductor.briefing(workspaceId);
                return out(
                  briefing,
                  briefing === null
                    ? "No briefing yet."
                    : [
                        `Briefing from ${formatWhen(briefing.at)}:`,
                        ...briefing.items.map((item, index) => `${index + 1}. [${item.kind}] ${item.threadId} · ${item.summary}${item.recommendation ? ` → ${item.recommendation}` : ""}`),
                        ...briefing.handled.map((entry) => `✓ ${entry.what}`),
                      ].join("\n"),
                );
              }
              case "log": {
                const entries = conductor.log(workspaceId, 50);
                return out(entries, entries.map((entry) => `${formatWhen(entry.at)}  ${entry.kind.padEnd(13)} ${entry.threadId ?? ""}  ${entry.text}`).join("\n") || "Nothing logged.");
              }
            }
            throw new Error("Use conductor status|start|restart|stop|wake|inbox|briefing|log.");
          }
          case "watches": {
            const result = await watchers.status();
            if (json) return { exitCode: 0, stdout: JSON.stringify(result) };
            const lines = [
              ...Object.entries(result.autoContinue).map(([id, entry]) => `continue    ${id}  at ${formatWhen(entry.resetsAt + 90_000)}`),
              ...Object.values(result.releaseWaiters).map((waiter) => `release     ${waiter.threadId}  (${waiter.projectName})`),
              ...Object.entries(result.pendingReleases).map(([key, release]) => `deploying   ${key}  ${release.title}`),
              ...Object.values(result.ciWatches).map((watch) => `ci          ${watch.threadId}  ${watch.repo}#${watch.pr} (${watch.watchFor})`),
            ];
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "Nothing watched." };
          }
          case "release-wait": {
            const threadId = resolveThread(args[0] ?? "--self");
            if (threadId === undefined) break;
            await watchers.registerReleaseWaiter(await bb.sdk.threads.get({ threadId }));
            return { exitCode: 0, stdout: `${threadId} will be woken on the next release (if its project has releaseWatch configured).` };
          }
          case "check-now":
            await watchers.checkReleases();
            await watchers.checkCi(true);
            return { exitCode: 0, stdout: "Checked releases and CI watches." };
          case "your-move": {
            const { items } = await yourMove({ withAsk: !argv.includes("--open") });
            if (argv.includes("--open")) {
              // Oldest first; skip the one you're already looking at.
              const focused = focus.focusedThreadId();
              const next = items.find((item) => item.threadId !== focused) ?? items[0];
              if (next === undefined) return { exitCode: 0, stdout: "Nothing is waiting on you." };
              await bb.sdk.threads.open({ threadId: next.threadId, file: null });
              return { exitCode: 0, stdout: `Opened ${next.threadId}  ${next.title}` };
            }
            if (json) return { exitCode: 0, stdout: JSON.stringify({ count: items.length, items }) };
            const lines = items.map((item) => `${formatWhen(item.since).padEnd(16)} ${item.threadId}  ${item.title}`);
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "Nothing is waiting on you." };
          }
          case "focus-clients": {
            const rows = focus.clients().map((entry) => ({
              clientId: entry.clientId,
              threadId: entry.threadId,
              windowFocused: entry.windowFocused,
              interacted: entry.interactedAt ? formatWhen(entry.interactedAt) : "never",
              reported: formatWhen(entry.at),
              origin: entry.origin ?? "?",
              userAgent: entry.userAgent ?? "?",
            }));
            return { exitCode: 0, stdout: JSON.stringify(rows, null, 2) };
          }
          case "focused": {
            const threadId = focus.focusedThreadId();
            if (threadId === null) return { exitCode: 1, stderr: "No focused thread." };
            const thread = await bb.sdk.threads.get({ threadId });
            return {
              exitCode: 0,
              stdout: json
                ? JSON.stringify({ threadId, projectId: thread.projectId, title: thread.title, status: thread.status })
                : `${threadId}  ${thread.title ?? ""}`,
            };
          }
          case "decisions": {
            const result = await decisionsFor(resolveThread(args[0] ?? "--focused") ?? null);
            const options = result.options;
            return {
              exitCode: 0,
              stdout: json
                ? JSON.stringify(result)
                : options.map((option) => `${option.n}. ${option.text}${option.recommended ? " (recommended)" : ""}`).join("\n") ||
                  "No open decision.",
            };
          }
          case "stop": {
            const threadId = resolveThread(args[0] ?? "--focused");
            if (threadId === undefined) return { exitCode: 1, stderr: "No focused thread." };
            await bb.sdk.threads.stop({ threadId });
            return { exitCode: 0, stdout: `Stopped ${threadId}.` };
          }
          case "tell": {
            const flag = args.indexOf("--thread");
            const target = flag === -1 ? await focus.requireFocused() : args[flag + 1];
            const text = (flag === -1 ? args : args.slice(0, flag)).join(" ").trim();
            if (target === undefined || text === "") break;
            await bb.sdk.threads.send({
              threadId: target,
              mode: "queue-if-active",
              input: [{ type: "text", text, mentions: [] }],
            });
            return { exitCode: 0, stdout: `Sent to ${target}.` };
          }
          case "needs-me": {
            const threads = await focus.needsMe();
            if (json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  count: threads.length,
                  threads: threads.map((thread) => ({ id: thread.id, title: thread.title, status: thread.status })),
                }),
              };
            }
            return {
              exitCode: 0,
              stdout: threads.length === 0 ? "Nothing needs you." : threads.map((thread) => `${thread.id}  ${thread.title ?? ""}`).join("\n"),
            };
          }
          case "next": {
            const focused = focus.focusedThreadId();
            const nextId = await nextThread(focused, focused);
            if (nextId === null) return { exitCode: 0, stdout: "Nothing needs you." };
            await bb.sdk.threads.open({ threadId: nextId, file: null });
            const next = await bb.sdk.threads.get({ threadId: nextId }).catch(() => null);
            return { exitCode: 0, stdout: `Opened ${nextId}  ${next?.title ?? ""}` };
          }
          case "now": {
            if (!(await settings.get()).nowQueue) return { exitCode: 1, stderr: "Now and Focus is turned off in the plugin settings." };
            const queue = await currentNow(await listLiveThreads(bb));
            if (json) return { exitCode: 0, stdout: JSON.stringify({ count: queue.now.length, threads: queue.now, moving: queue.moving }) };
            const line = (entry: (typeof queue.now)[number]) => `${entry.focused ? "*" : " "} ${entry.id}  ${entry.title}  [${entry.reason}]`;
            return {
              exitCode: 0,
              stdout: [...(queue.now.length ? queue.now.map(line) : ["Nothing in Now."]), ...(queue.moving.length ? ["", "Moving:", ...queue.moving.map(line)] : [])].join("\n"),
            };
          }
          case "repo": {
            const threadId = resolveThread(args[0] ?? "--self");
            if (threadId === undefined) break;
            const result = await repo.status(threadId);
            if (json) return { exitCode: 0, stdout: JSON.stringify(result) };
            const runLabel = (id: string) => {
              const run = result.runs.find((candidate) => candidate.commandId === id);
              return run ? `  [${run.status}${run.url ? ` ${run.url}` : ""}]` : "";
            };
            const pinned = result.commands.map((command) => `${command.id.padEnd(16)} ${command.label}${runLabel(command.id)}`);
            const scripts = result.scripts.map((script) => `${script.id.padEnd(16)} ${script.command}${runLabel(script.id)}`);
            const out = [result.projectName];
            if (pinned.length) out.push("", "Pinned:", ...pinned);
            if (scripts.length) out.push("", "Scripts:", ...scripts);
            else if (result.scriptsError) out.push("", `Scripts: ${result.scriptsError}`);
            if (!pinned.length && !scripts.length && !result.scriptsError) out.push("No commands or scripts.");
            return { exitCode: 0, stdout: out.join("\n") };
          }
          case "repo-run":
          case "repo-stop": {
            const threadId = resolveThread(args[1] ?? "--self");
            if (args[0] === undefined || threadId === undefined) break;
            if (command === "repo-stop") {
              return (await repo.stop(threadId, args[0]))
                ? { exitCode: 0, stdout: `Stopped ${args[0]}.` }
                : { exitCode: 1, stderr: `${args[0]} is not running in ${threadId}.` };
            }
            const run = await repo.run(threadId, args[0]);
            return {
              exitCode: 0,
              stdout: json ? JSON.stringify(run) : `Started ${run.label} (terminal ${run.terminalId})${run.url ? `; browser opens at ${run.url} once the port is up` : ""}.`,
            };
          }
          case "repo-config": {
            const [projectNameArg, ...rest] = args;
            const value = rest.join(" ");
            if (projectNameArg === undefined || value === "") break;
            const commands = value === "reset" ? null : z.array(repoCommandSchema).parse(JSON.parse(value));
            await repo.setCommands(projectNameArg, commands);
            return { exitCode: 0, stdout: commands === null ? "Reset." : `Saved ${commands.length} command(s).` };
          }
          case "wake-now":
            return { exitCode: 0, stdout: `Woke ${await wakeDue()} thread(s).` };
          case "digest": {
            const digest = await readDigest(refresh);
            if (json) return { exitCode: 0, stdout: JSON.stringify(digest) };
            const lines = digest.items
              .slice(0, 100)
              .map((item) => `${String(item.idleDays).padStart(3)}d  ${item.threadId}  ${item.title}`);
            const more =
              digest.items.length > 100 ? `\n… and ${digest.items.length - 100} more` : "";
            return {
              exitCode: 0,
              stdout: `${digest.items.length} stale thread(s), generated ${new Date(digest.generatedAt).toLocaleString()}\n${lines.join("\n")}${more}`,
            };
          }
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };
        }
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.log.info("loaded");
}
