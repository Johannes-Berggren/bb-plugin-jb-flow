// jb-flow frontend: the Triage thread list, a snooze control in the thread
// header, the stale-thread digest on the homepage, and the area-tag migration
// in settings. All plugin state comes from server.ts over RPC and refreshes on
// the "jb-flow-changed" realtime signal.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  ThreadTitle,
  useRealtime,
  useRpc,
  useSdk,
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  useBbContext,
  useComposerView,
  useSidebarSplitLayout,
  useSidebarThreadShortcut,
} from "@get-bb/plugin-sdk/app";
import type {
  JsonValue,
  PluginSidebarProject,
  PluginSidebarSection,
  PluginSidebarThread,
  PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import type { DigestItem, FlowState, rpcContract } from "./server";
import type { Leftover } from "./leftovers";
import { RepoCommandsPanel, RepoCommandsSettings } from "./repo-panel";
import {
  DecisionChips,
  YourMoveSection,
  HeaderStatusStrip,
  PR_TONE,
  PullRequestsPanel,
  ThreadHoverPreview,
  allSettled,
  attentionLabel,
  duration,
  prGlyph,
  runInfo,
  threadPrs,
  useNow,
  worstPr,
} from "./ui-extras";
import type { RunInfo, ThreadPr } from "./ui-extras";
import { formatWhen } from "./when";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Glyph } from "@/components/ui/glyph";
import type { GlyphName } from "@/components/ui/glyph";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const DAY_MS = 86_400_000;
const SNOOZE_PRESETS = [
  { label: "Later today", when: "today" },
  { label: "Tomorrow", when: "tomorrow" },
  { label: "Monday", when: "mon" },
  { label: "In 1 week", when: "1w" },
  { label: "In 2 weeks", when: "2w" },
] as const;

// --- shared state -------------------------------------------------------------

