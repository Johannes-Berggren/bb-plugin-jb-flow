import { afterEach, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { mountShellAppearance } from "./shell-appearance";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("jb-flow-shell");
});

it("applies globally, follows the appearance setting, and cleans up on disable/reload", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const mounted = await mountPluginContentScripts(
    {
      ...app,
      contentScripts: app.contentScripts.filter(
        (script) => script.id === "shell-appearance",
      ),
    },
    { pluginId: "jb-flow", generation: 1 },
  );
  const preference = app.appOverlays.find(
    (overlay) => overlay.id === "shell-appearance-preference",
  )!;
  expect(document.documentElement.classList.contains("jb-flow-shell")).toBe(
    true,
  );

  const disabled = renderSlot(
    preference,
    {},
    { settings: { polishShell: false } },
  );
  expect(document.documentElement.classList.contains("jb-flow-shell")).toBe(
    false,
  );
  disabled.lifecycle.unmount();

  const enabled = renderSlot(
    preference,
    {},
    { settings: { polishShell: true } },
  );
  expect(document.documentElement.classList.contains("jb-flow-shell")).toBe(
    true,
  );
  enabled.lifecycle.unmount();

  await mounted.lifecycle.dispose();
  expect(document.documentElement.classList.contains("jb-flow-shell")).toBe(
    false,
  );
  window.dispatchEvent(
    new CustomEvent("jb-flow-shell-appearance", { detail: true }),
  );
  expect(document.documentElement.classList.contains("jb-flow-shell")).toBe(
    false,
  );
});

it("removes shell styling immediately on abort and ignores malformed preferences", () => {
  const controller = new AbortController();
  const dispose = mountShellAppearance({ signal: controller.signal });
  window.dispatchEvent(
    new CustomEvent("jb-flow-shell-appearance", { detail: "false" }),
  );
  expect(document.documentElement.classList.contains("jb-flow-shell")).toBe(
    true,
  );
  controller.abort();
  expect(document.documentElement.classList.contains("jb-flow-shell")).toBe(
    false,
  );
  dispose?.();
  mountShellAppearance({ signal: controller.signal });
  expect(document.documentElement.classList.contains("jb-flow-shell")).toBe(
    false,
  );
});
