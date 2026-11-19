// The pull request for a thread's current branch, read from bb's bundled
// GitHub PR Status plugin (it replaced experimental_useSidebarThreadPullRequest).
// Keyed by environment id; the plugin batches every key a mounted hook holds.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_useRpcKeyedQuery as useRpcKeyedQuery } from "@get-bb/plugin-sdk/app";
import { z } from "zod";

/** The part of GitHub PR Status's `pullRequests` contract JB Flow reads. */
export const githubPrStatus = defineRpcContract({
  pullRequests: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(
      z.string(),
      z.discriminatedUnion("outcome", [
        z.object({
          outcome: z.literal("available"),
          pullRequest: z.object({
            number: z.number(),
            title: z.string(),
            url: z.string(),
            state: z.enum(["draft", "open", "merged", "closed"]),
            attention: z.string(),
          }),
        }),
        z.object({ outcome: z.literal("absent") }),
        z.object({ outcome: z.literal("unavailable"), message: z.string() }),
      ]),
    ),
  },
});

export const GITHUB_PR_STATUS = "bb--github-pr-status";

export type BranchPr = { number: number; title: string; url: string; state: "draft" | "open" | "merged" | "closed"; attention: string };

/**
 * The branch PR for an environment, or null: no environment, no PR, the machine
 * is offline, or GitHub PR Status is turned off.
 */
export function useBranchPr(environmentId: string | null | undefined): BranchPr | null {
  const { data } = useRpcKeyedQuery({
    pluginId: GITHUB_PR_STATUS,
    contract: githubPrStatus,
    method: "pullRequests",
    keys: environmentId ? [environmentId] : [],
  });
  const row = environmentId ? data?.[environmentId] : undefined;
  return row?.outcome === "available" ? row.pullRequest : null;
}
