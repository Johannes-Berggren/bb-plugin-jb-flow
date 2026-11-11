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
import { definePluginApp, experimental_useSidebarThreads as useSidebarThreads, useRpc, experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest, useBbContext, useComposer, useSidebarSplitLayout, useSettings } from "@get-bb/plugin-sdk/app";
import type { JsonValue } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { RepoCommandsPanel, RepoCommandsSettings } from "./repo-panel";
import { DecisionChips, UnreleasedSection, YourMoveSection, HeaderStatusStrip, PullRequestsPanel } from "./ui-extras";
import { formatWhen } from "./when";
import { focusLimitOf } from "./now-model";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { cn } from "@/lib/utils";
import { mountShellAppearance, ShellAppearancePreference } from "./shell-appearance";
import { LiveActivityBanner } from "./live-activity";
import { PALETTE_EVENT, Palette, usePaletteTrigger } from "./palette";
import { CatchUpHomeEntry, CatchUpOverlay, CatchUpPage, useCatchUpBadge, useCatchUpTrigger } from "./catch-up";
import { CATCH_UP_EVENT } from "./catch-up-model";
import { flowState, useFlowState } from "./flow-state";
import { SnoozeDialog } from "./dialogs";
import { TriageThreadList } from "./triage-list";
import { DigestSection } from "./digest";
import { LaneSettings, MigrationSettings } from "./settings-panels";
import { EXPAND_PLANS_FLAG, mountPlanExpander } from "./plan-expander";

// --- thread header: status strip + Pull requests panel ------------------------------

function ThreadStatusHeader({ threadId }: { threadId: string }) {
  const { state } = useFlowState();
  const { pullRequest } = useSidebarThreadPullRequest(threadId);
  return <HeaderStatusStrip threadId={threadId} state={state} branchPr={pullRequest} />;
}

function PullRequestsTab({ threadId, params }: { threadId: string; params: JsonValue | null }) {
  const { state } = useFlowState();
  const { pullRequest } = useSidebarThreadPullRequest(threadId);
  return <PullRequestsPanel threadId={threadId} params={params} state={state} branchPr={pullRequest} />;
}

function DecisionChipsBanner() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const { threads } = useSidebarThreads();
  const thread = threadId ? threads.find((candidate) => candidate.id === threadId) : undefined;
  if (composer.isRunning || !composer.isEmpty) return null;
  return <DecisionChips threadId={threadId} updatedAt={thread?.updatedAt ?? null} idle={thread?.status === "idle"} />;
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

// --- thread header action --------------------------------------------------------

function SnoozeHeaderAction({ threadId }: { threadId: string }) {
  const { state } = useFlowState();
  const [open, setOpen] = useState(false);
  const snoozed = state?.snoozes[threadId];
  const label = snoozed
    ? `Snoozed until ${formatWhen(snoozed.until)}`
    : "Snooze thread";
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "size-7",
          snoozed ? "text-foreground" : "text-muted-foreground",
        )}
        aria-label={label}
        onClick={() => setOpen(true)}
      >
        <Glyph name="alarm" className={cn("size-4", snoozed && "text-amber-500")} />
      </Button>
      <SnoozeDialog threadId={threadId} open={open} onOpenChange={setOpen} />
    </>
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
  }, [rpc, clientId, threadId]);
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
  app.contentScripts.register({ id: "plan-expander", mount: mountPlanExpander });
  app.slots.experimental_appOverlay({ id: "focus-reporter", component: FocusReporter });
  app.slots.experimental_sidebarNavigation({
    id: "workspaces", title: "JB Flow workspaces", placement: "list",
    description: "Workspace tabs with projects, threads, sections and tools.",
    component: WorkspaceNavigation,
  });
  app.slots.experimental_appOverlay({ id: "workspace-route", component: WorkspaceRouteBridge });
  app.slots.settingsSection({ id: "workspaces", title: "Workspaces", component: WorkspaceSettings });
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
  app.slots.experimental_threadHeaderAction({
    id: "status",
    title: "Thread status",
    component: ({ threadId }) => <ThreadStatusHeader threadId={threadId} />,
  });
  app.slots.threadPanelAction({
    id: "prs",
    title: "Pull requests",
    icon: "GitPullRequest",
    component: PullRequestsTab,
    run: ({ openPanel }) => {
      openPanel({ title: "Pull requests" });
    },
  });
  app.slots.experimental_appOverlay({ id: "command-host", component: CommandHost });
  app.slots.experimental_appOverlay({ id: "palette", component: PaletteHost });
  app.slots.experimental_appOverlay({ id: "catch-up", component: CatchUpHost });
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
    run: ({ openPanel }) => {
      openPanel({ actionId: "dev-servers", title: "Scripts", params: { autorun: "dev" } });
    },
  });
  app.commands.register({
    id: "pull-requests",
    title: "Show this thread's pull requests",
    defaultShortcut: { key: "p", alt: true, shift: true },
    isAvailable: inThread,
    run: ({ openPanel }) => {
      openPanel({ actionId: "prs", title: "Pull requests" });
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
  app.slots.experimental_threadHeaderAction({
    id: "snooze",
    title: "Snooze",
    component: ({ threadId }) => <SnoozeHeaderAction threadId={threadId} />,
  });
  app.slots.threadPanelAction({
    id: "dev-servers",
    title: "Start dev servers",
    icon: "Play",
    component: RepoCommandsPanel,
    run: ({ openPanel }) => {
      openPanel({ title: "Scripts", params: { autorun: "dev" } });
    },
  });
  app.slots.threadPanelAction({
    id: "repo-commands",
    title: "Scripts",
    icon: "ListView",
    component: RepoCommandsPanel,
    run: ({ openPanel }) => {
      openPanel({ title: "Scripts" });
    },
  });
  app.slots.settingsSection({
    id: "repo-commands",
    title: "Repo commands",
    description: "Per-project buttons for the thread side panel.",
    component: RepoCommandsSettings,
  });
  // Banners render in registration order: the reply choices sit above the monitor.
  app.composer.customize({
    id: "decision-chips",
    banners: [{ id: "decision-chips", chrome: "bare", component: DecisionChipsBanner }],
  });
  app.composer.customize({
    id: "live-activity",
    banners: [{ id: "live-activity", chrome: "bare", component: () => {
      const { state } = useFlowState();
      return <LiveActivityBanner runningSince={state?.running ?? {}} trackedPrs={state?.threadPrs ?? {}} watches={state?.watching ?? {}} />;
    } }],
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
    id: "stale-digest",
    title: "Stale threads",
    component: DigestSection,
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
