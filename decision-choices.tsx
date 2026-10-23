import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { DecisionOption } from "./decisions";
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
  const [options, setOptions] = useState<DecisionOption[]>([]);
  const [pending, setPending] = useState<number | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let live = true;
    rpc.call("decision_options", { threadId }).then(
      (result) => {
        if (live) setOptions(result.options);
      },
      () => {
        if (live) setOptions([]);
      },
    );
    return () => {
      live = false;
      mounted.current = false;
    };
  }, [rpc, threadId]);
  if (!options.length) return null;
  const reply = async (n: number) => {
    if (locked.current) return;
    locked.current = true;
    setPending(n);
    setError(null);
    try {
      await rpc.call("thread_reply", { threadId, text: String(n) });
      if (mounted.current) {
        setSent(n);
        setPending(null);
      }
    } catch {
      if (mounted.current) {
        locked.current = false;
        setPending(null);
        setError("Reply could not be sent. Choose an option to retry.");
      }
    }
  };
  return (
    <section className="jf-choices" aria-label="Reply choices">
      <div className="jf-choices-heading">
        <Icon name="MessageCircle" className="size-3.5" />
        <span>YOUR NEXT MOVE</span>
        <span className="jf-choices-hint">Choose a reply</span>
      </div>
      <div className="jf-choices-list">
        {options.map((option) => (
          <button
            key={option.n}
            type="button"
            className="jf-choice"
            data-recommended={option.recommended}
            data-selected={pending === option.n || sent === option.n}
            disabled={pending !== null || sent !== null}
            aria-label={`Reply ${option.n}: ${option.text}${option.recommended ? " (recommended)" : ""}`}
            aria-busy={pending === option.n}
            title={option.text}
            onClick={() => void reply(option.n)}
          >
            <span className="jf-choice-number" aria-hidden="true">
              {sent === option.n ? (
                <Icon name="Check" className="size-3" />
              ) : pending === option.n ? (
                <Icon name="Loader" className="jf-choice-spinner size-3" />
              ) : (
                option.n
              )}
            </span>
            <span className="jf-choice-text">{option.text}</span>
            {(option.recommended ||
              pending === option.n ||
              sent === option.n) && (
              <span className="jf-choice-meta">
                {pending === option.n
                  ? "Sending…"
                  : sent === option.n
                    ? "Reply sent"
                    : "Recommended"}
              </span>
            )}
          </button>
        ))}
      </div>
      {error && (
        <p className="jf-choices-error" role="alert">
          {error}
        </p>
      )}
      {sent !== null && (
        <span className="jf-choices-confirmation" role="status">
          Reply {sent} sent
        </span>
      )}
    </section>
  );
}
