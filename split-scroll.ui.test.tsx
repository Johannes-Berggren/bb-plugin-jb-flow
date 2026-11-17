import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { loadPluginApp, mountPluginContentScripts, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { mountSplitScroll } from "./split-scroll";

const CLASS = "jb-flow-split-scroll";
const OVERFLOW = "jb-flow-split-overflow";
const root = document.documentElement;
const scrolling = () => root.classList.contains(CLASS);
const overflowing = () => root.classList.contains(OVERFLOW);
const minWidth = () => root.style.getPropertyValue("--jb-flow-split-min-width");
const rect = (x: number, width: number) => ({ x, y: 0, width, height: 1 });
const panes = (focused: number, count = 4) => ({
  panes: Array.from({ length: count }, (_, index) => ({
    paneId: `p${index}`,
    rect: rect(index / count, 1 / count),
    threadId: `t${index}`,
    isFocused: index === focused,
  })),
});
const send = (detail: unknown) => window.dispatchEvent(new CustomEvent("jb-flow-split-scroll", { detail }));

/** BB's chain around the panes; jsdom has no layout, so the sizes are stubbed. */
function hostSplit({ scrollWidth = 2560, clientWidth = 1280 } = {}) {
  document.body.innerHTML = `<div id="split-workspace-main-panel"><div><div data-split-resize-grid-root=""><div data-split-pane-id="p0" data-focused="true"></div></div></div></div>`;
  const scroller = document.querySelector<HTMLElement>("#split-workspace-main-panel > div")!;
  Object.defineProperties(scroller, {
    scrollWidth: { value: scrollWidth },
    clientWidth: { value: clientWidth },
    scrollLeft: { value: 0, writable: true },
  });
  const scrollTo = vi.fn();
  scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;
  return { scroller, scrollTo, pane: scroller.querySelector<HTMLElement>("[data-split-pane-id]")! };
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    run(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  cleanup();
  root.classList.remove(CLASS, OVERFLOW);
  root.style.removeProperty("--jb-flow-split-min-width");
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function mount() {
  const app = await loadPluginApp(() => import("./app"));
  const scripts = await mountPluginContentScripts(
    { ...app, contentScripts: app.contentScripts.filter((script) => script.id === "split-scroll") },
    { pluginId: "jb-flow", generation: 1 },
  );
  return { scripts, preference: app.appOverlays.find((overlay) => overlay.id === "split-scroll-preference")! };
}

it("gives the split a minimum width only while a split is open and the setting is on", async () => {
  const { scripts, preference } = await mount();
  expect(scrolling()).toBe(false);

  const on = renderSlot(preference, {}, { settings: { splitScroll: true, splitMinPaneWidth: 500 }, sidebarSplitLayout: panes(0) });
  expect(scrolling()).toBe(true);
  expect(minWidth()).toBe("2000px");
  on.lifecycle.unmount();

  // Without the number the default minimum applies.
  const fallback = renderSlot(preference, {}, { settings: { splitScroll: true }, sidebarSplitLayout: panes(0) });
  expect(minWidth()).toBe("2560px");
  fallback.lifecycle.unmount();

  const off = renderSlot(preference, {}, { settings: { splitScroll: false }, sidebarSplitLayout: panes(0) });
  expect(scrolling()).toBe(false);
  expect(minWidth()).toBe("");
  off.lifecycle.unmount();

  renderSlot(preference, {}, { settings: { splitScroll: true }, sidebarSplitLayout: panes(0) }).lifecycle.unmount();
  expect(scrolling()).toBe(true);
  const single = renderSlot(preference, {}, { settings: { splitScroll: true } });
  expect(scrolling()).toBe(false);
  expect(minWidth()).toBe("");
  single.lifecycle.unmount();

  renderSlot(preference, {}, { settings: { splitScroll: true }, sidebarSplitLayout: panes(0) }).lifecycle.unmount();
  await scripts.lifecycle.dispose();
  expect(scrolling()).toBe(false);
  expect(minWidth()).toBe("");
  send({ width: 2000, focused: null });
  expect(scrolling()).toBe(false);
});

it("scrolls the strip to the pane that takes focus, and not when only its size changes", async () => {
  const { scripts, preference } = await mount();
  const { scrollTo } = hostSplit();
  const settings = { splitScroll: true };

  // The first pane is already in view.
  const first = renderSlot(preference, {}, { settings, sidebarSplitLayout: panes(0) });
  expect(scrollTo).not.toHaveBeenCalled();
  first.lifecycle.unmount();

  // The last pane is off to the right: 2560 wide strip, 1280 wide view.
  const last = renderSlot(preference, {}, { settings, sidebarSplitLayout: panes(3) });
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 1280, behavior: "smooth" });
  // The strip is wider than the view, which the header spacing keys on.
  expect(overflowing()).toBe(true);
  last.lifecycle.unmount();

  // The same pane, resized: no scroll, and the strip keeps its width.
  scrollTo.mockClear();
  const resized = panes(3);
  resized.panes[2]!.rect = rect(0.5, 0.3);
  resized.panes[3]!.rect = rect(0.8, 0.2);
  renderSlot(preference, {}, { settings, sidebarSplitLayout: resized }).lifecycle.unmount();
  expect(scrollTo).not.toHaveBeenCalled();
  expect(minWidth()).toBe("2560px");
  await scripts.lifecycle.dispose();
});

it("leaves the strip alone while a divider is dragged or a pane is maximized, then returns to the focused pane", async () => {
  const controller = new AbortController();
  mountSplitScroll({ signal: controller.signal });
  const { scroller, scrollTo, pane } = hostSplit();
  const focus = (key: string) => send({ width: 2560, focused: { key, x: 0.75, width: 0.25 } });

  scroller.insertAdjacentHTML("beforeend", `<div data-dragging="true"></div>`);
  focus("a");
  expect(scrollTo).not.toHaveBeenCalled();
  scroller.querySelector("[data-dragging]")!.remove();

  pane.setAttribute("data-maximized", "true");
  await Promise.resolve();
  focus("b");
  expect(scrollTo).not.toHaveBeenCalled();

  // Restoring the pane brings the strip back to it, without animation.
  pane.removeAttribute("data-maximized");
  await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 1280, behavior: "auto" }));
  controller.abort();
  expect(scrolling()).toBe(false);
  expect(overflowing()).toBe(false);
});

