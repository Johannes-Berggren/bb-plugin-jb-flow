import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  ExperimentalSidebarNavigationItem,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { initialWorkspaces } from "./workspaces";
import { mountWorkspaceTopBar, WORKSPACE_BAR_EVENT } from "./workspace-topbar";
import { selectWorkspace } from "./workspace-client";

const projects = [
  {
    id: "h",
    name: "hitlight-app",
    isPersonal: false,
    href: "/projects/h",
    settingsHref: "/projects/h/settings",
  },
  {
    id: "f",
    name: "monorepo-apps",
    isPersonal: false,
    href: "/projects/f",
    settingsHref: "/projects/f/settings",
  },
];
const state = { workspaces: initialWorkspaces(projects), threadWorkspaces: {} };
function item(
  id: string,
  label: string,
  pluginId: string | null,
): ExperimentalSidebarNavigationItem {
  return {
    id,
    label,
    pluginId,
    icon: { kind: "host", name: "extensions" },
    action: pluginId
      ? { kind: "open-plugin-panel", pluginId, panelId: "board" }
      : { kind: "new-thread" },
    isDisabled: false,
    isVisible: true,
    isLoading: false,
    shortcut: null,
    badge: null,
  };
}
const hThread = {
  id: "ht",
  projectId: "h",
  sectionId: null,
  parentThreadId: null,
  isArchived: false,
  isHidden: false,
  hasPendingInteraction: true,
  status: "idle",
  isUnread: false,
} as PluginSidebarThread;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  selectWorkspace(null);
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("switches tabs, filters the actual navigation, keeps shared tools, and opens new threads in the workspace project", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(
    app.experimentalSidebarNavigations.find(
      (registration) => registration.id === "workspaces",
    )!,
    {
      isCompactViewport: false,
      placement: "list",
      experimental_Original: () => null,
    },
    {
      rpc: { workspaces_get: () => state },
      sidebarThreads: {
        status: "ready",
        projects,
        threads: [hThread],
        sections: [],
      },
      sidebarNavigation: {
        items: [
          item("new", "New thread", null),
          item("hitlight-devops/board", "HitLight DevOps", "hitlight-devops"),
          item("findable-devops/board", "Findable DevOps", "findable-devops"),
          item("lifeboat/board", "Lifeboat", "lifeboat"),
        ],
      },
    },
  );
  const topbar = renderSlot(
    app.appOverlays.find((overlay) => overlay.id === "workspace-topbar")!,
    {},
    {
      rpc: { workspaces_get: () => state },
      sidebarThreads: {
        status: "ready",
        projects,
        threads: [hThread],
        sections: [],
      },
    },
  );
  expect(document.querySelector(".jf-workspaces [role=tablist]")).toBeNull();
  const hitlight = await topbar.findByRole("tab", { name: /HitLight/ });
  fireEvent.click(hitlight);
  expect(hitlight.getAttribute("aria-selected")).toBe("true");
  expect(slot.queryByRole("button", { name: "Findable DevOps" })).toBeNull();
  expect(slot.getByRole("button", { name: "HitLight DevOps" })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Lifeboat" })).toBeTruthy();
  expect(topbar.inspection.navigateCalls.at(-1)).toMatchObject({
    method: "toCompose",
    options: { projectId: "h" },
  });
  fireEvent.click(slot.getByRole("button", { name: "New thread" }));
  expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({
    method: "toCompose",
    options: { projectId: "h" },
  });
  fireEvent.click(slot.getByRole("button", { name: "More tools" }));
  expect(slot.getByRole("button", { name: "Findable DevOps" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Findable DevOps" }));
  expect(slot.inspection.sidebarNavigationCalls.at(-1)).toMatchObject({
    method: "activate",
    itemId: "findable-devops/board",
  });
  fireEvent.click(topbar.getByRole("tab", { name: "Findable" }));
  fireEvent.keyDown(topbar.getByRole("tablist"), { key: "Home" });
  expect(document.activeElement).toBe(hitlight);
  slot.lifecycle.unmount();
  expect(topbar.getByRole("tablist", { name: "Workspaces" })).toBeTruthy();
  topbar.lifecycle.unmount();
});

it("settings report save failures and preserve the edited values for retry", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(
    app.settingsSections.find((section) => section.id === "workspaces")!,
    {},
    {
      rpc: {
        workspaces_get: () => state,
        workspace_save: () => {
          throw new Error("Connection lost");
        },
      },
      sidebarThreads: { status: "ready", projects, threads: [], sections: [] },
      sdk: { plugins: { list: async () => ({ plugins: [] }) } },
    },
  );
  fireEvent.click(await slot.findByRole("button", { name: "Edit HitLight" }));
  const name = slot.getByRole("textbox", { name: "Workspace name" });
  fireEvent.change(name, { target: { value: "HitLight work" } });
  fireEvent.click(slot.getByRole("button", { name: "Save workspace" }));
  await waitFor(() =>
    expect(slot.getByRole("alert").textContent).toContain("Connection lost"),
  );
  expect((name as HTMLInputElement).value).toBe("HitLight work");
  expect(
    slot
      .getByRole("button", { name: "Save workspace" })
      .hasAttribute("disabled"),
  ).toBe(false);
  slot.lifecycle.unmount();
});

it("reveals the owning workspace when a deep link opens a thread from another workspace", async () => {
  selectWorkspace("findable");
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(
    app.appOverlays.find((overlay) => overlay.id === "workspace-route")!,
    {},
    {
      context: { threadId: "ht", projectId: "h" },
      rpc: { workspaces_get: () => state },
      sidebarThreads: {
        status: "ready",
        projects,
        threads: [hThread],
        sections: [],
      },
    },
  );
  await waitFor(() =>
    expect(sessionStorage.getItem("jb-flow-workspace")).toBe("hitlight"),
  );
  expect(sessionStorage.getItem("jb-flow-workspace-last:hitlight")).toBe("ht");
  slot.lifecycle.unmount();
});

it("reserves top-bar space only while the app-wide bar renders and cleans up on reload or disable", async () => {
  const controller = new AbortController();
  const dispose = mountWorkspaceTopBar({ signal: controller.signal });
  expect(
    document.documentElement.classList.contains("jb-flow-workspace-bar"),
  ).toBe(false);
  const app = await loadPluginApp(() => import("./app"));
  const topbar = renderSlot(
    app.appOverlays.find((overlay) => overlay.id === "workspace-topbar")!,
    {},
    {
      rpc: { workspaces_get: () => state },
      sidebarThreads: { status: "ready", projects, threads: [], sections: [] },
    },
  );
  await topbar.findByRole("tab", { name: "HitLight" });
  expect(
    document.documentElement.classList.contains("jb-flow-workspace-bar"),
  ).toBe(true);
  topbar.lifecycle.unmount();
  expect(
    document.documentElement.classList.contains("jb-flow-workspace-bar"),
  ).toBe(false);
  window.dispatchEvent(new CustomEvent(WORKSPACE_BAR_EVENT, { detail: true }));
  expect(
    document.documentElement.classList.contains("jb-flow-workspace-bar"),
  ).toBe(true);
  controller.abort();
  expect(
    document.documentElement.classList.contains("jb-flow-workspace-bar"),
  ).toBe(false);
  window.dispatchEvent(new CustomEvent(WORKSPACE_BAR_EVENT, { detail: true }));
  expect(
    document.documentElement.classList.contains("jb-flow-workspace-bar"),
  ).toBe(false);
  dispose?.();
});

it("opens management outside the sidebar, searches memberships, and preserves choices between categories", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const save = vi.fn((input) => input);
  const slot = renderSlot(
    app.appOverlays.find((overlay) => overlay.id === "workspace-topbar")!,
    {},
    {
      rpc: { workspaces_get: () => state, workspace_save: save },
      sidebarThreads: {
        status: "ready",
        projects,
        threads: [],
        sections: [
          {
            id: "sec",
            name: "Priority",
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      },
      sdk: { plugins: { list: async () => ({ plugins: [] }) } },
      sidebarNavigation: {
        items: [item("lifeboat/board", "Lifeboat", "lifeboat")],
      },
    },
  );
  await slot.findByRole("tab", { name: "HitLight" });
  fireEvent.click(slot.getByRole("button", { name: "Manage workspaces" }));
  expect(slot.getByRole("dialog", { name: "Workspaces" })).toBeTruthy();
  fireEvent.change(slot.getByRole("textbox", { name: "Search projects" }), {
    target: { value: "monorepo" },
  });
  expect(slot.queryByRole("checkbox", { name: "hitlight-app" })).toBeNull();
  fireEvent.click(slot.getByRole("checkbox", { name: /monorepo-apps/ }));
  fireEvent.click(slot.getByRole("button", { name: /Sections/ }));
  fireEvent.click(slot.getByRole("checkbox", { name: "Priority" }));
  fireEvent.click(slot.getByRole("button", { name: /Tools/ }));
  fireEvent.click(await slot.findByRole("checkbox", { name: "Lifeboat" }));
  fireEvent.click(slot.getByRole("button", { name: "Save workspace" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "hitlight",
        projectIds: ["h", "f"],
        sectionIds: ["sec"],
        pluginIds: expect.arrayContaining(["lifeboat"]),
      }),
    ),
  );
  fireEvent.click(slot.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  expect(slot.getByRole("button", { name: "Manage workspaces" })).toBeTruthy();
  slot.lifecycle.unmount();
});