function useFlowState() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<FlowState | null>(null);
  const refetch = useCallback(() => {
    rpc.call("state_get", null).then((next) => {
      projectNaming = next;
      setState(next);
    }, () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("jb-flow-changed", refetch);
  return { rpc, state };
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// --- lanes --------------------------------------------------------------------

type LaneId = "priority" | "active" | "waiting" | "later" | "low";
type Lane = {
  id: LaneId;
  title: string;
  sectionId: string | null;
  key: string;
};

/** Maps the existing sections onto lanes by name, so renames are tolerated. */
function resolveLanes(sections: readonly PluginSidebarSection[]): Lane[] {
  const find = (pattern: RegExp) =>
    sections.find((section) => pattern.test(section.name))?.id ?? null;
  const lanes: Lane[] = [
    {
      id: "priority",
      title: "Priority",
      sectionId: find(/^\W*priority/i),
      key: "1",
    },
    { id: "active", title: "Active", sectionId: null, key: "2" },
    {
      id: "waiting",
      title: "Waiting for others",
      sectionId: find(/waiting/i),
      key: "3",
    },
    {
      id: "later",
      title: "Pick up later",
      sectionId: find(/pick up later/i),
      key: "4",
    },
    {
      id: "low",
      title: "Low priority",
      sectionId: find(/low priority/i),
      key: "5",
    },
  ];
  // A lane whose section is missing is dropped; Active is the unsectioned bucket.
  return lanes.filter(
    (lane) => lane.id === "active" || lane.sectionId !== null,
  );
}

function needsMe(thread: PluginSidebarThread): boolean {
  return (
    thread.hasPendingInteraction ||
    thread.indicator === "waiting-for-input" ||
    thread.indicator === "unread-error" ||
    (thread.isUnread && thread.status === "idle")
  );
}

// --- project chips ------------------------------------------------------------

function projectHue(projectId: string): number {
  let hash = 0;
  for (const char of projectId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

// Filled from local.config.json via state_get; chips re-render with the list.
let projectNaming: Pick<FlowState, "projectShortNames" | "stripProjectPrefixes"> = {
  projectShortNames: {},
  stripProjectPrefixes: [],
};

function shortProjectName(name: string): string {
  const known = projectNaming.projectShortNames[name];
  if (known) return known;
  const prefix = projectNaming.stripProjectPrefixes.find((candidate) => name.startsWith(candidate));
  return (prefix ? name.slice(prefix.length) : name).slice(0, 10);
}

function ProjectChip({
  project,
}: {
  project: PluginSidebarProject | undefined;
}) {
  if (project === undefined || project.isPersonal) return null;
  const hue = projectHue(project.id);
  return (
    <span
      className="shrink-0 rounded px-1 text-[10px] font-medium leading-4"
      style={{
        backgroundColor: `hsl(${hue} 70% 50% / 0.16)`,
        color: `hsl(${hue} 60% 45%)`,
      }}
      title={project.name}
    >
      {shortProjectName(project.name)}
    </span>
  );
}

// --- dialogs --------------------------------------------------------------------

function SnoozeDialog({
  threadId,
  open,
  onOpenChange,
}: {
  threadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { rpc, state } = useFlowState();
  const current = state?.snoozes[threadId];
  const [note, setNote] = useState("");
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setNote(current?.note ?? "");
      setCustom("");
      setError(null);
    }
  }, [open, current?.note]);

  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await action();
      onOpenChange(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };
  const snooze = (when: string) =>
    run(() =>
      rpc.call("snooze", {
        threadId,
        when,
        note: note.trim() === "" ? null : note,
      }),
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Snooze thread</DialogTitle>
          <DialogDescription>
            {current
              ? `Snoozed until ${formatWhen(current.until)}.`
              : "Hide it until later. It comes back unread."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {SNOOZE_PRESETS.map((preset) => (
            <Button
              key={preset.when}
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => snooze(preset.when)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (custom.trim() !== "") void snooze(custom.trim());
          }}
        >
          <Input
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder="3d, fri, 2026-10-12…"
            aria-label="Custom snooze time"
          />
          <Button
            type="submit"
            size="sm"
            disabled={pending || custom.trim() === ""}
          >
            Snooze
          </Button>
        </form>
        <Input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Optional: prompt to send on wake-up"
          aria-label="Wake-up prompt"
        />
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {current ? (
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => run(() => rpc.call("unsnooze", { threadId }))}
            >
              Wake now
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TagDialog({
  threadId,
  tags,
  knownTags,
  onClose,
}: {
  threadId: string;
  tags: readonly string[];
  knownTags: readonly string[];
  onClose: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState<string[]>([...tags]);
  const [input, setInput] = useState("");
  const toggle = (tag: string) =>
    setDraft((current) =>
      current.includes(tag)
        ? current.filter((value) => value !== tag)
        : [...current, tag],
    );
  const save = async () => {
    const next =
      input.trim() === "" ? draft : [...new Set([...draft, input.trim()])];
    await rpc.call("tags_set", { threadId, tags: next });
    onClose();
  };
  const options = [...new Set([...knownTags, ...draft])].sort();
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Tags</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5">
          {options.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => toggle(tag)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs",
                draft.includes(tag)
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground",
              )}
            >
              {tag}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="New tag"
            aria-label="New tag"
          />
          <Button type="submit" size="sm">
            Save
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
  const view = useComposerView();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const { threads } = useSidebarThreads();
  const thread = threadId ? threads.find((candidate) => candidate.id === threadId) : undefined;
  if (view.run.isRunning || !view.draft.isEmpty) return null;
  return <DecisionChips threadId={threadId} updatedAt={thread?.updatedAt ?? null} idle={thread?.status === "idle"} />;
}

/** Hosts dialogs that command-palette commands open (they can't render UI themselves). */
function CommandHost() {
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

// --- triage thread list ----------------------------------------------------------

type Group = {
  id: string;
  title: string;
  threads: PluginSidebarThread[];
  defaultCollapsed?: boolean;
  limit?: number;
  action?: { label: string; run: () => void };
  hint?: string;
  dynamic?: { glyph: GlyphName; tone: string };
  /** First of your own sections: draws the "Your sections" divider above it. */
  firstUserGroup?: boolean;
  /** Your section behind this group (null = the unsectioned Active lane). */
  section?: { id: string | null; name: string; isLane: boolean };
};

// --- row status icon ---------------------------------------------------------------
// One glyph that answers "what is this thread doing / waiting on?", replacing the
// provider badge. Priority: needs you > error > running > watched > PR > finished.

type RowStatus = { glyph: GlyphName; tone: string; label: string; spin?: boolean };
function rowStatus(
  thread: PluginSidebarThread,
  busy: boolean,
  watching: FlowState["watching"][string] | undefined,
  prs: readonly ThreadPr[],
  run: RunInfo | null,
): RowStatus {
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") {
    return { glyph: "question", tone: "text-amber-500", label: thread.indicatorLabel ?? "Needs your input" };
  }
  if (thread.status === "error" || thread.indicator === "unread-error") {
    return { glyph: "alert", tone: "text-red-500", label: thread.indicatorLabel ?? "Failed" };
  }
  if (busy && run?.stuck) {
    return { glyph: "alert", tone: "text-amber-500", label: `Possibly stuck: no output for ${duration(run.silent)}` };
  }
  if (busy) return { glyph: "spinner", tone: "text-sky-500", label: run && run.elapsed >= 60_000 ? `Working for ${duration(run.elapsed)}` : "Working", spin: true };
  if (watching?.kind === "ci") return { glyph: "hourglass", tone: "text-sky-500", label: watching.label };
  if (watching?.kind === "release") return { glyph: "rocket", tone: "text-violet-500", label: watching.label };
  if (watching?.kind === "continue") return { glyph: "alarm", tone: "text-amber-500", label: watching.label };
  const worst = worstPr(prs);
  if (worst) {
    const label = prs.length === 1 ? `PR #${worst.number}: ${attentionLabel(worst.attention)}` : `${prs.length} PRs; worst: #${worst.number} ${attentionLabel(worst.attention)}`;
    return { glyph: prGlyph(worst), tone: PR_TONE[worst.attention] ?? "text-muted-foreground", label };
  }
  if (thread.isUnread) return { glyph: "check", tone: "text-green-500", label: "Finished, unread" };
  return { glyph: "dot", tone: "text-muted-foreground/40", label: "Idle" };
}

function StatusIcon({ status }: { status: RowStatus }) {
  return (
    <span title={status.label} aria-label={status.label} className="flex size-4 shrink-0 items-center justify-center">
      <Glyph name={status.glyph} className={cn("size-3.5", status.tone, status.spin && "animate-spin")} />
    </span>
  );
}

function ThreadRow({
  thread,
  project,
  active,
  tags,
  snoozeUntil,
  watching,
  createdPrs,
  running,
  now,
  lanes,
  otherSections,
  onNavigate,
  onSnooze,
  onUnsnooze,
  onTag,
  onRename,
}: {
  thread: PluginSidebarThread;
  project: PluginSidebarProject | undefined;
  active: boolean;
  tags: readonly string[];
  snoozeUntil: number | undefined;
  watching: FlowState["watching"][string] | undefined;
  createdPrs: FlowState["threadPrs"][string] | undefined;
  running: FlowState["running"][string] | undefined;
  now: number;
  lanes: readonly Lane[];
  otherSections: readonly PluginSidebarSection[];
  onNavigate: () => void;
  onSnooze: () => void;
  onUnsnooze: () => void;
  onTag: () => void;
  onRename: () => void;
}) {
  const actions = useSidebarThreadActions();
  const sdk = useSdk();
  const split = useSidebarThreadSplit(thread.id);
  const drag = useContext(DragContext);
  const moveTo = (sectionId: string | null) => {
    void sdk.threads.update({ threadId: thread.id, sectionId });
  };
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
  };
  const shortcut = useSidebarThreadShortcut(thread.id);
  const idleDays = (Date.now() - thread.updatedAt) / DAY_MS;
  const busy = thread.status === "active" || thread.status === "starting";
  const { pullRequest } = useSidebarThreadPullRequest(thread.id);
  const prs = threadPrs(createdPrs, pullRequest);
  const run = busy ? runInfo(running, now) : null;
  const status = rowStatus(thread, busy, watching, prs, run);
  const worst = worstPr(prs);
  const openPrs = prs.filter((pr) => pr.state === "open" || pr.state === "draft");
  const rpc = useRpc<typeof rpcContract>();

  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const lane = lanes.find((candidate) => candidate.key === event.key);
    if (lane) {
      event.preventDefault();
      void sdk.threads.update({
        threadId: thread.id,
        sectionId: lane.sectionId,
      });
    } else if (event.key === "e") {
      event.preventDefault();
      actions.archive(thread.id);
    } else if (event.key === "s") {
      event.preventDefault();
      onSnooze();
    } else if (event.key === "t") {
      event.preventDefault();
      onTag();
    } else if (event.key === "u") {
      event.preventDefault();
      void actions.setRead(thread.id, thread.isUnread);
    } else if (event.key === "j" || event.key === "k") {
      event.preventDefault();
      const rows = Array.from(
        document.querySelectorAll<HTMLAnchorElement>("[data-jb-flow-row]"),
      );
      const index = rows.indexOf(event.currentTarget);
      rows[index + (event.key === "j" ? 1 : -1)]?.focus();
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <ThreadHoverPreview
          thread={thread}
          projectName={project?.name ?? null}
          sectionName={[...lanes.map((lane) => ({ id: lane.sectionId, name: lane.title })), ...otherSections].find((section) => section.id === thread.sectionId)?.name ?? null}
          status={status}
          tags={tags}
          prs={prs}
          watching={watching}
          snoozeUntil={snoozeUntil}
        >
        <a
          href={thread.href}
          {...split.splitProps}
          onPointerDown={(event) => {
            split.splitProps.onPointerDown?.(event);
            drag.start(thread, event);
          }}
          data-jb-flow-row=""
          data-sidebar-thread-shortcut-target=""
          aria-current={active ? "page" : undefined}
          aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
          onClick={(event) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.button !== 0
            )
              return;
            event.preventDefault();
            actions.open(thread.id);
            onNavigate();
          }}
          onKeyDown={onKeyDown}
          className={cn(
            "group flex h-8 items-center gap-2 rounded-md pl-6 pr-2 text-sm outline-none",
            "hover:bg-accent focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-ring",
            active && "bg-accent",
          )}
          style={{
            opacity: drag.dragging?.threadId === thread.id ? 0.4 : active ? 1 : idleDays > 14 ? 0.5 : idleDays > 7 ? 0.7 : 1,
          }}
        >
          <StatusIcon status={status} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              thread.isUnread && "font-semibold",
            )}
          >
            <ThreadTitle threadId={thread.id} />
          </span>
          {tags.slice(0, 2).map((tag) => (
            <span
              key={tag}
              className="shrink-0 text-[10px] text-muted-foreground"
            >
              #{tag}
            </span>
          ))}
          <ProjectChip project={project} />
          {run ? (
            <span className={cn("shrink-0 text-[10px] tabular-nums", run.stuck ? "font-medium text-amber-600" : "text-sky-600")}>
              {run.stuck ? `stuck ${duration(run.silent)}` : duration(run.elapsed)}
            </span>
          ) : null}
          {worst ? (
            <button
              type="button"
              tabIndex={-1}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                window.open(worst.url, "_blank", "noopener");
              }}
              title={prs.map((pr) => `${pr.repo}#${pr.number} · ${attentionLabel(pr.attention)} · ${pr.title}`).join("\n")}
              className={cn("shrink-0 text-[10px] tabular-nums hover:underline", PR_TONE[worst.attention])}
            >
              {prs.length === 1 ? `#${worst.number}` : `${prs.length} PRs`}
            </button>
          ) : null}
          {snoozeUntil !== undefined ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {formatWhen(snoozeUntil)}
            </span>
          ) : shortcut ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {shortcut.label}
            </span>
          ) : null}
        </a>
        </ThreadHoverPreview>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem
          onSelect={() => {
            actions.open(thread.id);
            onNavigate();
          }}
        >
          <Icon name="MessageSquare" className="size-4" /> Open
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!split.isAvailable}
          onSelect={() => {
            actions.open(thread.id, { split: true });
            onNavigate();
          }}
        >
          <Icon name="Columns2" className="size-4" /> Open in split view
        </ContextMenuItem>
        {busy ? (
          <ContextMenuItem onSelect={() => void rpc.call("thread_stop", { threadId: thread.id })}>
            <Icon name="Square" className="size-4" /> Stop run{run?.stuck ? ` (silent ${duration(run.silent)})` : ""}
          </ContextMenuItem>
        ) : null}
        {openPrs.length > 0 ? (
          <ContextMenuItem onSelect={() => void rpc.call("thread_watch_ci", { threadId: thread.id })}>
            <Glyph name="hourglass" className="size-4" /> Watch CI ({openPrs.length} open PR{openPrs.length === 1 ? "" : "s"})
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => void actions.setPinned(thread.id, !thread.isPinned)}
        >
          <Icon name={thread.isPinned ? "PinOff" : "Pin"} className="size-4" />
          {thread.isPinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => void actions.setRead(thread.id, thread.isUnread)}
        >
          <Icon
            name={thread.isUnread ? "MailOpen" : "Mail"}
            className="size-4"
          />
          {thread.isUnread ? "Mark as read" : "Mark as unread"}
          <ContextMenuShortcut>U</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={onRename}>
          <Glyph name="pencil" className="size-4" /> Rename…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Glyph name="folderMove" className="size-4" /> Move to
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-52">
            {lanes.map((lane) => (
              <ContextMenuItem
                key={lane.id}
                disabled={thread.sectionId === lane.sectionId}
                onSelect={() => moveTo(lane.sectionId)}
              >
                {lane.title}
                <ContextMenuShortcut>{lane.key}</ContextMenuShortcut>
              </ContextMenuItem>
            ))}
            {otherSections.length > 0 ? <ContextMenuSeparator /> : null}
            {otherSections.map((section) => (
              <ContextMenuItem
                key={section.id}
                disabled={thread.sectionId === section.id}
                onSelect={() => moveTo(section.id)}
              >
                {section.name}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        {snoozeUntil !== undefined ? (
          <ContextMenuItem onSelect={onUnsnooze}>
            <Glyph name="alarm" className="size-4" /> Wake now
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onSelect={onSnooze}>
          <Glyph name="alarm" className="size-4" />{" "}
          {snoozeUntil !== undefined ? "Change snooze…" : "Snooze…"}
          <ContextMenuShortcut>S</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={onTag}>
          <Glyph name="tag" className="size-4" /> Tags…
          <ContextMenuShortcut>T</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() =>
            copy(new URL(thread.href, window.location.origin).toString())
          }
        >
          <Icon name="Link" className="size-4" /> Copy link
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => copy(thread.id)}>
          <Icon name="Copy" className="size-4" /> Copy thread ID
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.archive(thread.id)}>
          <Icon name="Archive" className="size-4" /> Archive
          <ContextMenuShortcut>E</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => actions.requestDelete(thread.id)}
        >
          <Icon name="Trash2" className="size-4" /> Delete…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RenameDialog({
  thread,
  onClose,
}: {
  thread: PluginSidebarThread;
  onClose: () => void;
}) {
  const actions = useSidebarThreadActions();
  const [title, setTitle] = useState(thread.title ?? thread.displayTitle);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename thread</DialogTitle>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() === "") return;
            void actions.rename(thread.id, title.trim()).then(onClose);
          }}
        >
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label="Thread title"
            autoFocus
          />
          <Button type="submit" size="sm" disabled={title.trim() === ""}>
            Save
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GroupHeader({
  title,
  count,
  collapsed,
  onToggle,
  action,
  hint,
  dynamic,
  menu,
  onDragStart,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  action?: { label: string; run: () => void };
  /** Shown on hover only, e.g. the lane's move key. */
  hint?: string;
  /** Computed group (not a section you made): accent styling. */
  dynamic?: { glyph: GlyphName; tone: string };
  /** Right-click menu items for this group. */
  menu?: ReactNode;
  /** Makes the header draggable to reorder sections. */
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const header = (
    <div onPointerDown={onDragStart} className="group/header flex w-full items-center gap-1 px-2 pb-1.5 pt-5 text-xs font-medium text-muted-foreground">
      <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex min-w-0 flex-1 items-center gap-1.5 hover:text-foreground">
        {dynamic ? (
          <Glyph name={dynamic.glyph} className={cn("size-3.5", dynamic.tone)} />
        ) : (
          <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} className="size-3" />
        )}
        <span className={cn("truncate", dynamic && "text-foreground")}>{title}</span>
        {hint ? (
          <kbd className="rounded border border-border px-1 text-[10px] font-normal leading-4 opacity-0 group-hover/header:opacity-100">{hint}</kbd>
        ) : null}
      </button>
      {action ? (
        <button type="button" onClick={action.run} className="rounded px-1 text-[11px] text-foreground/70 opacity-0 hover:bg-accent hover:text-foreground group-hover/header:opacity-100">
          {action.label}
        </button>
      ) : null}
      <span className="tabular-nums">{count}</span>
    </div>
  );
  if (!menu) return header;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">{menu}</ContextMenuContent>
    </ContextMenu>
  );
}

