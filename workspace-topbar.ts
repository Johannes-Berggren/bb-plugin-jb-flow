export const WORKSPACE_BAR_EVENT = "jb-flow-workspace-bar-visible";
const ROOT_CLASS = "jb-flow-workspace-bar";

export function mountWorkspaceTopBar({ signal }: { signal: AbortSignal }) {
  if (signal.aborted) return;
  const root = document.documentElement;
  const update = (event: Event) => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (typeof detail === "boolean") root.classList.toggle(ROOT_CLASS, detail);
  };
  window.addEventListener(WORKSPACE_BAR_EVENT, update, { signal });
  const cleanup = () => root.classList.remove(ROOT_CLASS);
  signal.addEventListener("abort", cleanup, { once: true });
  return () => {
    cleanup();
    window.removeEventListener(WORKSPACE_BAR_EVENT, update);
    signal.removeEventListener("abort", cleanup);
  };
}
