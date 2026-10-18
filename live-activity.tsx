import { useEffect, useId, useState } from "react";
import {
  useComposer,
  useRpc,
  useSdk,
  useSettings,
  useRealtimeConnectionState,
  UrlLink,
  experimental_useSidebarThreadPullRequest as useBranchPr,
  experimental_useSidebarThreads as useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import "./live-activity.css";
import { useMonitorCollapse } from "./monitor-collapse";
import type { rpcContract } from "./server";
import type { ThreadStatus } from "./thread-status";
import { statusPrompt } from "./status-prompt";

type Sdk = ReturnType<typeof useSdk>;
type Timeline = Awaited<ReturnType<Sdk["threads"]["timeline"]>>;
export type ActivityTask = Timeline["activeBackgroundCommands"][number];
export type ActivityData = Pick<
  Timeline,
  | "activeBackgroundCommands"
  | "activeWorkflows"
  | "rows"
  | "pendingTodos"
  | "goal"
  | "contextWindowUsage"
>;
export type ActivityPr = {
  number: number;
  title: string;
  url: string;
  state: string;
  attention: string;
};

function Meter({
  label,
  value,
  max,
  text,
  kind = "plan",
}: {
  label: string;
  value: number;
  max: number;
  text: string;
  kind?: "plan" | "workflow" | "budget" | "context";
}) {
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(value) || value < 0)
    return null;
  return (
    <div
      className="jf-live-meter"
      data-kind={kind}
      data-high={value / max >= 0.9}
    >
      <div>
        <span>{label}</span>
        <strong>{text}</strong>
      </div>
      <progress aria-label={label} max={max} value={Math.min(value, max)} />
    </div>
  );
}

function PrLink({ pr }: { pr: ActivityPr }) {
  let safe = false;
  try {
    safe = ["https:", "http:"].includes(new URL(pr.url).protocol);
  } catch {
    /* Invalid links stay inert. */
  }
  if (!safe) return null;
  const label =
    pr.state === "merged"
      ? "Merged"
      : pr.state === "closed"
        ? "Closed"
        : pr.state === "draft"
          ? "Draft"
          : pr.attention === "none"
            ? "Open"
            : pr.attention.replaceAll("_", " ");
  return (
    <UrlLink
      className="jf-live-pr"
      href={pr.url}
      title={pr.title}
      data-state={pr.state}
      data-attention={pr.attention}
    >
      <Icon
        name={pr.state === "merged" ? "GitMerge" : "GitPullRequest"}
        className="size-3.5"
      />
      #{pr.number}
      <span>{label}</span>
    </UrlLink>
  );
}

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function useActivity(threadId: string, enabled: boolean) {
  const sdk = useSdk();
  const [result, setResult] = useState<{
    threadId: string;
    data: ActivityData;
    updatedAt: number;
  } | null>(null);
  useEffect(() => {
    if (!enabled) {
      setResult(null);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight = false;
    let again = false;
    const refresh = async () => {
      if (controller.signal.aborted) return;
      if (inflight) {
        again = true;
        return;
      }
      inflight = true;
      try {
        const data = await sdk.threads.timeline({
          threadId,
          segmentLimit: "1",
          deferContent: "true",
          includeNestedRows: "false",
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setResult({ threadId, data, updatedAt: Date.now() });
        }
      } catch {
        if (!controller.signal.aborted) {
          setResult(null);
        }
      } finally {
        inflight = false;
        if (again && !controller.signal.aborted) {
          again = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      if (timer || controller.signal.aborted) return;
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, 750);
    };
    // One bounded snapshot on mount; subsequent snapshots follow real events.
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: schedule,
    });
    const reconnect = sdk.subscribe({
      event: "realtime:connection",
      callback: (event) => {
        if (event.state === "connected") schedule();
      },
    });
    void refresh();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      unsubscribe();
      reconnect();
    };
  }, [sdk, threadId, enabled]);
  return {
    data: result?.threadId === threadId ? result.data : null,
    updatedAt: result?.updatedAt ?? 0,
  };
}

