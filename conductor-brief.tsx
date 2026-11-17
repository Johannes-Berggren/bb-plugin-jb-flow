// The conductor where you already work: on the home page, what autopilot did
// for you today.
import "./conductor-brief.css";
import { useState } from "react";
import { useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import type { ConductorFeed } from "./server";
import { Icon } from "@/components/ui/icon";
import { tokens, useConductorFeed, useConductorList } from "./conductor-client";

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
  const conductors = useConductorList().filter((entry) => entry.active && entry.threadId);
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
      {conductors.length > 0 && (
        <p className="jf-feed-conductors">
          <span>Conductors</span>
          {conductors.map((entry) => (
            <button key={entry.workspaceId} type="button" onClick={() => navigate.toPluginPanel("conductor", { subPath: entry.workspaceId })}>
              {entry.name}
            </button>
          ))}
        </p>
      )}
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
