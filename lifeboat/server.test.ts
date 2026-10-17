// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import { createLifeboat } from "./server";
import { fixtureSnapshot } from "./fixtures";

const mac = makeHostResponse({
  id: "mac",
  name: "Studio",
  status: "connected",
});
describe("Lifeboat host routing", () => {
  it("routes to the selected enrolled host, shares reads, and registers monitoring only after a user action", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "jb-flow",
      sdk: { hosts: { list: async () => [mac] } },
      experimental_callHostRpc: async () => {
        await gate;
        return { ok: true, state: fixtureSnapshot() };
      },
    });
    const life = createLifeboat(bb);
    const first = life.run("mac", { command: "status" });
    const second = life.run("mac", { command: "status" });
    release();
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(harness.experimental_hostRpcCalls).toHaveLength(1);
    expect(harness.experimental_hostRpcCalls[0].hostId).toBe("mac");
    expect(await bb.storage.kv.get("lifeboat:hosts")).toBeUndefined();
    await life.run("mac", { command: "import" });
    expect(await bb.storage.kv.get("lifeboat:hosts")).toEqual(["mac"]);
    await harness.lifecycle.dispose();
  });
  it("refuses offline and unknown hosts without invoking a credential engine", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "jb-flow",
      sdk: {
        hosts: { list: async () => [{ ...mac, status: "disconnected" }] },
      },
    });
    const life = createLifeboat(bb);
    expect(
      (await life.run("mac", { command: "capture", provider: "claude" })).ok,
    ).toBe(false);
    expect((await life.run("unknown", { command: "import" })).ok).toBe(false);
    expect(harness.experimental_hostRpcCalls).toHaveLength(0);
    await harness.lifecycle.dispose();
  });
  it("does not queue duplicate credential mutations", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "jb-flow",
      sdk: { hosts: { list: async () => [mac] } },
      experimental_callHostRpc: async () => {
        await gate;
        return { ok: true, state: fixtureSnapshot() };
      },
    });
    const life = createLifeboat(bb);
    const first = life.run("mac", { command: "import" });
    // Yield to the host-list response before the concurrent write.
    await Promise.resolve();
    await Promise.resolve();
    const second = await life.run("mac", { command: "import" });
    expect(second.ok).toBe(false);
    release();
    await first;
    expect(harness.experimental_hostRpcCalls).toHaveLength(1);
    await harness.lifecycle.dispose();
  });
});