function useThreadStatus(threadId: string, enabled: boolean, running: boolean) {
  const sdk = useSdk();
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<{
    threadId: string;
    snapshot: ThreadStatus | null;
    stale: boolean;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight = false;
    let again = false;
    const refresh = async () => {
      if (disposed) return;
      if (inflight) {
        again = true;
        return;
      }
      inflight = true;
      try {
        const snapshot = await rpc.call("thread_status", {
          threadId,
          refresh: !running,
        });
        if (!disposed)
          setResult({
            threadId,
            snapshot: snapshot?.threadId === threadId ? snapshot : null,
            stale: false,
          });
      } catch {
        if (!disposed)
          setResult((previous) => ({
            threadId,
            snapshot:
              previous?.threadId === threadId ? previous.snapshot : null,
            stale: true,
          }));
      } finally {
        inflight = false;
        if (again && !disposed) {
          again = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      if (disposed || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 750);
    };
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: () => {
        if (!running) schedule();
      },
    });
    const reconnect = sdk.subscribe({
      event: "realtime:connection",
      callback: (event) => {
        if (event.state === "connected") schedule();
      },
    });
    void refresh();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      reconnect();
    };
  }, [sdk, rpc, threadId, enabled, running]);
  return result?.threadId === threadId ? result : null;
}

function taskKind(task: ActivityTask): string {
  if (
    task.taskType === "local_agent" ||
    task.taskType === "local_subagent" ||
    task.taskType.includes("agent")
  )
    return "Agent";
  if (task.workflowName || task.taskType === "workflow") return "Workflow";
  return "Command";
}

function activityTasks(data: ActivityData): ActivityTask[] {
  return [
    ...new Map(
      [...data.activeBackgroundCommands, ...data.activeWorkflows].map(
        (task) => [task.id, task],
      ),
    ).values(),
  ];
}

function currentAction(data: ActivityData): {
  title: string;
  detail: string | null;
} {
  const work = [...data.rows]
    .reverse()
    .find(
      (row) =>
        row.kind === "work" &&
        row.status === "pending" &&
        (row.workKind === "command" ||
          row.workKind === "tool" ||
          row.workKind === "file-change"),
    );
  if (work?.kind === "work") {
    if (work.workKind === "command")
      return { title: "Running a command", detail: work.command };
    if (work.workKind === "tool")
      return {
        title:
          work.presentation?.title ??
          work.presentation?.label.pending ??
          work.toolName,
        detail: work.presentation?.detail ?? null,
      };
    return { title: "Updating files", detail: null };
  }
  const step = data.pendingTodos?.items.find(
    (item) => item.status === "in_progress",
  );
  return { title: step?.text ?? "Working on your request", detail: null };
}

