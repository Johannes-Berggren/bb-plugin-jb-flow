// Tracks every PR a thread creates, across repos, so stacked and cross-repo
// work shows up as one unit. bb itself only links the PR for a thread's branch.
//
// Discovery: scan the thread's completed commands for `gh pr create` output
// (incrementally, from a per-thread cursor), plus manual links. Status: one
// batched GraphQL query every few minutes for all linked PRs, with stack order
// derived from base/head branches within a repo.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const prAttention = z.enum([
  "merged",
  "closed",
  "draft",
  "conflicts",
  "checks_failed",
  "changes_requested",
  "checks_pending",
  "review_requested",
  "ready_to_merge",
]);
export const prStatusSchema = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "draft", "merged", "closed"]),
  attention: prAttention,
  base: z.string(),
  head: z.string(),
  /** When it merged (ms), for release tracking; absent on older cached entries. */
  mergedAt: z.number().nullable().optional(),
  /** Number of the PR this one is stacked on (same repo), if any. */
  stackedOn: z.number().nullable(),
  checkedAt: z.number(),
});
export type PrStatus = z.infer<typeof prStatusSchema>;
type PrRef = { repo: string; number: number };
type ThreadPrs = { refs: PrRef[]; cursor: number };

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const key = (ref: PrRef) => `${ref.repo}#${ref.number}`;

export function gh(args: string[], timeout = 60_000): Promise<string> {
  const bin = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].find(existsSync) ?? "gh";
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`gh: ${stderr || error.message}`.slice(0, 400)));
      else resolve(stdout);
    });
  });
}

type GqlPr = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  baseRefName: string;
  headRefName: string;
  mergedAt: string | null;
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
};

function attentionOf(pr: GqlPr): PrStatus["attention"] {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  if (pr.isDraft) return "draft";
  if (pr.mergeable === "CONFLICTING") return "conflicts";
  const checks = pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null;
  if (checks === "FAILURE" || checks === "ERROR") return "checks_failed";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes_requested";
  if (checks === "PENDING" || checks === "EXPECTED") return "checks_pending";
  if (pr.reviewDecision === "REVIEW_REQUIRED") return "review_requested";
  return "ready_to_merge";
}

/** Long-lived branches: a PR *from* one of these (e.g. a dev→main release) is not a stack parent. */
const TRUNK = /^(main|master|dev|develop|development|staging|production|prod|release([/-].*)?)$/;

/** Orders PRs so each stack reads base-first, and fills `stackedOn`. */
export function orderStack(prs: PrStatus[]): PrStatus[] {
  const byHead = new Map(prs.filter((pr) => !TRUNK.test(pr.head)).map((pr) => [`${pr.repo}:${pr.head}`, pr]));
  const withParent = prs.map((pr) => ({ ...pr, stackedOn: byHead.get(`${pr.repo}:${pr.base}`)?.number ?? null }));
  const children = new Map<string, PrStatus[]>();
  for (const pr of withParent) {
    if (pr.stackedOn === null) continue;
    const parent = `${pr.repo}#${pr.stackedOn}`;
    children.set(parent, [...(children.get(parent) ?? []), pr]);
  }
  const ordered: PrStatus[] = [];
  const visit = (pr: PrStatus) => {
    if (ordered.includes(pr)) return;
    ordered.push(pr);
    for (const child of (children.get(key(pr)) ?? []).sort((a, b) => a.number - b.number)) visit(child);
  };
  withParent
    .filter((pr) => pr.stackedOn === null)
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number)
    .forEach(visit);
  withParent.forEach(visit); // cycles or orphans, just in case
  return ordered;
}

