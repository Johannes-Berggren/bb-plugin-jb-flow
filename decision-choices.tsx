import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, RefObject } from "react";
import { useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { DecisionMode, DecisionOption } from "./decisions";
import { Icon } from "@/components/ui/icon";
import "./decision-choices.css";

export function DecisionChips({
  threadId,
  updatedAt,
  idle,
}: {
  threadId: string | null;
  updatedAt: number | null;
  idle: boolean;
}) {
  // Keyed by thread only: marking a thread read also moves updatedAt, and a
  // remount then would drop what's ticked, turning the next click into a send.
  return threadId && idle ? <Choices key={threadId} threadId={threadId} updatedAt={updatedAt} /> : null;
}

/** Marks the agent's numbered list that these buttons repeat. CSS hides it. */
export const REPEATED_LIST_ATTR = "data-jf-choices-repeated";

const comparable = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** The ordered list in the latest message whose items are these options, if any. */
export function repeatedList(scope: Element, options: readonly DecisionOption[]): HTMLOListElement | null {
  const rows = scope.querySelectorAll("[data-timeline-row-id]");
  const last = rows[rows.length - 1];
  if (!last || options.length === 0) return null;
  const lists = Array.from(last.querySelectorAll("ol")).reverse();
  return (
    lists.find((list) => {
      const items = Array.from(list.children).filter((child) => child.tagName === "LI");
      if (items.length !== options.length) return false;
      return items.every((item, index) => {
        const want = comparable(options[index]!.text).slice(0, 32);
        return want.length > 0 && comparable(item.textContent ?? "").includes(want);
      });
    }) ?? null
  );
}

/** The nearest ancestor of the buttons that holds the thread's messages. */
function messageScope(from: Element | null): Element | null {
  for (let node = from?.parentElement ?? null; node; node = node.parentElement) {
    if (node.querySelector("[data-timeline-row-id]")) return node;
  }
  return null;
}

/** A line after the list that only says how to answer it: "Reply with the number(s)…", "Reply go for all…". */
const REPLY_LINE =
  /^\s*(?:reply|answer|respond|write|type|say|send|pick|choose|select|tick)\b[^\n]{0,80}?\b(?:numbers?|number\(s\)|go|options?|one or more|all that apply)\b/i;

/** The paragraphs right after the list that only tell you how to answer it; the buttons replace them too. */
export function repeatedReplyLines(list: Element): Element[] {
  const lines: Element[] = [];
  for (let next = list.nextElementSibling; next && lines.length < 2; next = next.nextElementSibling) {
    const text = next.textContent?.trim() ?? "";
    if (next.tagName !== "P" || text.length > 160 || !REPLY_LINE.test(text)) break;
    lines.push(next);
  }
  return lines;
}

/** While the buttons show, hide the same list (and its "Reply with…" line) in the message above them. */
function useHideRepeatedList(section: RefObject<HTMLElement | null>, options: readonly DecisionOption[], enabled: boolean) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!enabled || options.length === 0) return;
    const scope = messageScope(section.current);
    if (!scope) return;
    let marked: Element[] = [];
    const apply = () => {
      const list = repeatedList(scope, options);
      const next = list ? [list, ...repeatedReplyLines(list)] : [];
      if (next.length === marked.length && next.every((element, index) => element === marked[index])) return;
      for (const element of marked) element.removeAttribute(REPEATED_LIST_ATTR);
      for (const element of next) element.setAttribute(REPEATED_LIST_ATTR, "");
      marked = next;
      setHidden(list !== null);
    };
    apply();
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    });
    observer.observe(scope, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      for (const element of marked) element.removeAttribute(REPEATED_LIST_ATTR);
      setHidden(false);
    };
  }, [section, options, enabled]);
  return hidden;
}

const recommendedOf = (options: readonly DecisionOption[]) => options.filter((option) => option.recommended).map((option) => option.n);

