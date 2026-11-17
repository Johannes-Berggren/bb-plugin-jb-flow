// A thread's PRs and their CI: watching every open PR a thread created,
// linking PRs by URL, the PR radar (PRs to fix or merge) and the wait_for_ci
// and pr_status agent tools. prs.ts tracks the PRs; watchers.ts runs the watches.
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { AFTER_GREEN, type AfterGreen } from "./conductor-routing";
import type { createPrTracker, PrStatus } from "./prs";
import type { rpcContract } from "./rpc-contract";
import type { ListedThread } from "./thread-cache";
import type { createWatchers } from "./watchers";

type PrTracker = ReturnType<typeof createPrTracker>;

type PrCiDeps = {
  prTracker: PrTracker;
  watchers: ReturnType<typeof createWatchers>;
  listThreadsCached: () => Promise<ListedThread[]>;
};

export function createPrCi({ prTracker, watchers, listThreadsCached }: PrCiDeps) {
  /** Watch every open PR the thread created; fall back to its branch PR. */
  async function watchThreadCi(
    threadId: string,
    options: { pr?: number; repo?: string; watchFor?: "checks" | "reviews" | "both"; afterGreen?: AfterGreen },
  ) {
    // A bare PR number: use the repo of this thread's own PR with that number.
    if (options.pr !== undefined && options.repo === undefined) {
      const own = ((await prTracker.byThread())[threadId] ?? []).filter((pr) => pr.number === options.pr);
      const repos = [...new Set(own.map((pr) => pr.repo))];
      if (repos.length > 1) throw new Error(`#${options.pr} exists in ${repos.join(" and ")}. Pass repo.`);
      if (repos.length === 1) options = { ...options, repo: repos[0] };
    }
    if (options.pr === undefined) {
      const open = await prTracker.openPrsFor(threadId);
      if (open.length > 0) {
        return Promise.all(open.map((ref) => watchers.watchCi(threadId, { ...options, pr: ref.number, repo: ref.repo })));
      }
    }
    return [await watchers.watchCi(threadId, options)];
  }

  async function prRadar() {
    // Threads with an open PR that needs fixing or is ready to merge,
    // skipping threads whose agent is already working on it.
    const byThread = await prTracker.byThread();
    const live = new Map(
      (await listThreadsCached())
        .filter((thread) => thread.archivedAt === null && thread.status !== "active" && thread.status !== "starting")
        .map((thread) => [thread.id, thread]),
    );
    const broken: Array<{ threadId: string; title: string; pr: string }> = [];
    const ready: Array<{ threadId: string; title: string; pr: string }> = [];
    for (const [threadId, prs] of Object.entries(byThread)) {
      const thread = live.get(threadId);
      if (!thread) continue;
      const open = prs.filter((pr) => pr.state === "open" || pr.state === "draft");
      const bad = open.find((pr) => ["checks_failed", "changes_requested", "conflicts"].includes(pr.attention));
      const good = open.find((pr) => pr.attention === "ready_to_merge");
      const entry = (pr: PrStatus) => ({ threadId, title: thread.title ?? "", pr: `${pr.repo.split("/")[1]}#${pr.number}` });
      if (bad) broken.push(entry(bad));
      else if (good) ready.push(entry(good));
    }
    return { broken, ready };
  }

  const rpc: Pick<PluginRpcHandlers<typeof rpcContract>, "thread_watch_ci" | "pr_link" | "pr_refresh"> = {
    thread_watch_ci: async ({ threadId }) => ({
      watching: (await watchThreadCi(threadId, { watchFor: "both" })).map((watch) => `${watch.repo}#${watch.pr}`),
    }),
    pr_link: async ({ threadId, url, remove }) => {
      const match = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url);
      if (!match) throw new Error("Paste a GitHub PR URL, e.g. https://github.com/owner/repo/pull/123");
      await prTracker.link(threadId, { repo: match[1]!, number: Number(match[2]) }, remove);
      return { ok: true };
    },
    pr_refresh: async () => {
      await prTracker.refresh();
      return { ok: true };
    },
  };

  return { watchThreadCi, prRadar, rpc };
}

