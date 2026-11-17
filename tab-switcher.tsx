// Ctrl+Tab: hold Ctrl, tap Tab to step back through the threads you viewed
// last, let go to open one. A quick tap flips to the previous thread without
// showing anything. Ctrl+` does the same for workspace tabs, which also sit in
// a row above the threads. The panel never takes focus, so the composer keeps
// its caret and the Ctrl keyup reaches the window.
import "./tab-switcher.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarProject, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FlowState } from "./server";
import { useFlowState } from "./flow-state";
import { MODAL_OPEN, currentPlatform } from "./palette";
import { ago } from "./palette-model";
import { readRecentThreads, readRecentWorkspaces, useCurrentThreadId, useRecentThreadsTracker, useRecentWorkspacesTracker } from "./recents";
import {
  opensSwitcher,
  startIndex,
  step,
  threadItems,
  workspaceItems,
  workspaceLabel,
  type WorkspaceTab,
} from "./tab-switcher-model";
import { StatusIcon, rowStatus, runInfo, threadPrs, useNow } from "./ui-extras";
import { switchWorkspace, useSelectedWorkspace, useWorkspaces } from "./workspace-client";
import { workspaceTabOrder } from "./workspace-swipe";
import { inWorkspace, workspaceForThread, type WorkspaceState } from "./workspaces";
import { cn } from "@/lib/utils";

/** Held this long, the panel appears; a quicker tap just flips. */
export const SHOW_AFTER_MS = 90;

type Row = "threads" | "workspaces";
type Switcher = {
  row: Row;
  threads: string[];
  workspaces: WorkspaceTab[];
  threadIndex: number;
  workspaceIndex: number;
  visible: boolean;
};

