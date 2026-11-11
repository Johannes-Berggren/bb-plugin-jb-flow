// The Conductor page: one workspace's conductor, native to JB Flow.
// Briefing (cards you clear with one click or a key), its Conversation, the
// workspace's Threads and the conductor's Activity, as tabs inside the page.
import "./conductor-page.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
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
import { headlineOf, type BriefingContext, type BriefingItem } from "./conductor-model";
import type { ConductorFleetRow, ConductorPage as PageState, ConductorStatus, rpcContract } from "./server";
import { Button, buttonVariants } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { errorText } from "./flow-state";
import { useSelectedWorkspace, useWorkspaces } from "./workspace-client";
import { formatWhen } from "./when";

export const CONDUCTOR_PANEL = "conductor";

type Kind = BriefingItem["kind"];
/** Briefing order: what only you can decide first, what you only need to know last. */
const KIND_ORDER: Kind[] = ["decision", "blocked", "ready", "fyi"];
const KIND: Record<Kind, { label: string; plural: string; icon: string }> = {
  decision: { label: "Decision", plural: "Decisions", icon: "CircleQuestion" },
  blocked: { label: "Blocked on you", plural: "Blocked on you", icon: "AlertTriangle" },
  ready: { label: "Ready to go", plural: "Ready to go", icon: "Play" },
  fyi: { label: "FYI", plural: "FYI", icon: "Info" },
};
const SNOOZE_CHOICES = [
  { label: "2 hours", when: "2h" },
  { label: "Tomorrow", when: "tomorrow" },
  { label: "3 days", when: "3d" },
  { label: "Next week", when: "next-week" },
];
type Tab = "briefing" | "conversation" | "threads" | "activity";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "briefing", label: "Briefing" },
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

/** Typing in a field, or a menu open: page keys stay out of the way. */
function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName));
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

function useFleet(workspaceId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<ConductorFleetRow[] | null>(null);
  const load = useCallback(() => {
    if (workspaceId === null) return;
    rpc.call("conductor_fleet", { workspaceId }).then(setRows, () => setRows([]));
  }, [rpc, workspaceId]);
  useEffect(load, [load]);
  useRealtime("jb-flow-changed", load);
  return rows;
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
  return <ConductorWorkspace workspaceId={workspaceId} status={conductor} />;
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
          : "Pick a workspace. Each conductor takes its threads' routine news and leaves you one briefing."}
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
                {running ? (conductor!.needsYou ? `${conductor!.needsYou} need${conductor!.needsYou === 1 ? "s" : ""} you` : "all clear") : conductor ? "stopped" : "no conductor"}
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
  const fleet = useFleet(workspaceId);
  const rpc = useRpc<typeof rpcContract>();
  const [tab, setTab] = useState<Tab>("briefing");
  const [waking, setWaking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const threadId = page?.threadId ?? status.threadId;
  const working = page?.threadStatus === "active" || page?.threadStatus === "starting";
  const state = !status.active ? "off" : working ? "working" : "idle";
  const open = page?.briefing ? page.briefing.items.filter((item) => !page.resolved.includes(item.threadId)).length : 0;
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
          const count = entry.id === "briefing" ? open : entry.id === "threads" ? needsYou : null;
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
        {tab === "briefing" &&
          (page ? (
            <Briefing workspaceId={workspaceId} page={page} onAsk={() => setTab("conversation")} conductorThreadId={threadId} />
          ) : (
            <p className="jf-cd-muted jf-cd-loading">Loading…</p>
          ))}
        {tab === "conversation" && threadId && <ThreadChat threadId={threadId} variant="full" layout="contained" />}
        {tab === "threads" && <Fleet rows={fleet} />}
        {tab === "activity" && <Activity page={page} />}
      </div>
    </div>
  );
}

// --- briefing ----------------------------------------------------------------

/** Threads open beside the conductor, so the briefing stays in view. */
function useOpenThread() {
  const navigate = useBbNavigate();
  return useCallback((threadId: string) => navigate.toThread(threadId, { split: true }), [navigate]);
}

