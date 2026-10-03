// UI built on the plugin's thread state: PR stacks (any repo), running/stuck
// detection, the hover preview, the thread-header status strip, the Pull
// requests panel, and command-palette commands.
import { forwardRef, useEffect, useState } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import * as HoverCard from "@radix-ui/react-hover-card";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { JsonValue, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { PrStatus } from "./prs";
import type { FlowState, rpcContract } from "./server";
import { formatWhen } from "./when";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import type { GlyphName } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const STUCK_AFTER_MS = 15 * 60_000;

// --- PR helpers ------------------------------------------------------------------

export type ThreadPr = Pick<PrStatus, "repo" | "number" | "title" | "url" | "state" | "attention"> & {
  stackedOn: number | null;
};

/** Worst first: what most needs attention leads the summary. */
const ATTENTION_RANK: Record<string, number> = {
  conflicts: 0,
  checks_failed: 1,
  changes_requested: 2,
  blocked: 3,
  checks_pending: 4,
  review_requested: 5,
  ready_to_merge: 6,
  draft: 7,
  none: 8,
  merged: 9,
  closed: 10,
};

export const PR_TONE: Record<string, string> = {
  blocked: "text-red-500",
  changes_requested: "text-red-500",
  checks_failed: "text-red-500",
  conflicts: "text-red-500",
  checks_pending: "text-amber-500",
  review_requested: "text-sky-500",
  ready_to_merge: "text-green-500",
  merged: "text-violet-500",
  draft: "text-muted-foreground",
  closed: "text-muted-foreground",
  none: "text-muted-foreground",
};

export function prGlyph(pr: Pick<ThreadPr, "state">): GlyphName {
  return pr.state === "merged" ? "merged" : pr.state === "closed" ? "prClosed" : pr.state === "draft" ? "prDraft" : "pr";
}

export const attentionLabel = (attention: string) => attention.replace(/_/g, " ");

/** Merges the plugin's created-PR list with bb's branch PR, worst first. */
export function threadPrs(
  created: readonly PrStatus[] | undefined,
  branch: { number: number; title: string; url: string; state: string; attention: string } | null,
): ThreadPr[] {
  const prs: ThreadPr[] = [...(created ?? [])];
  if (branch && !prs.some((pr) => pr.url === branch.url)) {
    prs.push({
      repo: /github\.com\/([^/]+\/[^/]+)\//.exec(branch.url)?.[1] ?? "",
      number: branch.number,
      title: branch.title,
      url: branch.url,
      state: branch.state as ThreadPr["state"],
      attention: branch.attention as ThreadPr["attention"],
      stackedOn: null,
    });
  }
  return prs;
}

export function worstPr(prs: readonly ThreadPr[]): ThreadPr | null {
  return [...prs].sort((a, b) => (ATTENTION_RANK[a.attention] ?? 9) - (ATTENTION_RANK[b.attention] ?? 9))[0] ?? null;
}

export const allSettled = (prs: readonly ThreadPr[]) =>
  prs.length > 0 && prs.every((pr) => pr.state === "merged" || pr.state === "closed");

// --- time ------------------------------------------------------------------------

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export type RunInfo = { elapsed: number; silent: number; stuck: boolean };
export function runInfo(running: FlowState["running"][string] | undefined, now: number): RunInfo | null {
  if (!running) return null;
  const silent = now - running.lastEventAt;
  return { elapsed: now - running.since, silent, stuck: silent > STUCK_AFTER_MS };
}

// --- PR list (hover card, panel) ---------------------------------------------------

export function PrList({ prs, compact = false }: { prs: readonly ThreadPr[]; compact?: boolean }) {
  const byRepo = new Map<string, ThreadPr[]>();
  for (const pr of prs) byRepo.set(pr.repo, [...(byRepo.get(pr.repo) ?? []), pr]);
  return (
    <div className="space-y-2">
      {[...byRepo.entries()].map(([repo, list]) => (
        <div key={repo}>
          {byRepo.size > 1 || !compact ? (
            <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {repo.split("/")[1] ?? repo}
            </div>
          ) : null}
          <ul className="space-y-0.5">
            {list.map((pr) => (
              <li key={pr.url} className={cn("flex items-center gap-1.5 text-xs", pr.stackedOn !== null && "pl-3")}>
                {pr.stackedOn !== null ? <span className="text-muted-foreground">└</span> : null}
                <Glyph name={prGlyph(pr)} className={cn("size-3.5", PR_TONE[pr.attention])} />
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => event.stopPropagation()}
                  className="shrink-0 tabular-nums hover:underline"
                >
                  #{pr.number}
                </a>
                <span className="min-w-0 flex-1 truncate">{pr.title}</span>
                <span className={cn("shrink-0 text-[10px]", PR_TONE[pr.attention])}>{attentionLabel(pr.attention)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// --- hover preview -----------------------------------------------------------------

function ago(timestamp: number, now: number): string {
  return `${duration(now - timestamp)} ago`;
}

type HoverPreviewProps = {
  thread: PluginSidebarThread;
  projectName: string | null;
  sectionName: string | null;
  tags: readonly string[];
  prs: readonly ThreadPr[];
  run: RunInfo | null;
  watching: FlowState["watching"][string] | undefined;
  snoozeUntil: number | undefined;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"a">, "children">;

/**
 * Wraps a row in a hover card. Forwards the ref and any props (event handlers
 * from an outer `asChild` trigger such as the context menu) to the row
 * element, so wrapping never swallows right-click or keyboard handling.
 */
export const ThreadHoverPreview = forwardRef<HTMLAnchorElement, HoverPreviewProps>(function ThreadHoverPreview(
  { thread, projectName, sectionName, tags, prs, run, watching, snoozeUntil, children, ...triggerProps },
  ref,
) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ lastAssistant: string; lastUser: string; prompts: number } | null>(null);
  const now = Date.now();
  useEffect(() => {
    if (!open || preview !== null) return;
    rpc.call("thread_preview", { threadId: thread.id }).then(setPreview, () =>
      setPreview({ lastAssistant: "", lastUser: "", prompts: 0 }),
    );
  }, [open, preview, rpc, thread.id]);
  // Refresh the text next time the card opens after the thread changed.
  useEffect(() => setPreview(null), [thread.updatedAt]);

  const meta = [
    projectName,
    sectionName,
    thread.environment?.branchName ? `⎇ ${thread.environment.branchName}` : null,
    thread.host?.name ?? null,
    `created ${ago(thread.createdAt, now)}`,
    `updated ${ago(thread.updatedAt, now)}`,
    preview && preview.prompts > 0 ? `${preview.prompts} prompts` : null,
  ].filter(Boolean);

  return (
    <HoverCard.Root open={open} onOpenChange={setOpen} openDelay={650} closeDelay={80}>
      <HoverCard.Trigger asChild {...triggerProps} ref={ref}>
        {children}
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="right"
          align="start"
          sideOffset={12}
          collisionPadding={12}
          className="z-50 w-[36rem] max-w-[calc(100vw-2rem)] space-y-3 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl"
        >
          <div>
            <div className="text-[15px] font-medium leading-snug">{thread.displayTitle}</div>
            <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
              {meta.map((item) => (
                <span key={item}>{item}</span>
              ))}
              {tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </div>
          </div>
          {run || watching || snoozeUntil !== undefined || thread.isUnread ? (
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              {run ? (
                <span className={cn("rounded px-1.5 py-0.5", run.stuck ? "bg-amber-500/15 text-amber-600" : "bg-sky-500/10 text-sky-600")}>
                  {run.stuck ? `no output for ${duration(run.silent)} · running ${duration(run.elapsed)}` : `running ${duration(run.elapsed)}`}
                </span>
              ) : null}
              {watching ? <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{watching.label}</span> : null}
              {snoozeUntil !== undefined ? (
                <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">snoozed until {formatWhen(snoozeUntil)}</span>
              ) : null}
              {thread.isUnread ? <span className="rounded bg-green-500/10 px-1.5 py-0.5 text-green-600">unread</span> : null}
            </div>
          ) : null}
          {prs.length > 0 ? (
            <div className="rounded-md border border-border p-2">
              <PrList prs={prs} />
            </div>
          ) : null}
          {preview?.lastUser ? (
            <div className="text-xs">
              <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">You asked</div>
              <div className="line-clamp-3 whitespace-pre-wrap">{preview.lastUser}</div>
            </div>
          ) : null}
          <div className="text-xs">
            <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Last reply</div>
            <div className="max-h-80 overflow-hidden whitespace-pre-wrap leading-relaxed text-muted-foreground [mask-image:linear-gradient(to_bottom,black_85%,transparent)]">
              {preview === null ? "Loading…" : preview.lastAssistant || "(no reply yet)"}
            </div>
          </div>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
});

// --- thread header status strip -----------------------------------------------------

export function HeaderStatusStrip({
  threadId,
  state,
  branchPr,
}: {
  threadId: string;
  state: FlowState | null;
  branchPr: Parameters<typeof threadPrs>[1];
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const now = useNow();
  if (state === null) return null;
  const prs = threadPrs(state.threadPrs[threadId], branchPr);
  const open = prs.filter((pr) => pr.state === "open" || pr.state === "draft");
  const worst = worstPr(open.length ? open : prs);
  const run = runInfo(state.running[threadId], now);
  const watching = state.watching[threadId];
  const chip = "flex h-6 items-center gap-1 rounded-md px-1.5 text-xs hover:bg-accent";

  return (
    <div className="flex items-center gap-0.5">
      {run ? (
        run.stuck ? (
          <button
            type="button"
            className={cn(chip, "text-amber-600")}
            title={`No output for ${duration(run.silent)}. Click to stop the run.`}
            onClick={() => void rpc.call("thread_stop", { threadId })}
          >
            <Glyph name="alert" className="size-3.5" /> stuck {duration(run.silent)}
          </button>
        ) : (
          <span className={cn(chip, "text-sky-600 hover:bg-transparent")} title="Running">
            <Glyph name="spinner" className="size-3.5 animate-spin" /> {duration(run.elapsed)}
          </span>
        )
      ) : null}
      {watching ? (
        <span className={cn(chip, "text-muted-foreground hover:bg-transparent")} title={watching.label}>
          <Glyph name={watching.kind === "ci" ? "hourglass" : watching.kind === "release" ? "rocket" : "alarm"} className="size-3.5" />
          {watching.kind === "ci" ? "CI" : watching.kind === "release" ? "release" : "continue"}
        </span>
      ) : null}
      {worst ? (
        <button
          type="button"
          className={cn(chip, PR_TONE[worst.attention])}
          title={prs.map((pr) => `${pr.repo}#${pr.number} · ${attentionLabel(pr.attention)} · ${pr.title}`).join("\n")}
          onClick={() => navigate.openThreadPanel({ actionId: "prs", title: "Pull requests" })}
        >
          <Glyph name={prGlyph(worst)} className="size-3.5" />
          {prs.length === 1 ? `#${worst.number}` : `${prs.length} PRs`}
        </button>
      ) : null}
    </div>
  );
}

// --- Pull requests panel -------------------------------------------------------------

export function PullRequestsPanel({
  threadId,
  state,
  branchPr,
}: {
  threadId: string;
  params?: JsonValue | null;
  state: FlowState | null;
  branchPr: Parameters<typeof threadPrs>[1];
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const prs = threadPrs(state?.threadPrs[threadId], branchPr);
  const open = prs.filter((pr) => pr.state === "open" || pr.state === "draft");

  const act = async (fn: () => Promise<string>) => {
    setPending(true);
    try {
      setMessage(await fn());
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {prs.length === 0
            ? "No PRs linked yet. PRs this thread opens with gh pr create appear here automatically."
            : `${prs.length} PR${prs.length === 1 ? "" : "s"} · ${open.length} open`}
        </span>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(async () => (await rpc.call("pr_refresh", null), "Refreshed."))}>
            Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || open.length === 0}
            onClick={() =>
              act(async () => {
                const { watching } = await rpc.call("thread_watch_ci", { threadId });
                return `Watching ${watching.join(", ")}. This thread gets a message when checks finish or reviews arrive.`;
              })
            }
          >
            Watch CI
          </Button>
        </div>
      </div>
      {prs.length > 0 ? (
        <div className="rounded-lg border border-border bg-card p-3">
          <PrList prs={prs} />
        </div>
      ) : null}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (url.trim() === "") return;
          void act(async () => {
            await rpc.call("pr_link", { threadId, url: url.trim(), remove: false });
            setUrl("");
            return "Linked.";
          });
        }}
      >
        <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="Link a PR: https://github.com/owner/repo/pull/123" aria-label="PR URL to link" />
        <Button type="submit" size="sm" disabled={pending || url.trim() === ""}>
          Link
        </Button>
      </form>
      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}
