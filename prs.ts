// Tracks every PR a thread creates, across repos, so stacked and cross-repo
// work shows up as one unit. bb itself only links the PR for a thread's branch.
//
// Discovery: scan the thread's completed commands for `gh pr create` output
// (incrementally, from a per-thread cursor), plus manual links. Status: one
// batched GraphQL query every few minutes for all linked PRs, with stack order
// derived from base/head branches within a repo.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { anySignal, ghGraphql, type GhError } from "./gh.ts";
import { listLiveThreads } from "./thread-list.ts";

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
/** `scannedUpdatedAt`: the thread's updatedAt at its last scan; unchanged since means nothing new to read. */
type ThreadPrs = { refs: PrRef[]; cursor: number; scannedUpdatedAt?: number };

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const key = (ref: PrRef) => `${ref.repo}#${ref.number}`;

type CompletedItem = {
  type?: string;
  command?: unknown;
  aggregatedOutput?: unknown;
  tool?: unknown;
  status?: unknown;
  result?: unknown;
  text?: unknown;
};

const refsIn = (text: string): PrRef[] =>
  [...text.matchAll(PR_URL)].map((match) => ({ repo: match[1]!, number: Number(match[2]) }));

// A tool that opens a PR: GitHub MCP's create_pull_request and the like.
const CREATE_PR_TOOL = /create[_-]?pull[_-]?request|pull[_-]?request[_-]?create|\bcreate[_-]?pr\b/i;
// The agent saying it opened one ("Opened https://…/pull/12", "PR is up: …").
// Only these: a PR the agent merely mentions or reviews isn't the thread's.
const OPENED_PR = new RegExp(
  String.raw`\b(opened|created|raised|filed|submitted|put up|pushed up)\b[^\n]{0,80}?https://github\.com/[\w.-]+/[\w.-]+/pull/\d+|\b(PR|pull request)\b[^\n]{0,40}?\b(is up|opened|created)\b[^\n]{0,60}?https://github\.com/[\w.-]+/[\w.-]+/pull/\d+`,
  "gi",
);

/** PRs a completed thread item shows the thread created. */
export function createdPrs(item: CompletedItem | undefined): PrRef[] {
  if (!item) return [];
  if (item.type === "commandExecution") {
    const command = Array.isArray(item.command) ? item.command.join(" ") : String(item.command ?? "");
    return /\bgh\s+pr\s+create\b/.test(command) ? refsIn(String(item.aggregatedOutput ?? "")) : [];
  }
  if (item.type === "toolCall") {
    if (item.status !== "completed" || !CREATE_PR_TOOL.test(String(item.tool ?? ""))) return [];
    return refsIn(typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? ""));
  }
  if (item.type === "agentMessage") {
    return [...String(item.text ?? "").matchAll(OPENED_PR)].flatMap((match) => refsIn(match[0]));
  }
  return [];
}

/**
 * PRs to re-check once a thread's turn ends: the ones it just created, plus
 * every linked PR that was still open, draft or never fetched. A turn can
 * merge, close or push to a PR the thread already had, and the sidebar must
 * show that as soon as the turn ends, not at the next scheduled refresh.
 * Settled PRs (merged, closed) are left to the hourly re-check.
 */
