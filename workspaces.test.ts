// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createWorkspaceStorage } from "./workspace-storage";
import { exampleWorkspaces } from "./workspaces.fixtures";
import {
  inWorkspace,
  pluginInWorkspace,
  workspaceForThread,
  type WorkspaceState,
} from "./workspaces";

const projects = [
  { id: "h", name: "hitlight-app" },
  { id: "f", name: "monorepo-apps" },
  { id: "u", name: "Other" },
];
const initial: WorkspaceState = { workspaces: exampleWorkspaces(projects), threadWorkspaces: {} };
const thread = (
  id: string,
  projectId = "h",
  sectionId: string | null = null,
  parentThreadId: string | null = null,
) => ({ id, projectId, sectionId, parentThreadId });

describe("workspace membership", () => {
  it("uses project defaults, section assignment, explicit overrides and parent inheritance in that order", () => {
    const state: WorkspaceState = {
      workspaces: initial.workspaces.map((workspace) =>
        workspace.id === "findable"
          ? { ...workspace, sectionIds: ["findable-section"] }
          : workspace,
      ),
      threadWorkspaces: { moved: "findable", loose: null },
    };
    const threads = [thread("moved"), thread("child", "h", null, "moved")];
    expect(workspaceForThread(thread("default"), state)).toBe("hitlight");
    expect(workspaceForThread(thread("section", "h", "findable-section"), state)).toBe("findable");
    expect(workspaceForThread(threads[1]!, state, threads)).toBe("findable");
    expect(workspaceForThread(thread("loose"), state)).toBeNull();
    expect(inWorkspace(thread("loose"), "unassigned", state)).toBe(true);
    expect(inWorkspace(thread("loose"), "hitlight", state)).toBe(false);
    expect(inWorkspace(thread("loose"), null, state)).toBe(true);
    expect(workspaceForThread(thread("unknown", "u"), state)).toBeNull();
    state.threadWorkspaces.child = "hitlight";
    expect(workspaceForThread(threads[1]!, state, threads)).toBe("hitlight");
  });
  it("terminates a parent cycle and treats stale overrides as unassigned", () => {
    const threads = [thread("a", "h", null, "b"), thread("b", "h", null, "a")];
    expect(workspaceForThread(threads[0]!, initial, threads)).toBe("hitlight");
    expect(
      workspaceForThread(thread("a"), { ...initial, threadWorkspaces: { a: "deleted" } }),
    ).toBeNull();
  });
  it("keeps shared and host tools available while filtering workspace tools", () => {
    expect(pluginInWorkspace("findable-devops", "hitlight", initial)).toBe(false);
    expect(pluginInWorkspace("hitlight-devops", "hitlight", initial)).toBe(true);
    expect(pluginInWorkspace("lifeboat", "hitlight", initial)).toBe(true);
    expect(pluginInWorkspace(null, "hitlight", initial)).toBe(true);
    expect(pluginInWorkspace("findable-devops", null, initial)).toBe(true);
    const shared = {
      ...initial,
      workspaces: initial.workspaces.map((workspace) => ({
        ...workspace,
        pluginIds: [...workspace.pluginIds, "shared-tool"],
      })),
    };
    expect(pluginInWorkspace("shared-tool", "hitlight", shared)).toBe(true);
    expect(pluginInWorkspace("shared-tool", "findable", shared)).toBe(true);
  });
});

it("persists defaults and overrides through reload, serializes concurrent edits, and removes grouping without altering threads", async () => {
  const { bb, harness } = createFakePluginHost({
    sdk: {
      projects: { list: async () => projects },
      threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId }) },
    },
  });
  let store = createWorkspaceStorage(bb, () => {});
  // A new install has no workspaces until the user adds some.
  expect((await store.read()).workspaces).toEqual([]);
  await bb.storage.kv.set("workspaces", initial.workspaces);
  expect((await store.read()).workspaces).toEqual(initial.workspaces);
  const [hitlight, findable] = initial.workspaces;
  await Promise.all([
    store.save({ ...hitlight!, name: "HitLight tools", sectionIds: ["s1"] }),
    store.save({ ...findable!, name: "Findable tools", sectionIds: ["s2"] }),
  ]);
  await store.assign("moved", "findable", false);
  await store.assign("loose", null, false);
  expect((await store.read()).threadWorkspaces).toEqual({ moved: "findable", loose: null });
  const reloaded = await harness.lifecycle.reload(async (next) => {
    store = createWorkspaceStorage(next, () => {});
  });
  expect((await store.read()).workspaces.map((workspace) => workspace.name)).toEqual([
    "HitLight tools",
    "Findable tools",
  ]);
  await store.save({ ...findable!, sectionIds: ["s1"], projectIds: ["h", "f"] });
  expect(
    (await store.read()).workspaces.find((workspace) => workspace.id === "hitlight"),
  ).toMatchObject({ projectIds: [], sectionIds: [] });
  await store.assign("moved", null, true);
  expect((await store.read()).threadWorkspaces).toEqual({ loose: null });
  await store.assign("moved", "findable", false);
  await store.remove("findable");
  expect((await store.read()).threadWorkspaces.moved).toBeNull();
  await expect(store.assign("other", "findable", false)).rejects.toThrow(
    "Workspace no longer exists",
  );
  await expect(store.save({ ...hitlight!, name: "  " })).rejects.toThrow();
  await reloaded.harness.behavior.emitThreadEvent("thread.deleted", {
    thread: makeThreadResponse({ id: "moved" }),
  });
  expect((await store.read()).threadWorkspaces).not.toHaveProperty("moved");
  expect(reloaded.harness.inspection.sdk.callsTo("threads.update")).toHaveLength(0);
  expect(reloaded.harness.inspection.sdk.callsTo("threads.delete")).toHaveLength(0);
  await reloaded.harness.lifecycle.dispose();
});
