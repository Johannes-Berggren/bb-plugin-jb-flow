import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, RefObject } from "react";
import { useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { DecisionGroup, DecisionMode, DecisionOption } from "./decisions";
import { CALLOUT_ATTR } from "./callouts";
import { Icon } from "@/components/ui/icon";
import "./decision-choices.css";
import { notifyReplyChoiceSent } from "./next-in-now";
import { ThreadControl, useThreadControl } from "./thread-controls";

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

/** Marks message content repeated by the visible reply buttons. CSS hides it. */
export const REPEATED_LIST_ATTR = "data-jf-choices-repeated";

const cleanText = (text: string) => text.replace(/\s+/g, " ").trim();
const textOf = (element: Element) => cleanText(element.textContent ?? "");
// Keep rich content and any code that the controls' plain-text conversion can change.
const simpleText = (element: Element) =>
  !element.querySelector(":not(p, strong, em, code, br)") &&
  Array.from(element.querySelectorAll("code")).every((code) =>
    code.textContent === textOf(code) && !/\(recommended\)/i.test(code.textContent),
  );

/** The ordered list in the latest message whose items are these options, if any. */
export function repeatedList(scope: Element, options: readonly DecisionOption[]): HTMLOListElement | null {
  if (options.length === 0) return null;
  const matches = (list: HTMLOListElement) => {
    if (list.reversed || list.start !== options[0]!.n) return false;
    const items = Array.from(list.children);
    if (items.length !== options.length) return false;
    return items.every((item, index) => {
      if (item.tagName !== "LI" || item.hasAttribute("value") || !simpleText(item)) return false;
      const option = options[index]!;
      const text = textOf(item);
      return text === option.text ||
        (option.recommended && text.replace(/\s*\(recommended\)$/i, "") === option.text);
    });
  };
  // Newest row first. A compact thread can end in rows that hold no message (a
  // work summary, a turn footer), so look past them instead of only at the last.
  const row = Array.from(scope.querySelectorAll("[data-timeline-row-id]")).reverse()
    .find((element) => element.querySelector("[data-markdown-preview], ol"));
  return Array.from(row?.querySelectorAll("ol") ?? []).reverse().find(matches) ?? null;
}

/** The nearest ancestor of the buttons that holds the thread's messages. */
function messageScope(from: Element | null): Element | null {
  for (let node = from?.parentElement ?? null; node; node = node.parentElement) {
    if (node.querySelector("[data-timeline-row-id]")) return node;
  }
  return null;
}

const REPLY_LINE: Record<DecisionMode, RegExp> = {
  choice: /^Reply with (?:the|a) (?:number|option)\.?$/i,
  multi: /^Reply with (?:the numbers|one or more numbers)(?:, e\.g\.?,? \d+(?:,\s*\d+)*)?\.?$/i,
  go: /^Reply go(?: to run it| for all(?:, or go \d+(?:,\s*\d+)*)?)?\.?$/i,
};

/** The standard reply instruction, when the controls offer the same way to answer. */
function repeatedReplyLine(list: Element, mode: DecisionMode): Element | null {
  const next = list.nextElementSibling;
  return next?.tagName === "P" && simpleText(next) && REPLY_LINE[mode].test(textOf(next)) ? next : null;
}

/** The heading and Tip callouts can go when every block is represented in the controls. */
function repeatedNextSteps(lists: readonly (HTMLOListElement | null)[], groups: readonly DecisionGroup[]): Element[] {
  if (lists.length !== groups.length || groups.some(({ title }) => !title)) return [];
  const quotes = [...new Set(lists.map((list) => list?.parentElement))];
  const heading = quotes[0]?.previousElementSibling;
  if (!heading?.matches("h2, h3, h4") || !/^Next steps?$/i.test(textOf(heading)) || !simpleText(heading)) return [];
  const hidden = [heading];
  let sibling = heading.nextElementSibling;
  let index = 0;
  for (const quote of quotes) {
    if (!quote || quote !== sibling || quote.tagName !== "BLOCKQUOTE") return [];
    const blocks = Array.from(quote.children);
    const first = blocks[0];
    const hasMarker = first?.tagName === "P" && /^\[!TIP\]/i.test(textOf(first));
    if (!(hasMarker || quote.getAttribute(CALLOUT_ATTR) === "tip")) return [];
    if (Array.from(quote.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) return [];
    if (first?.tagName === "P" && simpleText(first) && /^(?:\[!TIP\])?$/i.test(textOf(first))) blocks.shift();
    while (blocks.length) {
      const [title, list] = blocks.splice(0, 2);
      const group = groups[index];
      if (!group || !list || list !== lists[index] || title?.tagName !== "P" || !simpleText(title)) return [];
      const titleText = title === first && hasMarker ? textOf(title).replace(/^\[!TIP\]\s*/i, "") : textOf(title);
      if (titleText !== group.title) return [];
      if (blocks[0] === repeatedReplyLine(list, group.mode)) blocks.shift();
      index += 1;
    }
    hidden.push(quote);
    sibling = quote.nextElementSibling;
  }
  // A status report's timestamp sits after the callouts. Leave it and any following sections visible.
  const endsSection = !sibling || sibling.matches("h1, h2, h3, h4, h5, h6") ||
    (sibling.tagName === "P" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Z]{2,5}$/.test(textOf(sibling)));
  return index === groups.length && endsSection ? hidden : [];
}

/** Hide duplicate content only while the controls that replace it are mounted. */
function useHideRepeatedList(
  section: RefObject<HTMLElement | null>,
  groups: readonly DecisionGroup[],
  enabled: boolean,
) {
  const [visibility, setVisibility] = useState<"original" | "lists" | "section">("original");
  useLayoutEffect(() => {
    if (!enabled || groups.every(({ options }) => options.length === 0)) return;
    const scope = messageScope(section.current);
    if (!scope) return;
    let marked: Element[] = [];
    const apply = () => {
      const found = groups.map(({ options }) => repeatedList(scope, options));
      const steps = repeatedNextSteps(found, groups);
      const next = steps.length ? steps : found.flatMap((list, index) => {
        if (!list) return [];
        const reply = repeatedReplyLine(list, groups[index]!.mode);
        return reply ? [list, reply] : [list];
      });
      if (next.length === marked.length && next.every((element, index) => element === marked[index])) return;
      for (const element of marked) element.removeAttribute(REPEATED_LIST_ATTR);
      for (const element of next) element.setAttribute(REPEATED_LIST_ATTR, "");
      marked = next;
      setVisibility(steps.length ? "section" : next.length ? "lists" : "original");
    };
    apply();
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    });
    observer.observe(scope, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: [CALLOUT_ATTR] });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      for (const element of marked) element.removeAttribute(REPEATED_LIST_ATTR);
      setVisibility("original");
    };
  }, [section, groups, enabled]);
  return visibility;
}

