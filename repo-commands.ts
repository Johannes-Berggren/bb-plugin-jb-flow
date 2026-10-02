// Repo commands: per-project buttons in the thread side panel that start a
// command in a BB terminal for the thread and, once its port answers, open
// the app in a BB browser tab. A command can declare several "slots" (e.g.
// pnpm dev / dev:2 / dev:3) so parallel worktrees each get free ports.
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const repoSlotSchema = z.object({
  command: z.string().min(1),
  /** Opened in a BB browser tab once its port accepts connections. */
  url: z.string().url().nullable(),
  /** Ports this slot binds; a slot is free when none of them answer. */
  ports: z.array(z.number().int().min(1).max(65535)),
});
export const repoCommandSchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(60),
  slots: z.array(repoSlotSchema).min(1).max(10),
});
export type RepoCommand = z.infer<typeof repoCommandSchema>;

export const repoScriptSchema = z.object({
  /** Command id used by run/stop: `script:<name>`. */
  id: z.string(),
  name: z.string(),
  /** The script body from package.json. */
  script: z.string(),
  /** What actually runs, e.g. `pnpm run build`. */
  command: z.string(),
  url: z.string().nullable(),
});
export type RepoScript = z.infer<typeof repoScriptSchema>;

const LIFECYCLE_SCRIPT = /^(pre|post)|^(prepare|install|prepublishOnly)$/;

function packageManager(dir: string): "pnpm" | "yarn" | "bun" | "npm" {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  return "npm";
}

/** Best-effort port from a script body: `--port 3000`, `-p 3300`, `PORT=4000`. */
function scriptPort(script: string): number | null {
  const match = /(?:--port[ =]|\s-p\s+|\bPORT=)(\d{2,5})\b/.exec(script);
  return match ? Number(match[1]) : null;
}

export const devRunSchema = z.object({
  threadId: z.string(),
  commandId: z.string(),
  label: z.string(),
  terminalId: z.string(),
  slot: z.number(),
  url: z.string().nullable(),
  status: z.enum(["starting", "ready", "exited", "timeout"]),
  startedAt: z.number(),
});
export type DevRun = z.infer<typeof devRunSchema>;

