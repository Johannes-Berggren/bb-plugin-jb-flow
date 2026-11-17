// jb-flow: snooze threads until a date, a daily stale-thread digest, and the
// state behind the Triage thread list in app.tsx.
//
// State lives in bb.storage.kv because thread plugin metadata is not part of
// thread list rows; the sidebar needs every snooze and tag in one read.
//
// This file is the composition root: it declares the settings, creates the
// stores and passes them to the modules that do the work, then registers the
// RPC handlers, schedules, agent tools and the CLI.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createActivity } from "./activity";
import { createAwaiting } from "./awaiting";
import { createChanges } from "./changes";
import { registerCli } from "./cli";
import { createConductor } from "./conductor";
import { createConductorStore } from "./conductor-store";
import { createConductorWiring } from "./conductor-wiring";
import { createDeck } from "./deck";
import { createFocus } from "./focus";
import { createLeftovers } from "./leftovers";
import { loadLocalConfig, readLocalConfigFile } from "./local-config";
import { createMachines } from "./machines";
import { migrate } from "./migrations";
import { createNowQueue, registerDueFromStatus, registerDueTool } from "./now-queue";
import { createNowStore } from "./now-store";
import { approvePlan, planModels } from "./plan-model";
import { createPrCi, registerPrTools } from "./pr-ci";
import { createPrTracker } from "./prs";
import { createRepoCommands } from "./repo-commands";
import { rpcContract } from "./rpc-contract";
import { createSnoozes, registerSnoozeTool } from "./snooze";
import { createStaleDigest } from "./stale-digest";
import { handBackInstructions } from "./status-prompt";
import { createThreadLists } from "./thread-cache";
import { threadPreviewRpc } from "./thread-preview";
import { createThreadStatus } from "./thread-status";
import { createTriageState } from "./triage-state";
import { createUnreleased } from "./unreleased";
import { autoContinueOverridesFor, createWakeups } from "./wakeups";
import { createWatchers } from "./watchers";
import { createWorkspaceStorage } from "./workspace-storage";

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

  // --- RPC ------------------------------------------------------------------

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

  const { decisionsFor, deckSnapshot } = createDeck(bb, { settings, listThreadsCached, awaiting, prRadar, focus, findSnoozedSection, currentNow });

  registerCli(bb, {
    settings,
    workspaces,
    snooze,
    unsnooze,
    getSnoozes,
    wakeDue,
    nowStore,
    watchThreadCi,
    prTracker,
    prRadar,
    findSnoozedSection,
    awaiting,
    watchingByThread,
    watchers,
    leftovers,
    repo,
    focus,
    waitForDeckChange,
    deckVersion,
    deckSnapshot,
    decisionsFor,
    currentConductor: conductorWiring.current,
    yourMove,
    nextThread,
    currentNow,
    readDigest,
  });

  bb.log.info("loaded");
}
