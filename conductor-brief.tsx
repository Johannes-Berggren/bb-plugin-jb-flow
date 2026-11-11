// The conductor where you already work: its brief on a thread's Catch up card,
// and on the home page what autopilot did for you today.
import "./conductor-brief.css";
import { useState } from "react";
import { useBbNavigate, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import type { ConductorFeed, rpcContract } from "./server";
import { Icon } from "@/components/ui/icon";
import { headlineOf } from "./conductor-model";
import { tokens, useConductorBriefs, useConductorFeed } from "./conductor-client";
import { errorText } from "./flow-state";

const shortReply = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 14 ? `Send “${flat}”` : "Send suggestion";
};

/** The conductor's brief for a thread, as a strip on its Catch up card: what's needed, and a one-click answer. */
export function ConductorBriefStrip({ threadId }: { threadId: string }) {
  const brief = useConductorBriefs().get(threadId);
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  if (!brief || state === "sent") return null;
  const { item } = brief;
  const send = async () => {
    setState("sending");
    setError(null);
    try {
      await rpc.call("conductor_card", { workspaceId: brief.workspaceId, threadId, action: "go" });
      setState("sent");
    } catch (cause) {
      setError(errorText(cause));
      setState("idle");
    }
  };
  return (
    <div className="jf-brief" data-kind={item.kind} role="note" aria-label="The conductor's brief">
      <span className="jf-brief-icon">
        <Icon name="Workflow" />
      </span>
      <div className="jf-brief-main">
        <p className="jf-brief-headline">{headlineOf(item, 120)}</p>
        {item.recommendation && <p className="jf-brief-rec">{item.recommendation}</p>}
        {error && (
          <p role="alert" className="jf-brief-error">
            {error}
          </p>
        )}
      </div>
      {item.reply && (
        <button type="button" className="jf-brief-send" disabled={state === "sending"} title={`Send to the thread: ${item.reply}`} onClick={() => void send()}>
          {state === "sending" ? "Sending…" : shortReply(item.reply)}
        </button>
      )}
    </div>
  );
}

const FEED: Record<string, { icon: string; label: string }> = {
  "auto-merged": { icon: "GitMerge", label: "Merged" },
  "auto-archived": { icon: "Archive", label: "Archived" },
  absorbed: { icon: "CircleCheck", label: "Noted" },
  forwarded: { icon: "Sent", label: "Passed on" },
  "merge-refused": { icon: "AlertTriangle", label: "Couldn't merge" },
};

function time(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Today's totals, in a sentence. */
export function feedSummary(feed: Pick<ConductorFeed, "merged" | "archived" | "wakeupsSpared" | "tokensSpared">): string {
  const parts = [
    feed.merged ? `${feed.merged} merged` : null,
    feed.archived ? `${feed.archived} archived` : null,
    feed.wakeupsSpared ? `${feed.wakeupsSpared} wake-up${feed.wakeupsSpared === 1 ? "" : "s"} spared${feed.tokensSpared ? ` (≈${tokens(feed.tokensSpared)} tokens)` : ""}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing yet today";
}

/** Home page: what autopilot did for you today, with undo for archives. */
export function DoneForYouSection() {
  const feed = useConductorFeed();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [showAll, setShowAll] = useState(false);
  const [restored, setRestored] = useState<Set<string>>(new Set());
  if (!feed) return null;
  const shown = showAll ? feed.entries : feed.entries.slice(0, 6);
  return (
    <section className="jf-feed" aria-label="Done for you">
      <p className="jf-feed-summary">
        <Icon name="Workflow" />
        <span>{feedSummary(feed)}</span>
        {feed.refused > 0 && <span className="jf-feed-refused">{feed.refused} couldn't merge: see the conductor</span>}
      </p>
      {shown.length > 0 && (
        <ol className="jf-feed-list">
          {shown.map((entry) => {
            const meta = FEED[entry.kind] ?? { icon: "Circle", label: entry.kind };
            return (
              <li key={entry.id} data-kind={entry.kind}>
                <span className="jf-feed-icon">
                  <Icon name={meta.icon} />
                </span>
                <span className="jf-feed-main">
                  {entry.threadId ? (
                    <button type="button" className="jf-feed-title" onClick={() => navigate.toThread(entry.threadId!, { split: true })}>
                      {entry.title || "A thread"}
                    </button>
                  ) : null}
                  <span className="jf-feed-text">{entry.text}</span>
                </span>
                <span className="jf-feed-meta">
                  {entry.savedTokens ? <span title="What waking the thread would have cost">≈{tokens(entry.savedTokens)}</span> : null}
                  <span>{time(entry.at)}</span>
                  {entry.kind === "auto-archived" && entry.threadId && !restored.has(entry.threadId) && (
                    <button
                      type="button"
                      className="jf-feed-undo"
                      onClick={() => {
                        const threadId = entry.threadId!;
                        void sdk.threads.unarchive({ threadId }).then(() => setRestored((current) => new Set(current).add(threadId)), () => undefined);
                      }}
                    >
                      Unarchive
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {feed.entries.length > 6 && (
        <button type="button" className="jf-feed-more" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Fewer" : `All ${feed.entries.length}`}
        </button>
      )}
    </section>
  );
}
