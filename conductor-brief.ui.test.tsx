import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ConductorBriefStrip, DoneForYouSection, feedSummary } from "./conductor-brief";
import type { ConductorBrief, ConductorFeed } from "./server";

const NOW = Date.now();

const brief: ConductorBrief = {
  workspaceId: "ws",
  threadId: "thr_b",
  at: NOW,
  item: { threadId: "thr_b", kind: "decision", headline: "Pick a chart library", summary: "Two fit.", recommendation: "Option 2: smaller bundle", reply: "2" },
};

const feed: ConductorFeed = {
  since: NOW - 3_600_000,
  merged: 2,
  archived: 1,
  forwarded: 1,
  refused: 0,
  wakeupsSpared: 5,
  tokensSpared: 7_400_000,
  entries: [
    { id: 3, at: NOW - 60_000, kind: "auto-archived", workspaceId: "ws", workspace: "Web", threadId: "thr_a", title: "Fix billing export", text: "web-app#12 merged and nothing else was open, so the thread is archived.", savedTokens: 1_200_000 },
    { id: 2, at: NOW - 120_000, kind: "auto-merged", workspaceId: "ws", workspace: "Web", threadId: "thr_a", title: "Fix billing export", text: "Merged web-app#12 once it was green.", savedTokens: 1_500_000 },
  ],
};

afterEach(() => cleanup());

describe("the conductor where you already work", () => {
  it("puts its brief on the thread's Catch up card, with a one-click answer", async () => {
    const slot = renderSlot({ component: () => <ConductorBriefStrip threadId="thr_b" /> }, {}, {
      settings: { conductor: true },
      rpc: { conductor_briefs: () => ({ briefs: [brief] }), conductor_card: () => ({ done: "ok" }) } as never,
      realtimeConnectionState: "connected",
    });
    await waitFor(() => expect(slot.container.textContent).toContain("Pick a chart library"));
    expect(slot.container.textContent).toContain("Option 2: smaller bundle");
    fireEvent.click(slot.getByRole("button", { name: "Send “2”" }));
    await waitFor(() =>
      expect(slot.rpcCalls.find((call) => call.method === "conductor_card")?.input).toEqual({ workspaceId: "ws", threadId: "thr_b", action: "go" }),
    );
    await waitFor(() => expect(slot.container.textContent).not.toContain("Pick a chart library"));
  });

  it("its icon opens the conductor, for the whole briefing and conversation", async () => {
    const slot = renderSlot({ component: () => <ConductorBriefStrip threadId="thr_b" /> }, {}, {
      settings: { conductor: true },
      rpc: { conductor_briefs: () => ({ briefs: [brief] }) } as never,
      realtimeConnectionState: "connected",
    });
    await waitFor(() => expect(slot.container.textContent).toContain("Pick a chart library"));
    fireEvent.click(slot.getByRole("button", { name: "Open the conductor" }));
    expect(slot.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "conductor", options: { subPath: "ws" } });
  });

  it("shows nothing for a thread without a brief, or with the conductor off", async () => {
    const other = renderSlot({ component: () => <ConductorBriefStrip threadId="thr_x" /> }, {}, {
      settings: { conductor: true },
      rpc: { conductor_briefs: () => ({ briefs: [brief] }) } as never,
      realtimeConnectionState: "connected",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(other.container.textContent).toBe("");
    cleanup();
    const off = renderSlot({ component: () => <ConductorBriefStrip threadId="thr_b" /> }, {}, {
      settings: { conductor: false },
      rpc: { conductor_briefs: () => ({ briefs: [brief] }) } as never,
      realtimeConnectionState: "connected",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(off.container.textContent).toBe("");
    expect(off.rpcCalls.some((call) => call.method === "conductor_briefs")).toBe(false);
  });

  it("lists what autopilot did today on the home page, with what it spared and an undo", async () => {
    const slot = renderSlot({ component: DoneForYouSection }, {}, {
      settings: { conductor: true },
      rpc: {
        conductor_feed: () => feed,
        conductor_list: () => ({
          enabled: true,
          conductors: [
            { workspaceId: "ws", name: "Web", enabled: true, active: true, threadId: "thr_c", open: 0, undelivered: 0, needsYou: 3 },
            { workspaceId: "off", name: "Api", enabled: false, active: false, threadId: "thr_d", open: 0, undelivered: 0, needsYou: 0 },
          ],
        }),
      } as never,
      sdk: { threads: { unarchive: (async () => ({})) as never } },
      realtimeConnectionState: "connected",
    });
    await waitFor(() => expect(slot.container.textContent).toContain("2 merged · 1 archived · 5 wake-ups spared (≈7.4M tokens)"));
    expect(slot.container.textContent).toContain("Merged web-app#12 once it was green.");
    // Running conductors are a click away, with what each still needs from you.
    await waitFor(() => expect(slot.getByRole("button", { name: "Web3" })).toBeTruthy());
    expect(slot.queryByRole("button", { name: /Api/ })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Web3" }));
    expect(slot.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "conductor", options: { subPath: "ws" } });
    fireEvent.click(slot.getByRole("button", { name: "Unarchive" }));
    await waitFor(() => expect(slot.sdkCalls.some((call) => call.method === "threads.unarchive")).toBe(true));
    fireEvent.click(slot.getAllByRole("button", { name: "Fix billing export" })[0]!);
    expect(slot.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: "thr_a", options: { split: true } });
  });

  it("says so when there's nothing yet", () => {
    expect(feedSummary({ merged: 0, archived: 0, wakeupsSpared: 0, tokensSpared: 0 })).toBe("Nothing yet today");
    expect(feedSummary({ merged: 1, archived: 0, wakeupsSpared: 1, tokensSpared: 0 })).toBe("1 merged · 1 wake-up spared");
  });
});