/** Mounted once per window. Keeps the recent lists fresh even while the switcher is off. */
export function TabSwitcherHost() {
  const settings = useSettings().values;
  const enabled = settings?.tabSwitcher === true;
  const workspacesOn = settings?.workspaces === true;
  useRecentThreadsTracker();
  const selected = useSelectedWorkspace();
  useRecentWorkspacesTracker(selected, workspacesOn);
  const { threads, projects } = useSidebarThreads();
  const { state: workspaceState } = useWorkspaces();
  const currentThreadId = useCurrentThreadId();
  // Read once here, where it's always mounted: mounting it in the panel refetched
  // the plugin's state on every open and re-rendered everything that reads it.
  const { state: flow } = useFlowState();
  const navigate = useBbNavigate();

  const [switcher, setSwitcherState] = useState<Switcher | null>(null);
  const current = useRef<Switcher | null>(null);
  const setSwitcher = (next: Switcher | null) => {
    current.current = next;
    setSwitcherState(next);
  };
  const live = useRef({ enabled, workspacesOn, threads, projects, workspaceState, selected, threadId: currentThreadId, navigate });
  live.current = { enabled, workspacesOn, threads, projects, workspaceState, selected, threadId: currentThreadId, navigate };

  const actions = useRef({
    commit: () => {},
    pick: (_row: Row, _index: number) => {},
    hover: (_row: Row, _index: number) => {},
  });

  useEffect(() => {
    let timer = 0;
    const close = () => {
      window.clearTimeout(timer);
      setSwitcher(null);
    };
    const commit = () => {
      const open = current.current;
      close();
      if (open === null) return;
      const now = live.current;
      if (open.row === "threads") {
        const id = open.threads[open.threadIndex];
        if (id !== undefined && id !== now.threadId) now.navigate.toThread(id);
        return;
      }
      const tab = open.workspaces[open.workspaceIndex];
      if (tab === undefined || tab === now.selected) return;
      switchWorkspace(tab, {
        state: now.workspaceState,
        threads: now.threads,
        projects: now.projects,
        currentThreadId: now.threadId,
        navigate: now.navigate,
      });
    };
    const begin = (row: Row, back: boolean): boolean => {
      const now = live.current;
      const threads = threadItems(readRecentThreads(), now.threads, now.threadId).map((thread) => thread.id);
      const workspaces =
        now.workspacesOn && now.workspaceState.workspaces.length > 0
          ? workspaceItems(readRecentWorkspaces(), workspaceTabOrder(now.workspaceState.workspaces), now.selected)
          : [];
      const items = row === "threads" ? threads : workspaces;
      // On a page that isn't a thread (Catch up, home), nothing is "current": start on the most recent.
      const threadsFromCurrent = now.threadId !== null && threads[0] === now.threadId;
      const minimum = row === "threads" && !threadsFromCurrent ? 1 : 2;
      if (items.length < minimum) return false;
      const first = back ? items.length - 1 : startIndex(items.length, row === "threads" ? threadsFromCurrent : true);
      setSwitcher({
        row,
        threads,
        workspaces,
        threadIndex: row === "threads" ? first : startIndex(threads.length, threadsFromCurrent),
        workspaceIndex: row === "workspaces" ? first : 0,
        visible: false,
      });
      timer = window.setTimeout(() => {
        if (current.current) setSwitcher({ ...current.current, visible: true });
      }, SHOW_AFTER_MS);
      return true;
    };
    /** Moves along a row (switching to it first if it isn't the active one). */
    const move = (row: Row, delta: number) => {
      const open = current.current;
      if (open === null) return;
      const length = row === "threads" ? open.threads.length : open.workspaces.length;
      if (length === 0) return;
      if (open.row !== row) {
        setSwitcher({ ...open, row });
        return;
      }
      setSwitcher(
        row === "threads"
          ? { ...open, threadIndex: step(open.threadIndex, delta, length) }
          : { ...open, workspaceIndex: step(open.workspaceIndex, delta, length) },
      );
    };
    const swallow = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const open = current.current;
      if (open === null) {
        const row = opensSwitcher(event);
        if (row === null || event.defaultPrevented || !live.current.enabled) return;
        if (document.querySelector(MODAL_OPEN)) return;
        if (begin(row, event.shiftKey)) swallow(event);
        return;
      }
      if (event.key === "Control") return;
      // Ctrl came up without a keyup reaching us (another window had it): go.
      if (!event.ctrlKey && event.key !== "Escape" && event.key !== "Enter") {
        commit();
        return;
      }
      const back = event.shiftKey;
      switch (event.key) {
        case "Tab":
          move("threads", back ? -1 : 1);
          break;
        case "Escape":
          close();
          break;
        case "Enter":
          commit();
          break;
        case "ArrowDown":
          if (open.row === "workspaces") move("threads", 0);
          else move("threads", 1);
          break;
        case "ArrowUp":
          if (open.row === "threads" && open.threadIndex === 0 && open.workspaces.length > 0) move("workspaces", 0);
          else if (open.row === "threads") move("threads", -1);
          break;
        case "ArrowLeft":
          if (open.row === "workspaces") move("workspaces", -1);
          break;
        case "ArrowRight":
          if (open.row === "workspaces") move("workspaces", 1);
          break;
        default:
          if (event.code === "Backquote") {
            move("workspaces", back ? -1 : 1);
            break;
          }
          // Any other shortcut: step aside and let it run.
          close();
          return;
      }
      swallow(event);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control" && current.current !== null) {
        swallow(event);
        commit();
      }
    };
    const onBlur = () => {
      if (current.current !== null) close();
    };
    actions.current = {
      commit,
      pick: (row, index) => {
        const open = current.current;
        if (open === null) return;
        current.current = row === "threads" ? { ...open, row, threadIndex: index } : { ...open, row, workspaceIndex: index };
        commit();
      },
      hover: (row, index) => {
        const open = current.current;
        if (open === null) return;
        setSwitcher(row === "threads" ? { ...open, row, threadIndex: index } : { ...open, row, workspaceIndex: index });
      },
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    if (!enabled && current.current !== null) setSwitcher(null);
  }, [enabled]);

  if (switcher === null || !switcher.visible) return null;
  return createPortal(
    <SwitcherPanel
      switcher={switcher}
      threads={threads}
      projects={projects}
      workspaceState={workspaceState}
      flow={flow}
      currentThreadId={currentThreadId}
      selected={selected}
      showWorkspaceNames={workspacesOn && workspaceState.workspaces.length > 0}
      onHover={(row, index) => actions.current.hover(row, index)}
      onPick={(row, index) => actions.current.pick(row, index)}
    />,
    document.body,
  );
}