function SectionNameDialog({
  initial,
  title,
  onSave,
  onClose,
}: {
  initial: string;
  title: string;
  onSave: (name: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() === "") return;
            onSave(name.trim()).then(onClose, (cause: unknown) => setError(errorText(cause)));
          }}
        >
          <Input value={name} onChange={(event) => setName(event.target.value)} aria-label="Section name" autoFocus />
          <Button type="submit" size="sm" disabled={name.trim() === ""}>
            Save
          </Button>
        </form>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() => {
              setPending(true);
              onConfirm().finally(onClose);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- drag threads between sections ---------------------------------------------------
// Pointer-based (not HTML5 drag) so bb's own drag-to-split keeps working: a
// drop inside the sidebar moves the thread; leaving the sidebar cancels ours
// and bb's split gesture takes over.

const DROP_ATTR = "data-jb-drop-section";
const ACTIVE_DROP = "__active";

type DragState = { threadId: string; title: string; x: number; y: number; over: string | null };
const DragContext = createContext<{
  start: (thread: PluginSidebarThread, event: ReactPointerEvent<HTMLElement>) => void;
  dragging: DragState | null;
}>({ start: () => undefined, dragging: null });

function useThreadDrag(onDrop: (threadId: string, sectionId: string | null) => void) {
  const [dragging, setDragging] = useState<DragState | null>(null);
  const start = useCallback(
    (thread: PluginSidebarThread, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
      const nav = event.currentTarget.closest("nav");
      const origin = { x: event.clientX, y: event.clientY };
      let active = false;
      let over: string | null = null;
      const move = (moveEvent: PointerEvent) => {
        if (!active) {
          if (Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) < 6) return;
          active = true;
        }
        const bounds = nav?.getBoundingClientRect();
        if (bounds && (moveEvent.clientX > bounds.right || moveEvent.clientX < bounds.left)) {
          finish(false); // left the sidebar: bb's drag-to-split owns this gesture
          return;
        }
        const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest(`[${DROP_ATTR}]`);
        over = target?.getAttribute(DROP_ATTR) ?? null;
        setDragging({ threadId: thread.id, title: thread.displayTitle, x: moveEvent.clientX, y: moveEvent.clientY, over });
      };
      const finish = (drop: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("keydown", escape);
        setDragging(null);
        if (!active) return;
        // Swallow the click that follows the drag so the row doesn't navigate.
        window.addEventListener("click", (clickEvent) => clickEvent.stopPropagation(), { capture: true, once: true });
        if (drop && over !== null) onDrop(thread.id, over === ACTIVE_DROP ? null : over);
      };
      const up = () => finish(true);
      const escape = (keyEvent: globalThis.KeyboardEvent) => {
        if (keyEvent.key === "Escape") finish(false);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("keydown", escape);
    },
    [onDrop],
  );
  return { start, dragging };
}

// --- reorder sections by dragging their header ---------------------------------------

const SECTION_ATTR = "data-jb-section-key";
/** Order key for a section; the unsectioned Active lane has no id. */
const sectionKey = (id: string | null) => id ?? ACTIVE_DROP;

/** Saved order first; sections it doesn't know yet go right after their default predecessor. */
function mergeOrder(saved: readonly string[], defaults: readonly string[]): string[] {
  const result = saved.filter((key, index) => defaults.includes(key) && saved.indexOf(key) === index);
  defaults.forEach((key, index) => {
    if (result.includes(key)) return;
    const previous = defaults.slice(0, index).reverse().find((candidate) => result.includes(candidate));
    result.splice(previous === undefined ? 0 : result.indexOf(previous) + 1, 0, key);
  });
  return result;
}

type SectionDragState = { key: string; over: string | null; after: boolean };

function useSectionDrag(onMove: (key: string, target: string, after: boolean) => void) {
  const [dragging, setDragging] = useState<SectionDragState | null>(null);
  const start = useCallback(
    (key: string, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
      const origin = { x: event.clientX, y: event.clientY };
      let active = false;
      let over: string | null = null;
      let after = false;
      const move = (moveEvent: PointerEvent) => {
        if (!active) {
          if (Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) < 6) return;
          active = true;
          document.body.style.userSelect = "none";
        }
        const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest(`[${SECTION_ATTR}]`);
        const targetKey = target?.getAttribute(SECTION_ATTR) ?? null;
        if (target && targetKey !== null && targetKey !== key) {
          const bounds = target.getBoundingClientRect();
          over = targetKey;
          after = moveEvent.clientY > bounds.top + bounds.height / 2;
        } else {
          over = null;
        }
        setDragging({ key, over, after });
      };
      const finish = (drop: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("keydown", escape);
        setDragging(null);
        if (!active) return;
        document.body.style.userSelect = "";
        // Swallow the click that follows the drag so the header doesn't toggle.
        window.addEventListener("click", (clickEvent) => clickEvent.stopPropagation(), { capture: true, once: true });
        if (drop && over !== null) onMove(key, over, after);
      };
      const up = () => finish(true);
      const escape = (keyEvent: globalThis.KeyboardEvent) => {
        if (keyEvent.key === "Escape") finish(false);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("keydown", escape);
    },
    [onMove],
  );
  return { start, dragging };
}

/** An unfiled thread counts as done only after this long without activity. */
const DONE_AFTER_MS = 2 * 3_600_000;

// --- smart filters (computed sets, not your sections) --------------------------------

type SmartId = "needs" | "yourMove" | "running" | "prAction" | "readyToMerge" | "autopilot" | "done";
const SMART: Array<{ id: SmartId; label: string; glyph: GlyphName; tone: string; hint: string }> = [
  { id: "needs", label: "Needs me", glyph: "question", tone: "text-amber-500", hint: "Waiting for your input, failed, or finished and unread" },
  { id: "yourMove", label: "Your move", glyph: "question", tone: "text-sky-500", hint: "You've read it, but the agent's last message asks you to decide, answer or act" },
  { id: "running", label: "Running", glyph: "spinner", tone: "text-sky-500", hint: "Agents working right now" },
  { id: "prAction", label: "PR action", glyph: "pr", tone: "text-red-500", hint: "An open PR has failing checks, requested changes or conflicts" },
  { id: "readyToMerge", label: "Ready to merge", glyph: "pr", tone: "text-green-500", hint: "An open PR is green and ready" },
  { id: "autopilot", label: "Autopilot", glyph: "hourglass", tone: "text-violet-500", hint: "Waiting on CI, a release or a usage-limit reset; you'll be pinged" },
  { id: "done", label: "Done", glyph: "check", tone: "text-green-500", hint: "Unfiled threads whose PRs are all merged or closed" },
];

const COLLAPSE_KEY = "jb-flow:collapsed";

function useCollapsed(defaults: Record<string, boolean>) {
  const [stored, setStored] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}") as Record<
        string,
        boolean
      >;
    } catch {
      return {};
    }
  });
  const isCollapsed = (id: string) => stored[id] ?? defaults[id] ?? false;
  const toggle = (id: string) =>
    setStored((current) => {
      const next = {
        ...current,
        [id]: !(current[id] ?? defaults[id] ?? false),
      };
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      return next;
    });
  return { isCollapsed, toggle };
}

