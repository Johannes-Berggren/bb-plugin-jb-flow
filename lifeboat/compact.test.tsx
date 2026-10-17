import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixtureSnapshot, FIXTURE_NOW } from "./fixtures";
import { lifeboatClient } from "./client";

afterEach(() => {
  cleanup();
  lifeboatClient.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const inventory = {
  localHostId: "studio",
  hosts: [
    { id: "studio", name: "Mac Studio", connected: true },
    { id: "air", name: "MacBook Air", connected: true },
  ],
};
const rpc = {
  lifeboat_hosts: () => inventory,
  lifeboat_run: () => ({
    ok: true,
    state: { ...fixtureSnapshot(), source: "legacy" as const },
  }),
};

describe("Lifeboat in BB's everyday surfaces", () => {
  it("replaces the usage footer with a managed disclosure and opens the selected Mac's dashboard", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const footer = app.experimentalSidebarFooterItems.find(
      (item) => item.id === "lifeboat-capacity",
    );
    expect(footer?.kind).toBe("disclosure");
    if (!footer || footer.kind !== "disclosure")
      throw new Error("Lifeboat footer missing");
    const dismiss = vi.fn();
    const slot = renderSlot(footer, { dismiss }, { rpc });
    expect(await slot.findByText("Work")).toBeTruthy();
    expect(slot.getByText("Read-only readings from the Mac app.")).toBeTruthy();
    fireEvent.change(slot.getByLabelText("Lifeboat Mac"), {
      target: { value: "air" },
    });
    fireEvent.click(slot.getByRole("button", { name: /Manage accounts/ }));
    expect(dismiss).toHaveBeenCalledOnce();
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({
        method: "toPluginPanel",
        path: "lifeboat",
        options: { subPath: "host/air" },
      }),
    );
    expect(
      slot.inspection.rpcCalls.every(
        (call) =>
          call.method !== "lifeboat_run" ||
          (call.input as { operation: { command: string } }).operation
            .command === "status",
      ),
    ).toBe(true);
    slot.lifecycle.unmount();
  });
  it("mounts the provider-scoped composer popup without switch or import controls", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const customization = app.composerCustomizations.find(
      (item) => item.id === "lifeboat-capacity",
    )!;
    const popup = customization.experimental_popups![0];
    const slot = renderSlot(
      popup,
      {},
      {
        rpc,
        composer: {
          scope: { kind: "new-thread", projectId: null },
          selection: {
            providerId: "codex",
            environment: {
              type: "host",
              hostId: "air",
              workspace: { type: "personal" },
            },
          },
        },
      },
    );
    expect(await slot.findByText("Codex")).toBeTruthy();
    expect(slot.getByText("MacBook Air")).toBeTruthy();
    expect(slot.queryByText("Claude Code")).toBeNull();
    expect(slot.queryByText(/% left/)).toBeNull();
    expect(
      slot
        .getAllByRole("meter")
        .every((meter) => !meter.hasAttribute("aria-valuenow")),
    ).toBe(true);
    expect(
      slot.queryByRole("button", { name: /Switch|Import|Bring into Flow/ }),
    ).toBeNull();
    slot.lifecycle.unmount();
  });
  it("shows a conservative capacity pill for the selected provider and Mac", async () => {
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW);
    lifeboatClient.reset();
    const app = await loadPluginApp(() => import("../app"));
    const action = app.composerCustomizations.find(
      (item) => item.id === "lifeboat-capacity",
    )!.actions![0];
    const slot = renderSlot(
      action,
      {},
      {
        rpc,
        composer: {
          scope: { kind: "new-thread", projectId: null },
          selection: {
            providerId: "codex",
            environment: {
              type: "host",
              hostId: "air",
              workspace: { type: "personal" },
            },
          },
        },
      },
    );
    expect(await slot.findByText("14% left")).toBeTruthy();
    expect(slot.getByRole("button").getAttribute("title")).toContain(
      "MacBook Air",
    );
    expect(slot.getByRole("button").getAttribute("title")).toContain(
      "may differ from this session",
    );
    slot.lifecycle.unmount();
  });
});
