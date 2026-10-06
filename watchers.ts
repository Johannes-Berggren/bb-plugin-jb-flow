// Event-driven wake-ups that replace the user (or the agent) polling:
//
// - Auto-continue: a thread that stops on "You've hit your session limit ·
//   resets 10pm" gets "continue" scheduled for just after the reset. The
//   scheduled message is cancelled if the thread resumes before then.
// - Release watcher: a thread that goes idle waiting for a release is woken
//   with "released" once a release PR merges into the base branch and its
//   workflow runs pass. Configured per project in local.config.json.
// - CI watcher: agents call `wait_for_ci` instead of polling `gh` in loops; the
//   plugin polls once for everyone and messages the thread when checks finish,
//   reviews/comments arrive, or the PR merges.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parseLimitHit } from "./limits";
import { RELEASE_WAIT } from "./release-wait";

export const releaseWatchSchema = z.object({
  /** owner/name; defaults to the project's GitHub remote. */
  repo: z.string().optional(),
  /** "pr": a merged PR into `base` whose title matches; "release": a published GitHub release. */
  mode: z.enum(["pr", "release"]).default("pr"),
  base: z.string().default("main"),
  /** Regex a merged PR title must match to count as a release. */
  titlePattern: z.string().default("^Release\\b"),
});
export type ReleaseWatchConfig = z.infer<typeof releaseWatchSchema>;

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
/** The fields release tracking needs; satisfied by both threads.get and threads.list rows. */
type ThreadRef = Pick<Thread, "id" | "projectId" | "updatedAt">;

const CONTINUE_DELAY_MS = 90_000;
const RELEASE_BACKFILL_VERSION = 1;
const CI_TIMEOUT_MS = 3 * 3_600_000;
const OK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
/** Deploy-preview and housekeeping bots: their comments are not review feedback. */
const BOT_LOGINS = new Set(["vercel", "github-actions", "dependabot", "linear", "changeset-bot", "codecov", "netlify", "sonarcloud"]);
const isBot = (login: string | undefined, body: string) =>
  login === undefined || login.endsWith("[bot]") || BOT_LOGINS.has(login) || /^\[vc\]:/.test(body);

type AutoContinue = { resetsAt: number; queuedMessageId: string | null };
export type ThreadPrRef = { repo: string; state: string; mergedAt?: number | null };
type ReleaseWaiter = { threadId: string; projectName: string; since: number };
/** A release seen but not yet announced. `sha` is null for GitHub releases (nothing to wait for). */
type Pending = { prNumber: number | null; title: string; sha: string | null; mergedAt: number; projectName: string };
type Release = { key: string; prNumber: number | null; title: string; sha: string | null; at: number };
type CiWatch = {
  threadId: string;
  repo: string;
  pr: number;
  watchFor: "checks" | "reviews" | "both";
  since: number;
  /** Reviews/comments newer than this are reported; advances after each report. */
  reviewsSince?: number;
  headSha: string | null;
};

function ghPath(): string {
  return ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].find(existsSync) ?? "gh";
}

function gh(args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ghPath(), args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`gh ${args.slice(0, 3).join(" ")}: ${stderr || error.message}`.slice(0, 500)));
      else resolve(stdout);
    });
  });
}