function TriageThreadList({
  activeThreadId,
  onNavigate,
}: PluginThreadListProps) {
  const { threads, projects, sections, status } = useSidebarThreads();
  const { rpc, state } = useFlowState();
  const now = useNow();
  const [renameTarget, setRenameTarget] = useState<PluginSidebarThread | null>(
    null,
  );
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [snoozeTarget, setSnoozeTarget] = useState<string | null>(null);
  const [tagTarget, setTagTarget] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const lanes = useMemo(() => resolveLanes(sections), [sections]);
  const otherSections = useMemo(() => {
    const laneIds = new Set(lanes.map((lane) => lane.sectionId));
    return sections.filter(
      (section) =>
        !laneIds.has(section.id) && section.id !== state?.snoozedSectionId,
    );
  }, [sections, lanes, state?.snoozedSectionId]);
  const tags = useMemo(() => state?.tags ?? {}, [state]);
  const knownTags = useMemo(
    () => [...new Set(Object.values(tags).flat())].sort(),
    [tags],
  );

  const [smart, setSmart] = useState<SmartId | null>(null);
  const [sectionDialog, setSectionDialog] = useState<{ mode: "create" | "rename"; id?: string; name: string } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; run: () => Promise<unknown> } | null>(null);
  const sdk = useSdk();
  const actions = useSidebarThreadActions();
  const onDrop = useCallback(
    (threadId: string, sectionId: string | null) => {
      void sdk.threads.update({ threadId, sectionId });
    },
    [sdk],
  );
  const drag = useThreadDrag(onDrop);

  // Lanes and your own sections share one order, so any section can sit anywhere.
  const sectionKeys = useMemo(
    () =>
      mergeOrder(state?.sectionOrder ?? [], [
        ...lanes.map((lane) => sectionKey(lane.sectionId)),
        ...otherSections.map((section) => section.id),
      ]),
    [lanes, otherSections, state?.sectionOrder],
  );

  const saveOrder = (keys: string[]) => void rpc.call("section_order_set", { order: keys });
  const moveSection = (key: string, delta: -1 | 1) => {
    const keys = [...sectionKeys];
    const from = keys.indexOf(key);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= keys.length) return;
    [keys[from], keys[to]] = [keys[to]!, keys[from]!];
    saveOrder(keys);
  };
  const sectionDrag = useSectionDrag(
    useCallback(
      (key: string, target: string, after: boolean) => {
        const keys = sectionKeys.filter((candidate) => candidate !== key);
        const index = keys.indexOf(target);
        if (index === -1) return;
        keys.splice(after ? index + 1 : index, 0, key);
        saveOrder(keys);
      },
      [sectionKeys, rpc],
    ),
  );

  const sectionMenu = (group: Group) => {
    const section = group.section;
    if (!section) return undefined;
    const ids = group.threads.map((thread) => thread.id);
    const index = sectionKeys.indexOf(sectionKey(section.id));
    return (
      <>
        <ContextMenuItem onSelect={() => actions.openNewThread({ ...(section.id ? { sectionId: section.id } : {}), focusPrompt: true })}>
          <Icon name="Plus" className="size-4" /> New thread here
        </ContextMenuItem>
        <ContextMenuItem disabled={ids.length === 0} onSelect={() => ids.forEach((id) => void actions.setRead(id, true))}>
          <Icon name="MailOpen" className="size-4" /> Mark all as read
        </ContextMenuItem>
        <ContextMenuSeparator />
        {!section.isLane && section.id !== null ? (
          <ContextMenuItem onSelect={() => setSectionDialog({ mode: "rename", id: section.id!, name: section.name })}>
            <Glyph name="pencil" className="size-4" /> Rename…
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem disabled={index <= 0} onSelect={() => moveSection(sectionKey(section.id), -1)}>
          <Icon name="ArrowUp" className="size-4" /> Move up
        </ContextMenuItem>
        <ContextMenuItem disabled={index === -1 || index >= sectionKeys.length - 1} onSelect={() => moveSection(sectionKey(section.id), 1)}>
          <Icon name="ArrowDown" className="size-4" /> Move down
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={ids.length === 0}
          onSelect={() =>
            setConfirm({
              title: `Archive ${ids.length} thread${ids.length === 1 ? "" : "s"}?`,
              body: `Everything in ${section.name} will be archived. You can unarchive threads later.`,
              label: "Archive all",
              run: () => rpc.call("archive", { threadIds: ids }),
            })
          }
        >
          <Icon name="Archive" className="size-4" /> Archive all threads…
        </ContextMenuItem>
        {!section.isLane && section.id !== null ? (
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() =>
              setConfirm({
                title: `Delete "${section.name}"?`,
                body: `The section is removed and its ${ids.length} thread${ids.length === 1 ? "" : "s"} move back to Active. Threads are not deleted.`,
                label: "Delete section",
                run: () => sdk.threadSections.delete({ id: section.id! }),
              })
            }
          >
            <Icon name="Trash2" className="size-4" /> Delete section…
          </ContextMenuItem>
        ) : null}
      </>
    );
  };

  const { groups, smartCounts } = useMemo(() => {
    const snoozedSectionId = state?.snoozedSectionId ?? null;
    const laneSectionIds = new Set(lanes.map((lane) => lane.sectionId));
    const visible = threads
      .filter((thread) => !thread.isHidden && !thread.isArchived && thread.parentThreadId === null)
      .filter((thread) => tagFilter === null || (tags[thread.id] ?? []).includes(tagFilter))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const snoozed = visible.filter((thread) => thread.sectionId === snoozedSectionId);
    const awake = visible.filter((thread) => thread.sectionId !== snoozedSectionId);

    const busy = (thread: PluginSidebarThread) => thread.status === "active" || thread.status === "starting";
    const openPrs = (thread: PluginSidebarThread) =>
      threadPrs(state?.threadPrs[thread.id], null).filter((pr) => pr.state === "open" || pr.state === "draft");
    const sets: Record<SmartId, (thread: PluginSidebarThread) => boolean> = {
      needs: needsMe,
      yourMove: (thread) => !busy(thread) && !needsMe(thread) && state?.awaiting[thread.id] !== undefined,
      running: busy,
      prAction: (thread) =>
        !busy(thread) && openPrs(thread).some((pr) => ["checks_failed", "changes_requested", "conflicts"].includes(pr.attention)),
      readyToMerge: (thread) => !busy(thread) && openPrs(thread).some((pr) => pr.attention === "ready_to_merge"),
      autopilot: (thread) => state?.watching[thread.id] !== undefined,
      // Only unfiled threads: anything you put in a section stays there. A thread
      // you just worked in, or are looking at, stays in Active for a while.
      done: (thread) =>
        thread.sectionId === null &&
        thread.id !== activeThreadId &&
        Date.now() - thread.updatedAt > DONE_AFTER_MS &&
        !busy(thread) &&
        !needsMe(thread) &&
        state?.watching[thread.id] === undefined &&
        state?.awaiting[thread.id] === undefined &&
        allSettled(threadPrs(state?.threadPrs[thread.id], null)),
    };
    const smartCounts = Object.fromEntries(
      SMART.map((entry) => [entry.id, awake.filter(sets[entry.id]).length]),
    ) as Record<SmartId, number>;

    // A smart filter replaces the list with that one computed set.
    if (smart !== null) {
      const entry = SMART.find((candidate) => candidate.id === smart)!;
      const members = awake.filter(sets[smart]);
      return {
        smartCounts,
        groups: [
          {
            id: `smart:${smart}`,
            title: entry.label,
            threads: members,
            dynamic: { glyph: entry.glyph, tone: entry.tone },
            action:
              smart === "done" && members.length > 0
                ? { label: "Archive all", run: () => void rpc.call("archive", { threadIds: members.map((thread) => thread.id) }) }
                : undefined,
          },
        ] satisfies Group[],
      };
    }

    const pinned = awake.filter((thread) => thread.isPinned);
    const attention = awake.filter((thread) => !thread.isPinned && needsMe(thread));
    const rest = awake.filter((thread) => !thread.isPinned && !needsMe(thread) && !sets.done(thread));

    const result: Group[] = [];
    if (pinned.length > 0) result.push({ id: "pinned", title: "Pinned", threads: pinned });
    result.push({
      id: "needs-me",
      title: "Needs me",
      threads: attention,
      dynamic: { glyph: "question", tone: "text-amber-500" },
    });
    for (const key of sectionKeys) {
      const lane = lanes.find((candidate) => sectionKey(candidate.sectionId) === key);
      if (lane) {
        result.push({
          id: `lane:${lane.id}`,
          title: lane.title,
          hint: lane.key,
          threads: rest.filter((thread) => thread.sectionId === lane.sectionId),
          defaultCollapsed: lane.id === "low" || lane.id === "later",
          limit: lane.id === "active" ? 25 : 15,
          section: { id: lane.sectionId, name: lane.title, isLane: true },
        });
        continue;
      }
      const section = otherSections.find((candidate) => candidate.id === key);
      if (!section) continue;
      result.push({
        id: `section:${section.id}`,
        title: section.name,
        threads: rest.filter((thread) => thread.sectionId === section.id),
        defaultCollapsed: true,
        section: { id: section.id, name: section.name, isLane: false },
      });
    }
    const firstUser = result.find((group) => group.section !== undefined);
    if (firstUser) firstUser.firstUserGroup = true;
    const done = awake.filter((thread) => !thread.isPinned && !needsMe(thread) && sets.done(thread));
    result.push({
      id: "done",
      title: "Done",
      threads: done,
      defaultCollapsed: true,
      dynamic: { glyph: "check", tone: "text-green-500" },
      action: done.length > 0 ? { label: "Archive all", run: () => void rpc.call("archive", { threadIds: done.map((thread) => thread.id) }) } : undefined,
    });
    result.push({
      id: "snoozed",
      title: "Snoozed",
      threads: snoozed.sort((a, b) => (state?.snoozes[a.id]?.until ?? 0) - (state?.snoozes[b.id]?.until ?? 0)),
      defaultCollapsed: true,
      dynamic: { glyph: "alarm", tone: "text-muted-foreground" },
    });
    return { groups: result, smartCounts };
  }, [threads, sections, lanes, otherSections, state, tags, tagFilter, smart, rpc, sectionKeys, activeThreadId]);

  const defaults = useMemo(
    () =>
      Object.fromEntries(
        groups.map((group) => [group.id, group.defaultCollapsed ?? false]),
      ),
    [groups],
  );
  const { isCollapsed, toggle } = useCollapsed(defaults);

  if (status === "loading") {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        Loading threads…
      </p>
    );
  }

  return (
    <DragContext.Provider value={drag}>
    <nav
      aria-label="Triage"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1 pb-4"
    >
      <div className="flex flex-wrap items-center gap-1 px-2 pt-2">
        {SMART.filter((entry) => entry.id === "needs" || smartCounts[entry.id] > 0 || smart === entry.id).map((entry) => (
          <button
            key={entry.id}
            type="button"
            title={entry.hint}
            onClick={() => setSmart((current) => (current === entry.id ? null : entry.id))}
            className={cn(
              "flex h-6 items-center gap-1 rounded-md border px-1.5 text-[11px] transition-colors",
              smart === entry.id
                ? "border-foreground/20 bg-accent text-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Glyph name={entry.glyph} className={cn("size-3", entry.tone)} />
            {entry.label}
            <span className="tabular-nums opacity-70">{smartCounts[entry.id]}</span>
          </button>
        ))}
        <span
          className="ml-auto cursor-help px-1 text-[11px] text-muted-foreground/70"
          title={"Keys on a focused row:\n1–5 move to lane · s snooze · t tag · e archive · u unread · j/k move"}
        >
          ?
        </span>
      </div>
      {knownTags.length > 0 ? (
        <div className="flex flex-wrap gap-1 px-2 pt-1">
          {knownTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => setTagFilter((current) => (current === tag ? null : tag))}
              className={cn(
                "rounded-full border px-2 text-[10px] leading-4",
                tagFilter === tag
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              #{tag}
            </button>
          ))}
        </div>
      ) : null}
      {groups.map((group) => {
        const keepEmpty =
          group.id === "needs-me" || group.id.startsWith("smart:") || group.id.startsWith("section:") || group.firstUserGroup;
        if (group.threads.length === 0 && !keepEmpty) return null;
        const collapsed = group.id.startsWith("smart:") ? false : isCollapsed(group.id);
        const limit = expanded[group.id] ? Infinity : (group.limit ?? Infinity);
        return (
          <section
            key={group.id}
            {...(group.section ? { [DROP_ATTR]: sectionKey(group.section.id), [SECTION_ATTR]: sectionKey(group.section.id) } : {})}
            className={cn(
              "relative rounded-md transition-colors",
              group.section && drag.dragging && drag.dragging.over === sectionKey(group.section.id) && "bg-accent/70 ring-1 ring-ring/40",
              group.section && sectionDrag.dragging?.key === sectionKey(group.section.id) && "opacity-40",
            )}
          >
            {group.section && sectionDrag.dragging?.over === sectionKey(group.section.id) ? (
              <div
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-primary",
                  sectionDrag.dragging.after ? "-bottom-px" : "top-0",
                )}
              />
            ) : null}
            {group.firstUserGroup ? (
              <div className="group/divider mx-2 mt-6 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                Your sections
                <span className="h-px flex-1 bg-border" />
                <button
                  type="button"
                  onClick={() => setSectionDialog({ mode: "create", name: "" })}
                  className="rounded px-1 normal-case tracking-normal text-muted-foreground hover:bg-accent hover:text-foreground"
                  title="New section"
                >
                  + New section
                </button>
              </div>
            ) : null}
            <GroupHeader
              title={group.title}
              count={group.threads.length}
              collapsed={collapsed}
              onToggle={() => toggle(group.id)}
              action={group.action}
              hint={group.hint}
              dynamic={group.dynamic}
              menu={sectionMenu(group)}
              {...(group.section && !smart ? { onDragStart: (event: ReactPointerEvent<HTMLElement>) => sectionDrag.start(sectionKey(group.section!.id), event) } : {})}
            />
            {collapsed ? null : group.threads.length === 0 ? (
              <p className="py-1 pl-6 pr-2 text-xs text-muted-foreground">
                {group.id === "needs-me" ? "Inbox zero ✨" : "Nothing here."}
              </p>
            ) : (
              <>
                {group.threads.slice(0, limit).map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    project={projectById.get(thread.projectId)}
                    active={thread.id === activeThreadId}
                    tags={tags[thread.id] ?? []}
                    snoozeUntil={state?.snoozes[thread.id]?.until}
                    watching={state?.watching[thread.id]}
                    createdPrs={state?.threadPrs[thread.id]}
                    running={state?.running[thread.id]}
                    now={now}
                    lanes={lanes}
                    otherSections={otherSections}
                    onNavigate={onNavigate}
                    onSnooze={() => setSnoozeTarget(thread.id)}
                    onUnsnooze={() =>
                      void rpc.call("unsnooze", { threadId: thread.id })
                    }
                    onTag={() => setTagTarget(thread.id)}
                    onRename={() => setRenameTarget(thread)}
                  />
                ))}
                {group.threads.length > limit ? (
                  <button
                    type="button"
                    className="py-1 pl-6 pr-2 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      setExpanded((current) => ({
                        ...current,
                        [group.id]: true,
                      }))
                    }
                  >
                    Show {group.threads.length - limit} more
                  </button>
                ) : null}
              </>
            )}
          </section>
        );
      })}
      {snoozeTarget === null ? null : (
        <SnoozeDialog
          threadId={snoozeTarget}
          open
          onOpenChange={(open) => (open ? undefined : setSnoozeTarget(null))}
        />
      )}
      {sectionDialog === null ? null : (
        <SectionNameDialog
          title={sectionDialog.mode === "create" ? "New section" : "Rename section"}
          initial={sectionDialog.name}
          onSave={(name) =>
            sectionDialog.mode === "create"
              ? sdk.threadSections.create({ name })
              : sdk.threadSections.update({ id: sectionDialog.id!, name })
          }
          onClose={() => setSectionDialog(null)}
        />
      )}
      {confirm === null ? null : (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          onConfirm={confirm.run}
          onClose={() => setConfirm(null)}
        />
      )}
      {renameTarget === null ? null : (
        <RenameDialog
          thread={renameTarget}
          onClose={() => setRenameTarget(null)}
        />
      )}
      {tagTarget === null ? null : (
        <TagDialog
          threadId={tagTarget}
          tags={tags[tagTarget] ?? []}
          knownTags={knownTags}
          onClose={() => setTagTarget(null)}
        />
      )}
      {drag.dragging ? (
        <div
          className="pointer-events-none fixed z-50 max-w-64 truncate rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-md"
          style={{ left: drag.dragging.x + 12, top: drag.dragging.y + 8 }}
        >
          {drag.dragging.title}
          <span className="ml-1 text-muted-foreground">{drag.dragging.over ? "→ drop to move" : ""}</span>
        </div>
      ) : null}
    </nav>
    </DragContext.Provider>
  );
}

