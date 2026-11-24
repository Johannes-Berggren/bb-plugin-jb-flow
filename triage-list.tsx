// The Triage thread list: the sidebar that replaces bb's own when its setting is on.
import { toast } from "sonner";
import { useWorkspaces, useSelectedWorkspace, switchWorkspace } from "./workspace-client";
import { useWorkspaceSwipe, sidebarBlock, slideIn, tabDirection } from "./workspace-ui";
import { inWorkspace, workspaceForThread } from "./workspaces";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { experimental_useSidebarThreads as useSidebarThreads, useBbNavigate, useSdk, useSettings } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread, PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import type { FlowState } from "./server";
import { useSidebarThreadActions } from "./thread-actions";
import { allSettled, threadPrs, useNow } from "./ui-extras";
import { groupByProject, groupBySection, quietFor, sortRows } from "./sidebar-groups";
import { childrenByParent, descendants, foldKey, pruneFolds, rootIds, subthreadRows, topLevel, treesOf, withMatches, withRows } from "./subthreads";
import { resolveLanes, sectionNames } from "./lanes";
import { formatDue } from "./when";
import { needsMe, replyQueued } from "./needs-me";
import { DUE_NOW_MS, actionablePr, sidebarPrReason, entryFor, focusLimitOf, nowQueue, reasonLabel, sidebarNowThread, type NowEntry } from "./now-model";
import { useConductorBriefs } from "./conductor-client";
import { headlineOf } from "./conductor-model";
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu";
import { Glyph } from "@/components/ui/glyph";
import type { GlyphName } from "@/components/ui/glyph";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useFlowState, errorText } from "./flow-state";
import { SnoozeDialog, TagDialog, RenameDialog, SectionNameDialog, ConfirmDialog, DueDialog, FocusLimitDialog } from "./dialogs";
import { Group, ThreadRow, GroupHeader, machineLabel } from "./thread-row";
import { ACTIVE_DROP, DROP_ATTR, DragContext, useThreadDrag, SECTION_ATTR, sectionKey, mergeOrder, useSectionDrag } from "./drag";
import { MissingLanesHint } from "./settings-panels";
/** Sent by "Nudge" on a stalled thread. */
const NUDGE =
  "You said you'd report back, but this thread went idle and nothing is running. Check the current state now, then continue or tell me what's blocking.";
/** A promise to report back counts as stalled after this long idle (matches awaiting.ts). */
const STALLED_AFTER_MS = 60 * 60_000;

/** An unfiled thread counts as done only after this long without activity. */
const DONE_AFTER_MS = 2 * 3_600_000;

// --- smart filters (computed sets, not your sections) --------------------------------

type SmartId = "needs" | "stalled" | "yourMove" | "readyToGo" | "running" | "prAction" | "readyToMerge" | "autopilot" | "done";
/** A smart filter, or one machine's threads (`machine:<hostId>`). */
type Filter = SmartId | `machine:${string}`;
const SMART: Array<{ id: SmartId; label: string; glyph: GlyphName; tone: string; hint: string }> = [
  { id: "needs", label: "Needs me", glyph: "question", tone: "text-amber-500", hint: "Waiting for your input, failed, or finished and unread" },
  { id: "stalled", label: "Stalled", glyph: "hourglass", tone: "text-orange-500", hint: "The agent said it would report back, but has been idle for over an hour. Nudge it" },
  { id: "yourMove", label: "Your move", glyph: "question", tone: "text-sky-500", hint: "You've read it, but the agent's last message asks you to decide, answer or act" },
  { id: "readyToGo", label: "Ready to go", glyph: "check", tone: "text-muted-foreground", hint: "The agent has next steps lined up and is waiting for your go. Nothing is stuck" },
  { id: "running", label: "Running", glyph: "spinner", tone: "text-sky-500", hint: "Agents working right now" },
  { id: "prAction", label: "PR action", glyph: "pr", tone: "text-red-500", hint: "An open PR has failing checks, requested changes or conflicts" },
  { id: "readyToMerge", label: "Ready to merge", glyph: "pr", tone: "text-green-500", hint: "An open PR is green and ready" },
  { id: "autopilot", label: "Autopilot", glyph: "hourglass", tone: "text-violet-500", hint: "Waiting on CI, a release or a usage-limit reset; you'll be pinged" },
  { id: "done", label: "Done", glyph: "check", tone: "text-green-500", hint: "Unfiled threads whose PRs are all merged or closed" },
];


/** The machine a thread runs on: via its environment, else the server's thread map. */
function threadHost(thread: PluginSidebarThread, machines: FlowState["machines"] | undefined): string | undefined {
  if (!machines) return undefined;
  return (thread.environment?.id ? machines.environmentHosts[thread.environment.id] : undefined) ?? machines.threadHosts[thread.id];
}

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
  /** Forgets subthread folds for threads that are gone, so the store doesn't grow with every fold. */
  const pruneFoldsOf = useCallback((exists: (threadId: string) => boolean) =>
    setStored((current) => {
      const next = pruneFolds(current, exists);
      if (next === null) return current;
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      return next;
    }), []);
  return { isCollapsed, toggle, pruneFoldsOf };
}

function FilterChip({ hint, active, onClick, glyph, tone, label, count }: {
  hint: string;
  active: boolean;
  onClick: () => void;
  glyph: GlyphName;
  tone: string;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      title={hint}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "jf-filter-chip flex h-6 items-center gap-1 rounded-md border px-1.5 text-[11px] transition-colors",
        active
          ? "border-foreground/20 bg-accent text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <Glyph name={glyph} className={cn("size-3", tone)} />
      <span className="jf-filter-label">{label}</span>
      <span className="jf-filter-count tabular-nums">{count}</span>
    </button>
  );
}

