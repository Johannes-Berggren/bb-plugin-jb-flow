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

export const releaseWatchSchema = z.object({
  /** owner/name; defaults to the project's GitHub remote. */
  repo: z.string().optional(),
  base: z.string().default("main"),
  /** Regex a merged PR title must match to count as a release. */
  titlePattern: z.string().default("^Release\\b"),
});
export type ReleaseWatchConfig = z.infer<typeof releaseWatchSchema>;

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

const CONTINUE_DELAY_MS = 90_000;
const RELEASE_WAIT =
  /waiting for (a |the )?(new )?(release|deploy)|once (it'?s|it is|you'?ve|this is|that'?s|everything is) (been )?(released|deployed|shipped|live)|once (`?main`? is|the release is|it'?s) (deployed|out|live|released)|after (the )?(next )?release|reply \*{0,2}go\*{0,2} once .{0,40}releas/i;
const CI_TIMEOUT_MS = 3 * 3_600_000;
const OK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

type AutoContinue = { resetsAt: number; queuedMessageId: string | null };
type ReleaseWaiter = { threadId: string; projectName: string; since: number };
type Pending = { prNumber: number; title: string; sha: string; mergedAt: number; projectName: string };
type CiWatch = {
  threadId: string;
  repo: string;
  pr: number;
  watchFor: "checks" | "reviews" | "both";
  since: number;
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

  async function projectFor(thread: Thread) {
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
    if (RELEASE_WAIT.test(text)) await registerReleaseWaiter(thread);
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

  async function registerReleaseWaiter(thread: Thread) {
    const { name } = await projectFor(thread);
    if (releaseConfig[name] === undefined) return;
    const waiters = await get<Record<string, ReleaseWaiter>>("releaseWaiters", {});
    if (waiters[thread.id] !== undefined) return;
    waiters[thread.id] = { threadId: thread.id, projectName: name, since: Date.now() };
    await kv.set("releaseWaiters", waiters);
    bb.log.info(`release waiter: ${thread.id} (${name})`);
    changed();
  }

  async function releaseRepo(projectName: string): Promise<string | null> {
    const config = releaseConfig[projectName];
    if (config?.repo) return config.repo;
    const projects = await bb.sdk.projects.list();
    const project = projects.find((candidate) => candidate.name === projectName);
    return repoSlug(project?.gitRemoteUrl ?? null);
  }

  async function checkReleases() {
    const waiters = Object.values(await get<Record<string, ReleaseWaiter>>("releaseWaiters", {}));
    const pending = await get<Record<string, Pending>>("pendingReleases", {});
    const projects = new Set([...waiters.map((waiter) => waiter.projectName), ...Object.values(pending).map((p) => p.projectName)]);
    const seen = await get<Record<string, number>>("seenReleases", {});

    for (const projectName of projects) {
      const config = releaseConfig[projectName];
      const repo = await releaseRepo(projectName);
      if (!config || !repo) continue;
      // 1. New release merges become pending until their workflows finish.
      const merged = JSON.parse(
        await gh(["pr", "list", "-R", repo, "--base", config.base, "--state", "merged", "-L", "10", "--json", "number,title,mergedAt,mergeCommit"]),
      ) as Array<{ number: number; title: string; mergedAt: string; mergeCommit: { oid: string } | null }>;
      const pattern = new RegExp(config.titlePattern, "i");
      for (const pr of merged) {
        const key = `${repo}#${pr.number}`;
        const mergedAt = Date.parse(pr.mergedAt);
        if (!pattern.test(pr.title) || seen[key] !== undefined || pending[key] !== undefined) continue;
        if (seen[repo] === undefined) {
          seen[key] = mergedAt; // first run: everything already merged is history
          continue;
        }
        if (pr.mergeCommit) pending[key] = { prNumber: pr.number, title: pr.title, sha: pr.mergeCommit.oid, mergedAt, projectName };
      }
      seen[repo] = Date.now();
    }

    // 2. Pending releases whose workflow runs completed wake their waiters.
    for (const [key, release] of Object.entries(pending)) {
      const repo = await releaseRepo(release.projectName);
      if (!repo) continue;
      const runs = JSON.parse(
        await gh(["run", "list", "-R", repo, "--commit", release.sha, "--json", "name,status,conclusion,url"]),
      ) as Array<{ name: string; status: string; conclusion: string | null; url: string }>;
      const running = runs.filter((run) => run.status !== "completed");
      const stale = Date.now() - release.mergedAt > 2 * 3_600_000;
      if (running.length > 0 && !stale) continue;
      const failed = runs.filter((run) => run.conclusion && !["success", "skipped", "neutral"].includes(run.conclusion));
      const allWaiters = await get<Record<string, ReleaseWaiter>>("releaseWaiters", {});
      const targets = Object.values(allWaiters).filter(
        (waiter) => waiter.projectName === release.projectName && waiter.since < release.mergedAt + 60_000,
      );
      const headline = `${release.title} (#${release.prNumber}), merged ${new Date(release.mergedAt).toLocaleString("en-GB")}`;
      const message =
        failed.length === 0
          ? `released: ${headline}. Its workflows passed${runs.length ? ` (${runs.length} runs)` : ""}. Continue where you left off.`
          : `The release merged (${headline}), but ${failed.length} workflow run(s) failed: ${failed
              .map((run) => `${run.name} (${run.url})`)
              .join(", ")}. Check whether that affects you before continuing.`;
      for (const waiter of targets) {
        const thread = await bb.sdk.threads.get({ threadId: waiter.threadId }).catch(() => null);
        if (thread && thread.archivedAt === null) {
          await tell(waiter.threadId, message).catch((error) => bb.log.warn(`release notify: ${String(error)}`));
        }
        delete allWaiters[waiter.threadId];
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
        notes.push(`PR #${watch.pr} is now ${pr.state.toLowerCase()}.`);
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
            notes.push(`✅ CI is green on #${watch.pr} (${pr.headRefOid.slice(0, 7)}): ${checks.length} checks passed.`);
          } else {
            const log = await failedLog(failed[0]!.url, watch.repo);
            notes.push(
              `❌ CI failed on #${watch.pr} (${pr.headRefOid.slice(0, 7)}): ${failed.map((check) => check.name).join(", ")}.${log}`,
            );
          }
          done = true;
        }
      }

      if (watch.watchFor !== "checks") {
        const fromOthers = <T extends { author: { login: string } | null }>(item: T) => item.author?.login !== me;
        const reviews = pr.reviews.filter((review) => Date.parse(review.submittedAt) > watch.since && fromOthers(review));
        const comments = pr.comments.filter((comment) => Date.parse(comment.createdAt) > watch.since && fromOthers(comment));
        for (const review of reviews) {
          notes.push(`Review from ${review.author?.login ?? "someone"}: ${review.state}${review.body ? ` — ${truncate(review.body, 800)}` : ""}`);
        }
        for (const comment of comments) {
          notes.push(`Comment from ${comment.author?.login ?? "someone"}: ${truncate(comment.body, 800)}`);
        }
        if (reviews.length + comments.length > 0) {
          done = true;
          notes.push(`Inline review comments: \`gh api repos/${watch.repo}/pulls/${watch.pr}/comments\``);
        }
      }

      if (!done && Date.now() - watch.since > CI_TIMEOUT_MS) {
        notes.push(`Still waiting on #${watch.pr} after 3 hours; stopped watching. ${pr.url}`);
        done = true;
      }

      if (done) {
        await tell(watch.threadId, `[ci watcher] ${notes.join("\n\n")}`).catch((error) => bb.log.warn(`ci notify: ${String(error)}`));
        delete watches[key];
      }
    }
    await kv.set("ciWatches", watches);
    changed();
  }

  // --- wiring ----------------------------------------------------------------

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => onIdle(thread, lastAssistantText));
  bb.events.on("thread.active", ({ thread }) => onActive(thread));
  bb.events.on("thread.archived", async ({ thread }) => {
    for (const key of ["releaseWaiters", "autoContinue"] as const) {
      const map = await get<Record<string, unknown>>(key, {});
      if (thread.id in map) {
        delete map[thread.id];
        await kv.set(key, map);
      }
    }
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
