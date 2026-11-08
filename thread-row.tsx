// One row of the Triage thread list, and the group headers between rows.
import type { WorkspaceState } from "./workspaces";
import { useContext } from "react";
import { toast } from "sonner";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { ThreadTitle, useRpc, useSdk, experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest, experimental_useSidebarThreadSplit as useSidebarThreadSplit, useSidebarThreadShortcut } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarProject, PluginSidebarSection, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FlowState, rpcContract } from "./server";
import { useSidebarThreadActions } from "./thread-actions";
import { PR_TONE, StatusIcon, ThreadHoverPreview, attentionLabel, duration, rowStatus, runInfo, threadPrs, worstPr } from "./ui-extras";
import { formatDue, formatWhen } from "./when";
import { type Lane } from "./lanes";
import { DUE_NOW_MS } from "./now-model";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Glyph } from "@/components/ui/glyph";
import type { GlyphName } from "@/components/ui/glyph";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { ProjectChip } from "./flow-state";
import { DragContext } from "./drag";

/** "Alex’s Mac Studio" → "Mac Studio". */
export const machineLabel = (name: string) => name.replace(/^[^’']+[’']s\s+/, "");
/** Row-sized: "MacBook Pro" → "MBP", "Mac Studio" → "Studio". */
const machineShort = (name: string) => {
  const label = machineLabel(name);
  if (/^MacBook Pro/i.test(label)) return "MBP";
  return label.replace(/^(MacBook|Mac)\s+/i, "");
};

/** The row after this one (or before, at the end), to keep focus on after this row moves away. */
function neighbourRowId(row: HTMLElement): string | null {
  const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-jb-flow-row]"));
  const index = rows.indexOf(row);
  return (rows[index + 1] ?? rows[index - 1])?.dataset.jbFlowRow ?? null;
}

/** Focuses a row once the list has re-rendered. */
function focusRowSoon(threadId: string | null) {
  if (threadId === null) return;
  window.setTimeout(() => {
    document.querySelector<HTMLElement>(`[data-jb-flow-row="${CSS.escape(threadId)}"]`)?.focus();
  }, 150);
}

// --- triage thread list ----------------------------------------------------------

export type Group = {
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
  /** Your section, but the plugin also files matching threads into it. */
  auto?: boolean;
  /** Your section behind this group (null = the unsectioned Active lane). */
  section?: { id: string | null; name: string; isLane: boolean };
  /** One project's share of the Active lane, in a workspace grouped by project. */
  project?: { id: string; name: string };
};

