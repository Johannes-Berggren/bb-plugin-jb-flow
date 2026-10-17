import { useEffect, useId, useState } from "react";
import {
  useComposer,
  useSdk,
  useSettings,
  useRealtimeConnectionState,
  experimental_useSidebarThreads as useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import "./live-activity.css";

type Sdk = ReturnType<typeof useSdk>;
type Timeline = Awaited<ReturnType<Sdk["threads"]["timeline"]>>;
export type ActivityTask = Timeline["activeBackgroundCommands"][number];
export type ActivityData = Pick<
  Timeline,
  "activeBackgroundCommands" | "activeWorkflows" | "rows" | "pendingTodos"
>;

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
  return { title: "Working on your request", detail: null };
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
}: {
  data: ActivityData;
  running: boolean;
  startedAt: number | null;
  now: number;
  updatedAt: number;
  connected: boolean;
  phase?: "working" | "waiting" | "stopping";
}) {
  const [expanded, setExpanded] = useState(false);
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
  const title = running
    ? phase === "stopping"
      ? "Stopping agent…"
      : phase === "waiting"
        ? "Waiting for your input"
        : action.title
    : (primary?.description ?? "Background work in progress");
  if (!running && count === 0) return null;
  return (
    <section
      className="jf-live-card"
      aria-label="Agent activity"
      data-jb-flow-live-activity=""
      data-connected={connected}
      data-active={
        phase === "working" &&
        (running ||
          tasks.some(
            (task) =>
              task.taskStatus === "running" || task.taskStatus === "pending",
          ))
      }
    >
      <div className="jf-live-heading">
        <span className="jf-live-orbit" aria-hidden="true">
          <Icon name="Zap" className="size-4" />
        </span>
        <div className="jf-live-heading-copy">
          <span className="jf-live-eyebrow">AGENT ACTIVITY</span>
          <span className="jf-live-live">
            <span aria-hidden="true" />
            {connected ? "Live" : "Reconnecting"}
          </span>
        </div>
        {startedAt !== null && (
          <time className="jf-live-elapsed" aria-label="Elapsed time">
            {elapsed(now - startedAt)}
          </time>
        )}
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
      </div>
      <div className="jf-live-title">{title}</div>
      {running && action.detail && (
        <div className="jf-live-action" title={action.detail}>
          {action.detail}
        </div>
      )}
      {!running && primary?.summary && (
        <p className="jf-live-summary">{primary.summary}</p>
      )}
      <div className="jf-live-footer">
        <div className="jf-live-badges">
          {running && (
            <span>
              {phase === "stopping"
                ? "Stop requested"
                : phase === "waiting"
                  ? "Your input needed"
                  : "Primary agent working"}
            </span>
          )}
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
          {todos.length > 0 && (
            <span>
              {completed}/{todos.length} plan steps
            </span>
          )}
        </div>
        <span className="jf-live-freshness">
          {connected
            ? `Updated ${elapsed(now - updatedAt)} ago`
            : "Showing last received activity"}
        </span>
      </div>
      <div id={detailsId} hidden={!expanded} className="jf-live-details">
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
    </section>
  );
}

export function LiveActivityBanner({
  runningSince,
}: {
  runningSince: Record<string, { since: number }>;
}) {
  const composer = useComposer();
  const { values } = useSettings();
  const { threads } = useSidebarThreads();
  const scope = composer.scope;
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const thread = threads.find((thread) => thread.id === threadId);
  const running =
    composer.isRunning ||
    thread?.status === "active" ||
    thread?.status === "starting" ||
    thread?.status === "stopping";
  const enabled =
    !!threadId &&
    values?.polishShell !== false &&
    (running ||
      (thread?.activity.backgroundAgents ?? 0) +
        (thread?.activity.backgroundCommands ?? 0) +
        (thread?.activity.workflows ?? 0) >
        0);
  const { data, updatedAt } = useActivity(threadId ?? "", enabled);
  const connection = useRealtimeConnectionState();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  if (!enabled || !threadId || !data) return null;
  const tasks = activityTasks(data);
  const taskStart =
    tasks.length > 0 ? Math.min(...tasks.map((task) => task.startedAt)) : null;
  return (
    <ActivityCard
      key={threadId}
      data={data}
      running={running}
      startedAt={runningSince[threadId]?.since ?? taskStart}
      now={now}
      updatedAt={updatedAt}
      connected={connection === "connected"}
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
