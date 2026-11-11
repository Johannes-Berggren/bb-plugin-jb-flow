// @vitest-environment node
// Boots the real server against bb's fake plugin host, which enforces
// append-only migrations the way bb does: an install that already ran the
// v0.1.10 schema must load the conductor tables on top of it.
import { describe, expect, it } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const V0110_MIGRATIONS = [
  "CREATE TABLE pr_status (key TEXT PRIMARY KEY, json TEXT NOT NULL)",
  "CREATE TABLE thread_prs (thread_id TEXT PRIMARY KEY, json TEXT NOT NULL)",
];

function host(settings: Record<string, boolean> = {}) {
  return createFakePluginHost({
    pluginId: "jb-flow",
    settings,
    sdk: {
      projects: { list: async () => [] },
      threads: { list: async () => [] },
      threadSections: { list: async () => [] },
    } as never,
  });
}

describe("server boot", () => {
  it("loads on a database that already has the v0.1.10 tables", async () => {
    const { bb, harness } = host();
    bb.storage.migrate(bb.storage.database(), V0110_MIGRATIONS);
    await plugin(bb);
    const tables = bb.storage
      .database()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(["pr_status", "thread_prs", "conductor_events", "conductor_log"]));
    expect(harness.registrations.schedules.map((schedule) => schedule.name)).toContain("conductor-wake");
    expect(harness.logEntries.filter((entry) => entry.level === "error")).toEqual([]);
  });

  it("gives every thread the usual tools and no conductor tools while the setting is off", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    const config = await harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "thr_a" } }));
    expect(JSON.stringify(config)).toContain("wait_for_ci");
    expect(JSON.stringify(config)).not.toContain("merge_pr");
  });

  it("doesn't take a plugin-spawned thread for a conductor while the setting is off", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    const config = await harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "thr_x" },
        pluginMetadata: { role: "conductor", workspaceId: "ws" },
        origin: { kind: null, pluginId: "jb-flow" },
      }),
    );
    expect(JSON.stringify(config)).not.toContain("merge_pr");
  });

  it("lists no conductors until one is started", async () => {
    const { bb, harness } = host({ conductor: true });
    await plugin(bb);
    expect(await harness.callRpc("conductor_list", null)).toEqual({ enabled: true, conductors: [] });
  });
});

describe("server boot with the conductor on", () => {
  it("starts a hidden conductor in a workspace and gives only it the conductor tools", async () => {
    const spawned: Array<Record<string, unknown>> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "jb-flow",
      settings: { conductor: true },
      sdk: {
        projects: { list: async () => [{ id: "proj_web", name: "web-app" }] },
        threads: {
          list: async () => [],
          spawn: async (args: Record<string, unknown>) => {
            spawned.push(args);
            return { id: "thr_conductor" };
          },
          get: async ({ threadId }: { threadId: string }) => ({ id: threadId, archivedAt: null, deletedAt: null, status: "idle" }),
        },
        threadSections: { list: async () => [] },
      } as never,
    });
    await bb.storage.kv.set("workspaces", [
      { id: "ws", name: "Web", projectIds: ["proj_web"], sectionIds: [], pluginIds: [], sectionOrder: [] },
    ]);
    await plugin(bb);
    expect(await harness.callRpc("conductor_start", { workspaceId: "ws" })).toEqual({ threadId: "thr_conductor" });
    expect(spawned[0]).toMatchObject({
      projectId: "proj_web",
      visibility: "hidden",
      title: "Conductor · Web",
      pluginMetadata: { role: "conductor", workspaceId: "ws" },
      environment: { type: "host", workspace: { type: "personal" } },
    });
    const own = (await harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "thr_conductor" } }))) as {
      tools?: unknown;
      instructions?: string;
    };
    expect(JSON.stringify(own)).toContain("merge_pr");
    expect(JSON.stringify(own)).not.toContain("wait_for_ci");
    const worker = await harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "thr_a" } }));
    expect(JSON.stringify(worker)).not.toContain("merge_pr");
    const list = (await harness.callRpc("conductor_list", null)) as { conductors: Array<{ workspaceId: string; active: boolean }> };
    expect(list.conductors).toMatchObject([{ workspaceId: "ws", active: true }]);
  });
});
