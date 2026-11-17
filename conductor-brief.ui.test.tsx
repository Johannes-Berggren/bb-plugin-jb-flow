import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DoneForYouSection, feedSummary } from "./conductor-brief";
import type { ConductorFeed } from "./server";

const NOW = Date.now();

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

describe("Done for you", () => {
  it("lists what autopilot did today on the home page, with what it spared and an undo", async () => {
    const slot = renderSlot({ component: DoneForYouSection }, {}, {
      settings: { conductor: true },
      rpc: {
        conductor_feed: () => feed,
        conductor_list: () => ({
          enabled: true,
          conductors: [
            { workspaceId: "ws", name: "Web", enabled: true, active: true, threadId: "thr_c", open: 0, undelivered: 0 },
            { workspaceId: "off", name: "Api", enabled: false, active: false, threadId: "thr_d", open: 0, undelivered: 0 },
          ],
        }),
      } as never,
      sdk: { threads: { unarchive: (async () => ({})) as never } },
      realtimeConnectionState: "connected",
    });
    await waitFor(() => expect(slot.container.textContent).toContain("2 merged · 1 archived · 5 wake-ups spared (≈7.4M tokens)"));
    expect(slot.container.textContent).toContain("Merged web-app#12 once it was green.");
    // Running conductors are a click away.
    await waitFor(() => expect(slot.getByRole("button", { name: "Web" })).toBeTruthy());
    expect(slot.queryByRole("button", { name: /Api/ })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Web" }));
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
