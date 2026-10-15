import { useEffect, useRef, useState } from "react";
import {
  ThreadChat,
  ThreadTitle,
  UrlLink,
  experimental_useAppPanel as useAppPanel,
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useSidebarThreadPullRequest as useBranchPr,
  useBbNavigate,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FlowState } from "./server";
import {
  PullRequestsPanel,
  attentionLabel,
  duration,
  useNow,
} from "./ui-extras";
import { STATUS_LABEL, studioStatus, studioThreads } from "./studio-model";
import type { StudioFilter } from "./studio-model";
import "./studio.css";

export const STUDIO_REVIEW_TAB = {
  id: "studio-review",
  panelId: "studio",
  title: "Review",
  icon: "GitPullRequest",
  layout: "padded",
} as const;

function selectedId(subPath: string): string | null {
  const match = /^thread\/([^/]+)$/.exec(subPath);
  return match?.[1] ?? null;
}

function Status({
  thread,
  state,
}: {
  thread: PluginSidebarThread;
  state: FlowState | null;
}) {
  const status = studioStatus(thread, state);
  return (
    <span className={`jf-studio-status jf-studio-status--${status}`}>
      <span aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

function activity(
  thread: PluginSidebarThread,
  state: FlowState | null,
  now: number,
): string {
  const status = studioStatus(thread, state);
  if (status === "attention")
    return (
      thread.indicatorLabel ?? "A decision or follow-up needs your attention"
    );
  if (status === "running") {
    const since = state?.running[thread.id]?.since;
    return since ? `Agent working · ${duration(now - since)}` : "Agent working";
  }
  if (state?.watching[thread.id]) return state.watching[thread.id].label;
  const prs = state?.threadPrs[thread.id] ?? [];
  if (status === "review") return "Linked pull request ready to merge";
  if (status === "done") return "Linked pull requests merged or closed";
  if (prs.some((pr) => pr.state === "open"))
    return `${prs.filter((pr) => pr.state === "open").length} open pull request${prs.filter((pr) => pr.state === "open").length === 1 ? "" : "s"}`;
  if (state?.snoozes[thread.id]) return "Snoozed · will return when due";
  if (state?.waitingOthers[thread.id] !== undefined)
    return "Waiting for someone else";
  return thread.environment?.branchName ?? "Ready when you are";
}

export function Studio({
  subPath,
  state,
}: {
  subPath: string;
  state: FlowState | null;
}) {
  const { threads, projects, status } = useSidebarThreads();
  const navigate = useBbNavigate();
  const connection = useRealtimeConnectionState();
  const panel = useAppPanel();
  const now = useNow();
  const [project, setProject] = useState("all");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StudioFilter>("all");
  const [compact, setCompact] = useState(false);
  const [limit, setLimit] = useState(40);
  const search = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = selectedId(subPath);
  const selected = threads.find(
    (thread) => thread.id === id && !thread.isHidden && !thread.isArchived,
  );
  const scoped = studioThreads(threads, state, {
    project,
    query: "",
    filter: "all",
  });
  const visible = studioThreads(threads, state, { project, query, filter });
  const count = (kind: StudioFilter) =>
    kind === "all"
      ? scoped.length
      : scoped.filter((thread) => studioStatus(thread, state) === kind).length;

  useEffect(() => {
    setLimit(40);
  }, [project, query, filter]);
  useEffect(() => {
    heading.current?.focus();
  }, [id]);

  if (id)
    return (
      <div className="jf-studio jf-studio-workspace">
        <div className="jf-studio-workspace-header">
          <button
            className="jf-studio-button"
            onClick={() => navigate.toPluginPanel("studio")}
          >
            <span aria-hidden="true">←</span> Overview
          </button>
          {selected && (
            <>
              <div className="jf-studio-workspace-title">
                <span className="jf-studio-eyebrow">
                  {projects.find((item) => item.id === selected.projectId)
                    ?.name ?? "Project"}
                </span>
                <h1 ref={heading} tabIndex={-1}>
                  <ThreadTitle threadId={selected.id} />
                </h1>
              </div>
              <div className="jf-studio-workspace-actions">
                <Status thread={selected} state={state} />
                <button
                  className="jf-studio-button"
                  onClick={() =>
                    panel.openFixedTab({
                      surface: { kind: "current" },
                      tab: STUDIO_REVIEW_TAB,
                    })
                  }
                >
                  Review ↗
                </button>
                <UrlLink className="jf-studio-button" href={selected.href}>
                  Open thread ↗
                </UrlLink>
              </div>
            </>
          )}
        </div>
        {selected ? (
          <>
            <div className="jf-studio-activity">
              <span
                className={`jf-studio-dot ${studioStatus(selected, state) === "running" ? "jf-studio-dot--working" : ""}`}
                aria-hidden="true"
              />
              {activity(selected, state, now)}
              {selected.host && (
                <span className="jf-studio-machine">{selected.host.name}</span>
              )}
            </div>
            <div className="jf-studio-chat">
              <ThreadChat
                key={selected.id}
                threadId={selected.id}
                variant="full"
                layout="contained"
              />
            </div>
          </>
        ) : (
          <div className="jf-studio-empty" role="status">
            <h2>
              {status === "loading"
                ? "Loading workspace…"
                : "Thread unavailable"}
            </h2>
            <p>
              {status === "loading"
                ? "Connecting to your threads."
                : "It may have been archived, removed, or hidden. Return to the overview to choose another thread."}
            </p>
          </div>
        )}
      </div>
    );

  return (
    <div
      className={`jf-studio ${compact ? "jf-studio--compact" : ""}`}
      onKeyDown={(event) => {
        if (
          event.key === "/" &&
          !(event.target instanceof HTMLInputElement) &&
          !(event.target instanceof HTMLSelectElement) &&
          !(event.target instanceof HTMLTextAreaElement) &&
          !(
            event.target instanceof HTMLElement &&
            event.target.isContentEditable
          )
        ) {
          event.preventDefault();
          search.current?.focus();
        }
      }}
    >
      <div className="jf-studio-overview">
        <header className="jf-studio-hero">
          <div>
            <span className="jf-studio-eyebrow">YOUR WORK, IN FOCUS</span>
            <h1 ref={heading} tabIndex={-1}>
              Room to think.
              <br />
              <span>Space to build.</span>
            </h1>
            <p>
              A clear view of what’s moving, what’s ready,
              <br className="jf-studio-desktop-break" /> and where you can make
              a difference.
            </p>
          </div>
          <div className="jf-studio-hero-actions">
            <span className="jf-studio-connection" role="status">
              <span
                className={`jf-studio-dot ${connection === "connected" ? "jf-studio-dot--live" : ""}`}
                aria-hidden="true"
              />
              {connection === "connected"
                ? "Live workspace"
                : connection === "reconnecting"
                  ? "Reconnecting…"
                  : "Connecting…"}
            </span>
            <button
              className="jf-studio-primary"
              onClick={() =>
                navigate.toCompose({
                  projectId: project === "all" ? undefined : project,
                  focusPrompt: true,
                })
              }
            >
              <span aria-hidden="true">＋</span> New thread
            </button>
          </div>
        </header>
        <div
          className="jf-studio-metrics"
          aria-label="Filter threads by status"
        >
          {(
            [
              {
                key: "attention",
                title: "Needs you",
                detail: "Decisions & follow-ups",
                symbol: "↗",
              },
              {
                key: "running",
                title: "In motion",
                detail: "Agents at work",
                symbol: "◌",
              },
              {
                key: "review",
                title: "Ready to merge",
                detail: "Linked PRs ready",
                symbol: "✓",
              },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              className={`jf-studio-metric jf-studio-metric--${item.key} ${filter === item.key ? "is-selected" : ""}`}
              aria-pressed={filter === item.key}
              onClick={() => setFilter(filter === item.key ? "all" : item.key)}
            >
              <span className="jf-studio-metric-label">
                <span aria-hidden="true">{item.symbol}</span>
                {item.title}
              </span>
              <strong>{status === "loading" ? "—" : count(item.key)}</strong>
              <span className="jf-studio-metric-detail">{item.detail}</span>
            </button>
          ))}
        </div>
        <section
          className="jf-studio-threads"
          aria-labelledby="jf-studio-threads-heading"
        >
          <div className="jf-studio-section-heading">
            <div>
              <h2 id="jf-studio-threads-heading">
                Your threads <span>{scoped.length}</span>
              </h2>
              <p>Attention first. Everything else in its place.</p>
            </div>
            <div className="jf-studio-controls">
              <select
                aria-label="Filter by project"
                value={project}
                onChange={(event) => setProject(event.target.value)}
              >
                <option value="all">All projects</option>
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <button
                className="jf-studio-button jf-studio-density"
                aria-pressed={compact}
                onClick={() => setCompact(!compact)}
              >
                {compact ? "Comfortable" : "Compact"}
              </button>
            </div>
          </div>
          <div className="jf-studio-toolbar">
            <div className="jf-studio-filters" aria-label="Thread filters">
              {(["all", "attention", "running", "review"] as const).map(
                (kind) => (
                  <button
                    key={kind}
                    aria-pressed={filter === kind}
                    className={filter === kind ? "is-selected" : ""}
                    onClick={() => setFilter(kind)}
                  >
                    {kind === "all"
                      ? "All threads"
                      : kind === "running"
                        ? "Working"
                        : kind === "review"
                          ? "Ready"
                          : "Needs you"}
                  </button>
                ),
              )}
            </div>
            <label className="jf-studio-search">
              <span aria-hidden="true">⌕</span>
              <input
                ref={search}
                type="search"
                aria-label="Search thread titles"
                placeholder="Find a thread…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <kbd aria-hidden="true">/</kbd>
            </label>
          </div>
          {status === "error" ? (
            <div role="alert" className="jf-studio-empty">
              <h3>Couldn’t load your threads</h3>
              <p>Check your connection and reopen Studio to try again.</p>
            </div>
          ) : status === "loading" ? (
            <div className="jf-studio-empty" role="status">
              <h3>Getting your workspace ready…</h3>
              <p>Your threads will appear here.</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="jf-studio-empty" role="status">
              <span className="jf-studio-empty-symbol" aria-hidden="true">
                ◇
              </span>
              <h3>
                {query
                  ? "No matching threads"
                  : filter === "attention"
                    ? "A little room to breathe."
                    : "Nothing here yet."}
              </h3>
              <p>
                {query
                  ? "Try another title or a different project."
                  : filter === "attention"
                    ? "No threads in this view need your attention."
                    : "Start a thread or choose another view."}
              </p>
              {(query || filter !== "all") && (
                <button
                  className="jf-studio-button"
                  onClick={() => {
                    setQuery("");
                    setFilter("all");
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="jf-studio-thread-list">
              {visible.slice(0, limit).map((thread) => (
                <button
                  key={thread.id}
                  className={`jf-studio-thread jf-studio-thread--${studioStatus(thread, state)}`}
                  onClick={() =>
                    navigate.toPluginPanel("studio", {
                      subPath: `thread/${thread.id}`,
                    })
                  }
                >
                  <span className="jf-studio-thread-mark" aria-hidden="true">
                    {studioStatus(thread, state) === "running"
                      ? "◌"
                      : studioStatus(thread, state) === "done"
                        ? "✓"
                        : "◇"}
                  </span>
                  <span className="jf-studio-thread-copy">
                    <span
                      className={`jf-studio-thread-title ${thread.isUnread ? "is-unread" : ""}`}
                    >
                      <ThreadTitle threadId={thread.id} />
                    </span>
                    <span className="jf-studio-thread-activity">
                      {activity(thread, state, now)}
                    </span>
                  </span>
                  <span className="jf-studio-project">
                    {projects.find((item) => item.id === thread.projectId)
                      ?.name ?? "Project"}
                  </span>
                  <Status thread={thread} state={state} />
                  <span
                    className="jf-studio-age"
                    title={new Date(thread.updatedAt).toLocaleString()}
                  >
                    {duration(Math.max(0, now - thread.updatedAt))}
                  </span>
                  <span className="jf-studio-thread-arrow" aria-hidden="true">
                    ↗
                  </span>
                </button>
              ))}
            </div>
          )}
          {visible.length > limit && (
            <button
              className="jf-studio-more"
              onClick={() => setLimit(limit + 40)}
            >
              Show more · {visible.length - limit} remaining
            </button>
          )}
        </section>
        <footer className="jf-studio-footer">
          <span>
            JB FLOW <span aria-hidden="true">/</span> STUDIO
          </span>
          <span>
            {state ? "Connected to your workflow" : "Syncing workflow details…"}
          </span>
        </footer>
      </div>
    </div>
  );
}

export function StudioReview({
  subPath,
  state,
}: {
  subPath: string;
  state: FlowState | null;
}) {
  const id = selectedId(subPath);
  return id ? (
    <StudioThreadReview key={id} threadId={id} state={state} />
  ) : (
    <div className="jf-studio-review-empty">
      <span className="jf-studio-eyebrow">THE FINISHING ROOM</span>
      <h2>
        Good work deserves
        <br />a closer look.
      </h2>
      <p>Open a thread to review its linked pull requests and checks here.</p>
      <p>Previews, files, and terminals are available in BB’s panel tabs.</p>
    </div>
  );
}

function StudioThreadReview({
  threadId,
  state,
}: {
  threadId: string;
  state: FlowState | null;
}) {
  const { pullRequest } = useBranchPr(threadId);
  const { threads } = useSidebarThreads();
  const thread = threads.find(
    (item) => item.id === threadId && !item.isArchived && !item.isHidden,
  );
  return (
    <div className="jf-studio-review">
      <span className="jf-studio-eyebrow">REVIEW & SHIP</span>
      <h2>{thread?.displayTitle ?? "Thread review"}</h2>
      {thread?.environment?.branchName && (
        <p className="jf-studio-review-branch">
          {thread.environment.branchName}
        </p>
      )}
      <PullRequestsPanel
        threadId={threadId}
        state={state}
        branchPr={pullRequest}
      />
      {pullRequest && (
        <p className="jf-studio-review-note">
          Branch PR: {attentionLabel(pullRequest.attention)}
        </p>
      )}
    </div>
  );
}
