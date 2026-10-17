import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { useSdk } from "@get-bb/plugin-sdk/app";
import {
  ActivityCard,
  LiveActivityBanner,
  elapsed,
  type ActivityData,
  type ActivityTask,
} from "./live-activity";

type Timeline = Awaited<
  ReturnType<ReturnType<typeof useSdk>["threads"]["timeline"]>
>;
const task: ActivityTask = {
  id: "task1",
  itemId: "i1",
  kind: "work",
  workKind: "workflow",
  threadId: "t1",
  turnId: null,
  description: "Run scorecard with the fix",
  startedAt: 1000,
  createdAt: 1000,
  completedAt: null,
  status: "pending",
  taskStatus: "running",
  taskType: "local_agent",
  model: "gpt-6.1-sol",
  error: null,
  summary: "Comparing baseline rows",
  sourceSeqStart: 1,
  sourceSeqEnd: 2,
  workflowName: null,
  usage: { durationMs: 1000, toolUses: 7, totalTokens: 1250 },
  workflow: {
    phases: [],
    agents: [
      {
        index: 1,
        attempt: 1,
        label: "Verify scorecard",
        state: "running",
        model: "gpt-6.1-sol",
        cached: false,
        lastProgressAt: 2000,
        lastToolName: "exec_command",
        lastToolSummary: "Checking 42 baseline rows",
      },
    ],
  },
};
const data: ActivityData = {
  activeBackgroundCommands: [task],
  activeWorkflows: [],
  rows: [],
  pendingTodos: {
    sourceSeq: 2,
    updatedAt: 2000,
    items: [
      { id: "step1", status: "completed", text: "Apply fix" },
      { id: "step2", status: "in_progress", text: "Run validation" },
    ],
  },
};
const snapshot: Timeline = {
  ...data,
  completedTurnDisplay: "flat",
  activePromptMode: null,
  activeThinking: null,
  contextBoundarySeq: 0,
  goal: null,
  maxSeq: 2,
  modelFallback: null,
  providerCommands: [],
  sessionOptions: null,
  timelinePage: {
    historySnapshot: "test",
    olderCursor: null,
    olderRowsSourceSeqEnd: null,
    returnedSegmentCount: 1,
  },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("shows real descriptions and elapsed time, with model, tool use and workflow details", () => {
  const slot = renderSlot(
    { component: ActivityCard },
    {
      data,
      running: false,
      startedAt: 1000,
      now: 279000,
      updatedAt: 278000,
      connected: true,
    },
  );
  expect(slot.getAllByText("Run scorecard with the fix")[0]).toBeTruthy();
  expect(slot.getByLabelText("Elapsed time").textContent).toBe("4m 38s");
  expect(slot.getByText("1 background agent")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Details" }));
  expect(slot.getByText("7 tool calls")).toBeTruthy();
  expect(slot.getByText("1,250 tokens")).toBeTruthy();
  expect(slot.getByText("Checking 42 baseline rows")).toBeTruthy();
  expect(slot.getByRole("progressbar").getAttribute("value")).toBe("0");
  fireEvent.click(slot.getByRole("button", { name: "Less" }));
  expect(
    slot.getByRole("button", { name: "Details" }).getAttribute("aria-expanded"),
  ).toBe("false");
  slot.lifecycle.unmount();
});

it("stops claiming live updates when disconnected, and renders no idle card", () => {
  const slot = renderSlot(
    { component: ActivityCard },
    {
      data,
      running: false,
      startedAt: 1000,
      now: 2000,
      updatedAt: 1000,
      connected: false,
    },
  );
  expect(slot.getByText("Reconnecting")).toBeTruthy();
  expect(slot.getByText("Showing last received activity")).toBeTruthy();
  slot.lifecycle.unmount();
  const idle = renderSlot(
    { component: ActivityCard },
    {
      data: { ...data, activeBackgroundCommands: [] },
      running: false,
      startedAt: null,
      now: 0,
      updatedAt: 0,
      connected: true,
    },
  );
  expect(idle.queryByRole("region", { name: "Agent activity" })).toBeNull();
  idle.lifecycle.unmount();
});

it("uses event-driven snapshots and unsubscribes/aborts on unmount", async () => {
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((_args: unknown) => unsubscribe);
  const timeline = vi.fn(async () => snapshot);
  const slot = renderSlot(
    { component: LiveActivityBanner },
    { runningSince: { t1: { since: 1000 } } },
    {
      composer: { scope: { kind: "thread", threadId: "t1" }, isRunning: true },
      sdk: { subscribe, threads: { timeline } },
    },
  );
  await slot.findByRole("region", { name: "Agent activity" });
  expect(timeline).toHaveBeenCalledTimes(1);
  expect(subscribe).toHaveBeenCalledWith(
    expect.objectContaining({ event: "thread:changed", threadId: "t1" }),
  );
  const changed = subscribe.mock.calls[0][0] as { callback: () => void };
  await act(async () => {
    changed.callback();
    changed.callback();
    changed.callback();
    await new Promise((resolve) => setTimeout(resolve, 800));
  });
  expect(timeline).toHaveBeenCalledTimes(2);
  const call = timeline.mock.calls[0] as unknown as [{ signal: AbortSignal }];
  slot.lifecycle.unmount();
  expect(call[0].signal.aborted).toBe(true);
  expect(unsubscribe).toHaveBeenCalledTimes(2);
});

it("falls back to native callouts on snapshot failure and never fetches when disabled", async () => {
  const timeline = vi.fn(async (): Promise<Timeline> => {
    throw new Error("offline");
  });
  const slot = renderSlot(
    { component: LiveActivityBanner },
    { runningSince: {} },
    {
      composer: { scope: { kind: "thread", threadId: "t1" }, isRunning: true },
      sdk: { subscribe: () => () => {}, threads: { timeline } },
    },
  );
  await waitFor(() => expect(timeline).toHaveBeenCalledTimes(1));
  expect(slot.queryByRole("region", { name: "Agent activity" })).toBeNull();
  slot.lifecycle.unmount();
  timeline.mockClear();
  const disabled = renderSlot(
    { component: LiveActivityBanner },
    { runningSince: {} },
    {
      settings: { polishShell: false },
      composer: { scope: { kind: "thread", threadId: "t1" }, isRunning: true },
      sdk: { threads: { timeline } },
    },
  );
  expect(timeline).not.toHaveBeenCalled();
  disabled.lifecycle.unmount();
});

it("formats time without negative values or invented percentages", () => {
  expect(elapsed(-1000)).toBe("0s");
  expect(elapsed(61000)).toBe("1m 1s");
  expect(elapsed(3661000)).toBe("1h 1m");
});

it("shows workflows without a primary run and deduplicates shared task rows", () => {
  const workflow = {
    ...task,
    id: "wf1",
    taskType: "workflow",
    workflowName: "Scorecard",
  };
  const slot = renderSlot(
    { component: ActivityCard },
    {
      data: {
        ...data,
        activeBackgroundCommands: [workflow],
        activeWorkflows: [workflow],
      },
      running: false,
      startedAt: 1000,
      now: 2000,
      updatedAt: 2000,
      connected: true,
    },
  );
  expect(slot.getByText("1 workflow")).toBeTruthy();
  expect(slot.queryByText("1 command")).toBeNull();
  slot.lifecycle.unmount();
});

it("distinguishes stopping and waiting from active execution", () => {
  for (const phase of ["waiting", "stopping"] as const) {
    const slot = renderSlot(
      { component: ActivityCard },
      {
        data,
        running: true,
        startedAt: 1000,
        now: 2000,
        updatedAt: 2000,
        connected: true,
        phase,
      },
    );
    expect(
      slot.getByText(
        phase === "waiting" ? "Waiting for your input" : "Stopping agent…",
      ),
    ).toBeTruthy();
    expect(
      slot
        .getByRole("region", { name: "Agent activity" })
        .getAttribute("data-active"),
    ).toBe("false");
    slot.lifecycle.unmount();
  }
});
