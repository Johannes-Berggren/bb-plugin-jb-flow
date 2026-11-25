import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Icon, type IconProps } from "@/components/ui/icon";
import "./thread-controls.css";

type Control = "choices" | "status" | "prs";
const ControlsContext = createContext<{
  open: Control | null;
  toggle: (control: Control) => void;
  close: (control: Control) => void;
} | null>(null);

/** Null means the original standalone control is in use. */
export function useThreadControl(control: Control): boolean | null {
  const controls = useContext(ControlsContext);
  return controls ? controls.open === control : null;
}

export function ThreadControls({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Control | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const toggle = useCallback((control: Control) => setOpen((current) => current === control ? null : control), []);
  const close = useCallback((control: Control) => setOpen((current) => current === control ? null : current), []);

  useLayoutEffect(() => {
    const element = row.current;
    const pane = element?.closest(".jf-catchup-chat, [data-split-pane-id]");
    if (!element || !pane) return;
    const resize = () => element.style.setProperty("--jf-control-pane-height", `${pane.clientHeight}px`);
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  return (
    <ControlsContext.Provider value={{ open, toggle, close }}>
      <div ref={row} className="jf-thread-controls" role="group" aria-label="Thread controls">
        {children}
      </div>
    </ControlsContext.Provider>
  );
}

export function ThreadControl({
  name, label, count, icon, children, tone, title,
}: {
  name: Control;
  label: string;
  count?: number;
  icon: IconProps["name"];
  children: ReactNode;
  tone?: string;
  title?: string;
}) {
  const controls = useContext(ControlsContext);
  const close = controls?.close;
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => () => close?.(name), [close, name]);
  if (!controls) return children;

  const open = controls.open === name;
  const buttonId = `${id}-toggle`;
  const collapseOnEscape = (event: KeyboardEvent) => {
    if (!open || event.defaultPrevented || event.key !== "Escape") return;
    event.stopPropagation();
    controls.close(name);
    trigger.current?.focus();
  };
  return (
    <>
      <button
        ref={trigger}
        id={buttonId}
        type="button"
        className={`jf-thread-control-toggle ${tone ?? ""}`}
        aria-expanded={open}
        aria-controls={id}
        aria-label={title}
        title={title ?? label}
        onClick={() => controls.toggle(name)}
        onKeyDown={collapseOnEscape}
      >
        <Icon name={icon} className="size-3.5" />
        <span className="jf-thread-control-label">{label}</span>
        {count !== undefined && <span className="jf-thread-control-count">{count}</span>}
        <Icon name={open ? "ChevronUp" : "ChevronDown"} className="jf-thread-control-caret size-3" />
      </button>
      <div
        id={id}
        className="jf-thread-control-panel"
        role="region"
        aria-labelledby={buttonId}
        hidden={!open}
        onKeyDown={collapseOnEscape}
      >
        {children}
      </div>
    </>
  );
}