const READY_TIMEOUT_MS = 5 * 60_000;

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(800, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function urlPort(url: string): number {
  const parsed = new URL(url);
  return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * @param defaults Pinned commands keyed by BB project name, from local.config.json.
 * Settings overrides (stored in plugin kv) win over these.
 */
export function createRepoCommands(
  bb: BbPluginApi,
  changed: () => void,
  defaults: Record<string, RepoCommand[]>,
) {
  const disposed = new AbortController();
  bb.onDispose(() => disposed.abort());

  async function getOverrides(): Promise<Record<string, RepoCommand[]>> {
    return (await bb.storage.kv.get<Record<string, RepoCommand[]>>("repoCommands")) ?? {};
  }
  async function getRuns(): Promise<Record<string, DevRun>> {
    return (await bb.storage.kv.get<Record<string, DevRun>>("devRuns")) ?? {};
  }
  async function saveRun(run: DevRun): Promise<void> {
    const runs = await getRuns();
    await bb.storage.kv.set("devRuns", { ...runs, [`${run.threadId}:${run.commandId}`]: run });
    changed();
  }

  async function projectName(threadId: string): Promise<{ projectId: string; name: string }> {
    const thread = await bb.sdk.threads.get({ threadId });
    const project = await bb.sdk.projects.get({ projectId: thread.projectId });
    return { projectId: thread.projectId, name: project.name };
  }

  async function scriptsFor(threadId: string, pinned: RepoCommand[]) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.environmentId === null) return { scripts: [] as RepoScript[], scriptsError: "Thread has no environment yet." };
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (environment.path === null) return { scripts: [], scriptsError: "Environment has no path." };
    let manifest: { scripts?: Record<string, string> };
    try {
      manifest = JSON.parse(readFileSync(join(environment.path, "package.json"), "utf8")) as typeof manifest;
    } catch {
      return { scripts: [], scriptsError: `No package.json in ${environment.path}.` };
    }
    const pm = packageManager(environment.path);
    // A pinned command that already runs a script replaces that script's row.
    const pinnedCommands = new Set(pinned.flatMap((command) => command.slots.map((slot) => slot.command)));
    const scripts = Object.entries(manifest.scripts ?? {})
      .filter(([name]) => !LIFECYCLE_SCRIPT.test(name))
      .map(([name, script]): RepoScript => {
        const port = scriptPort(script);
        return {
          id: `script:${name}`,
          name,
          script,
          command: `${pm} run ${name}`,
          url: port === null ? null : `http://localhost:${port}`,
        };
      })
      .filter((script) => !pinnedCommands.has(script.command) && !pinnedCommands.has(`${pm} ${script.name}`));
    return { scripts, scriptsError: null };
  }

  async function commandsFor(threadId: string) {
    const { name } = await projectName(threadId);
    const overrides = await getOverrides();
    const commands = overrides[name] ?? defaults[name] ?? [];
    return { projectName: name, commands };
  }

  /** Resolves a pinned command id or `script:<name>` into a runnable command. */
  async function resolveCommand(threadId: string, commandId: string) {
    const { commands, projectName: name } = await commandsFor(threadId);
    const pinned = commands.find((candidate) => candidate.id === commandId);
    if (pinned) return pinned;
    if (commandId.startsWith("script:")) {
      const { scripts, scriptsError } = await scriptsFor(threadId, []);
      const script = scripts.find((candidate) => candidate.id === commandId);
      if (script) {
        return {
          id: script.id,
          label: script.name,
          slots: [{ command: script.command, url: script.url, ports: script.url ? [Number(new URL(script.url).port)] : [] }],
        } satisfies RepoCommand;
      }
      if (scriptsError) throw new Error(scriptsError);
    }
    throw new Error(`No "${commandId}" command for ${name}.`);
  }

  /** Appends tabs to the thread's side panel, retrying once on a revision race. */
  async function addTabs(threadId: string, make: (existing: { id: string }[]) => unknown[]) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await bb.sdk.threads.tabs.get({ threadId });
      const extra = make(current.tabs);
      if (extra.length === 0) return;
      try {
        await bb.sdk.threads.tabs.update({
          threadId,
          expectedRevision: current.revision,
          tabs: [...current.tabs, ...extra] as typeof current.tabs,
        });
        return;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  }

  async function openBrowserTab(run: DevRun) {
    if (run.url === null) return;
    const thread = await bb.sdk.threads.get({ threadId: run.threadId });
    const tabId = `jb-flow-browser-${run.commandId}`;
    await addTabs(run.threadId, (existing) =>
      existing.some((tab) => tab.id === tabId)
        ? []
        : [{ id: tabId, kind: "browser", url: run.url, title: run.label, environmentId: thread.environmentId }],
    );
  }

  async function waitForReady(run: DevRun, port: number) {
    const deadline = run.startedAt + READY_TIMEOUT_MS;
    while (!disposed.signal.aborted && Date.now() < deadline) {
      const terminal = await bb.sdk.terminals.get({ terminalId: run.terminalId }).catch(() => null);
      if (terminal === null || terminal.status === "exited" || terminal.status === "disconnected") {
        await saveRun({ ...run, status: "exited" });
        return;
      }
      if (await portOpen(port)) {
        // Give the dev server a moment to finish its first compile before loading.
        await sleep(1500, disposed.signal);
        await openBrowserTab(run).catch((error) => bb.log.warn(`browser tab: ${String(error)}`));
        await saveRun({ ...run, status: "ready" });
        return;
      }
      await sleep(2000, disposed.signal);
    }
    if (!disposed.signal.aborted) await saveRun({ ...run, status: "timeout" });
  }

  async function run(threadId: string, commandId: string): Promise<DevRun> {
    const command = await resolveCommand(threadId, commandId);

    // Already running for this thread: just re-open its tabs.
    const existing = (await getRuns())[`${threadId}:${commandId}`];
    if (existing) {
      const terminal = await bb.sdk.terminals.get({ terminalId: existing.terminalId }).catch(() => null);
      if (terminal !== null && (terminal.status === "running" || terminal.status === "starting")) {
        await addTabs(threadId, (tabs) =>
          tabs.some((tab) => tab.id === `jb-flow-term-${commandId}`)
            ? []
            : [{ id: `jb-flow-term-${commandId}`, kind: "terminal", terminalId: existing.terminalId, target: { kind: "thread", threadId } }],
        );
        if (existing.status === "ready") await openBrowserTab(existing);
        return existing;
      }
    }

    let slot = -1;
    for (let index = 0; index < command.slots.length; index += 1) {
      const busy = await Promise.all(command.slots[index]!.ports.map(portOpen));
      if (!busy.some(Boolean)) {
        slot = index;
        break;
      }
    }
    if (slot === -1) {
      throw new Error(`All ${command.slots.length} slot(s) for "${command.label}" are in use. Stop one first.`);
    }
    const chosen = command.slots[slot]!;
    const terminal = await bb.sdk.terminals.create({
      cols: 120,
      rows: 32,
      scope: { kind: "thread", threadId },
      start: { mode: "command", command: chosen.command },
      title: command.slots.length > 1 ? `${command.label} (${chosen.command})` : command.label,
    });
    const devRun: DevRun = {
      threadId,
      commandId,
      label: command.label,
      terminalId: terminal.id,
      slot,
      url: chosen.url,
      status: chosen.url === null ? "ready" : "starting",
      startedAt: Date.now(),
    };
    await addTabs(threadId, () => [
      { id: `jb-flow-term-${commandId}`, kind: "terminal", terminalId: terminal.id, target: { kind: "thread", threadId } },
    ]);
    await saveRun(devRun);
    if (chosen.url !== null) void waitForReady(devRun, urlPort(chosen.url));
    return devRun;
  }

  async function stop(threadId: string, commandId: string): Promise<boolean> {
    const runs = await getRuns();
    const key = `${threadId}:${commandId}`;
    const existing = runs[key];
    if (existing === undefined) return false;
    await bb.sdk.terminals.close({ terminalId: existing.terminalId, mode: "force" }).catch(() => undefined);
    delete runs[key];
    await bb.storage.kv.set("devRuns", runs);
    changed();
    return true;
  }

  async function status(threadId: string) {
    const { commands, projectName: name } = await commandsFor(threadId);
    const { scripts, scriptsError } = await scriptsFor(threadId, commands);
    const runs = await getRuns();
    const live: DevRun[] = [];
    for (const [key, existing] of Object.entries(runs)) {
      if (!key.startsWith(`${threadId}:`)) continue;
      const terminal = await bb.sdk.terminals.get({ terminalId: existing.terminalId }).catch(() => null);
      const alive = terminal !== null && (terminal.status === "running" || terminal.status === "starting");
      live.push(alive || existing.status !== "starting" ? existing : { ...existing, status: "exited" });
    }
    return { projectName: name, commands, scripts, scriptsError, runs: live };
  }

  async function setCommands(projectNameValue: string, commands: RepoCommand[] | null) {
    const overrides = await getOverrides();
    if (commands === null) delete overrides[projectNameValue];
    else overrides[projectNameValue] = commands;
    await bb.storage.kv.set("repoCommands", overrides);
    changed();
  }

  async function allCommands() {
    const overrides = await getOverrides();
    return { defaults, overrides };
  }

  return { run, stop, status, setCommands, allCommands };
}
