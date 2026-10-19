import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  initialWorkspaces,
  workspaceSchema,
  type Workspace,
  type WorkspaceState,
} from "./workspaces";

export function createWorkspaceStorage(bb: BbPluginApi, changed: () => void) {
  const kv = bb.storage.kv;
  let pending: Promise<unknown> = Promise.resolve();
  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = pending.then(run, run);
    pending = result.catch(() => undefined);
    return result;
  }
  async function list(): Promise<Workspace[]> {
    const saved = await kv.get<Workspace[]>("workspaces");
    if (saved !== undefined) return saved;
    const workspaces = initialWorkspaces(await bb.sdk.projects.list());
    await kv.set("workspaces", workspaces);
    return workspaces;
  }
  async function read(): Promise<WorkspaceState> {
    const workspaces = await exclusive(list);
    const keys = await kv.list("workspace-thread:");
    const entries = await Promise.all(
      keys.map(
        async (key) =>
          [
            key.slice("workspace-thread:".length),
            (await kv.get<string | null>(key)) ?? null,
          ] as const,
      ),
    );
    return { workspaces, threadWorkspaces: Object.fromEntries(entries) };
  }
  function save(input: Omit<Workspace, "id"> & { id: string | null }): Promise<Workspace> {
    return exclusive(async () => {
      const all = await list();
      if (input.id !== null && !all.some((workspace) => workspace.id === input.id))
        throw new Error("Workspace no longer exists. Reload and try again.");
      const next = workspaceSchema.parse({
        ...input,
        id: input.id ?? `ws_${randomUUID().slice(0, 12)}`,
      });
      if (
        all.some(
          (workspace) =>
            workspace.id !== next.id && workspace.name.toLowerCase() === next.name.toLowerCase(),
        )
      )
        throw new Error("A workspace with this name already exists.");
      if (input.id === null && all.length >= 30)
        throw new Error("You can have up to 30 workspaces.");
      const updated = all
        .filter((workspace) => workspace.id !== next.id)
        .map((workspace) => ({
          ...workspace,
          projectIds: workspace.projectIds.filter((id) => !next.projectIds.includes(id)),
          sectionIds: workspace.sectionIds.filter((id) => !next.sectionIds.includes(id)),
        }));
      const index = all.findIndex((workspace) => workspace.id === next.id);
      updated.splice(index < 0 ? updated.length : index, 0, next);
      await kv.set("workspaces", updated);
      changed();
      return next;
    });
  }
  async function assign(
    threadId: string,
    workspaceId: string | null,
    automatic: boolean,
  ): Promise<void> {
    await bb.sdk.threads.get({ threadId });
    await exclusive(async () => {
      const all = await list();
      if (
        !automatic &&
        workspaceId !== null &&
        !all.some((workspace) => workspace.id === workspaceId)
      )
        throw new Error("Workspace no longer exists.");
      const key = `workspace-thread:${threadId}`;
      if (automatic) await kv.delete(key);
      else await kv.set(key, workspaceId);
    });
    changed();
  }
  async function remove(id: string): Promise<void> {
    await exclusive(async () => {
      const all = await list();
      await kv.set(
        "workspaces",
        all.filter((workspace) => workspace.id !== id),
      );
      for (const key of await kv.list("workspace-thread:")) {
        if ((await kv.get(key)) === id) await kv.set(key, null);
      }
    });
    changed();
  }
  bb.events.on("thread.deleted", async ({ thread }) => {
    await kv.delete(`workspace-thread:${thread.id}`);
  });
  return { read, save, assign, remove };
}