/** How many Now rows show before "Show N more". The list only helps while it's short. */
const NOW_ROWS = 7;
/** Waiting this long on you turns the row's chip amber. */
const OVERDUE_WAIT_MS = 24 * 3_600_000;

export function TriageThreadList({
  activeThreadId,
  onNavigate,
}: PluginThreadListProps) {
  const { threads: allThreads, projects, sections: hostSections, status } = useSidebarThreads();
  const { state: workspaceState, ready: workspaceReady, rpc: workspaceRpc, refresh: refreshWorkspaces } = useWorkspaces();
  const selectedWorkspace = useSelectedWorkspace();
  const workspace = workspaceState.workspaces.find((item) => item.id === selectedWorkspace);
  const threads = useMemo(() => allThreads.filter((thread) => inWorkspace(thread, selectedWorkspace, workspaceState, allThreads)), [allThreads, selectedWorkspace, workspaceState]);
  const { rpc, state } = useFlowState();
  // BB saves a section rename but doesn't refresh the sidebar's section list
  // until reload. Show the new name meanwhile; drop it once BB's name changes.
  const [renamed, setRenamed] = useState<Record<string, { from: string; to: string }>>({});
  const sections = useMemo(
    () =>
      hostSections.map((section) => {
        const rename = renamed[section.id];
        return rename && rename.from === section.name ? { ...section, name: rename.to } : section;
      }),
    [hostSections, renamed],
  );
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
  const lanes = useMemo(() => resolveLanes(sections, state?.laneSections), [sections, sectionNames(sections), state?.laneSections]);
  const otherSections = useMemo(() => {
    const laneIds = new Set(lanes.map((lane) => lane.sectionId));
    return sections.filter(
      (section) =>
        !laneIds.has(section.id) && section.id !== state?.snoozedSectionId &&
        (selectedWorkspace === null || workspace?.sectionIds.includes(section.id) || threads.some((thread) => !thread.isArchived && !thread.isHidden && thread.sectionId === section.id)),
    );
  }, [sections, lanes, state?.snoozedSectionId, selectedWorkspace, workspaceState, workspace, threads]);
  const tags = useMemo(() => state?.tags ?? {}, [state]);
  const knownTags = useMemo(
    () => [...new Set(Object.entries(tags).filter(([id]) => threads.some((thread) => thread.id === id)).flatMap(([, values]) => values))].sort(),
    [tags, threads],
  );

  const filterPanelId = useId();
  const [smart, setSmart] = useState<Filter | null>(null);
  useEffect(() => { setTagFilter(null); setSmart(null); setExpanded({}); }, [selectedWorkspace]);
  const machines = state?.machines;
  const rowMachine = (thread: PluginSidebarThread) => {
    const hostId = threadHost(thread, machines);
    return machines?.hosts.find((host) => host.id === hostId)?.name ?? null;
  };
  const [sectionDialog, setSectionDialog] = useState<{ mode: "create" | "rename"; id?: string; name: string; threadId?: string } | null>(null);
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
  const navigate = useBbNavigate();
  const listSettings = useSettings().values;
  const swipeOn = listSettings?.workspaceSwipe === true;
  const workspacesOn = listSettings?.workspaces === true;
  const onSwipe = useWorkspaceSwipe();
  // Whatever switched the workspace (a swipe or a tab click), slide the new one in.
  const listRef = useRef<HTMLElement>(null);
  const shownWorkspace = useRef(selectedWorkspace);
  useLayoutEffect(() => {
    const before = shownWorkspace.current;
    shownWorkspace.current = selectedWorkspace;
    if (!listRef.current || !swipeOn) return;
    // A list that remounts mid-swipe never sees the change: don't leave the sidebar hidden.
    if (before === selectedWorkspace) return void sidebarBlock(listRef.current).getAnimations?.().forEach((animation) => animation.cancel());
    slideIn(sidebarBlock(listRef.current), tabDirection(workspaceState.workspaces, before, selectedWorkspace));
  }, [selectedWorkspace]);

  // Lanes and your own sections share one order, so any section can sit anywhere.
  const sectionKeys = useMemo(
    () =>
      mergeOrder(workspace?.sectionOrder.length ? workspace.sectionOrder : state?.sectionOrder ?? [], [
        ...lanes.map((lane) => sectionKey(lane.sectionId)),
        ...otherSections.map((section) => section.id),
      ]),
    [lanes, otherSections, state?.sectionOrder, workspace?.sectionOrder],
  );

  const saveOrder = (keys: string[]) => void (workspace
    ? workspaceRpc.call("workspace_save", { ...workspace, sectionOrder: keys }).then(refreshWorkspaces)
    : rpc.call("section_order_set", { order: keys }));
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
    const key = sectionKey(section.id);
    const index = sectionKeys.indexOf(key);
    // The section's project, if set and still there: new threads start in it.
    const projectId = state?.sectionProjects[key];
    const project = projectId ? projectById.get(projectId) : undefined;
    const setProject = (next: string | null) => void rpc.call("section_project_set", { section: key, projectId: next });
    return (
      <>
        <ContextMenuItem
          onSelect={() =>
            actions.openNewThread({
              ...(section.id ? { sectionId: section.id } : {}),
              ...(project ? { projectId: project.id } : workspace?.projectIds[0] ? { projectId: workspace.projectIds[0] } : {}),
              focusPrompt: true,
            })
          }
        >
          <Icon name="Plus" className="size-4" />
          <span className="truncate">{project ? `New thread in ${project.name}` : "New thread here"}</span>
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Icon name="Folder" className="size-4" /> Project for new threads
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-80 w-56 overflow-y-auto">
            <ContextMenuItem onSelect={() => setProject(null)}>
              <span className="flex-1">Whatever is selected</span>
              {!project ? <Icon name="Check" className="size-4" /> : null}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {projects.map((candidate) => (
              <ContextMenuItem key={candidate.id} onSelect={() => setProject(candidate.id)}>
                <span className="flex-1 truncate">{candidate.name}</span>
                {project?.id === candidate.id ? <Icon name="Check" className="size-4" /> : null}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem disabled={ids.length === 0} onSelect={() => ids.forEach((id) => void actions.setRead(id, true))}>
          <Icon name="MailOpen" className="size-4" /> Mark all as read
        </ContextMenuItem>
        <ContextMenuSeparator />
        {section.id !== null ? (
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

  // Only a project this workspace owns, and not its last one, can move out. A
  // thread can be here through a section or by hand while its project lives elsewhere.
  const canMakeWorkspace = (projectId: string) =>
    workspace !== undefined && workspace.projectIds.length > 1 && workspace.projectIds.includes(projectId) && projectById.has(projectId);

  // Moves a project out of this workspace into a new one of its own, then shows it.
  // Saving a project into one workspace removes it from every other.
  const makeWorkspace = (project: { id: string; name: string }) => {
    // Workspace names are unique, and one is often named after its main project.
    const taken = new Set(workspaceState.workspaces.map((item) => item.name.toLowerCase()));
    let name = project.name;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${project.name} ${n}`;
    void workspaceRpc
      .call("workspace_save", { id: null, name, projectIds: [project.id], sectionIds: [], pluginIds: [], sectionOrder: [] })
      .then(async (saved) => {
        await refreshWorkspaces();
        const next = {
          ...workspaceState,
          workspaces: [
            ...workspaceState.workspaces.map((item) => ({ ...item, projectIds: item.projectIds.filter((id) => id !== project.id) })),
            saved,
          ],
        };
        switchWorkspace(saved.id, { state: next, threads: allThreads, projects, currentThreadId: activeThreadId ?? null, navigate });
        toast.success(`${project.name} is now its own workspace`);
      })
      .catch((cause) => toast.error(errorText(cause)));
  };

  const projectMenu = (project: { id: string; name: string }) =>
    projectById.has(project.id) ? (
      <>
        <ContextMenuItem onSelect={() => actions.openNewThread({ projectId: project.id, focusPrompt: true })}>
          <Icon name="Plus" className="size-4" />
          <span className="truncate">New thread in {project.name}</span>
        </ContextMenuItem>
        {canMakeWorkspace(project.id) ? (
          <ContextMenuItem onSelect={() => makeWorkspace(project)}>
            <Icon name="Layers" className="size-4" />
            <span className="truncate">Make {project.name} its own workspace</span>
          </ContextMenuItem>
        ) : null}
      </>
    ) : null;

  const settingValues = useSettings().values;
  const createdOrder = settingValues?.createdRowOrder === true;
  const nowEnabled = settingValues?.nowQueue === true;
  const focusLimit = focusLimitOf(settingValues?.focusLimit);
  const liveThreads = useMemo(() => threads.filter((thread) => !thread.isHidden && !thread.isArchived), [threads]);
  // Subthreads ride under their parent's row; only the rest are rows of their own.
  const liveRows = useMemo(() => topLevel(liveThreads), [liveThreads]);
  const subthreads = useMemo(() => childrenByParent(sortRows(liveThreads, createdOrder)), [liveThreads, createdOrder]);
  // Each row with everything under it. Now, the filters and their counts look at
  // subthreads too, and a match under a row brings the row along.
  const trees = useMemo(() => treesOf(liveRows, subthreads), [liveRows, subthreads]);
  const rootOf = useMemo(() => rootIds(trees), [trees]);
  // Waits and "no next step" depend on the clock, so the queue is rebuilt each minute.
  const nowMinute = Math.floor(now / 60_000);
  const lastNowOrder = useRef<readonly string[]>([]);
  const queue = useMemo(() => {
    if (!nowEnabled) return null;
    // Before state arrives: an empty Now, so the list doesn't show Needs me and then swap it.
    if (!state) return { now: [], moving: [] };
    // Subthreads are candidates too; each follows its row's pin and snooze. One
    // that wants you brings its row into Now, and shows under it there.
    const candidates = withRows(
      liveRows.filter((row) => !row.isPinned),
      trees,
    ).map(({ thread, row }) => sidebarNowThread(thread, state.snoozedSectionId !== null && row.sectionId === state.snoozedSectionId));
    const result = nowQueue(candidates, state, { now: Date.now(), openThreadId: activeThreadId ?? null, previous: lastNowOrder.current });
    lastNowOrder.current = result.now.map((entry) => entry.thread.id);
    return result;
  }, [nowEnabled, state, liveRows, trees, activeThreadId, nowMinute]);
  const nowEntries = useMemo(
    () => new Map<string, NowEntry>([...(queue?.now ?? []), ...(queue?.moving ?? [])].map((entry) => [entry.thread.id, entry])),
    [queue],
  );
  // The rows Now and Moving hold: each entry's own row, or the row it sits under.
  const nowRows = useMemo(() => new Set([...nowEntries.keys()].flatMap((id) => rootOf.get(id) ?? [])), [nowEntries, rootOf]);
  // The first entry, in queue order, that brought each row in: its own or a subthread's.
  const surfacedBy = useMemo(() => {
    const first = new Map<string, NowEntry>();
    for (const entry of [...(queue?.now ?? []), ...(queue?.moving ?? [])]) {
      const rowId = rootOf.get(entry.thread.id);
      if (rowId !== undefined && !first.has(rowId)) first.set(rowId, entry);
    }
    return first;
  }, [queue, rootOf]);

  // A thread the conductor briefed says what's needed instead of who holds it.
  const briefs = useConductorBriefs();
  // `fromSubthread`: the entry is a folded-away subthread's, shown on the row that holds it.
  const rowReason = (thread: PluginSidebarThread, queued: NowEntry | undefined, fromSubthread: boolean) => {
    if (!state) return undefined;
    const ranked = queued ?? entryFor(sidebarNowThread(thread, false), state, now);
    const entry = nowEnabled ? ranked : { ...ranked, dueAt: null };
    let label: string;
    switch (entry.state) {
      case "blocked": label = entry.thread.blocked === "input" ? "Waiting for your answer" : "Run failed"; break;
      case "yours": label = "Waiting for your answer"; break;
      case "go": label = "Waiting for your go-ahead"; break;
      case "stalled": label = "Agent hasn’t reported back"; break;
      case "pr": label = sidebarPrReason(actionablePr(entry.thread, state))!; break;
      default:
        if (!queued) return undefined;
        label = reasonLabel({ ...entry, dueAt: null }, state, now);
    }
    if (entry.dueAt !== null) label = `${formatDue(entry.dueAt, new Date(now))} · ${label}`;
    const brief = briefs.get(entry.thread.id);
    const detail = [brief && headlineOf(brief.item, 200), brief?.item.recommendation && `→ ${brief.item.recommendation}`,
      reasonLabel(entry, state, now), fromSubthread && "In a folded subthread"].filter(Boolean).join("\n");
    return {
      text: brief ? headlineOf(brief.item, 60) : label,
      detail,
      urgent: entry.state === "blocked" || (entry.dueAt !== null && entry.dueAt - now <= DUE_NOW_MS) ||
        (["yours", "cold", "stalled", "go"].includes(entry.state) && now - entry.since > OVERDUE_WAIT_MS),
    };
  };

  const [focusFull, setFocusFull] = useState<string | null>(null);
  const [dueTarget, setDueTarget] = useState<string | null>(null);
  const setFocus = (threadId: string, focused: boolean) =>
    rpc.call("focus_set", { threadId, focused }).catch((cause) => toast.error(errorText(cause)));
  // Threads in Focus across every workspace: the limit is on you, not on a tab.
  const focusedIds = allThreads.filter((thread) => !thread.isArchived && state?.focused[thread.id] !== undefined).map((thread) => thread.id);
  const toggleFocus = (threadId: string) => {
    if (state?.focused[threadId] !== undefined) void setFocus(threadId, false);
    else if (focusedIds.length >= focusLimit) setFocusFull(threadId);
    else void setFocus(threadId, true);
  };

  const { groups, smartCounts, machineCounts, shown } = useMemo(() => {
    const snoozedSectionId = state?.snoozedSectionId ?? null;
    const laneSectionIds = new Set(lanes.map((lane) => lane.sectionId));
    const tagged = (thread: PluginSidebarThread) => tagFilter === null || (tags[thread.id] ?? []).includes(tagFilter);
    const treeOf = (row: PluginSidebarThread) => trees.get(row.id) ?? [row];
    const rowById = new Map(liveRows.map((row) => [row.id, row]));
    // A tag filter keeps the rows with a tagged thread at or under them.
    const tagShown = tagFilter === null ? null : withMatches(trees, tagged);
    const visible = sortRows(tagShown ? liveRows.filter((row) => tagShown.has(row.id)) : liveRows, createdOrder);
    // No Snoozed section until the first snooze: then nothing is snoozed (a null
    // sectionId is "unsectioned", not "in a missing section").
    const isSnoozed = (thread: PluginSidebarThread) => snoozedSectionId !== null && thread.sectionId === snoozedSectionId;
    const snoozed = visible.filter(isSnoozed);
    const awake = visible.filter((thread) => !isSnoozed(thread));
    // What the filter chips count: every awake row and its subthreads, each on its own.
    const counted = awake.flatMap(treeOf).filter(tagged);

    const needs = (thread: PluginSidebarThread) => needsMe(thread, state?.awaiting);
    const busy = (thread: PluginSidebarThread) => thread.status === "active" || thread.status === "starting";
    // Promised to report back, but nothing is running and nothing is watching for it.
    const isStalled = (thread: PluginSidebarThread) =>
      !busy(thread) &&
      !replyQueued(thread) &&
      state?.promised[thread.id] !== undefined &&
      state?.watching[thread.id] === undefined &&
      quietFor(thread, Date.now()) > STALLED_AFTER_MS;
    const openPrs = (thread: PluginSidebarThread) =>
      threadPrs(state?.threadPrs[thread.id], null).filter((pr) => pr.state === "open" || pr.state === "draft");
    // Nothing left to do or watch. A thread you just worked in, or are looking at, isn't finished yet.
    const finished = (thread: PluginSidebarThread) =>
      thread.id !== activeThreadId &&
      quietFor(thread, Date.now()) > DONE_AFTER_MS &&
      !busy(thread) &&
      !needs(thread) &&
      state?.watching[thread.id] === undefined &&
      state?.awaiting[thread.id] === undefined &&
      state?.readyToGo?.[thread.id] === undefined &&
      !isStalled(thread) &&
      threadPrs(state?.threadPrs[thread.id], null).every((pr) => pr.state === "merged" || pr.state === "closed");
    // Only unfiled rows whose PRs are all merged or closed: anything you put in a
    // section stays there. Archiving a thread archives its subthreads with it (bb
    // does), so a row is done only when everything under it is finished too.
    const doneRows = new Map<string, boolean>();
    const doneRow = (row: PluginSidebarThread) => {
      let done = doneRows.get(row.id);
      if (done === undefined) {
        done = row.sectionId === null && allSettled(threadPrs(state?.threadPrs[row.id], null)) && treeOf(row).every(finished);
        doneRows.set(row.id, done);
      }
      return done;
    };
    const sets: Record<SmartId, (thread: PluginSidebarThread) => boolean> = {
      needs,
      stalled: (thread) => isStalled(thread),
      yourMove: (thread) => !busy(thread) && !replyQueued(thread) && !needs(thread) && state?.awaiting[thread.id] !== undefined,
      readyToGo: (thread) => !busy(thread) && !replyQueued(thread) && !needs(thread) && state?.readyToGo?.[thread.id] !== undefined,
      running: busy,
      prAction: (thread) =>
        !busy(thread) && openPrs(thread).some((pr) => ["checks_failed", "changes_requested", "conflicts"].includes(pr.attention)),
      readyToMerge: (thread) => !busy(thread) && openPrs(thread).some((pr) => pr.attention === "ready_to_merge"),
      autopilot: (thread) => state?.watching[thread.id] !== undefined,
      // A subthread goes with its row: it's done when the row is.
      done: (thread) => {
        const row = rowById.get(rootOf.get(thread.id) ?? "");
        return row !== undefined && doneRow(row);
      },
    };
    const smartCounts = Object.fromEntries(
      SMART.map((entry) => [entry.id, counted.filter(sets[entry.id]).length]),
    ) as Record<SmartId, number>;
    const machineCounts = new Map<string, number>();
    for (const thread of counted) {
      const host = threadHost(thread, machines);
      if (host) machineCounts.set(host, (machineCounts.get(host) ?? 0) + 1);
    }

    // A filter shows the rows with a match at or under them, and under each row
    // only the subthreads that match or lead to one. Its groups count the matches.
    const filterOf = (matches: (thread: PluginSidebarThread) => boolean) => {
      const match = (thread: PluginSidebarThread) => tagged(thread) && matches(thread);
      const shown = withMatches(trees, match);
      return { shown, rows: awake.filter((row) => shown.has(row.id)), count: (rows: readonly PluginSidebarThread[]) => rows.flatMap(treeOf).filter(match).length };
    };

    // One machine's threads, across every section.
    if (smart?.startsWith("machine:")) {
      const hostId = smart.slice("machine:".length);
      const host = machines?.hosts.find((candidate) => candidate.id === hostId);
      const filter = filterOf((thread) => threadHost(thread, machines) === hostId);
      return {
        smartCounts,
        machineCounts,
        shown: filter.shown,
        groups: [
          {
            id: smart,
            title: `On ${host ? machineLabel(host.name) : "machine"}`,
            threads: filter.rows,
            count: filter.count(filter.rows),
            dynamic: { glyph: "terminal", tone: "text-slate-400" },
          },
        ] satisfies Group[],
      };
    }

    // A smart filter narrows the list to that computed set, keeping your sections.
    // Done stays one flat list, so Archive all has one place to act on.
    if (smart !== null && smart !== "done") {
      const entry = SMART.find((candidate) => candidate.id === smart)!;
      const filter = filterOf(sets[smart as SmartId]);
      const { sections: bySection, loose } = groupBySection(filter.rows, sectionKeys, (thread) =>
        sectionKey(thread.sectionId),
      );
      const filtered: Group[] = loose.length > 0
        ? [{ id: `smart:${smart}`, title: entry.label, threads: loose, count: filter.count(loose), dynamic: { glyph: entry.glyph, tone: entry.tone } }]
        : [];
      for (const { key, threads: matches } of bySection) {
        const lane = lanes.find((candidate) => sectionKey(candidate.sectionId) === key);
        const section = lane ? null : otherSections.find((candidate) => candidate.id === key);
        const count = filter.count(matches);
        // "smart:" ids stay expanded: a filter's matches can't hide in a collapsed section.
        if (lane) {
          filtered.push({ id: `smart:${smart}:${key}`, title: lane.title, threads: matches, count, section: { id: lane.sectionId, name: lane.title, isLane: true } });
        } else if (section) {
          filtered.push({ id: `smart:${smart}:${key}`, title: section.name, threads: matches, count, section: { id: section.id, name: section.name, isLane: false } });
        } else {
          filtered.push({ id: `smart:${smart}:${key}`, title: entry.label, threads: matches, count, dynamic: { glyph: entry.glyph, tone: entry.tone } });
        }
      }
      return { smartCounts, machineCounts, shown: filter.shown, groups: filtered };
    }
    if (smart !== null) {
      const entry = SMART.find((candidate) => candidate.id === smart)!;
      const filter = filterOf(sets[smart as SmartId]);
      // Archiving a row takes its subthreads with it, so only the rows are sent.
      const members = filter.rows;
      return {
        smartCounts,
        machineCounts,
        shown: filter.shown,
        groups: [
          {
            id: `smart:${smart}`,
            title: entry.label,
            threads: members,
            count: filter.count(members),
            dynamic: { glyph: entry.glyph, tone: entry.tone },
            action:
              smart === "done" && members.length > 0
                ? { label: "Archive all", run: () => void rpc.call("archive", { threadIds: members.map((thread) => thread.id) }) }
                : undefined,
          },
        ] satisfies Group[],
      };
    }

    // Waiting on someone else: the agent said so, or every open PR waits on a reviewer.
    // Only unfiled threads move automatically; your own sections stay as you set them.
    const waitsOnOthers = (thread: PluginSidebarThread) => {
      if (thread.sectionId !== null || busy(thread) || needs(thread) || isStalled(thread)) return false;
      if (state?.awaiting[thread.id] !== undefined) return false;
      if (state?.waitingOthers[thread.id] !== undefined) return true;
      const open = openPrs(thread);
      return open.length > 0 && open.every((pr) => pr.attention === "review_requested");
    };
    const waitingLane = lanes.find((lane) => lane.id === "waiting");
    const inActive = (thread: PluginSidebarThread) => thread.sectionId === null && !(waitingLane && waitsOnOthers(thread));
    // A row and the subthreads under it that show (with a tag filter, only those leading to a tag).
    const shownTree = (row: PluginSidebarThread) => (tagShown ? treeOf(row).filter((thread) => tagShown.has(thread.id)) : treeOf(row));
    // A row needs you when it or a subthread under it does.
    const needing = (row: PluginSidebarThread) => shownTree(row).filter(needs).length;
    // With Now on, its groups claim their rows; with it off, Needs me does.
    const claimed = (thread: PluginSidebarThread) => (queue ? nowRows.has(thread.id) : needing(thread) > 0);
    const stalled = awake.filter((thread) => !thread.isPinned && !claimed(thread) && isStalled(thread));
    const pinned = awake.filter((thread) => thread.isPinned);
    const attention = awake.filter((thread) => !thread.isPinned && needing(thread) > 0);
    const rest = awake.filter((thread) => !thread.isPinned && !claimed(thread) && !isStalled(thread) && !doneRow(thread));

    const result: Group[] = [];
    if (pinned.length > 0) result.push({ id: "pinned", title: "Pinned", threads: pinned });
    if (queue) {
      // Each entry's row, in queue order: a subthread's entry stands for the row it sits under, once.
      const placed = new Set<string>();
      const rows = (entries: readonly NowEntry[]) =>
        entries.flatMap((entry) => {
          const row = rowById.get(rootOf.get(entry.thread.id) ?? "");
          if (!row || placed.has(row.id) || !visible.includes(row)) return [];
          placed.add(row.id);
          return [row];
        });
      result.push({ id: "now", title: "Now", threads: rows(queue.now), limit: NOW_ROWS, dynamic: { glyph: "star", tone: "text-amber-500" } });
      result.push({ id: "moving", title: "Moving", threads: rows(queue.moving), defaultCollapsed: true, dynamic: { glyph: "hourglass", tone: "text-violet-500" } });
    } else {
      result.push({
        id: "needs-me",
        title: "Needs me",
        threads: attention,
        count: attention.reduce((sum, row) => sum + needing(row), 0),
        dynamic: { glyph: "question", tone: "text-amber-500" },
      });
    }
    if (stalled.length > 0) {
      result.push({
        id: "stalled",
        title: "Stalled",
        threads: stalled,
        dynamic: { glyph: "hourglass", tone: "text-orange-500" },
        action: { label: "Nudge all", run: () => stalled.forEach((thread) => void rpc.call("thread_reply", { threadId: thread.id, text: NUDGE })) },
      });
    }
    for (const key of sectionKeys) {
      const lane = lanes.find((candidate) => sectionKey(candidate.sectionId) === key);
      // A workspace grouped by project shows its unfiled threads one project at a time.
      // With none, the plain Active lane stays, so there's still somewhere to drop.
      const unfiled = lane?.id === "active" && workspace?.groupByProject ? rest.filter(inActive) : [];
      if (unfiled.length > 0) {
        for (const { projectId, threads: members } of groupByProject(unfiled)) {
          const project = { id: projectId, name: projectById.get(projectId)?.name ?? "Other" };
          result.push({
            id: `project:${projectId}`,
            title: project.name,
            threads: members,
            limit: 15,
            project,
            action: canMakeWorkspace(projectId)
              ? { label: "Make workspace", run: () => makeWorkspace(project) }
              : undefined,
          });
        }
        continue;
      }
      if (lane) {
        result.push({
          id: `lane:${lane.id}`,
          title: lane.title,
          hint: lane.key,
          threads: rest.filter((thread) =>
            lane.id === "waiting"
              ? thread.sectionId === lane.sectionId || waitsOnOthers(thread)
              : lane.id === "active"
                ? inActive(thread)
                : thread.sectionId === lane.sectionId,
          ),
          ...(lane.id === "waiting" ? { auto: true } : {}),
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
    // Archive all sends only the rows: bb archives their subthreads with them.
    const done = awake.filter((thread) => !thread.isPinned && !claimed(thread) && doneRow(thread));
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
      threads: snoozed.filter((thread) => !nowRows.has(thread.id)).sort((a, b) => (state?.snoozes[a.id]?.until ?? 0) - (state?.snoozes[b.id]?.until ?? 0)),
      defaultCollapsed: true,
      dynamic: { glyph: "alarm", tone: "text-muted-foreground" },
    });
    return { groups: result, smartCounts, machineCounts, shown: tagShown };
  }, [threads, liveRows, trees, rootOf, queue, nowRows, sections, lanes, otherSections, state, tags, tagFilter, smart, rpc, sectionKeys, activeThreadId, machines, createdOrder, workspace, projectById, workspaceState, allThreads, projects, navigate]);

  const defaults = useMemo(
    () => ({ ...Object.fromEntries(groups.map((group) => [group.id, group.defaultCollapsed ?? false])), filters: true }),
    [groups],
  );
  const { isCollapsed, toggle, pruneFoldsOf } = useCollapsed(defaults);
  const filtersOpen = !isCollapsed("filters");
  const smartLabel = smart?.startsWith("machine:")
    ? machineLabel(machines?.hosts.find((host) => host.id === smart.slice(8))?.name ?? "Machine")
    : SMART.find((entry) => entry.id === smart)?.label;
  const activeFilters = [smartLabel, tagFilter && `#${tagFilter}`].filter(Boolean).join(" · ");
  // Folds of threads that are gone (deleted, or archived out of bb's list) are dropped.
  useEffect(() => {
    if (status !== "ready") return;
    const ids = new Set(allThreads.map((thread) => thread.id));
    pruneFoldsOf((threadId) => ids.has(threadId));
  }, [status, allThreads, pruneFoldsOf]);

  // Subthreads start unfolded, as in bb's own list; folding is remembered per thread.
  // With a filter on, its matches show whatever is folded, as its sections do.
  const isFolded = (threadId: string) => isCollapsed(foldKey(threadId));
  const subthreadToggle = (thread: PluginSidebarThread) => {
    if (shown) return undefined;
    const under = descendants(thread.id, subthreads);
    if (under.length === 0) return undefined;
    return {
      count: under.length,
      folded: isFolded(thread.id),
      // A folded thread still says when something under it needs you or is running.
      tone: under.some((child) => needsMe(child, state?.awaiting))
        ? ("needs" as const)
        : under.some((child) => child.status === "active" || child.status === "starting")
          ? ("running" as const)
          : null,
      onToggle: () => toggle(foldKey(thread.id)),
    };
  };
  // On the All tab rows of every workspace sit together: a colored one says which it is.
  const workspaceTagOf = (thread: PluginSidebarThread) => {
    if (!workspacesOn || selectedWorkspace !== null) return undefined;
    const id = workspaceForThread(thread, workspaceState, allThreads);
    const owner = id === null ? undefined : workspaceState.workspaces.find((item) => item.id === id);
    return owner?.color ? { name: owner.name, color: owner.color } : undefined;
  };
  const renderRow = (thread: PluginSidebarThread, group: Group, depth: number, borrowed?: NowEntry) => (
    <ThreadRow
      key={thread.id}
      thread={thread}
      depth={depth}
      subthreads={subthreadToggle(thread)}
      workspaceState={workspaceState}
      workspaceTag={workspaceTagOf(thread)}
      onWorkspace={(workspaceId, automatic) => void workspaceRpc.call("workspace_assign", { threadId: thread.id, workspaceId, automatic }).then(refreshWorkspaces).catch((cause) => toast.error(errorText(cause)))}
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
      onNewSection={() => setSectionDialog({ mode: "create", name: "", threadId: thread.id })}
      machine={rowMachine(thread)}
      focused={nowEnabled && state?.focused[thread.id] !== undefined}
      onToggleFocus={nowEnabled ? () => toggleFocus(thread.id) : undefined}
      due={nowEnabled ? state?.due[thread.id] : undefined}
      onSetDue={nowEnabled ? () => setDueTarget(thread.id) : undefined}
      reason={group.id === "snoozed" ? undefined : rowReason(thread, group.id === "now" || group.id === "moving" ? (nowEntries.get(thread.id) ?? borrowed) : undefined, borrowed !== undefined && !nowEntries.has(thread.id))}
    />
  );

  if (status === "loading" || (!workspaceReady && selectedWorkspace !== null)) {
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
      data-jf-color={workspacesOn ? workspace?.color : undefined}
      ref={listRef}
      onWheel={swipeOn ? onSwipe : undefined}
      className="jf-triage flex min-h-0 flex-1 flex-col overflow-y-auto px-1 pb-4"
    >
      <div className="jf-triage-heading">
        <button type="button" className="jf-filter-toggle" aria-expanded={filtersOpen} aria-controls={filterPanelId}
          onClick={() => toggle("filters")}>
          <Icon name="ListFilter" fallback="List" className="size-3.5" />
          <span>{activeFilters || "Filters"}</span>
          <Icon name={filtersOpen ? "ChevronUp" : "ChevronDown"} className="size-3" />
        </button>
        {activeFilters && <button type="button" aria-label="Clear filters" onClick={() => { setSmart(null); setTagFilter(null); }}>Clear</button>}
        <span className="jf-triage-keyboard" title={`Keys on a focused row: 1–5 move to lane · s snooze · t tag${nowEnabled ? " · f Focus · d due date" : ""} · e archive · u unread · ←/→ fold subthreads, ← to the parent · j/k move`}><Icon name="Info" className="size-3" /></span>
      </div>
      <div id={filterPanelId} hidden={!filtersOpen}>
        <div className="jf-triage-filters">
          {SMART.filter((entry) => entry.id === "needs" || smartCounts[entry.id] > 0 || smart === entry.id).map((entry) => (
            <FilterChip
              key={entry.id}
              hint={entry.hint}
              active={smart === entry.id}
              onClick={() => setSmart((current) => (current === entry.id ? null : entry.id))}
              glyph={entry.glyph}
              tone={entry.tone}
              label={entry.label}
              count={smartCounts[entry.id]}
            />
          ))}
        </div>
        {(machines?.hosts.length ?? 0) > 1 && (
          <details className="jf-machine-filters" key={smart?.startsWith("machine:") ? "selected-machine" : "machines"}
            open={smart?.startsWith("machine:") ? true : undefined}>
            <summary><Icon name="Terminal" className="size-3.5" /><span>Machines</span><Icon name="ChevronDown" className="size-3" /></summary>
            <div className="jf-triage-filters">
          {(machines?.hosts.length ?? 0) > 1
            ? machines!.hosts
                .filter((host) => (machineCounts.get(host.id) ?? 0) > 0 || smart === `machine:${host.id}`)
                .map((host) => {
                  const id = `machine:${host.id}` as const;
                  return (
                    <FilterChip
                      key={id}
                      hint={`Threads running on ${machineLabel(host.name)}${host.connected ? "" : " (offline)"}`}
                      active={smart === id}
                      onClick={() => setSmart((current) => (current === id ? null : id))}
                      glyph="terminal"
                      tone={host.connected ? "text-slate-400" : "text-slate-400/40"}
                      label={machineLabel(host.name)}
                      count={machineCounts.get(host.id) ?? 0}
                    />
                  );
                })
            : null}
            </div>
          </details>
        )}
        {knownTags.length > 0 ? (
          <div className="flex flex-wrap gap-1 px-2 pt-1">
            {knownTags.map((tag) => (
              <button
                key={tag}
                type="button"
                aria-pressed={tagFilter === tag}
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
      </div>
      {/* Before the groups: a new install has no sections, so no "Your sections" divider to hang it on. */}
      <MissingLanesHint sections={sections} pinned={state?.laneSections ?? {}} />
      {groups.map((group) => {
        const keepEmpty =
          group.id === "needs-me" || group.id === "now" || group.id.startsWith("smart:") || group.id.startsWith("section:") || group.firstUserGroup;
        if (group.threads.length === 0 && !keepEmpty) return null;
        const collapsed = group.id.startsWith("smart:") ? false : isCollapsed(group.id);
        const limit = expanded[group.id] ? Infinity : (group.limit ?? Infinity);
        return (
          <section
            key={group.id}
            {...(group.section ? { [DROP_ATTR]: sectionKey(group.section.id), [SECTION_ATTR]: sectionKey(group.section.id) } : group.project ? { [DROP_ATTR]: ACTIVE_DROP } : {})}
            className={cn(
              "relative rounded-md transition-colors",
              drag.dragging && drag.dragging.over === (group.section ? sectionKey(group.section.id) : group.project ? ACTIVE_DROP : undefined) && "bg-accent/70 ring-1 ring-ring/40",
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
              <div className="jf-sections-divider group/divider mx-2 mt-6 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
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
              count={group.count ?? group.threads.length}
              collapsed={collapsed}
              onToggle={() => toggle(group.id)}
              action={group.action}
              hint={group.hint}
              dynamic={group.dynamic}
              menu={group.project ? projectMenu(group.project) : sectionMenu(group)}
              auto={group.auto}
              {...(group.section && !smart ? { onDragStart: (event: ReactPointerEvent<HTMLElement>) => sectionDrag.start(sectionKey(group.section!.id), event) } : {})}
            />
            {collapsed ? null : group.threads.length === 0 ? (
              <p className="py-1 pl-6 pr-2 text-xs text-muted-foreground">
                {group.id === "now" && !state ? "Loading…" : group.id === "needs-me" || group.id === "now" ? "You’re all caught up." : "No threads yet."}
              </p>
            ) : (
              <>
                {group.threads.slice(0, limit).flatMap((thread) => {
                  const under = shown ? subthreadRows(thread.id, subthreads, () => false, shown) : subthreadRows(thread.id, subthreads, isFolded);
                  // A row in Now only for a subthread folded away under it says why itself,
                  // in the subthread's words (its conductor headline, if it has one).
                  const via = group.id === "now" || group.id === "moving" ? surfacedBy.get(thread.id) : undefined;
                  const borrowed = via && !nowEntries.has(thread.id) && !under.some((row) => row.thread.id === via.thread.id) ? via : undefined;
                  return [renderRow(thread, group, 0, borrowed), ...under.map((row) => renderRow(row.thread, group, row.depth))];
                })}
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
      {dueTarget === null ? null : <DueDialog threadId={dueTarget} onClose={() => setDueTarget(null)} />}
      {focusFull === null ? null : (
        <FocusLimitDialog
          limit={focusLimit}
          focusedIds={focusedIds}
          onReplace={(dropped) => {
            void setFocus(dropped, false).then(() => setFocus(focusFull, true));
            setFocusFull(null);
          }}
          onKeepAll={() => {
            void setFocus(focusFull, true);
            setFocusFull(null);
          }}
          onClose={() => setFocusFull(null)}
        />
      )}
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
              ? sdk.threadSections.create({ name }).then(async (section) => {
                  if (workspace) {
                    await workspaceRpc.call("workspace_save", { ...workspace, sectionIds: [...workspace.sectionIds, section.id] });
                    await refreshWorkspaces();
                  }
                  if (sectionDialog.threadId) await sdk.threads.update({ threadId: sectionDialog.threadId, sectionId: section.id });
                  return section;
                })
              : sdk.threadSections.update({ id: sectionDialog.id!, name }).then((result) => {
                  const from = hostSections.find((section) => section.id === sectionDialog.id)?.name;
                  if (from !== undefined) setRenamed((current) => ({ ...current, [sectionDialog.id!]: { from, to: name } }));
                  return result;
                })
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

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="jf-empty-state rounded-lg border border-border px-4 py-5 text-center text-xs text-muted-foreground"
    >
      {children}
    </div>
  );
}
