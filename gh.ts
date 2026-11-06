// The one way this plugin runs the GitHub CLI. GitHub answers with a 502 or 504
// now and then; those are retried with backoff here, so the PR, CI and release
// watchers don't each log a failure and wait for their next cycle. A reload
// aborts the signal, which kills a running gh instead of letting it finish on
// a plugin that's gone.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export const GH_MISSING = "The GitHub CLI (gh) isn't installed or isn't on PATH. Install it and run `gh auth login`.";

type ExecError = Error & { code?: string | number | null; killed?: boolean; signal?: NodeJS.Signals | null };

/** A gh failure. `transient` marks one worth trying again (a GitHub 5xx, a network blip, a timeout). */
export type GhError = Error & { transient?: boolean; aborted?: boolean };

/** A readable gh failure; a missing binary gets setup instructions instead of "spawn gh ENOENT". */
export function ghError(prefix: string, error: ExecError, stderr: string, max: number): GhError {
  if (error.code === "ENOENT") return new Error(GH_MISSING);
  const wrapped: GhError = new Error(`${prefix}: ${stderr || error.message}`.slice(0, max));
  if (error.name === "AbortError" || error.code === "ABORT_ERR") wrapped.aborted = true;
  else if (isTransient(error, stderr)) wrapped.transient = true;
  return wrapped;
}

const TRANSIENT =
  /\bHTTP 5\d\d\b|\b(502|503|504) (Bad Gateway|Service Unavailable|Gateway Time-?out)\b|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|i\/o timeout|TLS handshake timeout|connection reset|unexpected EOF/i;

/** Whether a failed gh run is worth retrying. Auth, permission and not-found errors are not. */
export function isTransient(error: ExecError, stderr: string): boolean {
  // Killed by our own timeout: GitHub was too slow this time.
  if (error.killed === true && error.signal === "SIGTERM") return true;
  return TRANSIENT.test(stderr) || TRANSIENT.test(error.message);
}

let resolvedBin: string | null = null;
/** gh's path, looked up once: bb's server may not have Homebrew on PATH. */
export function ghBin(): string {
  resolvedBin ??= ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].find((path) => existsSync(path)) ?? "gh";
  return resolvedBin;
}

export type GhOptions = {
  timeout?: number;
  signal?: AbortSignal | undefined;
  /** Extra attempts after a transient failure. */
  retries?: number;
  /** Prefix for error messages. */
  label?: string;
  /** Longest error message kept. */
  maxError?: number;
};

const DEFAULT_RETRIES = 2;
const BACKOFF_MS = [1_000, 4_000, 10_000];

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): GhError {
  const error: GhError = new Error("gh: aborted");
  error.aborted = true;
  return error;
}

/**
 * Runs `attempt` until it succeeds, fails for good, or the retries run out.
 * Only errors marked `transient` are retried, after a growing, jittered pause.
 */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  options: { retries?: number; signal?: AbortSignal | undefined; wait?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
): Promise<T> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const wait = options.wait ?? sleep;
  for (let tries = 0; ; tries += 1) {
    if (options.signal?.aborted) throw abortError();
    try {
      return await attempt();
    } catch (error) {
      if (!(error as GhError).transient || tries >= retries) throw error;
      const base = BACKOFF_MS[Math.min(tries, BACKOFF_MS.length - 1)]!;
      await wait(base + Math.floor(Math.random() * base * 0.25), options.signal);
    }
  }
}

type RawResult = { error: ExecError | null; stdout: string; stderr: string };

function run(args: string[], timeout: number, signal: AbortSignal | undefined): Promise<RawResult> {
  return new Promise((resolve) => {
    execFile(
      ghBin(),
      args,
      { timeout, maxBuffer: 20 * 1024 * 1024, ...(signal ? { signal } : {}) },
      (error, stdout, stderr) => resolve({ error: error as ExecError | null, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

/** gh's stdout, with transient failures retried. */
export function gh(args: string[], options: GhOptions = {}): Promise<string> {
  const { timeout = 30_000, signal, label = `gh ${args.slice(0, 3).join(" ")}`, maxError = 500 } = options;
  return withRetries(
    async () => {
      const { error, stdout, stderr } = await run(args, timeout, signal);
      if (error) throw ghError(label, error, stderr, maxError);
      return stdout;
    },
    { retries: options.retries, signal },
  );
}

/**
 * A GraphQL query through gh. GitHub answers a query with one unresolvable
 * part (an issue number, a deleted repo) with an error *and* data for every
 * other part; gh then exits non-zero. Keep that partial data.
 */
export function ghGraphql<T>(query: string, options: GhOptions = {}): Promise<T> {
  const { timeout = 30_000, signal, label = "gh graphql", maxError = 400 } = options;
  return withRetries(
    async () => {
      const { error, stdout, stderr } = await run(["api", "graphql", "-f", `query=${query}`], timeout, signal);
      let parsed: { data?: T | null } | null = null;
      try {
        parsed = JSON.parse(stdout) as { data?: T | null };
      } catch {
        parsed = null;
      }
      if (parsed?.data) return parsed.data;
      throw error ? ghError(label, error, stderr, maxError) : new Error(`${label}: no data`);
    },
    { retries: options.retries, signal },
  );
}

/** Combines the plugin's lifetime with a caller's signal (either aborting aborts both). */
export function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length <= 1) return present[0];
  return AbortSignal.any(present);
}
