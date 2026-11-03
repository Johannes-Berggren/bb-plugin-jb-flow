// The CI and review watcher's decisions, apart from gh and bb so they can be
// tested: what a watch should report, when it ends, and that a wake-up is only
// forgotten once its message has really been sent. watchers.ts wires it up.

/** How long to wait for checks. */
export const CI_TIMEOUT_MS = 3 * 3_600_000;
/** How long to wait for a review: people take days, so this can't share the CI limit. */
export const REVIEW_TIMEOUT_MS = 7 * 24 * 3_600_000;
/** Review-only watches can live for days, so they read GitHub less often than the 2-minute cycle. */
export const REVIEW_RECHECK_MS = 10 * 60_000;
export const NO_CHECKS_AFTER_MS = 10 * 60_000;
/** Attempts before an unsendable message is given up on (about an hour of 2-minute cycles). */
export const MAX_SEND_FAILURES = 30;

const OK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
/** Deploy-preview and housekeeping bots: their comments are not review feedback. */
const BOT_LOGINS = new Set(["vercel", "github-actions", "dependabot", "linear", "changeset-bot", "codecov", "netlify", "sonarcloud"]);
const isBot = (login: string | undefined, body: string) =>
  login === undefined || login.endsWith("[bot]") || BOT_LOGINS.has(login) || /^\[vc\]:/.test(body);

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export type CiWatch = {
  threadId: string;
  repo: string;
  pr: number;
  watchFor: "checks" | "reviews" | "both";
  since: number;
  /** Reviews/comments newer than this are reported; advances after each report. */
  reviewsSince?: number;
  headSha: string | null;
  /** "both" after its checks were reported: keep listening for reviews. */
  quiet?: boolean;
  /** When GitHub was last read for this watch, to space out review-only watches. */
  lastCheckedAt?: number;
  /** Failed attempts to send this watch's current news. */
  sendFailures?: number;
};

export type PrState = {
  state: string;
  headRefOid: string;
  url: string;
  statusCheckRollup: Array<{
    __typename: string;
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string | null;
    state?: string;
    detailsUrl?: string;
    targetUrl?: string;
  }>;
  reviews: Array<{ author: { login: string } | null; state: string; body: string; submittedAt: string }>;
  comments: Array<{ author: { login: string } | null; body: string; createdAt: string }>;
};

export const watchTimeoutMs = (watch: Pick<CiWatch, "watchFor">) =>
  watch.watchFor === "reviews" ? REVIEW_TIMEOUT_MS : CI_TIMEOUT_MS;

const shortName = (watch: Pick<CiWatch, "repo" | "pr">) => `${watch.repo.split("/")[1]}#${watch.pr}`;

export type WatchEvaluation = {
  /** The watch's new state. The input is left untouched, so a failed send can retry from it. */
  watch: CiWatch;
  notes: string[];
  /** The watch has nothing left to wait for. */
  done: boolean;
  /** There's news to send. */
  report: boolean;
};