function repoSlug(remote: string | null): string | null {
  const match = remote ? /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(remote) : null;
  return match ? match[1]! : null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function createWatchers(
  bb: BbPluginApi,
  releaseConfig: Record<string, ReleaseWatchConfig>,
  changed: () => void,
  /** The PRs a thread created, for cross-repo release waits. */
  threadPrs: (threadId: string) => Promise<ThreadPrRef[]> = async () => [],
) {
  const kv = bb.storage.kv;
  const get = async <T>(key: string, fallback: T): Promise<T> => (await kv.get<T>(key)) ?? fallback;

  async function tell(threadId: string, text: string, sendAt?: number) {
    return bb.sdk.threads.send({
      threadId,
      mode: "queue-if-active",
      input: [{ type: "text", text, mentions: [] }],
      ...(sendAt === undefined ? {} : { sendAt }),
    });
  }

  async function projectFor(thread: Pick<Thread, "projectId">) {
    const project = await bb.sdk.projects.get({ projectId: thread.projectId });
    return { name: project.name, slug: repoSlug(project.gitRemoteUrl) };
  }

  // --- auto-continue ---------------------------------------------------------

  async function onIdle(thread: Thread, text: string | null) {
    if (text === null || thread.parentThreadId !== null) return;
    const hit = parseLimitHit(text);
    if (hit !== null) {
      const pending = await get<Record<string, AutoContinue>>("autoContinue", {});
      if (pending[thread.id]?.resetsAt === hit.resetsAt) return;
      const sendAt = hit.resetsAt + CONTINUE_DELAY_MS;
      const result = await tell(thread.id, "continue", sendAt);
      pending[thread.id] = {
        resetsAt: hit.resetsAt,
        queuedMessageId: result.delivery === "queued" ? result.queuedMessage.id : null,
      };
      await kv.set("autoContinue", pending);
      bb.log.info(`auto-continue ${thread.id} at ${new Date(sendAt).toISOString()}`);
      return;
    }
    if (RELEASE_WAIT.test(text.slice(-1500))) await registerReleaseWaiter(thread);
  }

  /** The user resumed the thread before the reset: drop our scheduled "continue". */
  async function onActive(thread: Thread) {
    const pending = await get<Record<string, AutoContinue>>("autoContinue", {});
    const entry = pending[thread.id];
    if (entry === undefined) return;
    delete pending[thread.id];
    await kv.set("autoContinue", pending);
    if (entry.queuedMessageId !== null && Date.now() < entry.resetsAt) {
      await bb.sdk.threads.queuedMessages
        .delete({ threadId: thread.id, queuedMessageId: entry.queuedMessageId })
        .catch(() => undefined);
    }
  }

  // --- release watcher -------------------------------------------------------

  const waiterKey = (threadId: string, projectName: string) => `${threadId}@${projectName}`;

  /**
   * Projects whose release this thread may be waiting for: its own, plus repos
   * where it has a PR that hasn't shipped yet (still open, or merged after that
   * project's latest release). Long-shipped PRs don't count.
   */
  async function releaseProjectsFor(thread: ThreadRef): Promise<string[]> {
    const own = (await projectFor(thread)).name;
    const prs = await threadPrs(thread.id);
    const names = new Set<string>();
    if (releaseConfig[own] !== undefined) names.add(own);
    for (const name of Object.keys(releaseConfig)) {
      if (names.has(name)) continue;
      const repo = await releaseRepo(name);
      const inRepo = prs.filter((pr) => pr.repo === repo);
      if (inRepo.length === 0) continue;
      if (inRepo.some((pr) => pr.state === "open" || pr.state === "draft")) {
        names.add(name);
        continue;
      }
      const latest = await latestRelease(name).catch(() => null);
      if (inRepo.some((pr) => pr.state === "merged" && (pr.mergedAt ?? 0) > (latest?.at ?? 0))) names.add(name);
    }
    return [...names];
  }

  /**
   * Registers the thread for the next release of each relevant project. A
   * release that already shipped after the thread said it was waiting is
   * reported straight away.
   */
  async function registerReleaseWaiter(thread: ThreadRef) {
    const names = await releaseProjectsFor(thread);
    const waiters = await get<Record<string, ReleaseWaiter>>("releaseWaiters", {});
    for (const name of names) {
      const key = waiterKey(thread.id, name);
      if (waiters[key] !== undefined) continue;
      const since = Math.min(Date.now(), thread.updatedAt);
      const latest = await latestRelease(name).catch(() => null);
      if (latest && latest.at > since + 60_000 && Date.now() - latest.at > 30 * 60_000) {
        await tell(thread.id, releasedMessage(name, latest, [])).catch(() => undefined);
        bb.log.info(`release ${latest.key}: caught up ${thread.id}`);
        continue;
      }
      waiters[key] = { threadId: thread.id, projectName: name, since };
      bb.log.info(`release waiter: ${thread.id} (${name})`);
    }
    await kv.set("releaseWaiters", waiters);
    changed();
    return names;
  }

  async function releaseRepo(projectName: string): Promise<string | null> {
    const config = releaseConfig[projectName];
    if (config?.repo) return config.repo;
    const projects = await bb.sdk.projects.list();
    const project = projects.find((candidate) => candidate.name === projectName);
    return repoSlug(project?.gitRemoteUrl ?? null);
  }

  /** Recent releases of a project, newest first. */
  async function recentReleases(projectName: string): Promise<Release[]> {
    const config = releaseConfig[projectName];
    const repo = await releaseRepo(projectName);
    if (!config || !repo) return [];
    if (config.mode === "release") {
      const releases = JSON.parse(
        await gh(["release", "list", "-R", repo, "-L", "10", "--json", "tagName,name,publishedAt,isDraft"]),
      ) as Array<{ tagName: string; name: string; publishedAt: string; isDraft: boolean }>;
      return releases
        .filter((release) => !release.isDraft)
        .map((release) => ({ key: `${repo}@${release.tagName}`, prNumber: null, title: release.name || release.tagName, sha: null, at: Date.parse(release.publishedAt) }));
    }
    const merged = JSON.parse(
      await gh(["pr", "list", "-R", repo, "--base", config.base, "--state", "merged", "-L", "10", "--json", "number,title,mergedAt,mergeCommit"]),
    ) as Array<{ number: number; title: string; mergedAt: string; mergeCommit: { oid: string } | null }>;
    const pattern = new RegExp(config.titlePattern, "i");
    return merged
      .filter((pr) => pattern.test(pr.title))
      .map((pr) => ({ key: `${repo}#${pr.number}`, prNumber: pr.number, title: pr.title, sha: pr.mergeCommit?.oid ?? null, at: Date.parse(pr.mergedAt) }))
      .sort((a, b) => b.at - a.at);
  }

  async function latestRelease(projectName: string): Promise<Release | null> {
    return (await recentReleases(projectName))[0] ?? null;
  }

  function releasedMessage(projectName: string, release: Pick<Release, "title" | "prNumber" | "at">, runs: unknown[]) {
    const headline = `${release.title}${release.prNumber !== null ? ` (#${release.prNumber})` : ""} in ${projectName}, ${new Date(release.at).toLocaleString("en-GB")}`;
    return `released: ${headline}.${runs.length ? ` Its workflows passed (${runs.length} runs).` : ""} First confirm your changes are in it; if they aren't, say you're still waiting for a release and stop. Otherwise continue where you left off.`;
  }

  async function checkReleases() {
    const waiters = Object.values(await get<Record<string, ReleaseWaiter>>("releaseWaiters", {}));
    const pending = await get<Record<string, Pending>>("pendingReleases", {});
    const projects = new Set([...waiters.map((waiter) => waiter.projectName), ...Object.values(pending).map((p) => p.projectName)]);
    const seen = await get<Record<string, number>>("seenReleases", {});

    for (const projectName of projects) {
      const repo = await releaseRepo(projectName);
      if (!releaseConfig[projectName] || !repo) continue;
      // 1. New releases become pending until their workflows finish.
      for (const release of await recentReleases(projectName)) {
        if (seen[release.key] !== undefined || pending[release.key] !== undefined) continue;
        if (seen[repo] === undefined) {
          seen[release.key] = release.at; // first run: everything already released is history
          continue;
        }
        pending[release.key] = { prNumber: release.prNumber, title: release.title, sha: release.sha, mergedAt: release.at, projectName };
      }
      seen[repo] = Date.now();
    }

    // 2. Pending releases whose workflow runs completed wake their waiters.
    for (const [key, release] of Object.entries(pending)) {
      const repo = await releaseRepo(release.projectName);
      if (!repo) continue;
      const runs = (release.sha === null
        ? []
        : JSON.parse(await gh(["run", "list", "-R", repo, "--commit", release.sha, "--json", "name,status,conclusion,url"]))) as Array<{
        name: string;
        status: string;
        conclusion: string | null;
        url: string;
      }>;
      const running = runs.filter((run) => run.status !== "completed");
      const stale = Date.now() - release.mergedAt > 2 * 3_600_000;
      if (running.length > 0 && !stale) continue;
      const failed = runs.filter((run) => run.conclusion && !["success", "skipped", "neutral"].includes(run.conclusion));
      const allWaiters = await get<Record<string, ReleaseWaiter>>("releaseWaiters", {});
      const targets = Object.entries(allWaiters).filter(
        ([, waiter]) => waiter.projectName === release.projectName && waiter.since < release.mergedAt + 60_000,
      );
      const headline = `${release.title}${release.prNumber !== null ? ` (#${release.prNumber})` : ""}, ${new Date(release.mergedAt).toLocaleString("en-GB")}`;
      const message =
        failed.length === 0
          ? releasedMessage(release.projectName, { title: release.title, prNumber: release.prNumber, at: release.mergedAt }, runs)
          : `The release merged (${headline}), but ${failed.length} workflow run(s) failed: ${failed
              .map((run) => `${run.name} (${run.url})`)
              .join(", ")}. Check whether that affects you before continuing.`;
      for (const [waiterId, waiter] of targets) {
        const thread = await bb.sdk.threads.get({ threadId: waiter.threadId }).catch(() => null);
        if (thread && thread.archivedAt === null) {
          await tell(waiter.threadId, message).catch((error) => bb.log.warn(`release notify: ${String(error)}`));
        }
        delete allWaiters[waiterId];
      }
      await kv.set("releaseWaiters", allWaiters);
      seen[key] = release.mergedAt;
      delete pending[key];
      bb.log.info(`release ${key}: notified ${targets.length} thread(s)`);
    }
    await kv.set("pendingReleases", pending);
    await kv.set("seenReleases", seen);
    changed();
  }

  // --- CI / review watcher ---------------------------------------------------

  async function watchCi(
    threadId: string,
    options: { pr?: number; watchFor?: CiWatch["watchFor"]; repo?: string },
  ) {
    const thread = await bb.sdk.threads.get({ threadId });
    const slug = options.repo ?? (await projectFor(thread)).slug;
    if (!slug) throw new Error("This project has no GitHub remote.");
    let pr = options.pr;
    if (pr === undefined) {
      const environment = thread.environmentId
        ? await bb.sdk.environments.get({ environmentId: thread.environmentId })
        : null;
      if (!environment?.branchName) throw new Error("No PR number given and the thread has no branch.");
      const found = JSON.parse(
        await gh(["pr", "view", environment.branchName, "-R", slug, "--json", "number"]).catch(() => "{}"),
      ) as { number?: number };
      if (found.number === undefined) throw new Error(`No open PR for branch ${environment.branchName}.`);
      pr = found.number;
    }
    // Refuse closed/merged PRs up front: a wrong repo guess (same number, other
    // repo) shows up here instead of as a bogus "merged" notice later.
    const current = JSON.parse(
      await gh(["pr", "view", String(pr), "-R", slug, "--json", "state,title,createdAt"]).catch(() => "{}"),
    ) as { state?: string; title?: string; createdAt?: string };
    if (current.state === undefined) throw new Error(`${slug}#${pr} doesn't exist or isn't accessible. Pass repo explicitly.`);
    if (current.state !== "OPEN") {
      throw new Error(
        `${slug}#${pr} is already ${current.state.toLowerCase()} ("${current.title}", opened ${current.createdAt?.slice(0, 10)}). If you meant a PR in another repo, pass repo (owner/name).`,
      );
    }
    const watches = await get<Record<string, CiWatch>>("ciWatches", {});
    const key = `${threadId}:${slug}#${pr}`;
    watches[key] = { threadId, repo: slug, pr, watchFor: options.watchFor ?? "both", since: Date.now(), headSha: null };
    await kv.set("ciWatches", watches);
    changed();
    return watches[key]!;
  }

  type PrState = {
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

  async function failedLog(detailsUrl: string | undefined, repo: string): Promise<string> {
    const runId = detailsUrl ? /\/actions\/runs\/(\d+)/.exec(detailsUrl)?.[1] : undefined;
    if (!runId) return "";
    const log = await gh(["run", "view", runId, "-R", repo, "--log-failed"], 60_000).catch(() => "");
    const lines = log.trim().split("\n").slice(-60).map((line) => line.replace(/^[^\t]*\t[^\t]*\t/, ""));
    return lines.length > 1 ? `\n\`\`\`\n${truncate(lines.join("\n"), 4000)}\n\`\`\`` : "";
  }

  async function checkCi() {
    const watches = await get<Record<string, CiWatch>>("ciWatches", {});
    // One message per thread per cycle, however many of its PRs have news.
    const outbox = new Map<string, { notes: string[]; stillWatching: boolean }>();
    let me: string | null = null;
    for (const [key, watch] of Object.entries(watches)) {
      let pr: PrState;
      try {
        pr = JSON.parse(
          await gh(["pr", "view", String(watch.pr), "-R", watch.repo, "--json", "state,headRefOid,url,statusCheckRollup,reviews,comments"]),
        ) as PrState;
      } catch (error) {
        bb.log.warn(`ci ${key}: ${String(error)}`);
        continue;
      }
      me ??= (await gh(["api", "user", "-q", ".login"]).catch(() => "")).trim();
      const notes: string[] = [];
      let done = false;

      if (pr.state !== "OPEN") {
        notes.push(`PR ${watch.repo.split("/")[1]}#${watch.pr} is now ${pr.state.toLowerCase()}.`);
        done = true;
      }
      // A new push restarts the checks; keep waiting on the new head.
      if (watch.headSha !== null && watch.headSha !== pr.headRefOid) watch.since = Date.now();
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
            notes.push(`✅ CI is green on ${watch.repo.split("/")[1]}#${watch.pr} (${pr.headRefOid.slice(0, 7)}): ${checks.length} checks passed.`);
          } else {
            const log = await failedLog(failed[0]!.url, watch.repo);
            notes.push(
              `❌ CI failed on ${watch.repo.split("/")[1]}#${watch.pr} (${pr.headRefOid.slice(0, 7)}): ${failed.map((check) => check.name).join(", ")}.${log}`,
            );
          }
          done = true;
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

      if (!done && Date.now() - watch.since > CI_TIMEOUT_MS) {
        notes.push(`Still waiting on ${watch.repo.split("/")[1]}#${watch.pr} after 3 hours; stopped watching. ${pr.url}`);
        done = true;
      }

      if (done || reviewNews) {
        const entry = outbox.get(watch.threadId) ?? { notes: [], stillWatching: false };
        entry.notes.push(...notes);
        if (!done) entry.stillWatching = true;
        outbox.set(watch.threadId, entry);
        if (done) delete watches[key];
        else watch.reviewsSince = Date.now();
      }
    }
    for (const [threadId, entry] of outbox) {
      const others = Object.values(watches).filter((watch) => watch.threadId === threadId).length;
      const suffix =
        entry.stillWatching || others > 0
          ? `\n\n(Still watching ${others} PR${others === 1 ? "" : "s"}; you'll get another message when there's news.)`
          : "";
      await tell(threadId, `[ci watcher] ${entry.notes.join("\n\n")}${suffix}`).catch((error) =>
        bb.log.warn(`ci notify: ${String(error)}`),
      );
    }
    await kv.set("ciWatches", watches);
    changed();
  }

  // --- wiring ----------------------------------------------------------------

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => onIdle(thread, lastAssistantText));
  bb.events.on("thread.active", ({ thread }) => onActive(thread));
  bb.events.on("thread.archived", async ({ thread }) => {
    const continues = await get<Record<string, AutoContinue>>("autoContinue", {});
    if (thread.id in continues) {
      delete continues[thread.id];
      await kv.set("autoContinue", continues);
    }
    // Release waiters are keyed thread@project; one thread can wait on several.
    const waiters = await get<Record<string, ReleaseWaiter>>("releaseWaiters", {});
    const keys = Object.keys(waiters).filter((key) => waiters[key]!.threadId === thread.id);
    if (keys.length > 0) {
      for (const key of keys) delete waiters[key];
      await kv.set("releaseWaiters", waiters);
    }
  });

  // Register threads that were already waiting before these rules existed. Bump
  // the version when RELEASE_WAIT or the config changes.
  bb.background.service("release-backfill", {
    async start(signal) {
      // Waiters used to be keyed by thread id alone; move them to thread@project.
      const stored = await get<Record<string, ReleaseWaiter>>("releaseWaiters", {});
      const legacy = Object.keys(stored).filter((key) => !key.includes("@"));
      if (legacy.length > 0) {
        for (const key of legacy) {
          const waiter = stored[key]!;
          stored[waiterKey(waiter.threadId, waiter.projectName)] ??= waiter;
          delete stored[key];
        }
        await kv.set("releaseWaiters", stored);
      }
      if ((await get<number>("releaseBackfill", 0)) !== RELEASE_BACKFILL_VERSION) {
        const threads = await bb.sdk.threads.list({ limit: 500 });
        for (const thread of threads) {
          if (signal.aborted) return;
          if (thread.archivedAt !== null || thread.status !== "idle" || thread.parentThreadId !== null) continue;
          const output = await bb.sdk.threads.output({ threadId: thread.id, signal }).catch(() => null);
          const tail = (output?.output ?? "").slice(-1500);
          if (RELEASE_WAIT.test(tail)) await registerReleaseWaiter(thread).catch((error) => bb.log.warn(`release backfill ${thread.id}: ${String(error)}`));
        }
        if (!signal.aborted) await kv.set("releaseBackfill", RELEASE_BACKFILL_VERSION);
      }
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  let releaseBusy = false;
  bb.background.schedule("release-watch", "*/3 * * * *", async () => {
    if (releaseBusy || Object.keys(releaseConfig).length === 0) return;
    const waiters = await get<Record<string, ReleaseWaiter>>("releaseWaiters", {});
    const pending = await get<Record<string, Pending>>("pendingReleases", {});
    if (Object.keys(waiters).length + Object.keys(pending).length === 0) return;
    releaseBusy = true;
    try {
      await checkReleases();
    } finally {
      releaseBusy = false;
    }
  });
  let ciBusy = false;
  bb.background.schedule("ci-watch", "*/2 * * * *", async () => {
    if (ciBusy || Object.keys(await get<Record<string, CiWatch>>("ciWatches", {})).length === 0) return;
    ciBusy = true;
    try {
      await checkCi();
    } finally {
      ciBusy = false;
    }
  });

  async function status() {
    return {
      autoContinue: await get<Record<string, AutoContinue>>("autoContinue", {}),
      releaseWaiters: await get<Record<string, ReleaseWaiter>>("releaseWaiters", {}),
      pendingReleases: await get<Record<string, Pending>>("pendingReleases", {}),
      ciWatches: await get<Record<string, CiWatch>>("ciWatches", {}),
    };
  }

  return { watchCi, registerReleaseWaiter, checkReleases, checkCi, status, RELEASE_WAIT };
}