// --- homepage digest ---------------------------------------------------------------

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function DigestSection() {
  const rpc = useRpc<typeof rpcContract>();
  const actions = useSidebarThreadActions();
  const { projects } = useSidebarThreads();
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const [digest, setDigest] = useState<{
    generatedAt: number;
    items: DigestItem[];
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(
    (refresh: boolean) => {
      if (refresh) setPending(true);
      rpc
        .call("digest_list", { refresh })
        .then(
          (result) => {
            setDigest(result);
            setSelected((current) => {
              const ids = new Set(result.items.map((item) => item.threadId));
              return new Set([...current].filter((id) => ids.has(id)));
            });
            setError(null);
          },
          (cause: unknown) => setError(errorText(cause)),
        )
        .finally(() => {
          if (refresh) setPending(false);
        });
    },
    [rpc],
  );
  useEffect(() => load(false), [load]);
  useRealtime("jb-flow-changed", () => load(false));

  const act = async (action: () => Promise<unknown>) => {
    setPending(true);
    try {
      await action();
      setSelected(new Set());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };
  const ids = [...selected];
  const items = digest?.items ?? [];
  const shown = showAll ? items : items.slice(0, 15);
  const allSelected =
    items.length > 0 && items.every((item) => selected.has(item.threadId));
  const toggleOne = (threadId: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(threadId);
      else next.delete(threadId);
      return next;
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">
          {digest === null
            ? "Loading…"
            : `${items.length} idle unsectioned thread(s) · updated ${formatWhen(digest.generatedAt)}`}
        </span>
        <div className="ml-auto flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => load(true)}
          >
            <Icon name="RotateCcw" className="size-3.5" /> Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || ids.length === 0}
            onClick={() =>
              act(() => rpc.call("digest_keep", { threadIds: ids, days: 14 }))
            }
          >
            Keep 14d
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || ids.length === 0}
            onClick={() =>
              act(() =>
                Promise.all(
                  ids.map((threadId) =>
                    rpc.call("snooze", { threadId, when: "1w", note: null }),
                  ),
                ),
              )
            }
          >
            Snooze 1w
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending || ids.length === 0}
            onClick={() => act(() => rpc.call("archive", { threadIds: ids }))}
          >
            Archive{ids.length > 0 ? ` ${ids.length}` : ""}
          </Button>
        </div>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {digest === null ? null : items.length === 0 ? (
        <EmptyState>Nothing stale. Nice.</EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          <li className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground">
            <Checkbox
              checked={allSelected}
              onCheckedChange={(checked) =>
                setSelected(
                  checked === true
                    ? new Set(items.map((item) => item.threadId))
                    : new Set(),
                )
              }
              aria-label="Select all"
            />
            Select all
          </li>
          {shown.map((item) => (
            <li
              key={item.threadId}
              className="flex items-start gap-3 px-3 py-2 text-sm"
            >
              <Checkbox
                className="mt-0.5"
                checked={selected.has(item.threadId)}
                onCheckedChange={(checked) =>
                  toggleOne(item.threadId, checked === true)
                }
                aria-label={`Select "${item.title}"`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="truncate text-left font-medium hover:underline"
                    onClick={() => actions.open(item.threadId)}
                  >
                    {item.title}
                  </button>
                  <ProjectChip project={projectById.get(item.projectId)} />
                  <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                    {item.idleDays}d
                  </span>
                </div>
                {item.summary ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {item.summary}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
          {items.length > shown.length ? (
            <li className="px-3 py-2">
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShowAll(true)}
              >
                Show all {items.length}
              </button>
            </li>
          ) : null}
        </ul>
      )}
      <LeftoversBlock />
    </div>
  );
}

// --- settings: area-section → tag migration ---------------------------------------

// Worktree checkouts bb no longer tracks (see leftovers.ts). Shown only when there are some.
function LeftoversBlock() {
  const rpc = useRpc<typeof rpcContract>();
  const [report, setReport] = useState<{ checkedAt: number; items: Leftover[] } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("leftovers_get", { refresh: false }).then(setReport, (cause: unknown) => setError(errorText(cause)));
  }, [rpc]);
  if (!report || report.items.length === 0) return error ? <p className="text-sm text-destructive">{error}</p> : null;
  const safe = report.items.filter((item) => item.safe);
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">Leftover worktrees</span>
        <span className="text-muted-foreground">
          {report.items.length} checkout(s) bb no longer tracks · checked {formatWhen(report.checkedAt)}
        </span>
        {safe.length > 0 ? (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setConfirming(true)}>
            Delete {safe.length} merged
          </Button>
        ) : null}
      </div>
      <ul className="divide-y divide-border rounded-md border border-border text-xs">
        {report.items.map((item) => (
          <li key={item.path} className="flex items-center gap-2 px-3 py-1.5" title={item.path}>
            <span className="font-medium">{item.repo}</span>
            <span className="truncate text-muted-foreground">{item.branch}</span>
            <span className="ml-auto shrink-0 text-muted-foreground">
              {[item.pr ? `${item.pr} ${item.prState}` : "no PR", item.dirty ? `${item.dirty} uncommitted` : null, item.nodeModules ? "node_modules" : null]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {item.safe ? null : <span className="shrink-0 text-amber-600">keep</span>}
          </li>
        ))}
      </ul>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {confirming ? (
        <ConfirmDialog
          title={`Delete ${safe.length} leftover checkout(s)?`}
          body="Only checkouts whose PR is merged (or that have no commits of their own) and that have no uncommitted changes are removed. Branches stay on GitHub."
          confirmLabel="Delete"
          onConfirm={() => rpc.call("leftovers_clean", null).then(() => rpc.call("leftovers_get", { refresh: false }).then(setReport))}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}

function MigrationSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const { sections } = useSidebarThreads();
  const lanes = useMemo(() => resolveLanes(sections), [sections]);
  const laneIds = new Set(lanes.map((lane) => lane.sectionId));
  const candidates = sections.filter(
    (section) =>
      !laneIds.has(section.id) &&
      !/snoozed|agents|commands/i.test(section.name),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Turn "area" sections into tags. Their threads get the tag and move to
        the Active lane, so one thread can be both #Commercial and Waiting. The
        sections themselves are kept.
      </p>
      <div className="space-y-1.5">
        {candidates.map((section) => (
          <label key={section.id} className="flex items-center gap-2">
            <Checkbox
              checked={selected.has(section.id)}
              onCheckedChange={(checked) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (checked === true) next.add(section.id);
                  else next.delete(section.id);
                  return next;
                })
              }
            />
            {section.name}
          </label>
        ))}
      </div>
      <Button
        size="sm"
        disabled={pending || selected.size === 0}
        onClick={async () => {
          setPending(true);
          try {
            const { tagged } = await rpc.call("migrate_areas", {
              sectionIds: [...selected],
              moveToSectionId: null,
            });
            setResult(`Tagged and moved ${tagged} thread(s).`);
            setSelected(new Set());
          } catch (cause) {
            setResult(errorText(cause));
          } finally {
            setPending(false);
          }
        }}
      >
        Convert to tags
      </Button>
      {result === null ? null : (
        <p className="text-muted-foreground">{result}</p>
      )}
    </div>
  );
}