function age(since: number | null): string | null {
  if (!since) return null;
  const minutes = Math.max(0, Math.round((Date.now() - since) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function dueLabel(at: number | null): string | null {
  if (!at) return null;
  const days = Math.round((at - Date.now()) / 86_400_000);
  if (at < Date.now()) return "overdue";
  if (days < 1) return "due today";
  if (days < 2) return "due tomorrow";
  return `due ${new Date(at).toLocaleDateString([], { weekday: "short" })}`;
}

function Briefing({
  workspaceId,
  page,
  conductorThreadId,
  onAsk,
}: {
  workspaceId: string;
  page: PageState;
  conductorThreadId: string | null;
  onAsk: () => void;
}) {
  const { threads, projects } = useSidebarThreads();
  const titles = useMemo(() => new Map(threads.map((thread) => [thread.id, thread.title ?? thread.titleFallback ?? "Untitled"])), [threads]);
  const projectOf = useMemo(() => {
    const names = new Map(projects.map((project) => [project.id, project.name]));
    return new Map(threads.map((thread) => [thread.id, names.get(thread.projectId) ?? null]));
  }, [threads, projects]);
  const [filter, setFilter] = useState<Kind | "all">("all");
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [showHandled, setShowHandled] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const briefing = page.briefing;

  const open = useMemo(
    () =>
      (briefing?.items ?? [])
        .filter((item) => !page.resolved.includes(item.threadId))
        .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)),
    [briefing, page.resolved],
  );
  const visible = filter === "all" ? open : open.filter((item) => item.kind === filter);
  const counts = useMemo(() => {
    const result = new Map<Kind, number>();
    for (const item of open) result.set(item.kind, (result.get(item.kind) ?? 0) + 1);
    return result;
  }, [open]);
  const oldest = useMemo(() => {
    const times = open.map((item) => page.contexts[item.threadId]?.waitingSince ?? null).filter((at): at is number => at !== null);
    return times.length ? Math.min(...times) : null;
  }, [open, page.contexts]);
  useEffect(() => {
    if (filter !== "all" && !counts.get(filter)) setFilter("all");
  }, [counts, filter]);
  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, visible.length - 1)));
  }, [visible.length]);
  // Follow the selection with the scroll, but only when a key moved it.
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    root.current?.querySelector<HTMLElement>(`[data-item][data-selected]`)?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const select = (index: number) => {
    if (index === selected) setExpanded(!expanded);
    else {
      setSelected(index);
      setExpanded(true);
    }
  };
  // Keys act on the selected item; each item listens for its own via this event.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key;
    if (key === "j" || key === "ArrowDown" || key === "k" || key === "ArrowUp") {
      moved.current = true;
      const down = key === "j" || key === "ArrowDown";
      setSelected((index) => (down ? Math.min(index + 1, visible.length - 1) : Math.max(index - 1, 0)));
    } else if (key === "Enter") setExpanded((value) => !value);
    else if (["g", "r", "s", "o", "e"].includes(key) && visible[selected]) {
      root.current?.querySelector<HTMLElement>(`[data-item="${visible[selected].threadId}"]`)?.dispatchEvent(new CustomEvent("jf-cd-key", { detail: key }));
    } else return;
    event.preventDefault();
  };

  if (!briefing) {
    return (
      <EmptyNote icon="Workflow" title="No briefing yet">
        The conductor leaves one at the end of every turn. Wake it, or ask it something in the conversation.
      </EmptyNote>
    );
  }

  let index = 0;
  return (
    <div className="jf-cd-briefing" ref={root} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="jf-cd-summary-strip">
        <div className="jf-cd-stat">
          <strong>{open.length}</strong>
          <span>{open.length === 1 ? "needs you" : "need you"}</span>
        </div>
        {oldest && (
          <div className="jf-cd-stat">
            <strong>{age(oldest)}</strong>
            <span>oldest wait</span>
          </div>
        )}
        <div className="jf-cd-stat">
          <strong>{briefing.handled.length}</strong>
          <span>handled</span>
        </div>
        <span className="jf-cd-spacer" />
        {open.length > 0 && (
          <div className="jf-cd-filters" role="group" aria-label="Show">
            <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              All <span>{open.length}</span>
            </button>
            {KIND_ORDER.filter((kind) => counts.get(kind)).map((kind) => (
              <button key={kind} type="button" data-kind={kind} aria-pressed={filter === kind} onClick={() => setFilter(kind)}>
                <span className="jf-cd-kind-dot" data-kind={kind} />
                {KIND[kind].plural} <span>{counts.get(kind)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {briefing.note && (
        <p className="jf-cd-note">
          <Icon name="Workflow" />
          <span>{briefing.note}</span>
          <span className="jf-cd-muted">{clock(briefing.at)}</span>
        </p>
      )}

      {open.length === 0 ? (
        <EmptyNote icon="CircleCheck" title="Nothing needs you">
          The conductor will brief you when something does.
        </EmptyNote>
      ) : (
        KIND_ORDER.filter((kind) => visible.some((item) => item.kind === kind)).map((kind) => (
          <section key={kind} className="jf-cd-group" data-kind={kind}>
            <h2>
              {KIND[kind].plural}
              <span className="jf-cd-muted">{counts.get(kind)}</span>
            </h2>
            <ol className="jf-cd-list">
              {visible
                .filter((item) => item.kind === kind)
                .map((item) => {
                  const position = index++;
                  return (
                    <BriefingItemRow
                      key={item.threadId}
                      item={item}
                      context={page.contexts[item.threadId] ?? null}
                      title={titles.get(item.threadId) ?? item.threadId}
                      project={projectOf.get(item.threadId) ?? null}
                      workspaceId={workspaceId}
                      selected={position === selected}
                      expanded={position === selected && expanded}
                      onToggle={() => select(position)}
                    />
                  );
                })}
            </ol>
          </section>
        ))
      )}

      {briefing.handled.length > 0 && (
        <section className="jf-cd-handled">
          <button type="button" aria-expanded={showHandled} onClick={() => setShowHandled(!showHandled)}>
            <Icon name="ChevronDown" />
            Handled by the conductor · {briefing.handled.length}
          </button>
          {showHandled && (
            <ul>
              {briefing.handled.map((entry, position) => (
                <li key={position}>
                  <Icon name="Check" />
                  <span>
                    {entry.what}
                    {entry.threadId && titles.has(entry.threadId) ? <span className="jf-cd-muted"> · {titles.get(entry.threadId)}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {open.length > 0 && <p className="jf-cd-keys jf-cd-muted">j/k move · ↵ open/close · g send · r reply · s snooze · o open thread · e done</p>}

      {conductorThreadId && <AskConductor threadId={conductorThreadId} onSent={onAsk} />}
    </div>
  );
}

/** One line to the conductor itself ("2 go, 4 snooze 3d"), then on to the conversation. */
function AskConductor({ threadId, onSent }: { threadId: string; onSent: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await rpc.call("thread_reply", { threadId, text: text.trim() });
      setText("");
      onSent();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="jf-cd-ask"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Icon name="Workflow" />
      <input
        aria-label="Tell the conductor"
        placeholder="Tell the conductor… e.g. “2 go, 4 snooze 3d”"
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
      />
      <Button size="sm" variant="ghost" type="submit" disabled={busy || !text.trim()} aria-label="Send to the conductor">
        <Icon name="CornerDownLeft" />
      </Button>
    </form>
  );
}

const quote = (text: string, max = 18) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** One briefing item: a line to scan, which opens into its context and the ways to answer. */
export function BriefingItemRow({
  item,
  context,
  title,
  project,
  workspaceId,
  selected = false,
  expanded = false,
  onToggle,
}: {
  item: BriefingItem;
  context: BriefingContext | null;
  title: string;
  project?: string | null;
  workspaceId: string;
  selected?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const openThread = useOpenThread();
  const suggested = item.reply ?? "";
  const options = context?.options ?? [];
  // The conductor's suggestion is often just one of the thread's own options ("2", "go 1").
  const pick = options.find((option) => [String(option.n), `go ${option.n}`].includes(suggested.trim().toLowerCase()));
  const [draft, setDraft] = useState(suggested);
  const [composing, setComposing] = useState(suggested !== "" && !pick);
  const [snoozing, setSnoozing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const row = useRef<HTMLLIElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  const act = useCallback(
    async (action: "go" | "reply" | "snooze" | "dismiss", options: { text?: string; until?: string } = {}) => {
      setBusy(true);
      setError(null);
      try {
        await rpc.call("conductor_card", { workspaceId, threadId: item.threadId, action, ...options });
      } catch (cause) {
        setError(errorText(cause));
        setBusy(false);
      }
    },
    [rpc, workspaceId, item.threadId],
  );
  /** Sends text to the thread: the conductor's own suggestion, untouched, is a "go". */
  const sendText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      void (trimmed === suggested.trim() ? act("go") : act("reply", { text: trimmed }));
    },
    [suggested, act],
  );
  const reply = useCallback(() => {
    setComposing(true);
    requestAnimationFrame(() => field.current?.focus());
  }, []);

  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const onKey = (event: Event) => {
      const key = (event as CustomEvent<string>).detail;
      if (key === "g" && suggested) void act("go");
      else if (key === "r") reply();
      else if (key === "s") setSnoozing(true);
      else if (key === "o") openThread(item.threadId);
      else if (key === "e") void act("dismiss");
    };
    element.addEventListener("jf-cd-key", onKey);
    return () => element.removeEventListener("jf-cd-key", onKey);
  }, [act, reply, suggested, openThread, item.threadId]);

  const waited = age(context?.waitingSince ?? null);
  const due = dueLabel(context?.dueAt ?? null);
  // Without a headline the line is the summary's first sentence; don't say it twice.
  const headline = headlineOf(item);
  const summary = item.headline ? item.summary : item.summary.slice(item.summary.split(/(?<=[.!?])\s/)[0]!.length).trim();
  const reportLines = context ? ([["Goal", context.goal], ["Blocked", context.blocked], ["Next", context.next]] as const).filter(([, value]) => value) : [];

  return (
    <li
      ref={row}
      className="jf-cd-item"
      data-kind={item.kind}
      data-item={item.threadId}
      data-selected={selected || undefined}
      data-expanded={expanded || undefined}
      data-busy={busy || undefined}
    >
      <div className="jf-cd-row" onClick={onToggle}>
        <span className="jf-cd-kind-icon" title={KIND[item.kind].label}>
          <Icon name={KIND[item.kind].icon} />
        </span>
        <div className="jf-cd-row-main">
          <div className="jf-cd-row-top">
            <span className="jf-cd-row-title">{title}</span>
            {project && <span className="jf-cd-chip">{project}</span>}
          </div>
          <p className="jf-cd-headline">{headline}</p>
          {!expanded && (item.recommendation || pick) && (
            <p className="jf-cd-row-rec">
              <Icon name="ArrowRight" />
              <span>{item.recommendation ?? `${pick!.n}. ${pick!.text}`}</span>
            </p>
          )}
        </div>
        <div className="jf-cd-row-meta">
          {due && <span className="jf-cd-due" data-overdue={due === "overdue" || undefined}>{due}</span>}
          {waited && <span className="jf-cd-muted" title="Waiting on you for">{waited}</span>}
          {context && context.prs.length > 0 && (
            <span className="jf-cd-chip" title={context.prs.map((pr) => `${pr.repo}#${pr.number}: ${pr.title}`).join("\n")}>
              <Icon name="GitPullRequest" />
              {context.prs.length}
            </span>
          )}
          {suggested && !expanded && (
            <button
              type="button"
              className={`${buttonVariants({ variant: "outline", size: "sm" })} jf-cd-quick`}
              title={pick ? `Answer ${pick.n}: ${pick.text}` : `Send the suggested reply: ${suggested}`}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                void act("go");
              }}
            >
              {pick ? `Choose ${pick.n}` : suggested.length <= 14 ? `Send “${quote(suggested)}”` : "Send suggestion"}
            </button>
          )}
          <Icon name="ChevronDown" className="jf-cd-chevron" />
        </div>
      </div>

      {expanded && (
        <div className="jf-cd-detail">
          {summary && <p className="jf-cd-summary">{summary}</p>}

          {(reportLines.length > 0 || (context?.prs.length ?? 0) > 0) && (
            <dl className="jf-cd-context">
              {reportLines.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
              {context && context.prs.length > 0 && (
                <div>
                  <dt>PRs</dt>
                  <dd className="jf-cd-prs">
                    {context.prs.map((pr) => (
                      <a key={`${pr.repo}#${pr.number}`} className="jf-cd-chip" href={pr.url} target="_blank" rel="noreferrer" data-attention={pr.attention} title={pr.title}>
                        <Icon name="GitPullRequest" />
                        {pr.repo.split("/")[1]}#{pr.number} · {pr.attention.replaceAll("_", " ")}
                      </a>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
          )}

          {options.length > 0 && (
            <div className="jf-cd-options" role="group" aria-label="The thread's options">
              <span className="jf-cd-label">The thread asks</span>
              {options.map((option) => (
                <button
                  key={option.n}
                  type="button"
                  className="jf-cd-option"
                  data-recommended={option.recommended || undefined}
                  disabled={busy}
                  onClick={() => sendText(context?.optionsMode === "go" ? `go ${option.n}` : String(option.n))}
                >
                  <span className="jf-cd-option-n">{option.n}</span>
                  <span className="jf-cd-option-text">{option.text}</span>
                  {option === pick && <span className="jf-cd-option-badge" data-pick>Conductor's pick</span>}
                  {option.recommended && option !== pick && <span className="jf-cd-option-badge">Recommended</span>}
                </button>
              ))}
              {context?.optionsMode === "go" && (
                <button type="button" className="jf-cd-option" disabled={busy} onClick={() => sendText("go")}>
                  <span className="jf-cd-option-n">
                    <Icon name="Play" />
                  </span>
                  <span className="jf-cd-option-text">Go with all of them</span>
                </button>
              )}
            </div>
          )}

          {item.recommendation && !pick && (
            <p className="jf-cd-rec">
              <Icon name="Workflow" />
              <span>
                <span className="jf-cd-label">Conductor recommends</span>
                {item.recommendation}
              </span>
            </p>
          )}

          {composing && !snoozing && (
            <div className="jf-cd-composer">
              <span className="jf-cd-label">{suggested && draft.trim() === suggested.trim() ? "Suggested reply to the thread" : "Your reply to the thread"}</span>
              <textarea
                ref={field}
                aria-label={`Reply to ${title}`}
                value={draft}
                placeholder="Write to the thread…"
                rows={Math.min(5, Math.max(1, Math.ceil(draft.length / 70)))}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    sendText(draft);
                  }
                  if (event.key === "Escape") {
                    event.currentTarget.blur();
                    if (!suggested) setComposing(false);
                  }
                }}
              />
              {suggested && draft.trim() !== suggested.trim() && (
                <button type="button" className="jf-cd-more" onClick={() => setDraft(suggested)}>
                  Use the suggestion
                </button>
              )}
            </div>
          )}

          {snoozing ? (
            <div className="jf-cd-actions" role="group" aria-label="Snooze until">
              <span className="jf-cd-muted">Snooze until</span>
              {SNOOZE_CHOICES.map((choice) => (
                <Button key={choice.when} size="sm" variant="outline" disabled={busy} onClick={() => void act("snooze", { until: choice.when })}>
                  {choice.label}
                </Button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setSnoozing(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="jf-cd-actions">
              {composing ? (
                <Button size="sm" disabled={busy || !draft.trim()} onClick={() => sendText(draft)}>
                  {draft.trim() === suggested.trim() && suggested ? "Send suggested reply" : "Send"}
                  <kbd>⌘↵</kbd>
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={busy} onClick={reply}>
                  Reply…
                </Button>
              )}
              <span className="jf-cd-spacer" />
              <IconButton icon="Clock" label="Snooze" hint="s" disabled={busy} onClick={() => setSnoozing(true)} />
              <IconButton icon="Columns2" label="Open the thread beside this" hint="o" onClick={() => openThread(item.threadId)} />
              <IconButton icon="Check" label="Done: take it off the briefing" hint="e" disabled={busy} onClick={() => void act("dismiss")} />
            </div>
          )}
          {error && <p role="alert" className="jf-cd-error">{error}</p>}
        </div>
      )}
    </li>
  );
}

/** A quiet icon action with a tooltip naming it and its key. */
function IconButton({ icon, label, hint, disabled, onClick }: { icon: string; label: string; hint: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`${buttonVariants({ variant: "ghost", size: "icon" })} jf-cd-icon`}
      title={`${label} (${hint})`}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <Icon name={icon} />
    </button>
  );
}

// --- threads and activity -------------------------------------------------------

function Fleet({ rows }: { rows: ConductorFleetRow[] | null }) {
  const openThread = useOpenThread();
  if (rows === null) return <p className="jf-cd-muted jf-cd-loading">Loading…</p>;
  if (rows.length === 0) return <EmptyNote icon="ListView" title="No threads in this workspace" />;
  const groups: Array<[string, ConductorFleetRow[]]> = [
    ["Needs you", rows.filter((row) => row.needsYou)],
    ["Everything else", rows.filter((row) => !row.needsYou)],
  ];
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
