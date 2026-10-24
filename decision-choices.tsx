import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
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
  return threadId && idle ? (
    <Choices key={`${threadId}:${updatedAt}`} threadId={threadId} />
  ) : null;
}

function Choices({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [move, setMove] = useState<{ mode?: DecisionMode; options: DecisionOption[] }>({ options: [] });
  const [picked, setPicked] = useState<number[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let live = true;
    rpc.call("decision_options", { threadId }).then(
      (result) => {
        if (live) setMove(result);
      },
      () => {
        if (live) setMove({ options: [] });
      },
    );
    return () => {
      live = false;
      mounted.current = false;
    };
  }, [rpc, threadId]);
  const { options } = move;
  if (!options.length) return null;
  // A go-list: tick steps, then Go sends "go" (all) or "go 1,3".
  const go = move.mode === "go";
  const steps = [...picked].sort((a, b) => a - b);
  const goText = steps.length ? `go ${steps.join(",")}` : "go";
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
        setError(go ? "Reply could not be sent. Press Go to retry." : "Reply could not be sent. Choose an option to retry.");
      }
    }
  };
  const busy = pending !== null || sent !== null;
  return (
    <section className="jf-choices" aria-label="Reply choices" data-mode={go ? "go" : "choice"}>
      <div className="jf-choices-heading">
        <Icon name="MessageCircle" className="size-3.5" />
        <span>YOUR NEXT MOVE</span>
        <span className="jf-choices-hint">{go ? "Pick steps, or Go for all" : "Choose a reply"}</span>
      </div>
      <div className="jf-choices-list">
        {options.map((option) => {
          const text = String(option.n);
          const selected = go ? picked.includes(option.n) : pending === text || sent === text;
          return go ? (
            <button
              key={option.n}
              type="button"
              role="checkbox"
              className="jf-choice"
              data-recommended={option.recommended}
              data-selected={selected}
              aria-checked={selected}
              disabled={busy}
              aria-label={`Step ${option.n}: ${option.text}${option.recommended ? " (recommended)" : ""}`}
              title={option.text}
              onClick={() =>
                setPicked((current) => (current.includes(option.n) ? current.filter((n) => n !== option.n) : [...current, option.n]))
              }
            >
              <span className="jf-choice-number" aria-hidden="true">
                {selected ? <Icon name="Check" className="size-3" /> : option.n}
              </span>
              <span className="jf-choice-text">{option.text}</span>
              {option.recommended && <span className="jf-choice-meta">Recommended</span>}
            </button>
          ) : (
            <button
              key={option.n}
              type="button"
              className="jf-choice"
              data-recommended={option.recommended}
              data-selected={selected}
              disabled={busy}
              aria-label={`Reply ${option.n}: ${option.text}${option.recommended ? " (recommended)" : ""}`}
              aria-busy={pending === text}
              title={option.text}
              onClick={() => void reply(text)}
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
              {(option.recommended || pending === text || sent === text) && (
                <span className="jf-choice-meta">
                  {pending === text ? "Sending…" : sent === text ? "Reply sent" : "Recommended"}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {go && (
        <div className="jf-choices-actions">
          {sent === null ? (
            <button
              type="button"
              className="jf-choices-go"
              disabled={pending !== null}
              aria-busy={pending !== null}
              onClick={() => void reply(goText)}
            >
              {pending !== null ? "Sending…" : steps.length ? `Go with ${steps.join(", ")}` : "Go"}
            </button>
          ) : (
            <span role="status">Sent “{sent}”</span>
          )}
        </div>
      )}
      {error && (
        <p className="jf-choices-error" role="alert">
          {error}
        </p>
      )}
      {!go && sent !== null && (
        <span className="jf-choices-confirmation" role="status">
          Reply {sent} sent
        </span>
      )}
    </section>
  );
}