const recommendedOf = (options: readonly DecisionOption[]) => options.filter((option) => option.recommended).map((option) => option.n);

function Choices({ threadId, updatedAt }: { threadId: string; updatedAt: number | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const hideRepeated = useSettings().values?.hideRepeatedChoices !== false;
  const open = useThreadControl("choices");
  const sectionRef = useRef<HTMLElement>(null);
  const [move, setMove] = useState<{ mode?: DecisionMode; options: DecisionOption[]; groups?: DecisionGroup[] }>({ options: [] });
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
  const grouped = (move.groups?.length ?? 0) > 1 ? move.groups! : null;
  const groups = useMemo(
    () => move.groups?.length ? move.groups : [{ mode: move.mode ?? "choice", title: "", label: "", options: move.options }],
    [move],
  );
  const visibility = useHideRepeatedList(sectionRef, groups, hideRepeated && open !== false);
  const listHidden = visibility !== "original";
  if (grouped) {
    const count = grouped.reduce((total, group) => total + group.options.length, 0);
    return (
      <ThreadControl name="choices" label="Your next move" count={count} icon="MessageCircle" title={`Your next move · ${count} options`}>
        <GroupedChoices key={shown.current} sectionRef={sectionRef} threadId={threadId} groups={grouped} listHidden={listHidden} />
      </ThreadControl>
    );
  }
  if (!options.length) return null;
  const title = visibility === "section" ? groups[0]?.title : undefined;
  // A go-list: tick steps, then Go sends "go" (all) or "go 1,3".
  const go = move.mode === "go";
  // Several numbers: tick options, then Send sends "1,3".
  const multi = !go && (move.mode === "multi" || several);
  const ticking = go || multi;
  // One step to run: nothing to tick, only Go.
  const oneStep = go && options.length === 1;
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
      notifyReplyChoiceSent(threadId);
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
  const content = (
    <section ref={sectionRef} className="jf-choices" aria-label="Reply choices" data-mode={mode} data-full={listHidden || undefined}>
      <div className="jf-choices-heading">
        <Icon name="MessageCircle" className="size-3.5" />
        <span className="jf-choices-title">Your next move</span>
        <span className="jf-choices-hint">
          <span className="jf-choices-hint-text">{oneStep ? "Go runs it" : go ? "Pick steps, or Go for all" : multi ? "Pick one or more" : "Choose a reply"}</span>
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
      {title && (
        <div className="jf-choices-group-heading">
          <span className="jf-choices-group-title">{title}</span>
        </div>
      )}
      <div className="jf-choices-list" role="group" aria-label={title ?? (go ? "Steps" : "Options")} onKeyDown={onKeyDown}>
        {options.map((option) => {
          const text = String(option.n);
          const label = `${option.text}${option.recommended ? " (recommended)" : ""}`;
          if (oneStep)
            return (
              <div key={option.n} className="jf-choice" data-recommended={option.recommended} title={option.text}>
                <span className="jf-choice-number" aria-hidden="true">
                  {option.n}
                </span>
                <span className="jf-choice-text">{option.text}</span>
                {option.recommended && <span className="jf-choice-meta">Recommended</span>}
              </div>
            );
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
  return (
    <ThreadControl name="choices" label="Your next move" count={options.length} icon="MessageCircle" title={`Your next move · ${options.length} ${oneStep ? "step" : "options"}`}>
      {content}
    </ThreadControl>
  );
}

// --- several lists in one reply -------------------------------------------------------

/** What a group's picks say: "go", "go 1,3", "2" or "1,3"; null while nothing is picked. */
export function groupAnswer(group: Pick<DecisionGroup, "mode" | "options">, picked: readonly number[] | "all" | undefined): string | null {
  if (picked === undefined) return null;
  if (group.mode === "go") {
    if (picked === "all" || picked.length === group.options.length) return "go";
    return picked.length ? `go ${[...picked].sort((a, b) => a - b).join(",")}` : null;
  }
  if (picked === "all" || picked.length === 0) return null;
  return [...picked].sort((a, b) => a - b).join(",");
}

/** One reply that answers every picked list on its own line: "Path forward: go 1,3" and "Decision needed: 1". */
export function combinedReply(groups: readonly Pick<DecisionGroup, "mode" | "label" | "options">[], picks: Readonly<Record<number, readonly number[] | "all">>): string {
  return groups
    .flatMap((group, index) => {
      const answer = groupAnswer(group, picks[index]);
      return answer === null ? [] : [`${group.label || `List ${index + 1}`}: ${answer}`];
    })
    .join("\n");
}

/**
 * A reply that ends with several lists (a path forward and a decision): each
 * list is answered on its own, and one Send replies to all the picked ones at
 * once, so the agent never gets "go" for one list while the other waits.
 */
function GroupedChoices({
  sectionRef,
  threadId,
  groups,
  listHidden,
}: {
  sectionRef: RefObject<HTMLElement | null>;
  threadId: string;
  groups: readonly DecisionGroup[];
  listHidden: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [picks, setPicks] = useState<Record<number, number[] | "all">>({});
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const text = combinedReply(groups, picks);
  const busy = pending || sent !== null;
  const pick = (index: number, n: number) =>
    setPicks((current) => {
      const group = groups[index]!;
      const before = current[index];
      const list = before === undefined || before === "all" ? [] : before;
      // One number: picking another replaces it, picking it again clears it.
      const next = group.mode === "choice" ? (list.includes(n) ? [] : [n]) : list.includes(n) ? list.filter((value) => value !== n) : [...list, n];
      const copy = { ...current };
      if (next.length) copy[index] = next;
      else delete copy[index];
      return copy;
    });
  const goAll = (index: number) =>
    setPicks((current) => {
      const copy = { ...current };
      if (copy[index] === "all") delete copy[index];
      else copy[index] = "all";
      return copy;
    });
  const send = async () => {
    if (locked.current || !text) return;
    locked.current = true;
    setPending(true);
    setError(null);
    try {
      await rpc.call("thread_reply", { threadId, text });
      notifyReplyChoiceSent(threadId);
      if (mounted.current) {
        setSent(text);
        setPending(false);
      }
    } catch {
      if (mounted.current) {
        locked.current = false;
        setPending(false);
        setError("Reply could not be sent. Press Send to retry.");
      }
    }
  };
  return (
    <section ref={sectionRef} className="jf-choices" aria-label="Reply choices" data-mode="grouped" data-full={listHidden || undefined}>
      <div className="jf-choices-heading">
        <Icon name="MessageCircle" className="size-3.5" />
        <span className="jf-choices-title">Your next move</span>
        <span className="jf-choices-hint">
          <span className="jf-choices-hint-text">Answer each, then send once</span>
        </span>
      </div>
      {groups.map((group, index) => {
        const picked = picks[index];
        const name = group.label || `List ${index + 1}`;
        return (
          <div key={index} className="jf-choices-group" role="group" aria-label={group.title || name} data-mode={group.mode}>
            <div className="jf-choices-group-heading">
              <span className="jf-choices-group-title" title={group.title}>
                {group.title || name}
              </span>
              {group.mode === "go" ? (
                <button type="button" className="jf-choices-toggle" aria-pressed={picked === "all"} disabled={busy} onClick={() => goAll(index)}>
                  Go with all
                </button>
              ) : (
                <span className="jf-choices-group-hint">{group.mode === "multi" ? "One or more" : "One"}</span>
              )}
            </div>
            <div className="jf-choices-list">
              {group.options.map((option) => {
                const selected = picked === "all" || (picked?.includes(option.n) ?? false);
                return (
                  <button
                    key={option.n}
                    type="button"
                    role={group.mode === "choice" ? "radio" : "checkbox"}
                    className="jf-choice"
                    data-recommended={option.recommended}
                    data-selected={selected}
                    aria-checked={selected}
                    disabled={busy}
                    aria-label={`${name} ${option.n}: ${option.text}${option.recommended ? " (recommended)" : ""}`}
                    title={option.text}
                    onClick={() => pick(index, option.n)}
                  >
                    <span className="jf-choice-number" aria-hidden="true">
                      {selected ? <Icon name="Check" className="size-3" /> : option.n}
                    </span>
                    <span className="jf-choice-text">{option.text}</span>
                    {option.recommended && <span className="jf-choice-meta">Recommended</span>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="jf-choices-actions">
        {sent !== null ? (
          <span role="status">Reply sent</span>
        ) : (
          <>
            {text ? <span className="jf-choices-preview">{text.split("\n").join(" · ")}</span> : null}
            <button type="button" className="jf-choices-submit" disabled={pending || !text} aria-busy={pending} onClick={() => void send()}>
              {pending ? "Sending…" : "Send"}
            </button>
          </>
        )}
      </div>
      {error && (
        <p className="jf-choices-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