export function ThreadRow({
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
  onNewSection,
  machine,
  workspaceState, onWorkspace,
  focused,
  onToggleFocus,
  reason,
  due,
  onSetDue,
}: {
  thread: PluginSidebarThread;
  /** Marked as Focus. */
  focused: boolean;
  /** Missing when Now and Focus is turned off. */
  onToggleFocus: (() => void) | undefined;
  /** On a Now or Moving row: who holds the thread, and for how long. */
  reason: { text: string; urgent: boolean } | undefined;
  /** This thread's deadline, if it has one. */
  due: FlowState["due"][string] | undefined;
  /** Missing when Now and Focus is turned off. */
  onSetDue: (() => void) | undefined;
  workspaceState: WorkspaceState;
  onWorkspace: (workspaceId: string | null, automatic: boolean) => void;
  project: PluginSidebarProject | undefined;
  /** The machine it runs on; `remote` when it's not the machine BB runs on (tagged on the row). */
  machine: { name: string; remote: boolean } | null;
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
  /** Asks for a name, creates the section and moves this thread into it. */
  onNewSection: () => void;
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
  const busy = thread.status === "active" || thread.status === "starting";
  const { pullRequest } = useSidebarThreadPullRequest(thread.id);
  const prs = threadPrs(createdPrs, pullRequest);
  const run = busy ? runInfo(running, now) : null;
  const status = rowStatus(thread, busy, watching, prs, run);
  const worst = worstPr(prs);
  const openPrs = prs.filter((pr) => pr.state === "open" || pr.state === "draft");
  const rpc = useRpc<typeof rpcContract>();
  // A running thread already shows its run time.
  const reasonChip = run ? undefined : reason;

  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const lane = lanes.find((candidate) => candidate.key === event.key);
    if (lane) {
      event.preventDefault();
      // The row leaves its place; keep the keyboard on the list (inbox style).
      const next = neighbourRowId(event.currentTarget);
      void sdk.threads
        .update({ threadId: thread.id, sectionId: lane.sectionId })
        .then(() => focusRowSoon(next));
    } else if (event.key === "e") {
      event.preventDefault();
      // A clicked row keeps the keyboard, so a stray "e" typed before clicking into the composer
      // would archive the thread. Pinned threads are the ones people keep working in: no single key archives them.
      if (thread.isPinned) {
        toast("Pinned threads aren't archived with E. Unpin it first, or archive from the right-click menu.");
        return;
      }
      focusRowSoon(neighbourRowId(event.currentTarget));
      actions.archive(thread.id);
    } else if (event.key === "s") {
      event.preventDefault();
      onSnooze();
    } else if (event.key === "t") {
      event.preventDefault();
      onTag();
    } else if (event.key === "f" && onToggleFocus) {
      event.preventDefault();
      onToggleFocus();
    } else if (event.key === "d" && onSetDue) {
      event.preventDefault();
      onSetDue();
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
          machineName={machine ? machineLabel(machine.name) : null}
          sectionName={[...lanes.map((lane) => ({ id: lane.sectionId, name: lane.title })), ...otherSections].find((section) => section.id === thread.sectionId)?.name ?? null}
          status={status}
          tags={tags}
          prs={prs}
          watching={watching}
          snoozeUntil={snoozeUntil}
          dueDetail={due ? `${formatDue(due.at)}${due.reason ? `: ${due.reason}` : ""}${due.source === "agent" ? " (set by the agent)" : ""}` : null}
        >
        <a
          href={thread.href}
          {...split.splitProps}
          onPointerDown={(event) => {
            split.splitProps.onPointerDown?.(event);
            drag.start(thread, event);
          }}
          data-jb-flow-row={thread.id}
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
            "jf-thread-row group flex h-8 items-center gap-2 rounded-md pl-6 pr-2 text-sm outline-none",
            "hover:bg-accent focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-ring",
            active && "bg-accent",
          )}
          style={{
            opacity: drag.dragging?.threadId === thread.id ? 0.4 : 1,
          }}
        >
          <StatusIcon status={status} />
          {focused ? (
            <span role="img" aria-label="In Focus" title="In Focus" className="shrink-0">
              <Glyph name="star" className="size-3 text-amber-500" />
            </span>
          ) : null}
          {/* The title keeps a readable width; chips beside it truncate instead. */}
          <span
            data-jb-flow-row-title=""
            className={cn(
              "min-w-[5.5rem] flex-1 truncate",
              thread.isUnread && "font-semibold",
            )}
          >
            <ThreadTitle threadId={thread.id} />
          </span>
          {/* A Now row's reason chip says more; its tags stay in the hover card. */}
          {reasonChip
            ? null
            : tags.slice(0, 2).map((tag) => (
                <span
                  key={tag}
                  className="min-w-0 max-w-[5rem] truncate text-[10px] text-muted-foreground"
                >
                  #{tag}
                </span>
              ))}
          <ProjectChip project={project} />
          {machine?.remote ? (
            <span className="shrink-0 text-[10px] text-muted-foreground" title={`Runs on ${machineLabel(machine.name)}`}>
              {machineShort(machine.name)}
            </span>
          ) : null}
          {run ? (
            <span className={cn("shrink-0 text-[10px] tabular-nums", run.stuck ? "font-medium text-amber-600" : "text-sky-600")}>
              {run.stuck ? `stuck ${duration(run.silent)}` : duration(run.elapsed)}
            </span>
          ) : null}
          {due && !reasonChip ? (
            <span className={cn("shrink-0 text-[10px] tabular-nums", due.at - now <= DUE_NOW_MS ? "font-medium text-amber-600" : "text-muted-foreground")}>
              {formatDue(due.at, new Date(now))}
            </span>
          ) : null}
          {reasonChip ? (
            <span
              data-jb-flow-reason=""
              title={reasonChip.text}
              className={cn("min-w-0 truncate whitespace-nowrap text-[10px] tabular-nums", reasonChip.urgent ? "font-medium text-amber-600" : "text-muted-foreground")}
            >
              {reasonChip.text}
            </span>
          ) : null}
          {worst && !reasonChip ? (
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
        {onToggleFocus ? (
          <ContextMenuItem onSelect={onToggleFocus}>
            <Glyph name="star" className="size-4" />
            {focused ? "Remove from Focus" : "Add to Focus"}
          </ContextMenuItem>
        ) : null}
        {onSetDue ? (
          <ContextMenuItem onSelect={onSetDue}>
            <Glyph name="alarm" className="size-4" />
            {due ? "Change due date…" : "Set due date…"}
          </ContextMenuItem>
        ) : null}
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
          <ContextMenuSubTrigger><Icon name="Folder" className="size-4" /> Move to workspace</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-52">
            <ContextMenuItem onSelect={() => onWorkspace(null, true)}>Automatic</ContextMenuItem>
            {workspaceState.workspaces.map((workspace) => <ContextMenuItem key={workspace.id} onSelect={() => onWorkspace(workspace.id, false)}>{workspace.name}</ContextMenuItem>)}
            <ContextMenuItem onSelect={() => onWorkspace(null, false)}>No workspace</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
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
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onNewSection}>
              <Icon name="Plus" className="size-4" /> New section…
            </ContextMenuItem>
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

export function GroupHeader({
  title,
  count,
  collapsed,
  onToggle,
  action,
  hint,
  dynamic,
  menu,
  onDragStart,
  auto,
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
  auto?: boolean;
}) {
  const header = (
    <div data-jb-flow-section-header="" onPointerDown={onDragStart} className="group/header flex w-full items-center gap-1 px-2 pb-1.5 pt-5 text-xs font-medium text-muted-foreground">
      <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex min-w-0 flex-1 items-center gap-1.5 hover:text-foreground">
        {dynamic ? (
          <Glyph name={dynamic.glyph} className={cn("size-3.5", dynamic.tone)} />
        ) : (
          <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} className="size-3" />
        )}
        <span className={cn("truncate", dynamic && "text-foreground")}>{title}</span>
        {auto ? (
          <span
            title="Fills itself: unfiled threads whose agent is waiting on someone else, or whose open PRs all wait on a reviewer. Threads you move here stay."
            className="rounded border border-border px-1 text-[9px] font-normal uppercase leading-3 tracking-wide text-muted-foreground"
          >
            auto
          </span>
        ) : null}
        {hint ? (
          <kbd className="rounded border border-border px-1 text-[10px] font-normal leading-4 opacity-0 group-hover/header:opacity-100">{hint}</kbd>
        ) : null}
      </button>
      {action ? (
        <button type="button" onClick={action.run} className="jf-group-action rounded px-1 text-[11px] text-foreground/70 opacity-0 hover:bg-accent hover:text-foreground group-hover/header:opacity-100">
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
