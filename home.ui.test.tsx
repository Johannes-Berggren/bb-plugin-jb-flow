import { afterEach, expect, it } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { exampleWorkspaces } from "./workspaces.fixtures";
import { selectWorkspace, setWorkspacesEnabled } from "./workspace-client";

const projects = [
  { id: "me", name: "Personal", isPersonal: true, href: "/projects/me", settingsHref: "/projects/me/settings" },
  { id: "h", name: "acme-app", isPersonal: false, href: "/projects/h", settingsHref: "/projects/h/settings" },
  { id: "f", name: "globex-web", isPersonal: false, href: "/projects/f", settingsHref: "/projects/f/settings" },
];
const state = { workspaces: exampleWorkspaces(projects), threadWorkspaces: {} };
const report = (repo: string | null) => ({
  repo,
  head: repo ? "main" : null,
  base: repo ? "v1.0.0" : null,
  baseKind: repo ? "tag" : null,
  releasedAt: null,
  compareUrl: null,
  prs: repo ? [{ number: 7, title: "Ship it", author: "dev", url: "https://example.test/7", mergedAt: Date.now() }] : [],
  directCommits: 0,
  error: repo ? null : "Pick a project with a GitHub repo to see what's unreleased.",
  checkedAt: Date.now(),
});

afterEach(() => {
  cleanup();
  selectWorkspace(null);
  setWorkspacesEnabled(false);
  sessionStorage.clear();
});

async function section(id: string, options: Record<string, unknown>, props: Record<string, unknown> = {}) {
  const app = await loadPluginApp(() => import("./app"));
  return renderSlot(app.homepageSections.find((entry) => entry.id === id)!, props as never, {
    sidebarThreads: { status: "ready", projects, threads: [], sections: [] },
    ...options,
  } as never);
}

it("hides Unreleased on All with no project picked, or with the personal project", async () => {
  const calls: unknown[] = [];
  const rpc = { workspaces_get: () => state, unreleased: (input: unknown) => (calls.push(input), report(null)) };
  const none = await section("unreleased", { rpc }, { projectId: null });
  await waitFor(() => expect(none.container.querySelector("[data-jf-hidden-section]")).not.toBeNull());
  none.lifecycle.unmount();
  const personal = await section("unreleased", { rpc }, { projectId: "me" });
  await waitFor(() => expect(personal.container.querySelector("[data-jf-hidden-section]")).not.toBeNull());
  personal.lifecycle.unmount();
  // Nothing to look up, so GitHub isn't asked.
  expect(calls).toEqual([]);
});

it("inside a workspace tab, reports on the first of its projects with a GitHub repo", async () => {
  const workspace = state.workspaces[0]!;
  const withTwo = { ...state, workspaces: [{ ...workspace, projectIds: ["f", "h"] }, ...state.workspaces.slice(1)] };
  setWorkspacesEnabled(true);
  selectWorkspace(workspace.id);
  const slot = await section(
    "unreleased",
    { rpc: { workspaces_get: () => withTwo, unreleased: ({ projectId }: { projectId: string }) => report(projectId === "h" ? "acme/app" : null) } },
    { projectId: null },
  );
  await waitFor(() => expect(slot.container.textContent).toContain("acme/app: 1 PR on main since v1.0.0"));
  expect(slot.container.querySelector("[data-jf-hidden-section]")).toBeNull();
  slot.lifecycle.unmount();
});

it("a project picked in the composer is reported without a repo prefix; one without a repo hides the section", async () => {
  const rpc = { workspaces_get: () => state, unreleased: ({ projectId }: { projectId: string }) => report(projectId === "h" ? "acme/app" : null) };
  const picked = await section("unreleased", { rpc }, { projectId: "h" });
  await waitFor(() => expect(picked.container.textContent).toContain("1 PR on main since v1.0.0"));
  expect(picked.container.textContent).not.toContain("acme/app:");
  picked.lifecycle.unmount();
  const bare = await section("unreleased", { rpc }, { projectId: "f" });
  await waitFor(() => expect(bare.container.querySelector("[data-jf-hidden-section]")).not.toBeNull());
  bare.lifecycle.unmount();
});

it("Your move shows placeholder rows until its list arrives", async () => {
  let resolve = (_value: unknown) => {};
  const slot = await section("your-move", {
    rpc: {
      workspaces_get: () => state,
      state_get: () => ({ awaiting: {} }),
      your_move: () => new Promise((done) => (resolve = done)),
    },
  });
  expect(await slot.findByRole("status", { name: "Loading Your move" })).toBeDefined();
  expect(slot.container.textContent).not.toContain("Loading…");
  resolve({ items: [] });
  await waitFor(() => expect(slot.container.textContent).toContain("No decisions waiting on you."));
  expect(slot.queryByRole("status", { name: "Loading Your move" })).toBeNull();
  slot.lifecycle.unmount();
});