// --- focus reporter ------------------------------------------------------------------
// Tells the server which thread this window has focused, so `bb jb-flow focused`
// (used by the Stream Deck) can target it. Split layouts report the focused pane.

/** RPC client for command-palette handlers, which run outside React. */
let commandRpc: ReturnType<typeof useRpc<typeof rpcContract>> | null = null;
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

  useEffect(() => {
    const send = () => {
      void rpc
        .call("focus_report", { clientId, threadId, windowFocused: document.hasFocus() })
        .catch(() => undefined);
    };
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
      window.removeEventListener("focus", send);
      window.removeEventListener("blur", send);
      document.removeEventListener("visibilitychange", send);
      window.clearInterval(heartbeat);
    };
  }, [rpc, clientId, threadId]);
  return null;
}

// --- plan review banners -----------------------------------------------------------
// BB renders a plan awaiting approval in a banner that starts collapsed, caps its
// body at min(32rem, 50dvh) and sizes the banner to the space left in the thread.
// Core renderers can't be replaced, so this content script expands each banner
// once when it appears (a manual collapse sticks) and lets it take ~75% of the
// window with a single scroll area. Selectors are BB's own test ids.

const PLAN_BANNER = 'section[data-testid="plan-review-banner"]';
const PLAN_STYLE = `
${PLAN_BANNER}[data-expanded] {
  max-height: 80dvh !important;
}
${PLAN_BANNER} .overflow-y-auto:has([data-testid="plan-review-request"]) {
  max-height: 75dvh !important;
}
/* The plan body itself doesn't scroll; the banner body does. */
${PLAN_BANNER} [data-testid="plan-review-request"] > div:first-child {
  max-height: none !important;
  overflow: visible !important;
}
${PLAN_BANNER} [data-testid="plan-review-request"] .text-xs {
  font-size: 0.8125rem;
}
`;