function SwitcherPanel({
  switcher,
  flow,
  threads,
  projects,
  workspaceState,
  currentThreadId,
  selected,
  showWorkspaceNames,
  onHover,
  onPick,
}: {
  switcher: Switcher;
  flow: FlowState | null;
  threads: readonly PluginSidebarThread[];
  projects: readonly PluginSidebarProject[];
  workspaceState: WorkspaceState;
  currentThreadId: string | null;
  selected: WorkspaceTab;
  showWorkspaceNames: boolean;
  onHover: (row: Row, index: number) => void;
  onPick: (row: Row, index: number) => void;
}) {
  const now = useNow(30_000);
  const mac = currentPlatform() === "mac";
  const byId = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  const projectName = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  // Counted once per open, not on every Tab press: each count walks every thread.
  const unreadByTab = useMemo(
    () =>
      new Map(
        switcher.workspaces.map((tab) => [
          tab,
          threads.filter((thread) => thread.isUnread && !thread.isArchived && !thread.isHidden && inWorkspace(thread, tab, workspaceState, threads)).length,
        ]),
      ),
    [switcher.workspaces, threads, workspaceState],
  );
  const workspaceOf = useMemo(
    () => new Map(switcher.threads.map((id) => [id, showWorkspaceNames && byId.has(id) ? workspaceForThread(byId.get(id)!, workspaceState, threads) : undefined])),
    [switcher.threads, showWorkspaceNames, byId, workspaceState, threads],
  );
  const activeThread = switcher.row === "threads" ? switcher.threads[switcher.threadIndex] : undefined;
  // Pressing a row picks it. Mouse down, not click: with Ctrl held, macOS turns a click into a right-click.
  const press = (row: Row, index: number) => (event: ReactMouseEvent) => {
    event.preventDefault();
    onPick(row, index);
  };
  return (
    <div className="jf-switcher" role="dialog" aria-label="Switch thread or workspace">
      {switcher.workspaces.length > 0 ? (
        <div className="jf-switcher-workspaces" role="listbox" aria-label="Workspaces" data-active={switcher.row === "workspaces" || undefined}>
          {switcher.workspaces.map((tab, index) => {
            const unread = unreadByTab.get(tab) ?? 0;
            const chosen = switcher.row === "workspaces" && index === switcher.workspaceIndex;
            return (
              <div
                key={tab ?? "all"}
                role="option"
                aria-selected={chosen}
                className="jf-switcher-workspace"
                data-current={tab === selected || undefined}
                onMouseEnter={() => onHover("workspaces", index)}
                onMouseDown={press("workspaces", index)}
              >
                <span className="jf-switcher-workspace-name">{workspaceLabel(tab, workspaceState.workspaces)}</span>
                {unread > 0 ? <span className="jf-switcher-count">{unread}</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      <div
        className="jf-switcher-threads"
        role="listbox"
        aria-label="Recent threads"
        aria-activedescendant={activeThread ? `jf-switcher-${activeThread}` : undefined}
        data-active={switcher.row === "threads" || undefined}
      >
        {switcher.threads.map((id, index) => {
          const thread = byId.get(id);
          if (!thread) return null;
          const workspace = workspaceOf.get(id);
          return (
            <ThreadOption
              key={id}
              thread={thread}
              flow={flow}
              now={now}
              chosen={switcher.row === "threads" && index === switcher.threadIndex}
              current={id === currentThreadId}
              meta={[
                projectName.get(thread.projectId) ?? null,
                workspace === undefined ? null : workspaceLabel(workspace ?? "unassigned", workspaceState.workspaces),
              ]}
              onMouseEnter={() => onHover("threads", index)}
              onMouseDown={press("threads", index)}
            />
          );
        })}
      </div>
      <footer className="jf-switcher-hint" aria-hidden="true">
        <span>
          <kbd>Tab</kbd> next
        </span>
        <span>
          <kbd>⇧Tab</kbd> back
        </span>
        {switcher.workspaces.length > 0 ? (
          <span>
            <kbd>`</kbd> workspaces
          </span>
        ) : null}
        <span className="jf-switcher-hint-go">
          release <kbd>{mac ? "⌃" : "Ctrl"}</kbd> to open
        </span>
      </footer>
    </div>
  );
}

function ThreadOption({
  thread,
  flow,
  now,
  chosen,
  current,
  meta,
  onMouseEnter,
  onMouseDown,
}: {
  thread: PluginSidebarThread;
  flow: FlowState | null;
  now: number;
  chosen: boolean;
  current: boolean;
  meta: (string | null)[];
  onMouseEnter: () => void;
  onMouseDown: (event: ReactMouseEvent) => void;
}) {
  // The plugin's own PR records only: a per-row branch-PR lookup made opening slow.
  const busy = thread.status === "active" || thread.status === "starting";
  const status = rowStatus(
    thread,
    busy,
    flow?.watching[thread.id],
    threadPrs(flow?.threadPrs[thread.id], null),
    busy ? runInfo(flow?.running[thread.id], now) : null,
  );
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (chosen) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [chosen]);
  return (
    <div
      ref={ref}
      id={`jf-switcher-${thread.id}`}
      role="option"
      aria-selected={chosen}
      className={cn("jf-switcher-thread", thread.isUnread && "jf-switcher-unread")}
      onMouseEnter={onMouseEnter}
      onMouseDown={onMouseDown}
    >
      <StatusIcon status={status} />
      <span className="jf-switcher-main">
        <span className="jf-switcher-title">{thread.displayTitle}</span>
        <span className="jf-switcher-meta">
          {[...meta.filter((part): part is string => part !== null), current ? "open now" : ago(thread.latestAttentionAt ?? thread.updatedAt, now)].join(" · ")}
        </span>
      </span>
      {thread.isUnread ? <span className="jf-switcher-dot" aria-label="Unread" /> : null}
    </div>
  );
}
