// The Conductor page: one workspace's conductor, native to JB Flow. Its
// briefing as cards you clear with one click, its conversation below, and in
// the side panel the workspace's threads (Fleet) and what it did (Activity).
import "./conductor-page.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ThreadChat,
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSdk,
  useSettings,
  type ExperimentalBadge,
  type ExperimentalProviderModelPickerValue,
  type PluginNavPanelProps,
  type PluginSettingsSectionProps,
} from "@get-bb/plugin-sdk/app";
import type { BriefingItem } from "./conductor-model";
import type { ConductorFleetRow, ConductorPage as PageState, ConductorStatus, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { errorText } from "./flow-state";
import { useSelectedWorkspace, useWorkspaces } from "./workspace-client";
import { formatWhen } from "./when";

export const CONDUCTOR_PANEL = "conductor";
const SNOOZE_CHOICES = [
  { label: "2 hours", when: "2h" },
  { label: "Tomorrow", when: "tomorrow" },
  { label: "3 days", when: "3d" },
  { label: "Next week", when: "next-week" },
];
const KIND_LABEL: Record<BriefingItem["kind"], string> = {
  decision: "Decision",
  ready: "Ready to go",
  blocked: "Blocked",
  fyi: "FYI",
};

function ago(at: number | null | undefined): string {
  if (!at) return "never";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

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

/** The workspace the page shows: its own path first, then the selected workspace tab. */
function useTargetWorkspace(subPath: string): string | null {
  const selected = useSelectedWorkspace();
  const fromPath = subPath.split("/")[0] ?? "";
  if (fromPath) return fromPath;
  return selected && selected !== "unassigned" ? selected : null;
}

/** The count on the page's navigation entry: open briefing items across running conductors. */
export function useConductorBadge(): ExperimentalBadge | null {
  const enabled = useSettings().values?.conductor === true;
  const rpc = useRpc<typeof rpcContract>();
  const [count, setCount] = useState(0);
  const load = useCallback(() => {
    if (!enabled) return;
    rpc.call("conductor_list", null).then(
      (list) => setCount(list.conductors.filter((entry) => entry.active).reduce((sum, entry) => sum + entry.needsYou, 0)),
      () => undefined,
    );
  }, [enabled, rpc]);
  useEffect(load, [load]);
  useRealtime("jb-flow-changed", load);
  if (!enabled || count === 0) return null;
  return { count, tone: "critical", label: `${count} item${count === 1 ? "" : "s"} in your conductors' briefings` };
}

export function ConductorPage({ subPath }: PluginNavPanelProps) {
  const enabled = useSettings().values?.conductor === true;
  const workspaceId = useTargetWorkspace(subPath);
  const { state } = useConductors();
  if (!enabled) {
    return (
      <div className="jf-conductor-page">
        <p className="jf-conductor-empty">
          Conductor is off. Turn it on under Settings → JB Flow, then start one for a workspace under Settings → Conductors.
        </p>
      </div>
    );
  }
  const conductor = state?.conductors.find((entry) => entry.workspaceId === workspaceId);
  if (workspaceId === null || !conductor?.threadId) {
    return (
      <div className="jf-conductor-page">
        <ConductorOverview conductors={state?.conductors ?? []} workspaceId={workspaceId} />
      </div>
    );
  }
  return <ConductorWorkspace workspaceId={workspaceId} status={conductor} />;
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
    return <p className="jf-conductor-empty">A conductor looks after one workspace. Add a workspace under Settings → Workspaces first.</p>;
  }
  return (
    <div className="jf-conductor-overview">
      <h2>Conductors</h2>
      <p className="jf-conductor-muted">
        {workspaceId
          ? "This workspace has no conductor yet."
          : "Pick a workspace. Each conductor takes its threads' routine news and leaves you one briefing."}
      </p>
      {error && <p role="alert" className="jf-conductor-error">{error}</p>}
      <ul>
        {state.workspaces.map((workspace) => {
          const conductor = conductors.find((entry) => entry.workspaceId === workspace.id);
          return (
            <li key={workspace.id} data-current={workspace.id === workspaceId || undefined}>
              <span className="jf-conductor-name">{workspace.name}</span>
              <span className="jf-conductor-muted">
                {conductor?.active ? `running · ${conductor.open} in its inbox` : conductor ? "stopped" : "no conductor"}
              </span>
              {conductor?.active && conductor.threadId ? (
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
  const rpc = useRpc<typeof rpcContract>();
  const [waking, setWaking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const threadId = page?.threadId ?? status.threadId;
  const working = page?.threadStatus === "active" || page?.threadStatus === "starting";
  const wake = async () => {
    setWaking(true);
    try {
      const { result } = await rpc.call("conductor_wake", { workspaceId });
      setNotice(
        result === "woken" ? "Woken with its inbox." : result === "busy" ? "It's busy; it'll get the news when it's done." : "Nothing new for it.",
      );
      reload();
    } catch (cause) {
      setNotice(errorText(cause));
    } finally {
      setWaking(false);
    }
  };
  return (
    <div className="jf-conductor">
      <header className="jf-conductor-bar">
        <div className="jf-conductor-heading">
          <span className="jf-conductor-name">Conductor · {status.name}</span>
          <span className="jf-conductor-chip" data-state={!status.active ? "off" : working ? "working" : "idle"}>
            {!status.active ? "Stopped" : working ? "Working" : "Idle"}
          </span>
          <span className="jf-conductor-muted">
            {page ? `${page.open} in its inbox · woken ${ago(page.lastWakeAt)}` : "Loading…"}
          </span>
        </div>
        <div className="jf-conductor-tools">
          {notice && <span className="jf-conductor-muted" role="status">{notice}</span>}
          <Button size="sm" variant="ghost" disabled={waking || !status.active} onClick={() => void wake()}>
            {waking ? "Waking…" : "Wake now"}
          </Button>
        </div>
      </header>
      {error && <p role="alert" className="jf-conductor-error">{error}</p>}
      <section className="jf-conductor-briefing" aria-label="Briefing">
        {page && <Briefing workspaceId={workspaceId} page={page} />}
      </section>
      {threadId && (
        <section className="jf-conductor-chat" aria-label="Conversation with the conductor">
          <ThreadChat threadId={threadId} variant="full" layout="contained" />
        </section>
      )}
    </div>
  );
}

function Briefing({ workspaceId, page }: { workspaceId: string; page: PageState }) {
  const { threads } = useSidebarThreads();
  const titles = useMemo(() => new Map(threads.map((thread) => [thread.id, thread.title ?? thread.titleFallback ?? "Untitled"])), [threads]);
  const [showHandled, setShowHandled] = useState(false);
  const briefing = page.briefing;
  if (!briefing) {
    return <p className="jf-conductor-empty">No briefing yet. The conductor leaves one at the end of every turn.</p>;
  }
  const open = briefing.items.filter((item) => !page.resolved.includes(item.threadId));
  return (
    <>
      <div className="jf-conductor-briefing-head">
        <h2>{open.length === 0 ? "Nothing needs you" : `Needs you · ${open.length}`}</h2>
        <span className="jf-conductor-muted">Briefing from {formatWhen(briefing.at)}</span>
      </div>
      {briefing.note && <p className="jf-conductor-note">{briefing.note}</p>}
      <ol className="jf-conductor-cards">
        {open.map((item, index) => (
          <BriefingCard key={item.threadId} index={index + 1} item={item} title={titles.get(item.threadId) ?? item.threadId} workspaceId={workspaceId} />
        ))}
      </ol>
      {briefing.handled.length > 0 && (
        <div className="jf-conductor-handled">
          <button type="button" aria-expanded={showHandled} onClick={() => setShowHandled(!showHandled)}>
            Handled · {briefing.handled.length}
          </button>
          {showHandled && (
            <ul>
              {briefing.handled.map((entry, index) => (
                <li key={index}>
                  {entry.what}
                  {entry.threadId && titles.has(entry.threadId) ? <span className="jf-conductor-muted"> · {titles.get(entry.threadId)}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

export function BriefingCard({ index, item, title, workspaceId }: { index: number; item: BriefingItem; title: string; workspaceId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [mode, setMode] = useState<"idle" | "reply" | "snooze">("idle");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: "go" | "reply" | "snooze" | "dismiss", options: { text?: string; until?: string } = {}) => {
    setBusy(true);
    setError(null);
    try {
      await rpc.call("conductor_card", { workspaceId, threadId: item.threadId, action, ...options });
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };
  return (
    <li className="jf-conductor-card" data-kind={item.kind}>
      <div className="jf-conductor-card-head">
        <span className="jf-conductor-index">{index}</span>
        <span className="jf-conductor-kind">{KIND_LABEL[item.kind]}</span>
        <button type="button" className="jf-conductor-title" onClick={() => navigate.toThread(item.threadId)}>
          {title}
        </button>
      </div>
      <p className="jf-conductor-summary">{item.summary}</p>
      {item.recommendation && (
        <p className="jf-conductor-recommendation">
          <span className="jf-conductor-muted">Recommends:</span> {item.recommendation}
        </p>
      )}
      {item.reply && mode === "idle" && <blockquote className="jf-conductor-reply" title="Sent to the thread on Go">{item.reply}</blockquote>}
      {mode === "reply" && (
        <form
          className="jf-conductor-reply-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act("reply", { text });
          }}
        >
          <textarea
            aria-label={`Reply to ${title}`}
            value={text}
            autoFocus
            rows={3}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void act("reply", { text });
              }
              if (event.key === "Escape") setMode("idle");
            }}
          />
          <div className="jf-conductor-actions">
            <Button size="sm" type="submit" disabled={busy || !text.trim()}>
              Send
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {mode === "snooze" && (
        <div className="jf-conductor-actions" role="group" aria-label="Snooze until">
          {SNOOZE_CHOICES.map((choice) => (
            <Button key={choice.when} size="sm" variant="outline" disabled={busy} onClick={() => void act("snooze", { until: choice.when })}>
              {choice.label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setMode("idle")}>
            Cancel
          </Button>
        </div>
      )}
      {mode === "idle" && (
        <div className="jf-conductor-actions">
          {item.reply && (
            <Button size="sm" disabled={busy} onClick={() => void act("go")}>
              Go
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode("reply")}>
            Reply…
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMode("snooze")}>
            Snooze
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => navigate.toThread(item.threadId)}>
            Open
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("dismiss")}>
            Dismiss
          </Button>
        </div>
      )}
      {error && <p role="alert" className="jf-conductor-error">{error}</p>}
    </li>
  );
}

/** Side-panel tab: every thread in the workspace, those that need you first. */
export function ConductorFleetTab({ subPath }: PluginNavPanelProps) {
  const workspaceId = useTargetWorkspace(subPath);
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [rows, setRows] = useState<ConductorFleetRow[] | null>(null);
  const load = useCallback(() => {
    if (workspaceId === null) return;
    rpc.call("conductor_fleet", { workspaceId }).then(setRows, () => setRows([]));
  }, [rpc, workspaceId]);
  useEffect(load, [load]);
  useRealtime("jb-flow-changed", load);
  if (workspaceId === null) return <p className="jf-conductor-empty">Pick a workspace.</p>;
  if (rows === null) return <p className="jf-conductor-empty">Loading…</p>;
  if (rows.length === 0) return <p className="jf-conductor-empty">No threads in this workspace.</p>;
  return (
    <ul className="jf-conductor-fleet">
      {rows.map((row) => (
        <li key={row.threadId} data-needs-you={row.needsYou || undefined}>
          <button type="button" className="jf-conductor-title" onClick={() => navigate.toThread(row.threadId)}>
            {row.unread && <span className="jf-conductor-dot" aria-label="unread" />}
            {row.title}
          </button>
          <span className="jf-conductor-muted">{row.reason}</span>
          {row.prs.length > 0 && (
            <span className="jf-conductor-prs">
              {row.prs.map((pr) => (
                <a key={`${pr.repo}#${pr.number}`} href={pr.url} target="_blank" rel="noreferrer" data-attention={pr.attention}>
                  {pr.repo.split("/")[1]}#{pr.number}
                </a>
              ))}
            </span>
          )}
          {(row.blocked || row.next) && <span className="jf-conductor-next">{row.blocked ? `Blocked: ${row.blocked}` : `Next: ${row.next}`}</span>}
        </li>
      ))}
    </ul>
  );
}

const LOG_LABEL: Record<string, string> = {
  merged: "Merged",
  "merge-refused": "Merge refused",
  rerun: "Reran",
  forwarded: "Forwarded",
  archive: "Archived",
  snooze: "Snoozed",
  briefing: "Briefing",
  woken: "Woken",
  started: "Started",
  stopped: "Stopped",
  restored: "Restored",
  memory: "Memory",
};

/** Side-panel tab: what the conductor did, newest first. */
export function ConductorActivityTab({ subPath }: PluginNavPanelProps) {
  const workspaceId = useTargetWorkspace(subPath);
  const { page } = useConductorPage(workspaceId);
  if (workspaceId === null) return <p className="jf-conductor-empty">Pick a workspace.</p>;
  if (!page) return <p className="jf-conductor-empty">Loading…</p>;
  if (page.log.length === 0) return <p className="jf-conductor-empty">Nothing yet.</p>;
  return (
    <ol className="jf-conductor-log">
      {page.log.map((entry) => (
        <li key={entry.id} data-kind={entry.kind}>
          <span className="jf-conductor-muted">{formatWhen(entry.at)}</span>
          <span className="jf-conductor-log-kind">{LOG_LABEL[entry.kind] ?? (entry.kind.startsWith("you-") ? "You" : entry.kind)}</span>
          <span>{entry.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** Settings → Conductors: start or stop one per workspace, and pick its project and agent. */
export function ConductorSettings(_props: PluginSettingsSectionProps) {
  const enabled = useSettings().values?.conductor === true;
  const { state: workspaces } = useWorkspaces();
  const { state, reload } = useConductors();
  if (!enabled) return <p className="jf-conductor-muted">Turn on Conductor above to start one per workspace.</p>;
  if (workspaces.workspaces.length === 0) return <p className="jf-conductor-muted">Add a workspace first; a conductor looks after one.</p>;
  return (
    <ul className="jf-conductor-settings">
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
  const [projectId, setProjectId] = useState(conductor?.projectId ?? own[0]?.id ?? "");
  const [agent, setAgent] = useState<ExperimentalProviderModelPickerValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasThread = conductor?.threadId != null;
  useEffect(() => {
    if (hasThread || !projectId) return;
    let live = true;
    sdk.projects
      .defaultExecutionOptions({ projectId })
      .then((defaults) => {
        if (live && defaults) setAgent({ providerId: defaults.providerId, model: defaults.model, reasoningLevel: defaults.reasoningLevel as ExperimentalProviderModelPickerValue["reasoningLevel"] });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sdk, projectId, hasThread]);
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
      <div className="jf-conductor-settings-row">
        <span className="jf-conductor-name">{workspace.name}</span>
        <span className="jf-conductor-muted">{running ? "Running" : conductor ? "Stopped" : "No conductor"}</span>
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
        <div className="jf-conductor-settings-row">
          <label>
            <span className="jf-conductor-muted">Lives in </span>
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)} aria-label={`Project for ${workspace.name}'s conductor`}>
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
      {hasThread && conductor?.model && <p className="jf-conductor-muted">Runs on {conductor.model}.</p>}
      {error && <p role="alert" className="jf-conductor-error">{error}</p>}
    </li>
  );
}
