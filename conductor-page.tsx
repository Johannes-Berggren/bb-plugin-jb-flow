// The Conductor page: one workspace's conductor, native to JB Flow. Its
// Conversation, the workspace's Threads and the conductor's Activity, as tabs.
import "./conductor-page.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ThreadChat,
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSdk,
  useSettings,
  type ExperimentalProviderModelPickerValue,
  type PluginNavPanelProps,
  type PluginSettingsSectionProps,
} from "@get-bb/plugin-sdk/app";
import type { ConductorFleetRow, ConductorPage as PageState, ConductorStatus, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { TRIAGE_GROUP_KEYS, TRIAGE_GROUPS } from "./conductor-model";
import { errorText } from "./flow-state";
import { useSelectedWorkspace, useWorkspaces } from "./workspace-client";
import { formatWhen } from "./when";

export const CONDUCTOR_PANEL = "conductor";

type Tab = "conversation" | "threads" | "activity";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "conversation", label: "Conversation" },
  { id: "threads", label: "Threads" },
  { id: "activity", label: "Activity" },
];

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function lastWoke(at: number | null | undefined): string {
  if (!at) return "not woken yet";
  const sameDay = new Date(at).toDateString() === new Date().toDateString();
  return `last woke ${sameDay ? clock(at) : formatWhen(at)}`;
}

// --- data ------------------------------------------------------------------

/** Every conductor's status, kept current over realtime. */
export function useConductors() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{ enabled: boolean; conductors: ConductorStatus[] } | null>(null);
  const load = useCallback(() => {
    rpc.call("conductor_list", null).then(setState, () => undefined);
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime("jb-flow-changed", load);
  return { state, reload: load };
}

function useConductorPage(workspaceId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [page, setPage] = useState<PageState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (workspaceId === null) return;
    rpc.call("conductor_page", { workspaceId }).then(
      (result) => {
        setPage(result);
        setError(null);
      },
      (cause: unknown) => setError(errorText(cause)),
    );
  }, [rpc, workspaceId]);
  useEffect(load, [load]);
  useRealtime("jb-flow-changed", load);
  return { page, error, reload: load };
}

function useFleet(workspaceId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<{ rows: ConductorFleetRow[] | null; error: string | null }>({ rows: null, error: null });
  const request = useRef(0);
  const load = useCallback(() => {
    const id = ++request.current;
    rpc.call("conductor_fleet", { workspaceId }).then(
      (rows) => { if (id === request.current) setResult({ rows, error: null }); },
      (cause: unknown) => { if (id === request.current) setResult({ rows: null, error: errorText(cause) }); },
    );
  }, [rpc, workspaceId]);
  useEffect(load, [load]);
  useRealtime("jb-flow-changed", load);
  return result;
}

/** The workspace the page shows: its own path first, then the selected workspace tab. */
function useTargetWorkspace(subPath: string): string | null {
  const selected = useSelectedWorkspace();
  const fromPath = subPath.split("/")[0] ?? "";
  if (fromPath) return fromPath;
  return selected && selected !== "unassigned" ? selected : null;
}

// --- the page --------------------------------------------------------------

export function ConductorPage({ subPath }: PluginNavPanelProps) {
  const enabled = useSettings().values?.conductor === true;
  const workspaceId = useTargetWorkspace(subPath);
  const { state } = useConductors();
  if (!enabled) {
    return (
      <div className="jf-cd-page">
        <EmptyNote icon="Workflow" title="Conductor is off">
          Turn it on under Settings → JB Flow, then start one for a workspace under Settings → Conductors.
        </EmptyNote>
      </div>
    );
  }
  const conductor = state?.conductors.find((entry) => entry.workspaceId === workspaceId);
  if (workspaceId === null || !conductor?.threadId) {
    return (
      <div className="jf-cd-page">
        <ConductorOverview conductors={state?.conductors ?? []} workspaceId={workspaceId} />
      </div>
    );
  }
  return <ConductorWorkspace key={workspaceId} workspaceId={workspaceId} status={conductor} />;
}

function EmptyNote({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="jf-cd-empty" role="status">
      <span className="jf-cd-empty-icon">
        <Icon name={icon} />
      </span>
      <p className="jf-cd-empty-title">{title}</p>
      {children && <p className="jf-cd-muted">{children}</p>}
    </div>
  );
}