/** One watch against the PR's current state. */
export async function evaluateWatch(
  original: CiWatch,
  pr: PrState,
  now: number,
  me: string,
  failedLog: (detailsUrl: string | undefined, repo: string) => Promise<string>,
): Promise<WatchEvaluation> {
  const watch: CiWatch = { ...original };
  const name = shortName(watch);
  const notes: string[] = [];
  let done = false;
  let checksReported = false;

  if (pr.state !== "OPEN") {
    notes.push(`PR ${name} is now ${pr.state.toLowerCase()}.`);
    done = true;
  }
  // A new push restarts the checks; keep waiting on the new head. Reviews keep
  // their own cutoff, so one left before the push is still reported.
  if (watch.headSha !== null && watch.headSha !== pr.headRefOid) {
    watch.reviewsSince ??= watch.since;
    watch.since = now;
  }
  watch.headSha = pr.headRefOid;

  if (!done && watch.watchFor !== "reviews") {
    const checks = pr.statusCheckRollup.map((check) => ({
      name: check.name ?? check.context ?? "check",
      pending: check.__typename === "CheckRun" ? check.status !== "COMPLETED" : check.state === "PENDING" || check.state === "EXPECTED",
      ok: check.__typename === "CheckRun" ? OK_CONCLUSIONS.has(check.conclusion ?? "") : check.state === "SUCCESS",
      url: check.detailsUrl ?? check.targetUrl,
    }));
    if (checks.length > 0 && checks.every((check) => !check.pending)) {
      const failed = checks.filter((check) => !check.ok);
      if (failed.length === 0) {
        notes.push(`✅ CI is green on ${name} (${pr.headRefOid.slice(0, 7)}): ${checks.length} checks passed.`);
      } else {
        const log = await failedLog(failed[0]!.url, watch.repo);
        notes.push(`❌ CI failed on ${name} (${pr.headRefOid.slice(0, 7)}): ${failed.map((check) => check.name).join(", ")}.${log}`);
      }
      // "both" keeps listening for reviews (review bots often answer after CI).
      if (watch.watchFor === "both") {
        watch.watchFor = "reviews";
        watch.quiet = true;
        checksReported = true;
      } else done = true;
    } else if (checks.length === 0 && now - watch.since > NO_CHECKS_AFTER_MS) {
      notes.push(`${name} has no CI checks after 10 minutes; nothing to wait for.`);
      if (watch.watchFor === "both") {
        watch.watchFor = "reviews";
        watch.quiet = true;
        checksReported = true;
      } else done = true;
    }
  }

  let reviewNews = false;
  if (watch.watchFor !== "checks") {
    const cutoff = watch.reviewsSince ?? watch.since;
    const human = (author: { login: string } | null, body: string) => author?.login !== me && !isBot(author?.login, body);
    const reviews = pr.reviews.filter((review) => Date.parse(review.submittedAt) > cutoff && human(review.author, review.body));
    const comments = pr.comments.filter((comment) => Date.parse(comment.createdAt) > cutoff && human(comment.author, comment.body));
    for (const review of reviews) {
      notes.push(`Review from ${review.author?.login ?? "someone"}: ${review.state}${review.body ? ` — ${truncate(review.body, 800)}` : ""}`);
    }
    for (const comment of comments) {
      notes.push(`Comment from ${comment.author?.login ?? "someone"}: ${truncate(comment.body, 800)}`);
    }
    if (reviews.length + comments.length > 0) {
      reviewNews = true;
      notes.push(`Full comments: \`gh pr view ${watch.pr} -R ${watch.repo} --comments\`; inline: \`gh api repos/${watch.repo}/pulls/${watch.pr}/comments\``);
      // Reviews only: done. Both: report now, keep watching the checks.
      if (watch.watchFor === "reviews") done = true;
    }
  }

  if (!done && now - watch.since > watchTimeoutMs(watch)) {
    notes.push(
      watch.watchFor === "reviews"
        ? `No review on ${name} after 7 days; stopped watching. Call wait_for_ci again if you still need one. ${pr.url}`
        : `Still waiting on ${name} after 3 hours; stopped watching. ${pr.url}`,
    );
    done = true;
  }

  const report = done || reviewNews || checksReported;
  if (report && !done) watch.reviewsSince = now;
  return { watch, notes, done, report };
}

export type CiCycle = {
  /** The stored watches this cycle works from. */
  watches: Record<string, CiWatch>;
  /** Read every watch now, ignoring the review-only spacing (`check-now`). */
  force?: boolean;
  now: () => number;
  isBusy: (threadId: string) => Promise<boolean>;
  readPr: (watch: CiWatch) => Promise<PrState>;
  me: () => Promise<string>;
  failedLog: (detailsUrl: string | undefined, repo: string) => Promise<string>;
  send: (threadId: string, text: string) => Promise<unknown>;
  /** True only when the thread is known to be archived or deleted, not on a lookup failure. */
  threadGone: (threadId: string) => Promise<boolean>;
  warn: (message: string) => void;
};

/**
 * One pass over all watches. Returns what to store: key → new state, or null to
 * remove. A watch with news changes only once its message has been sent, so a
 * failed send is tried again next cycle instead of being lost.
 */