function mountPlanExpander({ signal }: { signal: AbortSignal }) {
  const style = document.createElement("style");
  style.dataset.jbFlow = "plan-expander";
  style.textContent = PLAN_STYLE;
  document.head.append(style);

  const seen = new WeakSet<Element>();
  const expand = () => {
    for (const banner of Array.from(document.querySelectorAll<HTMLElement>(PLAN_BANNER))) {
      if (seen.has(banner)) continue;
      seen.add(banner);
      if (banner.hasAttribute("data-expanded")) continue;
      const toggle = banner.querySelector('button[aria-expanded="false"]') as HTMLButtonElement | null;
      toggle?.click();
    }
  };
  expand();
  const observer = new MutationObserver(expand);
  observer.observe(document.body, { childList: true, subtree: true });
  signal.addEventListener("abort", () => observer.disconnect(), { once: true });
  return () => {
    observer.disconnect();
    style.remove();
  };
}

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "plan-expander", mount: mountPlanExpander });
  app.slots.experimental_appOverlay({ id: "focus-reporter", component: FocusReporter });
  app.slots.experimental_threadList({
    id: "triage",
    title: "Triage",
    description:
      "Needs me on top, then lanes, project chips, tags, snooze and keyboard triage.",
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
  const inThread = ({ threadId }: { threadId: string | null }) => threadId !== null;
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
  app.composer.customize({
    id: "decision-chips",
    banners: [{ id: "decision-chips", chrome: "bare", component: DecisionChipsBanner }],
  });
  app.slots.homepageSection({
    id: "your-move",
    title: "Your move",
    component: YourMoveSection,
  });
  app.slots.homepageSection({
    id: "stale-digest",
    title: "Stale threads",
    component: DigestSection,
  });
  app.slots.settingsSection({
    id: "area-tags",
    title: "Area tags",
    description: "Convert area sections into multi-valued tags.",
    component: MigrationSettings,
  });
});
