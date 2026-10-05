// Finds worktree checkouts bb no longer tracks. bb tears down the worktree it
// created when a thread is archived, but extra checkouts an agent adds next to
// it (cross-repo work) and the odd failed teardown stay on disk forever, often
// with node_modules. A weekly scan lists them in the digest; merged, clean ones
// can be removed in one go.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const leftoverSchema = z.object({
  path: z.string(),
  repo: z.string(),
  branch: z.string(),
  pr: z.string().nullable(),
  prState: z.enum(["merged", "closed", "open", "none"]),
  dirty: z.number(),
  nodeModules: z.boolean(),
  modifiedAt: z.number(),
  /** Merged PR (or nothing of its own) and no uncommitted changes. */
  safe: z.boolean(),
});
export type Leftover = z.infer<typeof leftoverSchema>;
export type LeftoverReport = { checkedAt: number; items: Leftover[] };

/** bb's old worktree root, from before worktrees moved into the plugin's host data. */
const LEGACY_ROOT = join(homedir(), ".bb", "worktrees");

function run(bin: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    );
  });
}
const gitBin = () => ["/opt/homebrew/bin/git", "/usr/bin/git"].find(existsSync) ?? "git";
const ghBin = () => ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].find(existsSync) ?? "gh";

async function subdirs(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => join(path, entry.name));
}

export function createLeftovers(bb: BbPluginApi) {
  async function scan(): Promise<LeftoverReport> {
    const environments = await bb.sdk.environments.list({ limit: 1000 });
    const worktrees = environments.filter(
      (environment) => environment.isWorktree && environment.path && environment.lifecycle?.phase !== "destroyed",
    );
    // Each worktree lives at <root>/<env folder>/<repo>; any env folder bb doesn't know is left over.
    const liveFolders = new Set(worktrees.map((environment) => dirname(environment.path!)));
    const roots = new Set([LEGACY_ROOT, ...worktrees.map((environment) => dirname(dirname(environment.path!)))]);
    const items: Leftover[] = [];
    for (const root of roots) {
      for (const folder of await subdirs(root)) {
        if (liveFolders.has(folder)) continue;
        for (const path of await subdirs(folder)) items.push(await inspect(path));
      }
    }
    const report = { checkedAt: Date.now(), items };
    await bb.storage.kv.set("leftovers", report);
    return report;
  }

  async function inspect(path: string): Promise<Leftover> {
    const git = (...args: string[]) => run(gitBin(), args, path).catch(() => "");
    const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")) || "?";
    const dirty = (await git("status", "--porcelain", "--untracked-files=no")).split("\n").filter(Boolean).length;
    const ownCommits = (await git("log", "HEAD", "--not", "--remotes", "--oneline")).split("\n").filter(Boolean).length;
    const remote = (await git("remote", "get-url", "origin")).replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
    let pr: string | null = null;
    let prState: Leftover["prState"] = "none";
    if (remote && branch !== "HEAD" && branch !== "?") {
      const found = await run(ghBin(), ["pr", "list", "-R", remote, "--head", branch, "--state", "all", "--json", "number,state", "-q", ".[0]"]).catch(() => "");
      if (found) {
        const parsed = JSON.parse(found) as { number: number; state: string };
        pr = `${remote.split("/")[1]}#${parsed.number}`;
        prState = parsed.state.toLowerCase() as Leftover["prState"];
      }
    }
    const info = await stat(path);
    return {
      path,
      repo: basename(path),
      branch,
      pr,
      prState,
      dirty,
      nodeModules: existsSync(join(path, "node_modules")),
      modifiedAt: info.mtimeMs,
      safe: dirty === 0 && (prState === "merged" || ownCommits === 0),
    };
  }

  async function read(refresh = false): Promise<LeftoverReport> {
    const cached = await bb.storage.kv.get<LeftoverReport>("leftovers");
    return cached && !refresh ? cached : scan();
  }

  /** Removes the safe leftovers (git worktree remove, so the main repo forgets them too). */
  async function clean(): Promise<{ removed: string[]; kept: string[] }> {
    const report = await scan();
    const removed: string[] = [];
    for (const item of report.items.filter((candidate) => candidate.safe)) {
      const common = await run(gitBin(), ["rev-parse", "--path-format=absolute", "--git-common-dir"], item.path).catch(() => "");
      if (common && common !== join(item.path, ".git")) {
        await run(gitBin(), ["worktree", "remove", "--force", "--force", item.path], dirname(common)).catch(() => undefined);
      }
      await rm(item.path, { recursive: true, force: true });
      removed.push(item.path);
      // Drop the env folder once nothing but bb's marker files is left.
      if ((await subdirs(dirname(item.path))).length === 0) await rm(dirname(item.path), { recursive: true, force: true });
    }
    const after = await scan();
    return { removed, kept: after.items.map((item) => item.path) };
  }

  bb.background.schedule("leftover-worktrees", "0 8 * * 1", async () => {
    const report = await scan();
    bb.log.info(`leftovers: ${report.items.length} untracked checkout(s)`);
  });

  return { read, clean };
}
