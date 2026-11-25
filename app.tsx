// jb-flow frontend: the Triage thread list, a snooze control in the thread
// header, the stale-thread digest on the homepage, and the area-tag migration
// in settings. All plugin state comes from server.ts over RPC and refreshes on
// the "jb-flow-changed" realtime signal.
import "./flow-ui.css";
import { mountWorkspaceTopBar } from "./workspace-topbar";
import { toast } from "sonner";
import { WorkspaceNavigation, WorkspaceTopBar, WorkspaceRouteBridge, WorkspaceSettings } from "./workspace-ui";
import { useWorkspaces } from "./workspace-client";
import { mountTimelineActivity } from "./timeline-activity";
import { COPY_CODE_FLAG, mountInlineCodeCopy } from "./inline-code-copy";
import { mountCallouts } from "./callouts";
import { useEffect, useRef, useState } from "react";
import { definePluginApp, experimental_useSidebarThreads as useSidebarThreads, useRpc, useBbContext, useComposer, useSidebarSplitLayout, useSettings } from "@get-bb/plugin-sdk/app";
import { useBranchPr } from "./branch-pr";
import { DEV_AUTORUN, DEV_SERVERS_TAB, PRS_TAB, REPO_COMMANDS_TAB } from "./panel-tabs";
import type { JsonValue } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { RepoCommandsPanel, RepoCommandsSettings } from "./repo-panel";
import { UnreleasedSection, YourMoveSection, ThreadStatusStrip, PullRequestsPanel, PR_TONE, runInfo, threadPrs, worstPr } from "./ui-extras";
import { DecisionChips } from "./decision-choices";
import { ThreadControl, ThreadControls } from "./thread-controls";
import { formatWhen } from "./when";
import { focusLimitOf } from "./now-model";
import { mountShellAppearance, ShellAppearancePreference } from "./shell-appearance";
import { mountPaneAppearance, PaneAppearancePreference } from "./pane-appearance";
import { mountSplitScroll, SplitScrollPreference } from "./split-scroll";
import { PaneEdgeHints } from "./pane-edge-hints";
import { paneOrder } from "./pane-strip-model";
import { PaneCommandsHost, paneCommands } from "./pane-commands";
import { OPEN_QUEUE_EVENT, STATUS_PANES_EVENT } from "./pane-commands-model";
import { LiveActivityBanner } from "./live-activity";
import { PALETTE_EVENT, Palette, usePaletteTrigger } from "./palette";
import { TabSwitcherHost } from "./tab-switcher";
import { CatchUpHomeEntry, CatchUpOverlay, CatchUpPage, useCatchUpBadge, useCatchUpTrigger } from "./catch-up";
import { CATCH_UP_EVENT } from "./catch-up-model";
import { flowState, useFlowState } from "./flow-state";
import { SnoozeDialog } from "./dialogs";
import { NextInNowBanner } from "./next-in-now";
import { TriageThreadList } from "./triage-list";
import { DigestSection } from "./digest";
import { LaneSettings, MigrationSettings } from "./settings-panels";
import { EXPAND_PLANS_FLAG, mountPlanExpander } from "./plan-expander";
import { CONDUCTOR_PANEL, ConductorPage, ConductorSettings } from "./conductor-page";
import { DoneForYouSection } from "./conductor-brief";
import { PlanModelPicker } from "./plan-model-picker";

// --- thread status strip (above the composer) + Pull requests panel ------------------

type SegmentInput = { threadId: string; environment: { id: string } | null };

function ThreadStatusSegment({ threadId, environment }: SegmentInput) {
  const { state } = useFlowState();
  const pullRequest = useBranchPr(environment?.id);
  const showPrs = useSettings().values?.compactThreadControls !== true;
  return <ThreadStatusStrip threadId={threadId} state={state} branchPr={pullRequest} showPrs={showPrs} />;
}