export function createPrTracker(bb: BbPluginApi, changed: () => void) {
  const kv = bb.storage.kv;
  const getThreads = async () => (await kv.get<Record<string, ThreadPrs>>("threadPrs")) ?? {};
  // Scans (backfill, idle events, CLI) interleave; serialize read-modify-write
  // of the threadPrs map so one never overwrites another's results.
  let lock: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  }
  const updateThread = (threadId: string, apply: (entry: ThreadPrs) => void) =>
    exclusive(async () => {
      const all = await getThreads();
      const entry = all[threadId] ?? { refs: [], cursor: 0 };
      apply(entry);
      all[threadId] = entry;
      await kv.set("threadPrs", all);
      return entry;
    });
  const getStatus = async () => (await kv.get<Record<string, PrStatus>>("prStatus")) ?? {};

  /** Reads new completed commands since the thread's cursor and links PRs it created. */
  async function scan(threadId: string, signal?: AbortSignal): Promise<PrRef[]> {
    let cursor = (await getThreads())[threadId]?.cursor ?? 0;
    const found: PrRef[] = [];
    for (let page = 0; page < 400; page += 1) {
      if (signal?.aborted) break;
      const rows = await bb.sdk.threads.events.list({
        ...(signal ? { signal } : {}),
        threadId,
        afterSeq: String(cursor),
        types: ["item/completed"],
        order: "asc",
        limit: "100",
      });
      for (const row of rows) {
        cursor = Math.max(cursor, row.seq);
        const item = (row.data as { item?: { type?: string; command?: unknown; aggregatedOutput?: unknown } }).item;
        if (item?.type !== "commandExecution") continue;
        const command = Array.isArray(item.command) ? item.command.join(" ") : String(item.command ?? "");
        if (!/\bgh\s+pr\s+create\b/.test(command)) continue;
        for (const match of String(item.aggregatedOutput ?? "").matchAll(PR_URL)) {
          found.push({ repo: match[1]!, number: Number(match[2]) });
        }
      }
      if (rows.length < 100) break;
    }
    await updateThread(threadId, (entry) => {
      entry.cursor = Math.max(entry.cursor, cursor);
      for (const ref of found) if (!entry.refs.some((existing) => key(existing) === key(ref))) entry.refs.push(ref);
    });
    return found;
  }

  async function link(threadId: string, ref: PrRef, remove = false) {
    await updateThread(threadId, (entry) => {
      entry.refs = entry.refs.filter((existing) => key(existing) !== key(ref));
      if (!remove) entry.refs.push(ref);
    });
    await refresh([ref]);
  }

  /** Fetches status for the given PRs (default: all linked to active threads). */
  async function refresh(only?: PrRef[]) {
    const status = await getStatus();
    let refs = only;
    if (refs === undefined) {
      const all = await getThreads();
      const live = new Set<string>();
      for (const [threadId, entry] of Object.entries(all)) {
        const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
        if (thread === null || thread.archivedAt !== null) continue;
        for (const ref of entry.refs) {
          const known = status[key(ref)];
          // Merged/closed PRs are settled; re-check them at most hourly.
          if (known && (known.state === "merged" || known.state === "closed") && Date.now() - known.checkedAt < 3_600_000) continue;
          live.add(key(ref));
        }
      }
      refs = [...live].map((value) => {
        const [repo, number] = value.split("#");
        return { repo: repo!, number: Number(number) };
      });
    }
    for (let index = 0; index < refs.length; index += 40) {
      const batch = refs.slice(index, index + 40);
      const byRepo = new Map<string, number[]>();
      for (const ref of batch) byRepo.set(ref.repo, [...(byRepo.get(ref.repo) ?? []), ref.number]);
      const repos = [...byRepo.entries()];
      const query = `query { ${repos
        .map(([repo, numbers], r) => {
          const [owner, name] = repo.split("/");
          return `r${r}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${numbers
            .map((number) => `p${number}: pullRequest(number: ${number}) { ...F }`)
            .join(" ")} }`;
        })
        .join(" ")} }
        fragment F on PullRequest { number title url state isDraft mergeable reviewDecision baseRefName headRefName mergedAt
          commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`;
      let data: Record<string, Record<string, GqlPr | null> | null>;
      try {
        data = (JSON.parse(await gh(["api", "graphql", "-f", `query=${query}`])) as { data: typeof data }).data;
      } catch (error) {
        bb.log.warn(`pr refresh: ${String(error)}`);
        continue;
      }
      repos.forEach(([repo, numbers], r) => {
        for (const number of numbers) {
          const pr = data[`r${r}`]?.[`p${number}`];
          if (!pr) continue;
          status[`${repo}#${number}`] = {
            repo,
            number,
            title: pr.title,
            url: pr.url,
            state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open",
            attention: attentionOf(pr),
            base: pr.baseRefName,
            head: pr.headRefName,
            mergedAt: pr.mergedAt ? Date.parse(pr.mergedAt) : null,
            stackedOn: null,
            checkedAt: Date.now(),
          };
        }
      });
    }
    await kv.set("prStatus", status);
    changed();
  }

  /** PRs per active thread, stack-ordered, for the UI. */
  async function byThread(): Promise<Record<string, PrStatus[]>> {
    const all = await getThreads();
    const status = await getStatus();
    const result: Record<string, PrStatus[]> = {};
    for (const [threadId, entry] of Object.entries(all)) {
      const prs = entry.refs.map((ref) => status[key(ref)]).filter((pr): pr is PrStatus => pr !== undefined);
      if (prs.length > 0) result[threadId] = orderStack(prs);
    }
    return result;
  }

  async function openPrsFor(threadId: string): Promise<PrRef[]> {
    const prs = (await byThread())[threadId] ?? [];
    return prs.filter((pr) => pr.state === "open" || pr.state === "draft").map(({ repo, number }) => ({ repo, number }));
  }

  // New PRs show up right after the turn that created them.
  bb.events.on("thread.idle", async ({ thread }) => {
    const found = await scan(thread.id).catch(() => []);
    if (found.length > 0) await refresh(found);
  });

  bb.background.schedule("pr-refresh", "*/3 * * * *", () => refresh());

  // Backfill active threads once per load, without blocking startup.
  bb.background.service("pr-backfill", {
    async start(signal) {
      if ((await kv.get<number>("threadPrsVersion")) !== 2) {
        await exclusive(() => kv.set("threadPrs", {}));
        await kv.set("threadPrsVersion", 2);
      }
      const threads = await bb.sdk.threads.list({ limit: 500 });
      for (const thread of threads) {
        if (signal.aborted) return;
        if (thread.archivedAt !== null || thread.parentThreadId !== null) continue;
        await scan(thread.id, signal).catch((error) => {
          if (!signal.aborted) bb.log.warn(`pr scan ${thread.id}: ${String(error)}`);
        });
      }
      if (!signal.aborted) await refresh();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  return { scan, link, refresh, byThread, openPrsFor };
}
