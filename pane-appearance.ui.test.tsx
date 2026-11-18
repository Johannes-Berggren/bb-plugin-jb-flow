import { afterEach, expect, it } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, mountPluginContentScripts, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { exampleWorkspaces } from "./workspaces.fixtures";
import { loneThreadRule, mountPaneAppearance, paneColorRules } from "./pane-appearance";

const CLASS = "jb-flow-active-pane";
const framed = () => document.documentElement.classList.contains(CLASS);
const rules = () => document.querySelector("style[data-jf-pane-colors]")?.textContent ?? null;

const projects = [
  { id: "h", name: "acme-app", isPersonal: false, href: "/projects/h", settingsHref: "/projects/h/settings" },
  { id: "f", name: "globex-web", isPersonal: false, href: "/projects/f", settingsHref: "/projects/f/settings" },
];
const state = {
  workspaces: exampleWorkspaces(projects).map((workspace) => (workspace.id === "acme" ? { ...workspace, color: "teal" as const } : workspace)),
  threadWorkspaces: {},
};
const thread = (id: string, projectId: string) =>
  ({ id, projectId, sectionId: null, parentThreadId: null, isArchived: false, isHidden: false }) as PluginSidebarThread;
const rect = { x: 0, y: 0, width: 0.5, height: 1 };
const split = {
  panes: [
    { paneId: "p1", rect, threadId: "acme-thread", isFocused: true },
    { paneId: "p2", rect: { ...rect, x: 0.5 }, threadId: "globex-thread", isFocused: false },
  ],
};
const host = {
  rpc: { workspaces_get: () => state },
  sidebarThreads: { status: "ready" as const, projects, threads: [thread("acme-thread", "h"), thread("globex-thread", "f")], sections: [] },
};

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove(CLASS);
});

async function mount() {
  const app = await loadPluginApp(() => import("./app"));
  const scripts = await mountPluginContentScripts(
    { ...app, contentScripts: app.contentScripts.filter((script) => script.id === "pane-appearance") },
    { pluginId: "jb-flow", generation: 1 },
  );
  return { scripts, preference: app.appOverlays.find((overlay) => overlay.id === "pane-appearance-preference")! };
}

it("frames the active pane and colors panes by workspace only while a split is open and the setting is on", async () => {
  const { scripts, preference } = await mount();
  // Nothing until the preference asks for it.
  expect(framed()).toBe(false);

  const on = renderSlot(preference, {}, { ...host, settings: { highlightActivePane: true, workspaces: true }, sidebarSplitLayout: split });
  expect(framed()).toBe(true);
  // Only the pane whose workspace has a color gets a rule.
  await waitFor(() => expect(rules()).toBe(`.${CLASS} [data-split-pane-id="p1"]{--jf-pane-color:var(--jf-ws-teal)}`));
  on.lifecycle.unmount();
  expect(rules()).toBeNull();

  // The frame works without workspaces; the colors don't.
  const plain = renderSlot(preference, {}, { ...host, settings: { highlightActivePane: true, workspaces: false }, sidebarSplitLayout: split });
  expect(framed()).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(rules()).toBeNull();
  plain.lifecycle.unmount();

  const off = renderSlot(preference, {}, { ...host, settings: { highlightActivePane: false, workspaces: true }, sidebarSplitLayout: split });
  expect(framed()).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(rules()).toBeNull();
  off.lifecycle.unmount();

  // A single pane has nothing to tell apart.
  renderSlot(preference, {}, { ...host, settings: { highlightActivePane: true, workspaces: true }, sidebarSplitLayout: split }).lifecycle.unmount();
  expect(framed()).toBe(true);
  const single = renderSlot(preference, {}, { ...host, settings: { highlightActivePane: true, workspaces: true } });
  expect(framed()).toBe(false);
  expect(rules()).toBeNull();
  single.lifecycle.unmount();

  renderSlot(preference, {}, { ...host, settings: { highlightActivePane: true }, sidebarSplitLayout: split }).lifecycle.unmount();
  expect(framed()).toBe(true);
  await scripts.lifecycle.dispose();
  expect(framed()).toBe(false);
  window.dispatchEvent(new CustomEvent("jb-flow-pane-appearance", { detail: true }));
  expect(framed()).toBe(false);
});

it("stays off until asked, ignores malformed preferences and cleans up on abort", () => {
  const controller = new AbortController();
  const dispose = mountPaneAppearance({ signal: controller.signal });
  expect(framed()).toBe(false);
  window.dispatchEvent(new CustomEvent("jb-flow-pane-appearance", { detail: "true" }));
  expect(framed()).toBe(false);
  window.dispatchEvent(new CustomEvent("jb-flow-pane-appearance", { detail: true }));
  expect(framed()).toBe(true);
  controller.abort();
  expect(framed()).toBe(false);
  dispose?.();
  mountPaneAppearance({ signal: controller.signal });
  window.dispatchEvent(new CustomEvent("jb-flow-pane-appearance", { detail: true }));
  expect(framed()).toBe(false);
});

it("writes one rule per colored thread pane and escapes pane ids", () => {
  const colorOf = (threadId: string) => (threadId === "a" ? ("blue" as const) : undefined);
  expect(
    paneColorRules(
      [
        { paneId: 'x"y\\z', threadId: "a" },
        { paneId: "plain", threadId: "b" },
        { paneId: "empty", threadId: null },
      ],
      colorOf,
    ),
  ).toBe(`.${CLASS} [data-split-pane-id="x\\"y\\\\z"]{--jf-pane-color:var(--jf-ws-blue)}`);
});

it("tops a lone thread's header with its workspace's color", async () => {
  const { scripts, preference } = await mount();
  const lone = renderSlot(preference, {}, { ...host, settings: { highlightActivePane: true, workspaces: true }, context: { threadId: "acme-thread", projectId: "h" } });
  await waitFor(() => expect(rules()).toBe(loneThreadRule("teal")));
  // No frame class: there is no split to frame.
  expect(framed()).toBe(false);
  lone.lifecycle.unmount();

  // A workspace without a color, or the setting off: nothing.
  const plain = renderSlot(preference, {}, { ...host, settings: { highlightActivePane: true, workspaces: true }, context: { threadId: "globex-thread", projectId: "f" } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(rules()).toBeNull();
  plain.lifecycle.unmount();
  const off = renderSlot(preference, {}, { ...host, settings: { highlightActivePane: false, workspaces: true }, context: { threadId: "acme-thread", projectId: "h" } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(rules()).toBeNull();
  off.lifecycle.unmount();
  await scripts.lifecycle.dispose();
});

it("writes the lone-thread rule only for a color, and only outside a split", () => {
  expect(loneThreadRule(undefined)).toBe("");
  expect(loneThreadRule("teal")).toContain("body:not(:has(#split-workspace-main-panel))");
  expect(loneThreadRule("teal")).toContain("box-shadow:inset 0 2px 0 var(--jf-ws-teal)");
});