function Task({ task, now }: { task: ActivityTask; now: number }) {
  const agents = task.workflow?.agents ?? [];
  const done = agents.filter(
    (agent) => agent.state === "done" || agent.state === "skipped",
  ).length;
  return (
    <article className="jf-live-task" data-task-state={task.taskStatus}>
      <div className="jf-live-task-top">
        <span className="jf-live-task-kind">
          <Icon
            name={taskKind(task) === "Agent" ? "UserRoundPlus" : "Terminal"}
            className="size-3.5"
          />
          {taskKind(task)}
        </span>
        <span className="jf-live-task-state">{task.taskStatus}</span>
        <time>{elapsed(now - task.startedAt)}</time>
      </div>
      <div className="jf-live-task-title">{task.description}</div>
      {task.summary && <p className="jf-live-task-update">{task.summary}</p>}
      <div className="jf-live-task-meta">
        {task.model && <span>{task.model}</span>}
        {task.usage && (
          <>
            <span>{task.usage.toolUses.toLocaleString()} tool calls</span>
            <span>{task.usage.totalTokens.toLocaleString()} tokens</span>
          </>
        )}
      </div>
      {agents.length > 0 && (
        <>
          <div className="jf-live-progress-label">
            <span>Workflow steps</span>
            <span>
              {done}/{agents.length} complete
            </span>
          </div>
          <progress
            max={agents.length}
            value={done}
            aria-label={`${task.description}: workflow steps complete`}
          />
          <ul className="jf-live-agents">
            {agents.map((agent) => (
              <li
                key={`${agent.index}:${agent.attempt}`}
                data-state={agent.state}
              >
                <span className="jf-live-step-dot" aria-hidden="true" />
                <div>
                  <strong>{agent.label}</strong>
                  <span>
                    {agent.lastToolSummary ??
                      agent.lastToolName ??
                      agent.phaseTitle ??
                      agent.state}
                  </span>
                </div>
                <span>{agent.state}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {task.error && <p className="jf-live-task-error">{task.error}</p>}
    </article>
  );
}

export function ActivityCard({
  data,
  running,
  startedAt,
  now,
  updatedAt,
  connected,
  phase = "working",
  prs = [],
  branchPrUrl,
  onClearGoal,
  idleLabel,
  monitor,
  monitorStale = false,
  hasLiveData = true,
  onRequestStatus,
}: {
  idleLabel?: string;
  monitor?: ThreadStatus | null;
  monitorStale?: boolean;
  hasLiveData?: boolean;
  onRequestStatus?: () => Promise<void>;
  data: ActivityData;
  running: boolean;
  startedAt: number | null;
  now: number;
  updatedAt: number;
  connected: boolean;
  phase?: "working" | "waiting" | "stopping";
  prs?: readonly ActivityPr[];
  branchPrUrl?: string;
  onClearGoal?: () => Promise<void>;
}) {
  const { collapsed, toggle: toggleCollapsed } = useMonitorCollapse();
  const bodyId = useId();
  const [expanded, setExpanded] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [goalError, setGoalError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const detailsId = useId();
  const tasks = activityTasks(data);
  const count = tasks.length;
  const agents = tasks.filter((task) => taskKind(task) === "Agent").length;
  const commands = tasks.filter((task) => taskKind(task) === "Command").length;
  const workflows = tasks.filter(
    (task) => taskKind(task) === "Workflow",
  ).length;
  const action = currentAction(data);
  const primary = tasks[0];
  const todos = data.pendingTodos?.items ?? [];
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const goal = data.goal;
  const context = data.contextWindowUsage;
  const active =
    running ||
    tasks.some(
      (task) => task.taskStatus === "running" || task.taskStatus === "pending",
    );
  const steps = tasks.flatMap((task) => task.workflow?.agents ?? []);
  const finishedSteps = steps.filter(
    (step) => step.state === "done" || step.state === "skipped",
  ).length;
  const title = running
    ? phase === "stopping"
      ? "Stopping agent…"
      : phase === "waiting"
        ? "Waiting for your input"
        : action.title
    : (idleLabel ??
      primary?.description ??
      (goal?.status === "complete"
        ? "Goal complete"
        : goal?.status === "paused"
          ? "Goal paused"
          : goal?.status === "budgetLimited"
            ? "Goal budget reached"
            : goal
              ? "Ready to continue"
              : "Agent idle"));
  return (
    <section
      className="jf-live-card"
      aria-label="Agent activity"
      data-jb-flow-live-activity={hasLiveData ? "" : undefined}
      data-jb-flow-goal={hasLiveData && !!goal && !!onClearGoal}
      data-jb-flow-branch-pr={!!branchPrUrl}
      data-jb-flow-plan={hasLiveData && todos.length > 0}
      data-collapsed={collapsed}
      data-expanded={expanded}
      data-connected={connected}
      data-active={phase === "working" && active}
    >
      <div className="jf-live-heading">
        <span className="jf-live-orbit" aria-hidden="true">
          <Icon name="Zap" className="size-4" />
        </span>
        <div className="jf-live-heading-copy">
          <span className="jf-live-eyebrow">THREAD MONITOR</span>
          <strong className="jf-live-now" title={title}>
            {title}
          </strong>
        </div>
        <span className="jf-live-live">
          <span aria-hidden="true" />
          {connected ? (active ? "Live" : "Idle") : "Reconnecting"}
        </span>
        {active && startedAt !== null && (
          <time className="jf-live-elapsed" aria-label="Elapsed time">
            {elapsed(now - startedAt)}
          </time>
        )}
        {!collapsed && (
          <button
            type="button"
            className="jf-live-toggle"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Less" : "Details"}
            <Icon
              name={expanded ? "ChevronUp" : "ChevronDown"}
              className="size-3.5"
            />
          </button>
        )}
        <button
          type="button"
          className="jf-live-toggle jf-monitor-collapse"
          aria-label={collapsed ? "Expand monitor" : "Collapse monitor"}
          title={collapsed ? "Expand monitor" : "Collapse monitor"}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={toggleCollapsed}
        >
          <Icon
            name={collapsed ? "ChevronDown" : "ChevronUp"}
            className="size-4"
          />
        </button>
      </div>
      <div id={bodyId} hidden={collapsed} className="jf-monitor-body">
        {goal && !((!active || expanded) && monitor?.report) && (
          <div className="jf-live-goal">
            <Icon name="Target" className="size-3.5" />
            <p title={goal.objective}>{goal.objective}</p>
          </div>
        )}
        {(!active || expanded) && (
          <div className="jf-monitor-report">
            {monitor?.report ? (
              <>
                <div className="jf-monitor-caption">
                  Last status report{" "}
                  <time
                    title={new Date(monitor.report.capturedAt).toLocaleString()}
                  >
                    {elapsed(now - monitor.report.capturedAt)} ago
                  </time>
                </div>
                <dl className="jf-monitor-steps">
                  {(
                    [
                      ["Just did", monitor.report.done, "Check"],
                      ["Next step", monitor.report.next, "ArrowRight"],
                      [
                        "Goal",
                        goal?.objective || monitor.report.goal,
                        "Target",
                      ],
                      ["Blocked", monitor.report.blocked, "AlertCircle"],
                    ] as const
                  )
                    .filter(([, text]) => text)
                    .map(([label, text, icon]) => (
                      <div
                        key={label}
                        className="jf-monitor-step"
                        data-field={label}
                      >
                        <dt>
                          <span
                            className="jf-monitor-step-icon"
                            aria-hidden="true"
                          >
                            <Icon name={icon} className="size-3" />
                          </span>
                          <span>{label}</span>
                        </dt>
                        <dd>{text}</dd>
                      </div>
                    ))}
                </dl>
                {monitor.report.milestones.length > 0 && (
                  <div className="jf-monitor-milestones">
                    {monitor.report.milestones
                      .slice(0, expanded ? 12 : 3)
                      .map((milestone, index) => (
                        <Meter
                          key={`${index}:${milestone.label}`}
                          label={milestone.label}
                          value={milestone.percent}
                          max={100}
                          text={`${Math.round(milestone.percent)}%`}
                        />
                      ))}
                    {!expanded && monitor.report.milestones.length > 3 && (
                      <span className="jf-monitor-caption">
                        +{monitor.report.milestones.length - 3} milestones in
                        Details
                      </span>
                    )}
                  </div>
                )}
              </>
            ) : monitor?.latest ? (
              <>
                <div className="jf-monitor-caption">
                  Latest reply{" "}
                  <time title={new Date(monitor.latestAt).toLocaleString()}>
                    {elapsed(now - monitor.latestAt)} ago
                  </time>
                </div>
                <p className="jf-monitor-latest">{monitor.latest}</p>
              </>
            ) : (
              <p className="jf-monitor-empty">
                Ready when you are. Request a status report for Goal, Done,
                Next, Blocked and milestone progress.
              </p>
            )}
            {monitorStale && (
              <p className="jf-monitor-caption" role="status">
                {monitor
                  ? "Status refresh unavailable · showing saved information"
                  : "Status unavailable · try again when connected"}
              </p>
            )}
          </div>
        )}
        {!hasLiveData && (
          <p className="jf-monitor-caption">Live activity unavailable</p>
        )}
        {running && action.detail && (
          <div className="jf-live-action" title={action.detail}>
            {action.detail}
          </div>
        )}
        {!running && primary?.summary && (
          <p className="jf-live-summary">{primary.summary}</p>
        )}
        <div className="jf-live-meters">
          {active &&
            phase === "working" &&
            todos.length === 0 &&
            steps.length === 0 &&
            !(goal?.tokenBudget && goal.tokenBudget > 0) &&
            !(context && context.modelContextWindow > 0) && (
              <div className="jf-live-meter">
                <div>
                  <span>Live activity</span>
                  <strong>In progress</strong>
                </div>
                <div
                  className="jf-live-indeterminate"
                  role="progressbar"
                  aria-label="Live activity in progress"
                >
                  <span />
                </div>
              </div>
            )}
          {todos.length > 0 && (
            <Meter
              label="Plan complete"
              value={completed}
              max={todos.length}
              text={`${completed}/${todos.length}`}
            />
          )}
          {steps.length > 0 && (
            <Meter
              label="Workflow steps finished"
              kind="workflow"
              value={finishedSteps}
              max={steps.length}
              text={`${finishedSteps}/${steps.length}`}
            />
          )}
          {goal?.tokenBudget != null && (
            <Meter
              label="Goal token budget used"
              kind="budget"
              value={goal.tokensUsed}
              max={goal.tokenBudget}
              text={`${Math.round((goal.tokensUsed / goal.tokenBudget) * 100)}%`}
            />
          )}
          {context && (
            <Meter
              kind="context"
              label={
                context.estimated ? "Context used · estimated" : "Context used"
              }
              value={context.usedTokens}
              max={context.modelContextWindow}
              text={`${Math.round((context.usedTokens / context.modelContextWindow) * 100)}%`}
            />
          )}
        </div>
        {!active && onRequestStatus && (
          <div className="jf-monitor-controls">
            <button
              type="button"
              disabled={requesting}
              onClick={async () => {
                setRequesting(true);
                setStatusError(null);
                try {
                  await onRequestStatus();
                } catch {
                  setStatusError("Could not request status. Try again.");
                } finally {
                  setRequesting(false);
                }
              }}
            >
              {requesting ? "Requesting…" : "Update status"}
            </button>
            <span>Sends the status report prompt (Settings → JB Flow)</span>
            {statusError && <p role="alert">{statusError}</p>}
          </div>
        )}
        <div className="jf-live-footer">
          <div className="jf-live-badges">
            {agents > 0 && (
              <span>
                {agents} background agent{agents === 1 ? "" : "s"}
              </span>
            )}
            {commands > 0 && (
              <span>
                {commands} command{commands === 1 ? "" : "s"}
              </span>
            )}
            {workflows > 0 && (
              <span>
                {workflows} workflow{workflows === 1 ? "" : "s"}
              </span>
            )}
            {!running && primary?.model && <span>{primary.model}</span>}
            {goal && (
              <span className="jf-live-goal-usage">
                {goal.tokensUsed.toLocaleString()} tokens ·{" "}
                {elapsed(goal.timeUsedSeconds * 1000)} goal runtime
              </span>
            )}
            {prs.slice(0, expanded ? prs.length : 2).map((pr) => (
              <PrLink key={pr.url} pr={pr} />
            ))}
            {!expanded && prs.length > 2 && (
              <button
                type="button"
                className="jf-live-pr-more"
                onClick={() => setExpanded(true)}
              >
                +{prs.length - 2} PRs
              </button>
            )}
          </div>
          {hasLiveData && (!connected || now - updatedAt > 10000) && (
            <span className="jf-live-freshness">
              {connected
                ? `Updated ${elapsed(now - updatedAt)} ago`
                : "Showing last received activity"}
            </span>
          )}
        </div>
        <div id={detailsId} hidden={!expanded} className="jf-live-details">
          {monitor?.report && monitor.latestAt > monitor.report.capturedAt && (
            <div className="jf-live-summary">
              <span className="jf-live-eyebrow">LATEST REPLY</span>
              <p>{monitor.latest}</p>
            </div>
          )}

          {running && action.detail && (
            <div className="jf-live-current-details">
              <span className="jf-live-eyebrow">CURRENT ACTION</span>
              <pre>{action.detail}</pre>
            </div>
          )}
          {goal && (
            <div className="jf-live-goal-details">
              <div>
                <span className="jf-live-eyebrow">
                  GOAL ·{" "}
                  {goal.status === "budgetLimited"
                    ? "budget limited"
                    : goal.status}
                </span>
                {onClearGoal && (
                  <button
                    type="button"
                    className="jf-live-toggle"
                    disabled={clearing}
                    onClick={async () => {
                      setClearing(true);
                      setGoalError(null);
                      try {
                        await onClearGoal();
                      } catch (error) {
                        setGoalError(
                          error instanceof Error
                            ? error.message
                            : String(error),
                        );
                      } finally {
                        setClearing(false);
                      }
                    }}
                  >
                    {clearing ? "Clearing…" : "Clear goal"}
                  </button>
                )}
              </div>
              <p>{goal.objective}</p>
              {goalError && (
                <p className="jf-live-task-error" role="alert">
                  {goalError}
                </p>
              )}
            </div>
          )}
          {count > 0 ? (
            tasks.map((task) => <Task key={task.id} task={task} now={now} />)
          ) : (
            <p className="jf-live-empty">
              {running
                ? "The primary agent is active. Background tasks will appear here when started."
                : "No background tasks running."}
            </p>
          )}
          {todos.length > 0 && (
            <div className="jf-live-plan">
              <span className="jf-live-eyebrow">CURRENT PLAN</span>
              <ol>
                {todos.map((todo) => (
                  <li key={todo.id} data-state={todo.status}>
                    <Icon
                      name={
                        todo.status === "completed"
                          ? "Check"
                          : todo.status === "in_progress"
                            ? "Loader"
                            : "Circle"
                      }
                      className="size-3.5"
                    />
                    {todo.text}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
        <div className="jf-live-signal" aria-hidden="true">
          <span />
        </div>
      </div>
    </section>
  );
}

export function LiveActivityBanner({
  runningSince,
  trackedPrs = {},
  watches = {},
}: {
  runningSince: Record<string, { since: number }>;
  trackedPrs?: Record<string, readonly ActivityPr[]>;
  watches?: Record<string, { label: string }>;
}) {
  const sdk = useSdk();
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const { values } = useSettings();
  const { threads } = useSidebarThreads();
  const scope = composer.scope;
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const { pullRequest } = useBranchPr(threadId ?? "");
  const thread = threads.find((thread) => thread.id === threadId);
  const running =
    composer.isRunning ||
    thread?.status === "active" ||
    thread?.status === "starting" ||
    thread?.status === "stopping";
  const enabled =
    !!threadId && values?.threadMonitor === true && !thread?.isArchived;
  const { data, updatedAt } = useActivity(threadId ?? "", enabled);
  const monitor = useThreadStatus(threadId ?? "", enabled, running);
  const connection = useRealtimeConnectionState();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  if (!enabled || !threadId) return null;
  const activity = data ?? {
    activeBackgroundCommands: [],
    activeWorkflows: [],
    rows: [],
    pendingTodos: null,
    goal: null,
  };
  const tasks = activityTasks(activity);
  const taskStart =
    tasks.length > 0 ? Math.min(...tasks.map((task) => task.startedAt)) : null;
  const prs = [...(trackedPrs[threadId] ?? [])];
  if (pullRequest) {
    const index = prs.findIndex((pr) => pr.url === pullRequest.url);
    if (index < 0) prs.push(pullRequest);
    else prs[index] = pullRequest;
  }
  return (
    <ActivityCard
      key={threadId}
      data={activity}
      hasLiveData={!!data}
      idleLabel={
        thread?.status === "error"
          ? "Agent needs attention"
          : thread?.hasPendingInteraction
            ? "Waiting for your input"
            : watches[threadId]
              ? `Waiting · ${watches[threadId].label}`
              : undefined
      }
      monitor={monitor?.snapshot}
      monitorStale={monitor?.stale}
      onRequestStatus={async () => {
        await rpc.call("thread_reply", { threadId, text: statusPrompt(values?.statusPrompt) });
      }}
      running={running}
      startedAt={runningSince[threadId]?.since ?? taskStart}
      now={now}
      updatedAt={updatedAt}
      connected={connection === "connected"}
      prs={prs}
      branchPrUrl={pullRequest?.url}
      onClearGoal={
        thread && !thread.isArchived
          ? async () => {
              await sdk.threads.clearGoal({ threadId });
            }
          : undefined
      }
      phase={
        thread?.status === "stopping"
          ? "stopping"
          : thread?.hasPendingInteraction
            ? "waiting"
            : "working"
      }
    />
  );
}