export async function runCiCycle(cycle: CiCycle): Promise<Map<string, CiWatch | null>> {
  const { watches } = cycle;
  const changes = new Map<string, CiWatch | null>();
  // One message per thread per cycle, however many of its PRs have news.
  const outbox = new Map<string, { notes: string[]; staged: Map<string, CiWatch | null>; stillWatching: boolean }>();
  const stage = (threadId: string) => {
    const entry = outbox.get(threadId) ?? { notes: [], staged: new Map<string, CiWatch | null>(), stillWatching: false };
    outbox.set(threadId, entry);
    return entry;
  };
  // A working agent checks its PRs itself (pr_status). Its watches stay as they
  // are until it goes idle; the first idle cycle then reports the current checks
  // and every review since the last report, in one message.
  const busy = new Map<string, boolean>();

  for (const [key, watch] of Object.entries(watches)) {
    if (!busy.has(watch.threadId)) busy.set(watch.threadId, await cycle.isBusy(watch.threadId));
    if (busy.get(watch.threadId)) continue;
    // Before the read: a review landing during it stays newer than this cutoff.
    const now = cycle.now();
    const lastChecked = watch.lastCheckedAt;
    if (!cycle.force && watch.watchFor === "reviews" && lastChecked !== undefined && now - lastChecked < REVIEW_RECHECK_MS) continue;

    let pr: PrState;
    try {
      pr = await cycle.readPr(watch);
    } catch (error) {
      cycle.warn(`ci ${key}: ${String(error)}`);
      // gh missing, logged out or the PR gone: give up after the usual limit, and say so.
      if (now - watch.since > watchTimeoutMs(watch)) {
        const entry = stage(watch.threadId);
        entry.notes.push(`Couldn't read ${shortName(watch)} from GitHub; stopped watching it.`);
        entry.staged.set(key, null);
      } else {
        changes.set(key, { ...watch, lastCheckedAt: now });
      }
      continue;
    }

    const result = await evaluateWatch(watch, pr, now, await cycle.me(), cycle.failedLog);
    const next: CiWatch = { ...result.watch, lastCheckedAt: now };
    if (!result.report) {
      changes.set(key, next);
      continue;
    }
    const entry = stage(watch.threadId);
    entry.notes.push(...result.notes);
    if (result.done) entry.staged.set(key, null);
    else {
      delete next.sendFailures;
      entry.staged.set(key, next);
      entry.stillWatching = true;
    }
  }

  for (const [threadId, entry] of outbox) {
    const others = Object.entries(watches).filter(
      ([key, watch]) => watch.threadId === threadId && entry.staged.get(key) !== null,
    ).length;
    const suffix =
      entry.stillWatching || others > 0
        ? `\n\n(Still watching ${others} PR${others === 1 ? "" : "s"}; you'll get another message when there's news.)`
        : "";
    try {
      await cycle.send(threadId, `[ci watcher] ${entry.notes.join("\n\n")}${suffix}`);
      for (const [key, next] of entry.staged) changes.set(key, next);
    } catch (error) {
      cycle.warn(`ci notify: ${String(error)}`);
      const gone = await cycle.threadGone(threadId);
      for (const key of entry.staged.keys()) {
        const failures = (watches[key]!.sendFailures ?? 0) + 1;
        if (gone) changes.set(key, null);
        else if (failures >= MAX_SEND_FAILURES) {
          cycle.warn(`ci ${key}: dropped after ${failures} failed sends`);
          changes.set(key, null);
        } else changes.set(key, { ...watches[key]!, sendFailures: failures });
      }
    }
  }
  return changes;
}

/**
 * Applies a cycle's result to freshly read storage. A watch registered again
 * during the cycle is left alone: the message that ended the old one can make
 * the agent ask for a new one straight away, and that one must survive.
 */
export function applyCiChanges(
  stored: Record<string, CiWatch>,
  snapshot: Record<string, CiWatch>,
  changes: ReadonlyMap<string, CiWatch | null>,
): void {
  for (const [key, next] of changes) {
    const current = stored[key];
    const seen = snapshot[key];
    if (current === undefined || seen === undefined || current.since !== seen.since) continue;
    if (next === null) delete stored[key];
    else stored[key] = next;
  }
}

/** Real status from a failed bb call, from its field or its "HTTP 404: …" message. */
function httpStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status;
  const match = /\bHTTP (\d{3})\b/.exec(String(error));
  return match ? Number(match[1]) : null;
}

/** A failed lookup that proves the thread is gone. Anything else (a timeout, a 503) proves nothing. */
export function isGoneError(error: unknown): boolean {
  const status = httpStatus(error);
  return status === 404 || status === 410;
}

/** Whether a thread is known to be gone. */
export async function isThreadGone(
  getThread: () => Promise<{ archivedAt: number | null; deletedAt: number | null }>,
): Promise<boolean> {
  try {
    const thread = await getThread();
    return thread.archivedAt !== null || thread.deletedAt !== null;
  } catch (error) {
    return isGoneError(error);
  }
}