/** The strip takes room in the context row only while it has a run, a watch or a PR to show. */
function useThreadStatusVisible({ threadId, environment }: SegmentInput): boolean {
  const { state } = useFlowState();
  const pullRequest = useBranchPr(environment?.id);
  const showPrs = useSettings().values?.compactThreadControls !== true;
  return state !== null && (runInfo(state.running[threadId], Date.now()) !== null || !!state.watching[threadId] ||
    (showPrs && threadPrs(state.threadPrs[threadId], pullRequest).length > 0));
}

function PullRequestsTab({ threadId, environment, params }: { threadId: string; environment: { id: string } | null; params: JsonValue | null }) {
  const { state } = useFlowState();
  const pullRequest = useBranchPr(environment?.id);
  return <PullRequestsPanel threadId={threadId} params={params} state={state} branchPr={pullRequest} />;
}

function ThreadControlsBanner() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const { threads } = useSidebarThreads();
  const thread = threadId ? threads.find((candidate) => candidate.id === threadId) : undefined;
  const { state } = useFlowState();
  const compact = useSettings().values?.compactThreadControls === true;
  const branchPr = useBranchPr(compact ? thread?.environment?.id : null);
  if (!threadId) return null;

  const choices = (
    <DecisionChips
      threadId={threadId}
      updatedAt={thread?.updatedAt ?? null}
      idle={thread?.status === "idle" && !composer.isRunning && composer.isEmpty}
    />
  );
  const status = <LiveActivityBanner runningSince={state?.running ?? {}} trackedPrs={state?.threadPrs ?? {}} watches={state?.watching ?? {}} />;
  if (!compact) return <>{choices}<NextInNowBanner />{status}</>;

  const prs = threadPrs(state?.threadPrs[threadId], branchPr);
  const openPrs = prs.filter((pr) => pr.state === "open" || pr.state === "draft");
  const worst = worstPr(openPrs.length ? openPrs : prs);
  return (
    <>
      <ThreadControls key={threadId}>
        {choices}
        {status}
        {worst && (
          <ThreadControl name="prs" label={`${prs.length} PR${prs.length === 1 ? "" : "s"}`} icon="GitPullRequest" tone={PR_TONE[worst.attention]}>
            <PullRequestsPanel threadId={threadId} state={state} branchPr={branchPr} inline />
          </ThreadControl>
        )}
      </ThreadControls>
      <NextInNowBanner />
    </>
  );
}

/** The ⌘K palette: mounted once per window, rendered only while open. */
function PaletteHost() {
  const enabled = useSettings().values?.palette === true;
  const { open, close, shortcut } = usePaletteTrigger(enabled);
  return open ? <PaletteWithFlow onClose={close} shortcut={shortcut} /> : null;
}

function PaletteWithFlow(props: { onClose: () => void; shortcut: Parameters<typeof Palette>[0]["shortcut"] }) {
  const { state } = useFlowState();
  return <Palette {...props} flow={state} />;
}

/** Catch up's overlay: mounted once per window, rendered only while open. */
function CatchUpHost() {
  const enabled = useSettings().values?.catchUp === true;
  useEffect(() => {
    catchUpEnabled = enabled;
  }, [enabled]);
  const { open, close } = useCatchUpTrigger(enabled);
  return open ? <CatchUpWithFlow onClose={close} /> : null;
}

function WorkspaceTopBarWithFlow() {
  const { state } = useFlowState();
  return <WorkspaceTopBar flow={state} />;
}

function CatchUpWithFlow({ onClose }: { onClose: () => void }) {
  const { state } = useFlowState();
  return <CatchUpOverlay flow={state} onClose={onClose} />;
}

