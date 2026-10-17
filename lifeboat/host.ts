import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  hostContract,
  resultSchema,
  type Operation,
  type Result,
} from "./contract";

const flights = new Map<string, Promise<Result>>();
const pending = new Set<Promise<Result>>();
const unavailable = (error: string, setupRequired = false): Result => ({
  ok: false,
  error,
  setupRequired,
});

export async function runHelper(
  executable: string,
  dataDir: string,
  operation: Operation,
): Promise<Result> {
  try {
    await access(executable, constants.X_OK);
  } catch {
    return unavailable(
      "Set up the Lifeboat helper on this Mac with npm run lifeboat:build in the JB Flow plugin checkout.",
      true,
    );
  }
  return new Promise((resolve) => {
    // No shell; fixed executable; credentials never occur in args or stdout.
    // Do not SIGKILL a credential transaction on navigation or cancellation.
    // The helper's network operations have their own bounded timeouts and its
    // cross-process lock prevents a new operation overtaking an old one.
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    let oversized = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (oversized) return;
      output += chunk;
      if (Buffer.byteLength(output) > 7 * 1024 * 1024) {
        oversized = true;
        output = "";
      }
    });
    child.on("error", () =>
      resolve(
        unavailable(
          "The Lifeboat helper could not start. Rebuild it on this Mac and retry.",
        ),
      ),
    );
    child.stdin.on("error", () => undefined);
    child.on("close", () => {
      if (oversized)
        return resolve(
          unavailable("The Lifeboat report exceeded its size limit."),
        );
      try {
        resolve(resultSchema.parse(JSON.parse(output)));
      } catch {
        resolve(
          unavailable(
            "The Lifeboat helper returned an unreadable report. Rebuild it and retry.",
          ),
        );
      }
    });
    child.stdin.end(JSON.stringify({ ...operation, dataDir }));
  });
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    lifeboat: async ({ operation }, context) => {
      if (process.platform !== "darwin" || process.arch !== "arm64") {
        return unavailable(
          "Lifeboat's account engine currently needs an Apple Silicon Mac running macOS 14 or later.",
        );
      }
      if (context.signal.aborted)
        return unavailable("The request was cancelled before it started.");
      const dataDir = context.experimental_paths.dataDir;
      // Share read flights, reject overlapping mutations. Never queue a switch
      // behind an unrelated request and apply it much later without feedback.
      const key = `${dataDir}:${operation.command === "status" ? "read" : "write"}`;
      const existing = flights.get(`${dataDir}:write`);
      if (existing)
        return unavailable(
          "A Lifeboat operation is already running on this Mac. Wait for it to finish, then retry.",
        );
      if (operation.command === "status" && flights.has(key))
        return flights.get(key)!;
      const task = runHelper(
        join(homedir(), ".local/lib/jb-flow/flow-lifeboat"),
        dataDir,
        operation,
      ).finally(() => {
        flights.delete(key);
        pending.delete(task);
      });
      flights.set(key, task);
      pending.add(task);
      return task;
    },
  },
  dispose: async () => {
    await Promise.allSettled([...pending]);
  },
});