type PrToolDeps = {
  prTracker: PrTracker;
  watchThreadCi: ReturnType<typeof createPrCi>["watchThreadCi"];
};

/** The wait_for_ci and pr_status agent tools. */
export function registerPrTools(bb: BbPluginApi, { prTracker, watchThreadCi }: PrToolDeps) {
  bb.agents.registerTool({
    name: "wait_for_ci",
    description:
      "Wait for a GitHub PR's CI checks and/or new reviews/comments without polling. Registers a watch and returns immediately; when checks finish (with the failed log on failure), a review or comment arrives, or the PR merges/closes, a message is sent to this thread once it is idle; nothing is sent while it is still working. End your turn after calling it.",
    instructions:
      "Never poll CI or PR state in loops (no `gh pr checks --watch`, `gh run watch`, `until gh ...; sleep`, or repeated `gh pr view`). After pushing or opening a PR, call wait_for_ci (pr optional: defaults to this branch's PR) and end your turn; you'll be messaged with the result once you're idle. Nothing arrives while you keep working, so check pr_status before relying on a PR's state. For a review loop use for: \"both\". Say what you'll do once checks pass with after_green: \"merge\" when merging is part of your task, \"continue\" when you have more to do (the next PR in a stack, a deploy step), \"nothing\" when green needs no action from you.",
    parameters: z.object({
      pr: z.number().int().positive().optional().describe("PR number; defaults to every open PR this thread created (all repos), else this branch's PR"),
      repo: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/)
        .optional()
        .describe("owner/name of the PR's repo. Needed when the PR is not in this thread's project repo and this thread didn't create it"),
      for: z.enum(["checks", "reviews", "both"]).optional().describe("What to wait for (default both)"),
      after_green: z
        .enum(AFTER_GREEN)
        .optional()
        .describe("What you'll do once checks pass: merge (merging is part of your task), continue (more work follows), nothing. A workspace conductor, if enabled, handles merge and nothing for you."),
    }),
    async execute({ pr, repo, for: watchFor, after_green: afterGreen }, ctx) {
      try {
        const watches = await watchThreadCi(ctx.threadId, { pr, repo, watchFor, afterGreen });
        return `Watching ${watches.map((watch) => `${watch.repo}#${watch.pr}`).join(", ")} for ${watches[0]!.watchFor}. End your turn now; a message will arrive when there's news.`;
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  });
  bb.agents.registerTool({
    name: "pr_status",
    description:
      "State of every PR this thread created (any repo, stack order): checks, review decision, conflicts, draft/merged, base/head. Served from the plugin's cache, refreshed every 3 minutes; pass refresh: true for a live read. Use this instead of gh pr view / gh pr checks to check PR state.",
    instructions:
      "To check the state of this thread's PRs, call pr_status (one call, all repos) instead of gh pr view / gh pr checks. Use gh only to read full review comments or logs.",
    parameters: z.object({
      refresh: z.boolean().optional().describe("Fetch this thread's PRs live first (one batched GitHub query)"),
    }),
    async execute({ refresh }, ctx) {
      if (refresh) {
        await prTracker.refreshThread(ctx.threadId);
      }
      const prs = (await prTracker.byThread())[ctx.threadId] ?? [];
      if (prs.length === 0) return "No PRs linked to this thread. PRs opened with gh pr create are linked automatically; others via `bb jb-flow pr-link <url> --self`.";
      return prs
        .map(
          (pr) =>
            `${pr.stackedOn !== null ? "  └ " : ""}${pr.repo}#${pr.number} [${pr.attention}] ${pr.title} (${pr.head} → ${pr.base}) ${pr.url}`,
        )
        .join("\n");
    },
  });
}