/** Hosts dialogs that command-palette commands open (they can't render UI themselves). */
function CommandHost() {
  const settings = useSettings().values;
  const expandPlans = settings?.expandPlans === true;
  const copyCode = settings?.copyCode === true;
  const nowOn = settings?.nowQueue === true;
  const focusLimit = focusLimitOf(settings?.focusLimit);
  useEffect(() => {
    focusCommand = nowOn ? { limit: focusLimit } : null;
  }, [nowOn, focusLimit]);
  useEffect(() => {
    // Read by the plan-expander content script, which can't use hooks.
    if (expandPlans) document.documentElement.dataset[EXPAND_PLANS_FLAG] = "";
    else delete document.documentElement.dataset[EXPAND_PLANS_FLAG];
  }, [expandPlans]);
  useEffect(() => {
    // Read by the inline-code-copy content script.
    if (copyCode) document.documentElement.dataset[COPY_CODE_FLAG] = "";
    else delete document.documentElement.dataset[COPY_CODE_FLAG];
  }, [copyCode]);
  const [snoozeThreadId, setSnoozeThreadId] = useState<string | null>(null);
  useEffect(() => {
    const onSnooze = (event: Event) => setSnoozeThreadId((event as CustomEvent<string>).detail);
    window.addEventListener(SNOOZE_EVENT, onSnooze);
    return () => window.removeEventListener(SNOOZE_EVENT, onSnooze);
  }, []);
  return snoozeThreadId === null ? null : (
    <SnoozeDialog threadId={snoozeThreadId} open onOpenChange={(open) => (open ? undefined : setSnoozeThreadId(null))} />
  );
}

// --- focus reporter ------------------------------------------------------------------
// Tells the server which thread this window has focused, so `bb jb-flow focused`
// (used by the Stream Deck) can target it. Split layouts report the focused pane.

/** RPC client for command-palette handlers, which run outside React. */
let commandRpc: ReturnType<typeof useRpc<typeof rpcContract>> | null = null;
/** The Catch up setting, for the command's availability check (it can't use hooks). */
let catchUpEnabled = false;
/** What the Focus command needs from settings; null while Now and Focus is off. */
let focusCommand: { limit: number } | null = null;
const SNOOZE_EVENT = "jb-flow:snooze";