it("still scrolls to the focused pane when another layout change follows before the next frame", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => frames.push(run));
  const controller = new AbortController();
  mountSplitScroll({ signal: controller.signal });
  const { scrollTo } = hostSplit();
  send({ width: 2560, focused: { key: "last", x: 0.75, width: 0.25 } });
  // A resize of the same pane arrives before BB has painted.
  send({ width: 2560, focused: { key: "last", x: 0.75, width: 0.25 } });
  frames.at(-1)!(0);
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 1280, behavior: "smooth" });
  controller.abort();
});

it("waits for BB to draw a saved split after a page load, then shows the focused pane", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => frames.push(run));
  const controller = new AbortController();
  mountSplitScroll({ signal: controller.signal });
  // The plugin starts first: no split in the page yet.
  send({ width: 2560, focused: { key: "last", x: 0.75, width: 0.25 } });
  frames.shift()!(0);
  frames.shift()!(0);
  expect(overflowing()).toBe(false);
  const { scrollTo } = hostSplit();
  frames.shift()!(0);
  expect(overflowing()).toBe(true);
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 1280, behavior: "smooth" });
  // Found: it stops looking.
  expect(frames).toHaveLength(0);
  controller.abort();
});

it("marks the strip as overflowing only while it is wider than the view", () => {
  const controller = new AbortController();
  mountSplitScroll({ signal: controller.signal });
  hostSplit({ scrollWidth: 1280, clientWidth: 1280 });
  send({ width: 1280, focused: null });
  expect(scrolling()).toBe(true);
  expect(overflowing()).toBe(false);
  document.body.innerHTML = "";
  hostSplit({ scrollWidth: 2560, clientWidth: 1280 });
  send({ width: 2560, focused: null });
  expect(overflowing()).toBe(true);
  send({ width: null, focused: null });
  expect(overflowing()).toBe(false);
  controller.abort();
});

it("ignores malformed preferences and stops listening once aborted", () => {
  const controller = new AbortController();
  const dispose = mountSplitScroll({ signal: controller.signal });
  for (const detail of [true, "on", { width: "2000" }, { width: -1, focused: null }, { width: 2000, focused: { key: 1 } }]) send(detail);
  expect(scrolling()).toBe(false);
  send({ width: 2000, focused: null });
  expect(scrolling()).toBe(true);
  expect(minWidth()).toBe("2000px");
  controller.abort();
  expect(scrolling()).toBe(false);
  expect(minWidth()).toBe("");
  dispose?.();
  mountSplitScroll({ signal: controller.signal });
  send({ width: 2000, focused: null });
  expect(scrolling()).toBe(false);
});