function Choices({ threadId, updatedAt }: { threadId: string; updatedAt: number | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const hideRepeated = useSettings().values?.hideRepeatedChoices !== false;
  const sectionRef = useRef<HTMLElement>(null);
  const [move, setMove] = useState<{ mode?: DecisionMode; options: DecisionOption[] }>({ options: [] });
  // "Pick several": a one-number decision switched to ticking.
  const [several, setSeveral] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const mounted = useRef(false);
  // What the panel shows now, so a re-read that finds the same options changes nothing.
  const shown = useRef("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    rpc.call("decision_options", { threadId }).then(
      (result) => {
        const signature = JSON.stringify(result);
        if (!live || signature === shown.current) return;
        // New options: start over. Several can go together: the recommended ones start ticked.
        shown.current = signature;
        setMove(result);
        setSeveral(false);
        setPicked(result.mode === "multi" ? recommendedOf(result.options) : []);
        setPending(null);
        setSent(null);
        setError(null);
        locked.current = false;
      },
      // A failed re-read keeps what's showing.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rpc, threadId, updatedAt]);
  const { options } = move;
  const listHidden = useHideRepeatedList(sectionRef, options, hideRepeated);
  if (!options.length) return null;
  // A go-list: tick steps, then Go sends "go" (all) or "go 1,3".
  const go = move.mode === "go";
  // Several numbers: tick options, then Send sends "1,3".
  const multi = !go && (move.mode === "multi" || several);
  const ticking = go || multi;
  const mode = go ? "go" : multi ? "multi" : "choice";
  const steps = [...picked].sort((a, b) => a - b);
  // Every step ticked is the same as none: "go".
  const goText = steps.length && steps.length < options.length ? `go ${steps.join(",")}` : "go";
  const sendText = steps.join(",");
  const busy = pending !== null || sent !== null;
  const reply = async (text: string) => {
    if (locked.current) return;
    locked.current = true;
    setPending(text);
    setError(null);
    try {
      await rpc.call("thread_reply", { threadId, text });
      if (mounted.current) {
        setSent(text);
        setPending(null);
      }
    } catch {
      if (mounted.current) {
        locked.current = false;
        setPending(null);
        setError(
          go
            ? "Reply could not be sent. Press Go to retry."
            : multi
              ? "Reply could not be sent. Press Send to retry."
              : "Reply could not be sent. Choose an option to retry.",
        );
      }
    }
  };
  const toggle = (n: number) => setPicked((current) => (current.includes(n) ? current.filter((value) => value !== n) : [...current, n]));
  const pickSeveral = (on: boolean, first?: number) => {
    setSeveral(on);
    setPicked(on && first !== undefined ? [first] : []);
  };
  const onChoiceClick = (event: MouseEvent<HTMLButtonElement>, n: number) => {
    // ⌘/Ctrl-click starts picking several instead of sending this one.
    if (event.metaKey || event.ctrlKey) pickSeveral(true, n);
    else void reply(String(n));
  };
  // Arrows, Home/End move between options; a digit ticks that option, or moves to it when a click sends.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".jf-choice"));
    const at = rows.findIndex((row) => row === document.activeElement);
    let target: number;
    if (event.key === "ArrowDown") target = Math.min(rows.length - 1, at + 1);
    else if (event.key === "ArrowUp") target = Math.max(0, at - 1);
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = rows.length - 1;
    else if (/^[1-9]$/.test(event.key)) {
      target = options.findIndex((option) => option.n === Number(event.key));
      if (target < 0) return;
      if (ticking && !busy) toggle(options[target]!.n);
    } else return;
    event.preventDefault();
    rows[target]?.focus();
  };
  return (
    <section ref={sectionRef} className="jf-choices" aria-label="Reply choices" data-mode={mode} data-full={listHidden || undefined}>
      <div className="jf-choices-heading">
        <Icon name="MessageCircle" className="size-3.5" />
        <span className="jf-choices-title">Your next move</span>
        <span className="jf-choices-hint">
          {go ? "Pick steps, or Go for all" : multi ? "Pick one or more" : "Choose a reply"}
          {!go && move.mode !== "multi" ? (
            <button
              type="button"
              className="jf-choices-toggle"
              aria-pressed={several}
              disabled={busy}
              title="Tick several options and send them together (or ⌘-click an option)"
              onClick={() => pickSeveral(!several)}
            >
              Pick several
            </button>
          ) : null}
        </span>
      </div>
      <div className="jf-choices-list" role="group" aria-label={go ? "Steps" : "Options"} onKeyDown={onKeyDown}>
        {options.map((option) => {
          const text = String(option.n);
          const label = `${option.text}${option.recommended ? " (recommended)" : ""}`;
          if (ticking) {
            const selected = picked.includes(option.n);
            return (
              <button
                key={option.n}
                type="button"
                role="checkbox"
                className="jf-choice"
                data-recommended={option.recommended}
                data-selected={selected}
                aria-checked={selected}
                disabled={busy}
                aria-label={`${go ? "Step" : "Option"} ${option.n}: ${label}`}
                title={option.text}
                onClick={() => toggle(option.n)}
              >
                <span className="jf-choice-number" aria-hidden="true">
                  {selected ? <Icon name="Check" className="size-3" /> : option.n}
                </span>
                <span className="jf-choice-text">{option.text}</span>
                {option.recommended && <span className="jf-choice-meta">Recommended</span>}
              </button>
            );
          }
          const selected = pending === text || sent === text;
          return (
            <button
              key={option.n}
              type="button"
              className="jf-choice"
              data-recommended={option.recommended}
              data-selected={selected}
              disabled={busy}
              aria-label={`Reply ${option.n}: ${label}`}
              aria-busy={pending === text}
              title={option.text}
              onClick={(event) => onChoiceClick(event, option.n)}
            >
              <span className="jf-choice-number" aria-hidden="true">
                {sent === text ? (
                  <Icon name="Check" className="size-3" />
                ) : pending === text ? (
                  <Icon name="Loader" className="jf-choice-spinner size-3" />
                ) : (
                  option.n
                )}
              </span>
              <span className="jf-choice-text">{option.text}</span>
              {(option.recommended || selected) && (
                <span className="jf-choice-meta">
                  {pending === text ? "Sending…" : sent === text ? "Reply sent" : "Recommended"}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {ticking && (
        <div className="jf-choices-actions">
          {sent !== null ? (
            <span role="status">Sent “{sent}”</span>
          ) : go ? (
            <button
              type="button"
              className="jf-choices-submit"
              disabled={pending !== null}
              aria-busy={pending !== null}
              onClick={() => void reply(goText)}
            >
              {pending !== null ? "Sending…" : goText === "go" ? "Go" : `Go with ${steps.join(", ")}`}
            </button>
          ) : (
            <button
              type="button"
              className="jf-choices-submit"
              disabled={pending !== null || steps.length === 0}
              aria-busy={pending !== null}
              onClick={() => void reply(sendText)}
            >
              {pending !== null ? "Sending…" : steps.length ? `Send ${steps.join(", ")}` : "Send"}
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="jf-choices-error" role="alert">
          {error}
        </p>
      )}
      {!ticking && sent !== null && (
        <span className="jf-choices-confirmation" role="status">
          Reply {sent} sent
        </span>
      )}
    </section>
  );
}