function FocusReporter() {
  const rpc = useRpc<typeof rpcContract>();
  commandRpc = rpc;
  const { threadId: routeThreadId } = useBbContext();
  const split = useSidebarSplitLayout();
  const threadId = split?.panes.find((pane) => pane.isFocused)?.threadId ?? routeThreadId;
  // Where the focused pane sits, for a deck key that shows "2/5".
  const ordered = split && split.panes.length > 1 ? paneOrder(split.panes) : [];
  const focusedIndex = ordered.findIndex((pane) => pane.isFocused);
  const paneIndex = focusedIndex >= 0 ? focusedIndex + 1 : null;
  const paneTotal = ordered.length;
  const [clientId] = useState(() => {
    const existing = sessionStorage.getItem("jb-flow:client");
    if (existing) return existing;
    const created = Math.random().toString(36).slice(2, 12);
    sessionStorage.setItem("jb-flow:client", created);
    return created;
  });

  const interactedAt = useRef(0);
  useEffect(() => {
    const send = () => {
      void rpc
        .call("focus_report", {
          clientId,
          threadId,
          windowFocused: document.hasFocus(),
          interactedAt: interactedAt.current,
          origin: location.origin,
          userAgent: navigator.userAgent.slice(0, 300),
          ...(paneIndex !== null ? { panes: { index: paneIndex, total: paneTotal } } : {}),
        })
        .catch(() => undefined);
    };
    // The window you last physically used wins, so report interactions promptly
    // (throttled: at most one extra report per 5s).
    let lastSent = 0;
    const interact = () => {
      interactedAt.current = Date.now();
      if (Date.now() - lastSent > 5_000) {
        lastSent = Date.now();
        send();
      }
    };
    for (const type of ["pointerdown", "keydown", "pointermove", "wheel"] as const) {
      window.addEventListener(type, interact, { passive: true, capture: true });
    }
    send();
    window.addEventListener("focus", send);
    window.addEventListener("blur", send);
    document.addEventListener("visibilitychange", send);
    // Keep reporting while BB is in the background too: deck keys are pressed
    // while other apps have focus.
    const heartbeat = window.setInterval(() => {
      if (document.visibilityState === "visible") send();
    }, 60_000);
    return () => {
      for (const type of ["pointerdown", "keydown", "pointermove", "wheel"] as const) {
        window.removeEventListener(type, interact, { capture: true });
      }
      window.removeEventListener("focus", send);
      window.removeEventListener("blur", send);
      document.removeEventListener("visibilitychange", send);
      window.clearInterval(heartbeat);
    };
  }, [rpc, clientId, threadId, paneIndex, paneTotal]);
  return null;
}

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "workspace-topbar", mount: mountWorkspaceTopBar });
  app.slots.experimental_appOverlay({ id: "workspace-topbar", component: WorkspaceTopBarWithFlow });
  app.contentScripts.register({ id: "shell-appearance", mount: mountShellAppearance });
  app.contentScripts.register({ id: "timeline-activity", mount: mountTimelineActivity });
  app.contentScripts.register({ id: "inline-code-copy", mount: mountInlineCodeCopy });
  app.contentScripts.register({ id: "callouts", mount: mountCallouts });
  app.slots.experimental_appOverlay({ id: "shell-appearance-preference", component: ShellAppearancePreference });
  app.contentScripts.register({ id: "pane-appearance", mount: mountPaneAppearance });
  app.slots.experimental_appOverlay({ id: "pane-appearance-preference", component: PaneAppearancePreference });
  app.contentScripts.register({ id: "split-scroll", mount: mountSplitScroll });
  app.slots.experimental_appOverlay({ id: "split-scroll-preference", component: SplitScrollPreference });
  app.slots.experimental_appOverlay({ id: "pane-edge-hints", component: PaneEdgeHints });
  app.slots.experimental_appOverlay({ id: "pane-commands", component: PaneCommandsHost });
  app.slots.navPanel({
    id: "catch-up",
    title: "Catch up",
    icon: "MailOpen",
    path: "catch-up",
    component: () => {
      const { state } = useFlowState();
      return <CatchUpPage flow={state} />;
    },
    experimental_useBadge: () => {
      const { state } = useFlowState();
      return useCatchUpBadge(state, useSettings().values?.catchUp === true);
    },
  });
  app.slots.navPanel({
    id: CONDUCTOR_PANEL,
    title: "Conductor",
    icon: "Workflow",
    path: CONDUCTOR_PANEL,
    component: ConductorPage,
  });
  app.contentScripts.register({ id: "plan-expander", mount: mountPlanExpander });
  app.slots.experimental_appOverlay({ id: "focus-reporter", component: FocusReporter });
  app.slots.experimental_appOverlay({ id: "plan-model-picker", component: PlanModelPicker });
  app.slots.experimental_sidebarNavigation({
    id: "workspaces", title: "JB Flow workspaces", placement: "list",
    description: "Workspace tabs with projects, threads, sections and tools.",
    component: WorkspaceNavigation,
  });
  app.slots.experimental_appOverlay({ id: "workspace-route", component: WorkspaceRouteBridge });
  app.slots.settingsSection({ id: "workspaces", title: "Workspaces", component: () => <WorkspaceSettings /> });
  app.slots.experimental_threadAction({
    id: "workspace", title: "Workspace", icon: "Folder", group: "organize",
    useData: () => ({ ...useWorkspaces(), enabled: useSettings().values?.workspaces === true }),
    item: ({ thread, data }) => !data.enabled ? null : ({
      label: "Move to workspace", icon: "Folder",
      choices: { items: [
        { id: "auto", label: "Automatic (from parent, section or project)" },
        ...data.state.workspaces.map((workspace) => ({ id: workspace.id, label: workspace.name })),
        { id: "unassigned", label: "No workspace" },
      ] },
      run: async ({ value }) => {
        if (!value) return;
        await data.rpc.call("workspace_assign", { threadId: thread.id, workspaceId: value === "auto" || value === "unassigned" ? null : value, automatic: value === "auto" });
        await data.refresh();
      },
    }),
  });
  app.slots.experimental_threadList({
    id: "triage",
    title: "Triage",
    description:
      "What to do next on top, then lanes, project chips, tags, snooze and keyboard triage.",
    component: TriageThreadList,
  });
  app.slots.experimental_threadContextSegment({
    id: "status",
    title: "Thread status",
    // After bb's parent thread, before its changed files.
    group: "2_status",
    summary: ThreadStatusSegment,
    useVisible: useThreadStatusVisible,
  });
  app.slots.experimental_tab({
    ...PRS_TAB,
    title: "Pull requests",
    icon: "GitPullRequest",
    component: PullRequestsTab,
    run: ({ experimental_panel }) => {
      experimental_panel.openTab({ tab: PRS_TAB, title: "Pull requests" });
    },
  });
  app.slots.experimental_appOverlay({ id: "command-host", component: CommandHost });
  app.slots.experimental_appOverlay({ id: "palette", component: PaletteHost });
  app.slots.experimental_appOverlay({ id: "catch-up", component: CatchUpHost });
  app.slots.experimental_appOverlay({ id: "tab-switcher", component: TabSwitcherHost });
  const inThread = ({ threadId }: { threadId: string | null }) => threadId !== null;
  app.commands.register({
    id: "palette",
    title: "Open JB Flow palette",
    run: () => {
      window.dispatchEvent(new CustomEvent(PALETTE_EVENT));
    },
  });
  app.commands.register({
    id: "catch-up",
    title: "Catch up on unread threads",
    defaultShortcut: { key: "c", alt: true, shift: true },
    isAvailable: () => catchUpEnabled,
    run: () => {
      window.dispatchEvent(new CustomEvent(CATCH_UP_EVENT));
    },
  });
  app.commands.register({
    id: "snooze",
    title: "Snooze this thread…",
    defaultShortcut: { key: "s", alt: true, shift: true },
    isAvailable: inThread,
    run: ({ threadId }) => {
      if (threadId) window.dispatchEvent(new CustomEvent(SNOOZE_EVENT, { detail: threadId }));
    },
  });
  app.commands.register({
    id: "toggle-focus",
    title: "Add this thread to Focus, or remove it",
    defaultShortcut: { key: "f", alt: true, shift: true },
    isAvailable: (context) => focusCommand !== null && inThread(context),
    run: async ({ threadId }) => {
      if (!threadId || focusCommand === null) return;
      const focused = flowState?.focused ?? {};
      const inFocus = focused[threadId] !== undefined;
      if (!inFocus && Object.keys(focused).length >= focusCommand.limit) {
        toast.error(`Focus is full (${Object.keys(focused).length} of ${focusCommand.limit}). Press f on a row in the sidebar to choose one to drop.`);
        return;
      }
      await commandRpc?.call("focus_set", { threadId, focused: !inFocus });
      toast.success(inFocus ? "Removed from Focus" : "Added to Focus");
    },
  });
  app.commands.register({
    id: "next-needs-me",
    title: "Open the next thread that needs me",
    defaultShortcut: { key: "n", alt: true, shift: true },
    run: async () => {
      await commandRpc?.call("next_needs_me", { archiveThreadId: null });
    },
  });
  app.commands.register({
    id: "open-queue-panes",
    title: "Open what needs me side by side",
    defaultShortcut: { key: "o", alt: true, shift: true },
    run: () => {
      window.dispatchEvent(new CustomEvent(OPEN_QUEUE_EVENT));
    },
  });
  app.commands.register({
    id: "status-open-panes",
    title: "Update status in every open pane…",
    isAvailable: () => paneCommands.statusAvailable,
    run: () => {
      window.dispatchEvent(new CustomEvent(STATUS_PANES_EVENT));
    },
  });
  app.commands.register({
    id: "archive-next",
    title: "Archive this thread and open the next that needs me",
    defaultShortcut: { key: "e", alt: true, shift: true },
    isAvailable: inThread,
    run: async ({ threadId }) => {
      await commandRpc?.call("next_needs_me", { archiveThreadId: threadId });
    },
  });
  app.commands.register({
    id: "dev-servers",
    title: "Start dev servers",
    defaultShortcut: { key: "d", alt: true, shift: true },
    isAvailable: inThread,
    run: ({ experimental_panel }) => {
      experimental_panel.openTab({ tab: DEV_SERVERS_TAB, params: DEV_AUTORUN, title: "Scripts" });
    },
  });
  app.commands.register({
    id: "pull-requests",
    title: "Show this thread's pull requests",
    defaultShortcut: { key: "p", alt: true, shift: true },
    isAvailable: inThread,
    run: ({ experimental_panel }) => {
      experimental_panel.openTab({ tab: PRS_TAB, title: "Pull requests" });
    },
  });
  app.commands.register({
    id: "watch-ci",
    title: "Watch CI and reviews for this thread's PRs",
    defaultShortcut: { key: "w", alt: true, shift: true },
    isAvailable: inThread,
    run: async ({ threadId }) => {
      if (threadId) await commandRpc?.call("thread_watch_ci", { threadId });
    },
  });
  app.slots.experimental_threadAction({
    id: "snooze",
    title: "Snooze",
    icon: "Clock",
    group: "1_state",
    placement: "header",
    useData: () => useFlowState().state?.snoozes ?? {},
    item: ({ thread, data }) => {
      const snoozed = data[thread.id];
      return {
        label: snoozed ? `Snoozed until ${formatWhen(snoozed.until)}` : "Snooze",
        icon: "Clock",
        // The dialog lives in CommandHost, shared with the Snooze command.
        run: () => {
          window.dispatchEvent(new CustomEvent(SNOOZE_EVENT, { detail: thread.id }));
        },
      };
    },
  });
  app.slots.experimental_tab({
    ...DEV_SERVERS_TAB,
    title: "Start dev servers",
    icon: "Play",
    component: RepoCommandsPanel,
    params: DEV_AUTORUN,
    run: ({ experimental_panel }) => {
      experimental_panel.openTab({ tab: DEV_SERVERS_TAB, params: DEV_AUTORUN, title: "Scripts" });
    },
  });
  app.slots.experimental_tab({
    ...REPO_COMMANDS_TAB,
    title: "Scripts",
    icon: "ListView",
    component: RepoCommandsPanel,
    run: ({ experimental_panel }) => {
      experimental_panel.openTab({ tab: REPO_COMMANDS_TAB, title: "Scripts" });
    },
  });
  app.slots.settingsSection({
    id: "repo-commands",
    title: "Repo commands",
    description: "Per-project buttons for the thread side panel.",
    component: RepoCommandsSettings,
  });
  app.composer.customize({
    id: "thread-controls",
    banners: [{ id: "thread-controls", chrome: "bare", component: ThreadControlsBanner }],
  });
  app.slots.homepageSection({
    id: "unreleased",
    title: "Unreleased",
    component: UnreleasedSection,
  });
  app.slots.homepageSection({
    id: "your-move",
    title: "Your move",
    component: () => {
      const { state } = useFlowState();
      return <YourMoveSection lead={<CatchUpHomeEntry flow={state} />} />;
    },
  });
  app.slots.homepageSection({
    id: "conductor-feed",
    title: "Done for you",
    component: DoneForYouSection,
  });
  app.slots.homepageSection({
    id: "stale-digest",
    title: "Stale threads",
    component: DigestSection,
  });
  app.slots.settingsSection({
    id: "conductors",
    title: "Conductors",
    description: "One permanent conductor per workspace takes its threads' routine news and leaves you one briefing. Needs the Conductor setting.",
    component: ConductorSettings,
  });
  app.slots.settingsSection({
    id: "lanes",
    title: "Triage lanes",
    description: "Sections the Triage list uses as numbered lanes.",
    component: LaneSettings,
  });
  app.slots.settingsSection({
    id: "area-tags",
    title: "Area tags",
    description: "Convert area sections into multi-valued tags.",
    component: MigrationSettings,
  });
});
