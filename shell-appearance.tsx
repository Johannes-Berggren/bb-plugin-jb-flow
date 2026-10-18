import { useEffect } from "react";
import { useSettings } from "@get-bb/plugin-sdk/app";
import "./shell-appearance.css";

const SHELL_CLASS = "jb-flow-shell";
const APPEARANCE_EVENT = "jb-flow-shell-appearance";

/** Keep shell DOM ownership in the content-script lifecycle. No polling or observers. */
export function mountShellAppearance({ signal }: { signal: AbortSignal }) {
  if (signal.aborted) return;
  const root = document.documentElement;
  root.classList.add(SHELL_CLASS);
  const update = (event: Event) => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (typeof detail === "boolean") root.classList.toggle(SHELL_CLASS, detail);
  };
  window.addEventListener(APPEARANCE_EVENT, update, { signal });
  const cleanup = () => root.classList.remove(SHELL_CLASS);
  signal.addEventListener("abort", cleanup, { once: true });
  return () => {
    cleanup();
    window.removeEventListener(APPEARANCE_EVENT, update);
    signal.removeEventListener("abort", cleanup);
  };
}

/** The public settings hook bridges only the appearance preference to the script. */
export function ShellAppearancePreference() {
  const { values, isLoading } = useSettings();
  const enabled = values?.polishShell !== false;
  useEffect(() => {
    if (!isLoading)
      window.dispatchEvent(
        new CustomEvent(APPEARANCE_EVENT, { detail: enabled }),
      );
  }, [enabled, isLoading]);
  return null;
}