/** Shown when the page has no running conductor to show: every workspace, with a way to start one. */
function ConductorOverview({ conductors, workspaceId }: { conductors: ConductorStatus[]; workspaceId: string | null }) {
  const { state } = useWorkspaces();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await rpc.call("conductor_start", { workspaceId: id });
      navigate.toPluginPanel(CONDUCTOR_PANEL, { subPath: id });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };
  if (state.workspaces.length === 0) {
    return (
      <EmptyNote icon="Workflow" title="No workspaces yet">
        A conductor looks after one workspace. Add a workspace under Settings → Workspaces first.
      </EmptyNote>
    );
  }
  return (
    <div className="jf-cd-overview">
      <h1>Conductors</h1>
      <p className="jf-cd-muted">
        {workspaceId
          ? "This workspace has no conductor yet."
          : "Pick a workspace. Each conductor takes its threads' routine news, so their workers aren't woken for it."}
      </p>
      {error && <p role="alert" className="jf-cd-error">{error}</p>}
      <ul>
        {state.workspaces.map((workspace) => {
          const conductor = conductors.find((entry) => entry.workspaceId === workspace.id);
          const running = conductor?.active === true && conductor.threadId !== null;
          return (
            <li key={workspace.id} data-current={workspace.id === workspaceId || undefined}>
              <span className="jf-cd-dot" data-state={running ? "idle" : "off"} />
              <span className="jf-cd-overview-name">{workspace.name}</span>
              <span className="jf-cd-muted">
                {running ? "running" : conductor ? "stopped" : "no conductor"}
              </span>
              {running ? (
                <Button size="sm" variant="outline" onClick={() => navigate.toPluginPanel(CONDUCTOR_PANEL, { subPath: workspace.id })}>
                  Open
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void start(workspace.id)}>
                  {busy === workspace.id ? "Starting…" : conductor ? "Start again" : "Start"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ConductorWorkspace({ workspaceId, status }: { workspaceId: string; status: ConductorStatus }) {
  const { page, error, reload } = useConductorPage(workspaceId);
  const { rows: fleet, error: fleetError } = useFleet(workspaceId);
  const rpc = useRpc<typeof rpcContract>();
  const [tab, setTab] = useState<Tab>("conversation");
  const [waking, setWaking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const threadId = page?.threadId ?? status.threadId;
  const working = page?.threadStatus === "active" || page?.threadStatus === "starting";
  const state = !status.active ? "off" : working ? "working" : "idle";
  const needsYou = fleet?.filter((row) => row.needsYou).length ?? null;

  const wake = async () => {
    setWaking(true);
    try {
      const { result } = await rpc.call("conductor_wake", { workspaceId });
      setNotice(result === "woken" ? "Woken with its inbox" : result === "busy" ? "Busy; it gets the news when it's done" : "Nothing new for it");
      reload();
    } catch (cause) {
      setNotice(errorText(cause));
    } finally {
      setWaking(false);
    }
  };

  return (
    <div className="jf-cd">
      <header className="jf-cd-head jf-cd-frame">
        <span className="jf-cd-avatar" data-state={state} aria-hidden>
          <Icon name="Workflow" />
        </span>
        <div className="jf-cd-identity">
          <h1>{status.name}</h1>
          <p className="jf-cd-muted">
            <span className="jf-cd-dot" data-state={state} />
            {state === "off" ? "Stopped" : working ? "Working" : "Idle"}
            {" · "}
            {lastWoke(page?.lastWakeAt)}
            {page && page.open > 0 ? ` · ${page.open} waiting in its inbox` : ""}
          </p>
        </div>
        <div className="jf-cd-head-actions">
          {notice && (
            <span className="jf-cd-muted" role="status">
              {notice}
            </span>
          )}
          <Button size="sm" variant="ghost" disabled={waking || !status.active} onClick={() => void wake()}>
            <Icon name="Zap" />
            {waking ? "Waking…" : "Wake now"}
          </Button>
        </div>
      </header>

      <nav className="jf-cd-tabs" role="tablist" aria-label="Conductor">
        <div className="jf-cd-frame jf-cd-tabs-inner">
        {TABS.map((entry) => {
          const count = entry.id === "threads" ? needsYou : null;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className="jf-cd-tab"
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
              {count ? <span className="jf-cd-count">{count}</span> : null}
            </button>
          );
        })}
        </div>
      </nav>

      {error && <p role="alert" className="jf-cd-error">{error}</p>}

      <div className="jf-cd-body" data-tab={tab}>
        {tab === "conversation" && threadId && <ThreadChat threadId={threadId} variant="full" layout="contained" />}
        {tab === "threads" && (fleetError ? <p role="alert" className="jf-cd-error">{fleetError}</p> : <Fleet rows={fleet} />)}
        {tab === "activity" && <Activity page={page} />}
      </div>
    </div>
  );
}

// --- threads and activity -------------------------------------------------------

/** Threads open beside the conductor, so the page stays in view. */
function useOpenThread() {
  const navigate = useBbNavigate();
  return useCallback((threadId: string) => navigate.toThread(threadId, { split: true }), [navigate]);
}

function Fleet({ rows }: { rows: ConductorFleetRow[] | null }) {
  const openThread = useOpenThread();
  if (rows === null) return <p className="jf-cd-muted jf-cd-loading">Loading…</p>;
  if (rows.length === 0) return <EmptyNote icon="ListView" title="No threads in this workspace" />;
  const groups = TRIAGE_GROUP_KEYS.map((group) => [TRIAGE_GROUPS[group], rows.filter((row) => row.group === group)] as const);
  return (
    <div className="jf-cd-fleet">
      {groups
        .filter(([, list]) => list.length > 0)
        .map(([label, list]) => (
          <section key={label}>
            <h2>
              {label} <span className="jf-cd-muted">{list.length}</span>
            </h2>
            <ul>
              {list.map((row) => (
                <li key={row.threadId} data-needs-you={row.needsYou || undefined}>
                  <span className="jf-cd-dot" data-state={row.state} />
                  <div className="jf-cd-fleet-main">
                    <button type="button" className="jf-cd-fleet-title" data-unread={row.unread || undefined} onClick={() => openThread(row.threadId)}>
                      {row.title}
                    </button>
                    {row.parentTitle && <span className="jf-cd-muted">Subthread of {row.parentTitle}</span>}
                    {(row.blocked || row.next) && <span className="jf-cd-fleet-next">{row.blocked ? `Blocked: ${row.blocked}` : `Next: ${row.next}`}</span>}
                  </div>
                  <div className="jf-cd-fleet-side">
                    <span className="jf-cd-muted">{row.reason}</span>
                    {row.prs.map((pr) => (
                      <a key={`${pr.repo}#${pr.number}`} className="jf-cd-chip" href={pr.url} target="_blank" rel="noreferrer" data-attention={pr.attention}>
                        <Icon name="GitPullRequest" />
                        {pr.repo.split("/")[1]}#{pr.number}
                      </a>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}

const LOG: Record<string, { label: string; icon: string }> = {
  merged: { label: "Merged", icon: "GitMerge" },
  "merge-refused": { label: "Merge refused", icon: "AlertTriangle" },
  "archive-held": { label: "Archive held", icon: "AlertTriangle" },
  rerun: { label: "Reran", icon: "Repeat" },
  forwarded: { label: "Forwarded", icon: "Sent" },
  archive: { label: "Archived", icon: "Archive" },
  unarchive: { label: "Unarchived", icon: "ArchiveRestore" },
  snooze: { label: "Snoozed", icon: "Clock" },
  briefing: { label: "Briefing", icon: "ListView" },
  woken: { label: "Woken", icon: "Zap" },
  started: { label: "Started", icon: "Play" },
  stopped: { label: "Stopped", icon: "Pause" },
  restored: { label: "Restored", icon: "ArchiveRestore" },
  deleted: { label: "Deleted", icon: "AlertTriangle" },
  memory: { label: "Memory", icon: "Brain" },
};

function Activity({ page }: { page: PageState | null }) {
  const { threads } = useSidebarThreads();
  const titles = useMemo(() => new Map(threads.map((thread) => [thread.id, thread.title ?? thread.titleFallback ?? ""])), [threads]);
  if (!page) return <p className="jf-cd-muted jf-cd-loading">Loading…</p>;
  if (page.log.length === 0) return <EmptyNote icon="Clock" title="Nothing yet" />;
  const days = new Map<string, typeof page.log>();
  for (const entry of page.log) {
    const day = new Date(entry.at).toDateString() === new Date().toDateString() ? "Today" : new Date(entry.at).toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
    days.set(day, [...(days.get(day) ?? []), entry]);
  }
  return (
    <div className="jf-cd-activity">
      {[...days.entries()].map(([day, entries]) => (
        <section key={day}>
          <h2>{day}</h2>
          <ol>
            {entries.map((entry) => {
              const yours = entry.kind.startsWith("you-");
              const meta = LOG[entry.kind] ?? { label: yours ? "You" : entry.kind, icon: yours ? "UserRound" : "Circle" };
              return (
                <li key={entry.id} data-kind={entry.kind} data-yours={yours || undefined}>
                  <span className="jf-cd-activity-icon">
                    <Icon name={meta.icon} />
                  </span>
                  <div>
                    <p>
                      <strong>{meta.label}</strong> {entry.text}
                    </p>
                    <p className="jf-cd-muted">
                      {clock(entry.at)}
                      {entry.threadId && titles.get(entry.threadId) ? ` · ${titles.get(entry.threadId)}` : ""}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

// --- settings --------------------------------------------------------------------

/** Settings → Conductors: start or stop one per workspace, and pick its project and agent. */
export function ConductorSettings(_props: PluginSettingsSectionProps) {
  const enabled = useSettings().values?.conductor === true;
  const { state: workspaces } = useWorkspaces();
  const { state, reload } = useConductors();
  if (!enabled) return <p className="jf-cd-muted">Turn on Conductor above to start one per workspace.</p>;
  if (workspaces.workspaces.length === 0) return <p className="jf-cd-muted">Add a workspace first; a conductor looks after one.</p>;
  return (
    <ul className="jf-cd-settings">
      {workspaces.workspaces.map((workspace) => (
        <ConductorSettingsRow
          key={workspace.id}
          workspace={workspace}
          conductor={state?.conductors.find((entry) => entry.workspaceId === workspace.id) ?? null}
          onChange={reload}
        />
      ))}
    </ul>
  );
}

function ConductorSettingsRow({
  workspace,
  conductor,
  onChange,
}: {
  workspace: { id: string; name: string; projectIds: string[] };
  conductor: ConductorStatus | null;
  onChange: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const { projects } = useSidebarThreads();
  const own = projects.filter((project) => workspace.projectIds.includes(project.id));
  // Empty: bb's Personal project, a plain folder rather than a checkout of the workspace's code.
  const [projectId, setProjectId] = useState(conductor?.projectId ?? "");
  const [agent, setAgent] = useState<ExperimentalProviderModelPickerValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasThread = conductor?.threadId != null;
  useEffect(() => {
    const forDefaults = projectId || own[0]?.id;
    if (hasThread || !forDefaults) return;
    let live = true;
    sdk.projects
      .defaultExecutionOptions({ projectId: forDefaults })
      .then((defaults) => {
        if (live && defaults) setAgent({ providerId: defaults.providerId, model: defaults.model, reasoningLevel: defaults.reasoningLevel as ExperimentalProviderModelPickerValue["reasoningLevel"] });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sdk, projectId, hasThread, own]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChange();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const running = conductor?.active === true;
  return (
    <li>
      <div className="jf-cd-settings-row">
        <span className="jf-cd-dot" data-state={running ? "idle" : "off"} />
        <span className="jf-cd-overview-name">{workspace.name}</span>
        <span className="jf-cd-muted">{running ? "Running" : conductor ? "Stopped" : "No conductor"}</span>
        {running ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => rpc.call("conductor_stop", { workspaceId: workspace.id }))}>
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(() =>
                rpc.call("conductor_start", {
                  workspaceId: workspace.id,
                  ...(projectId && !hasThread ? { projectId } : {}),
                  ...(agent && !hasThread ? { providerId: agent.providerId, model: agent.model } : {}),
                }),
              )
            }
          >
            {busy ? "Starting…" : conductor ? "Start again" : "Start"}
          </Button>
        )}
      </div>
      {!hasThread && (
        <div className="jf-cd-settings-row">
          <label>
            <span className="jf-cd-muted">Lives in </span>
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)} aria-label={`Project for ${workspace.name}'s conductor`}>
              <option value="">Personal (no checkout)</option>
              {(own.length > 0 ? own : projects).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          {agent && <ProviderModelPicker value={agent} onChange={setAgent} />}
        </div>
      )}
      {hasThread && conductor?.model && <p className="jf-cd-muted">Runs on {conductor.model}.</p>}
      {error && <p role="alert" className="jf-cd-error">{error}</p>}
    </li>
  );
}
