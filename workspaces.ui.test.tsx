import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  ExperimentalSidebarNavigationItem,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { initialWorkspaces } from "./workspaces";
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
afterEach(() => {
  cleanup();
  selectWorkspace(null);
  sessionStorage.clear();
});

it("switches tabs, filters the actual navigation, keeps shared tools, and opens new threads in the workspace project", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(
    app.experimentalSidebarNavigations.find((registration) => registration.id === "workspaces")!,
    { isCompactViewport: false, placement: "list", experimental_Original: () => null },
    {
      rpc: { workspaces_get: () => state },
      sidebarThreads: { status: "ready", projects, threads: [hThread], sections: [] },
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
  const hitlight = await slot.findByRole("tab", { name: /HitLight/ });
  fireEvent.click(hitlight);
  expect(hitlight.getAttribute("aria-selected")).toBe("true");
  expect(slot.queryByRole("button", { name: "Findable DevOps" })).toBeNull();
  expect(slot.getByRole("button", { name: "HitLight DevOps" })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Lifeboat" })).toBeTruthy();
  expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({
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
  fireEvent.click(slot.getByRole("tab", { name: "Findable" }));
  fireEvent.keyDown(slot.getByRole("tablist"), { key: "Home" });
  expect(document.activeElement).toBe(hitlight);
  slot.lifecycle.unmount();
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
  fireEvent.click(await slot.findByRole("button", { name: /HitLight · Edit/ }));
  const name = slot.getByRole("textbox", { name: "Name" });
  fireEvent.change(name, { target: { value: "HitLight work" } });
  fireEvent.click(slot.getByRole("button", { name: "Save workspace" }));
  await waitFor(() => expect(slot.getByRole("alert").textContent).toContain("Connection lost"));
  expect((name as HTMLInputElement).value).toBe("HitLight work");
  expect(slot.getByRole("button", { name: "Save workspace" }).hasAttribute("disabled")).toBe(false);
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
      sidebarThreads: { status: "ready", projects, threads: [hThread], sections: [] },
    },
  );
  await waitFor(() => expect(sessionStorage.getItem("jb-flow-workspace")).toBe("hitlight"));
  expect(sessionStorage.getItem("jb-flow-workspace-last:hitlight")).toBe("ht");
  slot.lifecycle.unmount();
});
