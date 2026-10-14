// Mirror of the Focus Board plugin's snooze. Both plugins snooze threads; this
// keeps them in step: a jb-flow snooze also dims the card on the board, and a
// snooze set on the board also moves the thread to jb-flow's Snoozed section.
// Writes go through Focus Board's own CLI so it arms its wake timer and
// refreshes open boards. Everything here is best-effort: with Focus Board
// disabled or missing, jb-flow snoozes work exactly as before.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const PLUGIN_ID = "focus-board";

export type BoardSnooze = { id: string; wakeAt: string };

export function createFocusBoard(bb: BbPluginApi) {
  // Most people don't have Focus Board: check it's installed and running before
  // calling it, at most every 5 minutes, instead of a failing request each sync.
  let available: { at: number; value: boolean } | null = null;
  async function isAvailable(): Promise<boolean> {
    if (available && Date.now() - available.at < 5 * 60_000) return available.value;
    const value = await bb.sdk.plugins
      .list()
      .then(({ plugins }) => plugins.some((plugin) => plugin.id === PLUGIN_ID && plugin.enabled && plugin.status === "running"))
      .catch(() => false);
    available = { at: Date.now(), value };
    return value;
  }

  async function serverUrl(): Promise<string> {
    // This bb's own runtime file, not ~/.bb's: a second instance has its own.
    const runtime = JSON.parse(await readFile(path.join(bb.server.experimental_dataDir, "bb-app-runtime.json"), "utf8"));
    return runtime.serverUrl;
  }

  async function cli(argv: string[]): Promise<string> {
    if (!(await isAvailable())) throw new Error("Focus Board is not running");
    const response = await fetch(`${await serverUrl()}/api/v1/plugins/${PLUGIN_ID}/cli`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ argv, cwd: os.homedir() }),
      signal: AbortSignal.timeout(30_000),
    });
    const result = (await response.json().catch(() => null)) as
      | { exitCode?: number; stdout?: string; stderr?: string; error?: string }
      | null;
    if (typeof result?.exitCode !== "number") throw new Error(result?.error ?? `HTTP ${response.status}`);
    if (result.exitCode !== 0) throw new Error((result.stderr || result.stdout || `exit ${result.exitCode}`).trim());
    return result.stdout ?? "";
  }

  return {
    /** Snooze on the board until `until` (epoch ms). Returns false when the board isn't reachable. */
    boardSnooze: (threadId: string, until: number): Promise<boolean> =>
      cli(["snooze", "set", new Date(until).toISOString(), threadId]).then(
        () => true,
        () => false,
      ),
    boardClear: async (threadIds: string[]): Promise<void> => {
      if (threadIds.length > 0) await cli(["snooze", "clear", ...threadIds]).catch(() => undefined);
    },
    /** The board's snoozes, or null when Focus Board isn't reachable. */
    boardSnoozes: async (): Promise<BoardSnooze[] | null> => {
      try {
        const rows = JSON.parse(await cli(["snooze", "list", "--json"])) as BoardSnooze[];
        return rows.map(({ id, wakeAt }) => ({ id, wakeAt }));
      } catch {
        return null;
      }
    },
  };
}
