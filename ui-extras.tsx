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
import { usePortalScopeProps } from "@/lib/portal-scope";
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
  /** The row's status (icon, colour, label), shown first. */
  status: { glyph: GlyphName; tone: string; label: string; spin?: boolean };
  projectName: string | null;
  sectionName: string | null;
  tags: readonly string[];
  prs: readonly ThreadPr[];
  watching: FlowState["watching"][string] | undefined;
  snoozeUntil: number | undefined;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"a">, "children">;

type Preview = { goal: string; done: string; next: string; blocked: string; latest: string; prompts: number };

function Field({ label, children, tone }: { label: string; children: ReactNode; tone?: string }) {
  return (
    <div className="flex gap-2 text-xs leading-snug">
      <span className="w-12 shrink-0 pt-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn("line-clamp-2 min-w-0 flex-1", tone)}>{children}</span>
    </div>
  );
}

/**
 * Wraps a row in a hover card. Forwards the ref and any props (event handlers
 * from an outer `asChild` trigger such as the context menu) to the row
 * element, so wrapping never swallows right-click or keyboard handling.
 *
 * Order is by importance: status, goal, next/blocked, PRs, then details.
 */
export const ThreadHoverPreview = forwardRef<HTMLAnchorElement, HoverPreviewProps>(function ThreadHoverPreview(
  { thread, status, projectName, sectionName, tags, prs, watching, snoozeUntil, children, ...triggerProps },
  ref,
) {
  const rpc = useRpc<typeof rpcContract>();
  // Portaled to <body>: these attributes put the card inside the plugin's CSS scope.
  const portalScope = usePortalScopeProps();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    if (!open || preview !== null) return;
    rpc.call("thread_preview", { threadId: thread.id }).then(setPreview, () =>
      setPreview({ goal: "", done: "", next: "", blocked: "", latest: "", prompts: 0 }),
    );
  }, [open, preview, rpc, thread.id]);
  useEffect(() => setPreview(null), [thread.updatedAt]);

  const shownPrs = prs.slice(0, 4);
  const details = [
    projectName === "Personal" ? null : projectName,
    sectionName,
    thread.environment?.branchName ? `⎇ ${thread.environment.branchName}` : null,
    `updated ${duration(Date.now() - thread.updatedAt)} ago`,
    preview && preview.prompts > 0 ? `${preview.prompts} prompts` : null,
    ...tags.map((tag) => `#${tag}`),
  ].filter(Boolean);

  return (
    <HoverCard.Root open={open} onOpenChange={setOpen} openDelay={1000} closeDelay={60}>
      <HoverCard.Trigger asChild {...triggerProps} ref={ref}>
        {children}
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          {...portalScope}
          side="right"
          align="start"
          sideOffset={10}
          collisionPadding={12}
          className="z-50 w-[26rem] max-w-[calc(100vw-2rem)] space-y-2.5 rounded-xl border border-border bg-popover p-3.5 text-popover-foreground shadow-lg"
        >
          <div className="space-y-1">
            <div className={cn("flex items-center gap-1.5 text-[11px] font-medium", status.tone)}>
              <Glyph name={status.glyph} className={cn("size-3.5", status.spin && "animate-spin")} />
              <span className="truncate">{status.label}</span>
              {snoozeUntil !== undefined ? (
                <span className="ml-auto shrink-0 font-normal text-muted-foreground">snoozed · {formatWhen(snoozeUntil)}</span>
              ) : null}
            </div>
            <div className="text-sm font-medium leading-snug">{thread.displayTitle}</div>
          </div>

          {preview === null ? (
            <div className="h-10 animate-pulse rounded-md bg-muted/60" />
          ) : (
            <div className="space-y-1.5">
              {preview.goal ? <Field label="Goal">{preview.goal}</Field> : null}
              {preview.blocked ? (
                <Field label="Blocked" tone="text-amber-600">
                  {preview.blocked}
                </Field>
              ) : null}
              {preview.next ? <Field label="Next">{preview.next}</Field> : null}
              {!preview.next && !preview.blocked && preview.latest ? (
                <Field label="Latest" tone="text-muted-foreground">
                  {preview.latest}
                </Field>
              ) : null}
            </div>
          )}

          {watching && !status.label.startsWith(watching.label) ? (
            <div className="text-[11px] text-muted-foreground">{watching.label}</div>
          ) : null}

          {shownPrs.length > 0 ? (
            <div className="space-y-0.5 border-t border-border pt-2">
              {shownPrs.map((pr) => (
                <div key={pr.url} className={cn("flex items-center gap-1.5 text-xs", pr.stackedOn !== null && "pl-3")}>
                  <Glyph name={prGlyph(pr)} className={cn("size-3.5", PR_TONE[pr.attention])} />
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {prs.some((other) => other.repo !== pr.repo) ? `${pr.repo.split("/")[1]}#` : "#"}
                    {pr.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{pr.title}</span>
                  <span className={cn("shrink-0 text-[10px]", PR_TONE[pr.attention])}>{attentionLabel(pr.attention)}</span>
                </div>
              ))}
              {prs.length > shownPrs.length ? (
                <div className="text-[11px] text-muted-foreground">+{prs.length - shownPrs.length} more</div>
              ) : null}
            </div>
          ) : null}

          <div className="truncate border-t border-border pt-2 text-[10px] text-muted-foreground">{details.join(" · ")}</div>
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
