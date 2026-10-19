import { useEffect, useRef, useState } from "react";
import {
  experimental_useSidebarNavigation as useSidebarNavigation,
  experimental_SidebarNavigationIcon as SidebarNavigationIcon,
  experimental_useSidebarNavigationSplit as useNavigationSplit,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useSdk,
  type ExperimentalSidebarNavigationItem,
  type ExperimentalSidebarNavigationProps,
} from "@get-bb/plugin-sdk/app";
import { inWorkspace, pluginInWorkspace, workspaceForThread, type Workspace } from "./workspaces";
import {
  useWorkspaces,
  useSelectedWorkspace,
  selectWorkspace,
  rememberWorkspaceThread,
  lastWorkspaceThread,
} from "./workspace-client";
import "./workspaces.css";

function NavItem({
  item,
  projectId,
}: {
  item: ExperimentalSidebarNavigationItem;
  projectId: string | undefined;
}) {
  const { actions, activeItemId } = useSidebarNavigation();
  const split = useNavigationSplit(item.id);
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      className="jf-workspace-tool"
      disabled={item.isDisabled || item.isLoading}
      aria-current={activeItemId === item.id ? "page" : undefined}
      aria-label={item.badge ? `${item.label}: ${item.badge.label}` : item.label}
      aria-keyshortcuts={item.shortcut?.ariaKeyShortcuts}
      {...split.splitProps}
      onClick={(event) => {
        if (item.action.kind === "new-thread" && projectId && !event.metaKey && !event.ctrlKey)
          navigate.toCompose({ projectId, focusPrompt: true });
        else actions.activate(item.id, { openInSplit: event.metaKey || event.ctrlKey });
      }}
    >
      <SidebarNavigationIcon icon={item.icon} className="size-4" />
      <span>{item.label}</span>
      {item.badge && (
        <span className="jf-workspace-badge" title={item.badge.label}>
          ●
        </span>
      )}
    </button>
  );
}

export function WorkspaceNavigation(_props: ExperimentalSidebarNavigationProps) {
  const { state, ready, error, refresh } = useWorkspaces();
  const selected = useSelectedWorkspace();
  const { items, actions } = useSidebarNavigation();
  const { threads, projects } = useSidebarThreads();
  const context = useBbContext();
  const navigate = useBbNavigate();
  const [manage, setManage] = useState(false);
  const [more, setMore] = useState(false);
  const [tip, setTip] = useState(() => {
    try {
      return localStorage.getItem("jb-flow-workspaces-tip") !== "dismissed";
    } catch {
      return true;
    }
  });
  const active = state.workspaces.find((workspace) => workspace.id === selected);
  const projectId = active?.projectIds.find((id) => projects.some((project) => project.id === id));
  useEffect(() => {
    if (ready && selected && selected !== "unassigned" && !active) selectWorkspace(null);
  }, [ready, selected, active]);
  function choose(id: string | null) {
    if (context.threadId) rememberWorkspaceThread(selected, context.threadId);
    selectWorkspace(id);
    const last = lastWorkspaceThread(id);
    const thread = threads.find(
      (thread) =>
        thread.id === last &&
        !thread.isArchived &&
        !thread.isHidden &&
        inWorkspace(thread, id, state, threads),
    );
    const workspace = state.workspaces.find((workspace) => workspace.id === id);
    if (thread) navigate.toThread(thread.id);
    else
      navigate.toCompose({
        ...(workspace?.projectIds.find((id) => projects.some((project) => project.id === id))
          ? {
              projectId: workspace.projectIds.find((id) =>
                projects.some((project) => project.id === id),
              ),
            }
          : {}),
        focusPrompt: true,
      });
  }
  const scoped = items.filter((item) => pluginInWorkspace(item.pluginId, selected, state));
  const attention = (id: string | null) =>
    threads.filter(
      (thread) =>
        !thread.isArchived &&
        !thread.isHidden &&
        thread.parentThreadId === null &&
        inWorkspace(thread, id, state, threads) &&
        (thread.hasPendingInteraction ||
          thread.indicator === "waiting-for-input" ||
          thread.indicator === "unread-error" ||
          (thread.isUnread && thread.status === "idle")),
    ).length;
  const tabs = [
    ...state.workspaces.map((workspace) => ({
      id: workspace.id as string | null,
      name: workspace.name,
    })),
    { id: null, name: "All" },
    { id: "unassigned", name: "Unassigned" },
  ];
  return (
    <div className="jf-workspaces">
      <div
        role="tablist"
        aria-label="Workspaces"
        className="jf-workspace-tabs"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
          );
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
          event.preventDefault();
          buttons[next]?.focus();
        }}
      >
        {tabs.map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={selected === tab.id}
            key={tab.id ?? "all"}
            onClick={() => choose(tab.id)}
          >
            {tab.name}
            {attention(tab.id) > 0 && (
              <span aria-label={`${attention(tab.id)} need attention`}>{attention(tab.id)}</span>
            )}
          </button>
        ))}
      </div>
      {tip && (
        <div className="jf-workspace-tip">
          <span>
            Workspaces group your projects, threads, sections and tools. All keeps everything within
            reach.
          </span>
          <button
            type="button"
            aria-label="Dismiss workspace introduction"
            onClick={() => {
              setTip(false);
              try {
                localStorage.setItem("jb-flow-workspaces-tip", "dismissed");
              } catch {
                /* Keep dismissal for this window. */
              }
            }}
          >
            ×
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="jf-workspace-error">
          Couldn’t load workspaces.{" "}
          <button type="button" onClick={() => void refresh()}>
            Retry
          </button>
        </p>
      )}
      {!ready && !error && <p role="status">Loading workspaces…</p>}
      <div className="jf-workspace-tools">
        {scoped
          .filter((item) => item.isVisible)
          .map((item) => (
            <NavItem key={item.id} item={item} projectId={projectId} />
          ))}
      </div>
      <div className="jf-workspace-footer">
        <button type="button" onClick={() => setManage(!manage)} aria-expanded={manage}>
          Manage workspaces
        </button>
        <button type="button" onClick={() => setMore(!more)} aria-expanded={more}>
          More tools
        </button>
        <button
          type="button"
          onClick={() => actions.openCustomize()}
          aria-label="Customise navigation"
        >
          ···
        </button>
      </div>
      {more && (
        <div className="jf-workspace-tools" aria-label="All other tools">
          {items
            .filter((item) => !scoped.includes(item) || !item.isVisible)
            .map((item) => (
              <NavItem key={item.id} item={item} projectId={projectId} />
            ))}
        </div>
      )}
      {manage && <WorkspaceSettings />}
    </div>
  );
}