export function refsToRefreshAfterTurn(
  linked: readonly PrRef[],
  status: Readonly<Record<string, Pick<PrStatus, "state">>>,
  created: readonly PrRef[],
): PrRef[] {
  const out = new Map<string, PrRef>();
  for (const ref of created) out.set(key(ref), ref);
  for (const ref of linked) {
    const state = status[key(ref)]?.state;
    if (state === "merged" || state === "closed") continue;
    out.set(key(ref), ref);
  }
  return [...out.values()];
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

/**
 * What to do when a whole batch query failed. A GitHub outage or a missing gh
 * fails every query alike, so asking repo by repo would only multiply the
 * failures; stop and let the next cycle try. Anything else (one deleted repo,
 * one inaccessible PR) is worth splitting up so the rest still updates.
 */
export function onBatchFailure(error: unknown): "split" | "stop" {
  const failure = error as GhError | null;
  if (failure?.transient || failure?.aborted) return "stop";
  if (/isn't installed or isn't on PATH|auth login|HTTP 401|HTTP 403|rate limit/i.test(String(failure?.message ?? error))) return "stop";
  return "split";
}

/** What the UI shows of the PR map: everything but when each PR was last checked. */
export function shown(status: Readonly<Record<string, PrStatus>>): string {
  return JSON.stringify(
    Object.keys(status)
      .sort()
      .map((prKey) => {
        const { checkedAt: _, ...rest } = status[prKey]!;
        return [prKey, rest];
      }),
  );
}

export function createPrTracker(bb: BbPluginApi, changed: () => void) {
  const kv = bb.storage.kv;
  // Aborted when this load is disposed (a reload, disable or update). Work still
  // running then must stop before its next bb call: the old handle is dead.
  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort());
  // PR data lives in the plugin's own SQLite database: kv values are capped at
  // 256KB, and a busy user links hundreds of PRs a month.
  const db = () => bb.storage.database();
  bb.storage.migrate(db(), [
    "CREATE TABLE pr_status (key TEXT PRIMARY KEY, json TEXT NOT NULL)",
    "CREATE TABLE thread_prs (thread_id TEXT PRIMARY KEY, json TEXT NOT NULL)",
  ]);
  function readTable<T>(table: "pr_status" | "thread_prs", column: "key" | "thread_id"): Record<string, T> {
    const rows = db().prepare(`SELECT ${column} AS id, json FROM ${table}`).all() as Array<{ id: string; json: string }>;
    return Object.fromEntries(rows.map((row) => [row.id, JSON.parse(row.json) as T]));
  }
  // byThread() is read by every state build, the palette and Now; it changes
  // only when a table is written.
  let byThreadCache: Promise<Record<string, PrStatus[]>> | null = null;
  /** Stores `value` as the whole table, writing only the rows that differ. Returns how many did. */
  function writeTable(table: "pr_status" | "thread_prs", column: "key" | "thread_id", value: Record<string, unknown>): number {
    const handle = db();
    const upsert = handle.prepare(`INSERT OR REPLACE INTO ${table} (${column}, json) VALUES (?, ?)`);
    const remove = handle.prepare(`DELETE FROM ${table} WHERE ${column} = ?`);
    let written = 0;
    byThreadCache = null;
    handle.transaction(() => {
      const rows = handle.prepare(`SELECT ${column} AS id, json FROM ${table}`).all() as Array<{ id: string; json: string }>;
      const stored = new Map(rows.map((row) => [row.id, row.json]));
      for (const [id, entry] of Object.entries(value)) {
        const json = JSON.stringify(entry);
        if (stored.get(id) !== json) {
          upsert.run(id, json);
          written += 1;
        }
        stored.delete(id);
      }
      for (const id of stored.keys()) {
        remove.run(id);
        written += 1;
      }
    })();
    return written;
  }
  // One-time move out of kv (v0.1.1 and earlier).
  const moved = (async () => {
    for (const [kvKey, table, column] of [
      ["prStatus", "pr_status", "key"],
      ["threadPrs", "thread_prs", "thread_id"],
    ] as const) {
      const old = await kv.get<Record<string, unknown>>(kvKey);
      if (old === null || old === undefined) continue;
      writeTable(table, column, old);
      await kv.delete(kvKey);
    }
  })().catch((error) => bb.log.warn(`pr storage move: ${String(error)}`));
  const getThreads = async () => {
    await moved;
    return readTable<ThreadPrs>("thread_prs", "thread_id");
  };
  const setThreads = async (value: Record<string, ThreadPrs>) => writeTable("thread_prs", "thread_id", value);
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
      await setThreads(all);
      return entry;
    });
  const getStatus = async () => {
    await moved;
    return readTable<PrStatus>("pr_status", "key");
  };

  /** Reads new completed commands since the thread's cursor and links PRs it created. */
  async function scan(threadId: string, signal?: AbortSignal, updatedAt?: number): Promise<PrRef[]> {
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
        found.push(...createdPrs((row.data as { item?: CompletedItem }).item));
      }
      if (rows.length < 100) break;
    }
    // Disposed mid-scan: nothing is saved, and the next load scans from the same cursor.
    if (signal?.aborted || lifetime.signal.aborted) return found;
    await updateThread(threadId, (entry) => {
      entry.cursor = Math.max(entry.cursor, cursor);
      if (updatedAt !== undefined) entry.scannedUpdatedAt = updatedAt;
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

  /** Ids of threads that are neither archived nor deleted. */
  async function liveThreadIds(): Promise<Set<string>> {
    const threads = await listLiveThreads(bb);
    return new Set(threads.filter((thread) => thread.deletedAt === null).map((thread) => thread.id));
  }

  /**
   * Drops archived and deleted threads, and the PRs only they referenced. kv
   * values are capped at 256KB, and a busy user links hundreds of PRs a month.
   */
  async function prune(live: Set<string>, status: Record<string, PrStatus>) {
    const kept = await exclusive(async () => {
      const all = await getThreads();
      let removed = 0;
      for (const threadId of Object.keys(all)) {
        if (!live.has(threadId)) {
          delete all[threadId];
          removed += 1;
        }
      }
      if (removed > 0) await setThreads(all);
      return all;
    });
    const referenced = new Set(Object.values(kept).flatMap((entry) => entry.refs.map(key)));
    for (const prKey of Object.keys(status)) if (!referenced.has(prKey)) delete status[prKey];
    return kept;
  }

  /** Fetches status for the given PRs (default: all linked to active threads). */
  let refreshLock: Promise<unknown> = Promise.resolve();
  function refresh(only?: PrRef[], signal?: AbortSignal): Promise<void> {
    const combined = anySignal(lifetime.signal, signal)!;
    // One at a time: each run writes the whole prStatus map.
    const go = () => (combined.aborted ? undefined : refreshNow(only, combined));
    const run = refreshLock.then(go, go);
    refreshLock = run.catch(() => undefined);
    return run;
  }

  type Batch = Record<string, Record<string, GqlPr | null> | null>;
  async function fetchBatch(query: string, signal: AbortSignal): Promise<{ data: Batch } | { error: unknown }> {
    try {
      // Up to 40 PRs with their checks: GitHub can take a while.
      return { data: await ghGraphql<Batch>(query, { signal, timeout: 60_000 }) };
    } catch (error) {
      if (!signal.aborted) bb.log.warn(`pr refresh: ${String(error)}`);
      return { error };
    }
  }

  async function refreshNow(only: PrRef[] | undefined, signal: AbortSignal) {
    const status = await getStatus();
    const before = shown(status);
    let refs = only;
    if (refs === undefined) {
      const all = await prune(await liveThreadIds(), status);
      const live = new Set<string>();
      for (const entry of Object.values(all)) {
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
    batches: for (let index = 0; index < refs.length; index += 40) {
      // Stop between batches on a reload; what's fetched so far is kept below.
      if (signal.aborted) break;
      const batch = refs.slice(index, index + 40);
      const byRepo = new Map<string, number[]>();
      for (const ref of batch) byRepo.set(ref.repo, [...(byRepo.get(ref.repo) ?? []), ref.number]);
      const allRepos = [...byRepo.entries()];
      const queryFor = (repos: typeof allRepos) => `query { ${repos
        .map(([repo, numbers], r) => {
          const [owner, name] = repo.split("/");
          return `r${r}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${numbers
            .map((number) => `p${number}: pullRequest(number: ${number}) { ...F }`)
            .join(" ")} }`;
        })
        .join(" ")} }
        fragment F on PullRequest { number title url state isDraft mergeable reviewDecision baseRefName headRefName mergedAt
          commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`;
      // One deleted repo or inaccessible PR can fail the whole query; then retry
      // repo by repo so the rest still updates. A GitHub outage stops the run.
      const whole = await fetchBatch(queryFor(allRepos), signal);
      const parts: Array<[typeof allRepos, Batch]> = [];
      if ("data" in whole) parts.push([allRepos, whole.data]);
      else if (onBatchFailure(whole.error) === "stop") break batches;
      else if (allRepos.length > 1) {
        for (const single of allRepos) {
          if (signal.aborted) break batches;
          const one = await fetchBatch(queryFor([single]), signal);
          if ("data" in one) parts.push([[single], one.data]);
          else if (onBatchFailure(one.error) === "stop") break batches;
        }
      }
      for (const [repos, data] of parts) repos.forEach(([repo, numbers], r) => {
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
    // Disposed meanwhile: the storage handle is gone; the next load refreshes again.
    if (lifetime.signal.aborted) return;
    writeTable("pr_status", "key", status);
    // Open windows re-read all state on a change; a refresh that only moved
    // checkedAt forward has nothing new to show.
    if (shown(status) !== before) changed();
  }

  /** PRs per active thread, stack-ordered, for the UI. Callers must not mutate the result. */
  function byThread(): Promise<Record<string, PrStatus[]>> {
    const build = (byThreadCache ??= buildByThread());
    build.catch(() => {
      if (byThreadCache === build) byThreadCache = null;
    });
    return build;
  }
  async function buildByThread(): Promise<Record<string, PrStatus[]>> {
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

  // When a turn ends, its new PRs appear and its linked PRs show what the
  // turn did to them (merged, closed, new checks) right away.
  /**
   * One thread's PRs, live: new ones it created, and every linked PR that isn't
   * settled. For agents and the CLI, so asking about one thread doesn't refresh
   * every PR of every thread.
   */
  async function refreshThread(threadId: string): Promise<void> {
    const found = await scan(threadId, lifetime.signal).catch(() => []);
    if (lifetime.signal.aborted) return;
    const linked = (await getThreads())[threadId]?.refs ?? [];
    const refs = refsToRefreshAfterTurn(linked, await getStatus(), found);
    if (refs.length > 0) await refresh(refs);
  }

  bb.events.on("thread.idle", ({ thread }) => refreshThread(thread.id));

  // Single flight: a slow run (GitHub having a bad day) mustn't queue up more
  // full runs behind it; the next tick after it finishes picks up from there.
  let scheduled: Promise<void> | null = null;
  bb.background.schedule("pr-refresh", "*/3 * * * *", () => {
    if (scheduled !== null || lifetime.signal.aborted) return;
    scheduled = refresh().finally(() => (scheduled = null));
    return scheduled;
  });

  // Backfill active threads once per load, without blocking startup.
  bb.background.service("pr-backfill", {
    async start(signal) {
      if ((await kv.get<number>("threadPrsVersion")) !== 2) {
        await exclusive(() => setThreads({}));
        await kv.set("threadPrsVersion", 2);
      }
      const threads = await listLiveThreads(bb, { signal });
      const known = await getThreads();
      for (const thread of threads) {
        if (signal.aborted) return;
        if (thread.parentThreadId !== null) continue;
        // Untouched since its last scan: no new commands to read.
        if (known[thread.id]?.scannedUpdatedAt === thread.updatedAt) continue;
        await scan(thread.id, signal, thread.updatedAt).catch((error) => {
          if (!signal.aborted) bb.log.warn(`pr scan ${thread.id}: ${String(error)}`);
        });
      }
      if (!signal.aborted) await refresh(undefined, signal);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  return { scan, link, refresh, refreshThread, byThread, openPrsFor };
}