export function WorkspaceRouteBridge() {
  const { state, ready } = useWorkspaces();
  const selected = useSelectedWorkspace();
  const { threadId } = useBbContext();
  const { threads } = useSidebarThreads();
  const previous = useRef<{ id: string; owner: string | null } | null>(null);
  useEffect(() => {
    if (!ready || !threadId) return;
    const thread = threads.find((thread) => thread.id === threadId);
    if (!thread) return;
    const owner = workspaceForThread(thread, state, threads);
    if (previous.current?.id === threadId && previous.current.owner === owner) return;
    previous.current = { id: threadId, owner };
    if (!inWorkspace(thread, selected, state, threads)) selectWorkspace(owner ?? "unassigned");
    rememberWorkspaceThread(owner, threadId);
    rememberWorkspaceThread(null, threadId);
  }, [ready, threadId, threads, state, selected]);
  return null;
}

export function WorkspaceSettings() {
  const { state, ready, error, rpc, refresh } = useWorkspaces();
  const { projects, sections } = useSidebarThreads();
  const { items } = useSidebarNavigation();
  const sdk = useSdk();
  const [catalog, setCatalog] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    void sdk.plugins.list().then(
      (result) =>
        setCatalog(
          result.plugins
            .filter((plugin) => plugin.enabled && plugin.id !== "jb-flow")
            .map((plugin) => ({ id: plugin.id, name: plugin.name ?? plugin.id })),
        ),
      () => undefined,
    );
  }, [sdk]);
  const [editing, setEditing] = useState<Workspace | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const plugins = [
    ...new Map([
      ...catalog.map((plugin) => [plugin.id, plugin] as const),
      ...items
        .filter((item) => item.pluginId && item.pluginId !== "jb-flow")
        .map((item) => [item.pluginId!, { id: item.pluginId!, name: item.label }] as const),
    ]).values(),
  ];
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      await refresh();
      setEditing(null);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  if (!ready) return <p role="status">{error ?? "Loading workspaces…"}</p>;
  const toggle = (field: "projectIds" | "sectionIds" | "pluginIds", id: string) => {
    if (editing)
      setEditing({
        ...editing,
        [field]: editing[field].includes(id)
          ? editing[field].filter((value) => value !== id)
          : [...editing[field], id],
      });
  };
  return (
    <div className="jf-workspace-settings">
      <p>
        Selecting a project or section moves its grouping to this workspace. Tools can appear in
        several; tools assigned nowhere are shared everywhere.
      </p>
      <div className="jf-workspace-edit-list">
        {state.workspaces.map((workspace) => (
          <button type="button" key={workspace.id} onClick={() => setEditing({ ...workspace })}>
            {workspace.name} · Edit
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          setEditing({
            id: "",
            name: "",
            projectIds: [],
            sectionIds: [],
            pluginIds: [],
            sectionOrder: [],
          })
        }
      >
        + New workspace
      </button>
      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => rpc.call("workspace_save", { ...editing, id: editing.id || null }));
          }}
        >
          <label>
            Name
            <input
              autoFocus
              required
              maxLength={60}
              value={editing.name}
              onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            />
          </label>
          {(
            [
              ["projectIds", "Projects", projects],
              ["sectionIds", "Sections", sections],
              ["pluginIds", "Tools", plugins],
            ] as const
          ).map(([field, title, entries]) => (
            <fieldset key={field}>
              <legend>{title}</legend>
              {entries.map((entry) => (
                <label key={entry.id}>
                  <input
                    type="checkbox"
                    checked={editing[field].includes(entry.id)}
                    onChange={() => toggle(field, entry.id)}
                  />
                  {entry.name}
                </label>
              ))}
            </fieldset>
          ))}
          <div className="jf-workspace-edit-list">
            <button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save workspace"}
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
          {editing.id && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => rpc.call("workspace_remove", { id: editing.id }))}
            >
              Remove workspace grouping (keeps threads and projects)
            </button>
          )}
        </form>
      )}
      {message && <p role="alert">{message}</p>}
    </div>
  );
}
