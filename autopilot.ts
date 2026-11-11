// Autopilot: the routine PR steps the plugin takes itself, without an agent,
// for threads in a workspace with a conductor. Pure, so the rules are tested
// apart from gh and bb; conductor.ts carries them out.
//
// - CI green on a PR the worker said it would merge: merge it (the repo's own
//   method, never bypassing protection, only the commit that went green).
// - A merged PR that was the thread's last open one, which the worker meant
//   to merge: the work is done, so archive the thread.
// - Green the worker didn't ask about: note it; nobody needs waking.
// - What a worker must hear (the next PR in a stack, a closed PR, a watch
//   that ran out, a release shipped): forward it to the worker.
// - Anything else needs judgement: the conductor (an agent) gets it.
import type { AfterGreen } from "./conductor-routing.ts";

export type AutopilotAction = "merge" | "archive" | "record" | "forward" | "conductor";

export type AutopilotInput = {
  kind: string;
  afterGreen?: AfterGreen;
  /** The worker's own words say it merges once checks pass. */
  mergeIntent: boolean;
  /** The PR as last read (prs.ts), or null when it isn't tracked. */
  pr: { state: string; attention: string } | null;
  /** Open PRs on the thread besides this one. */
  otherOpenPrs: number;
  /** Autopilot merged this PR itself. */
  mergedByAutopilot: boolean;
};

export type AutopilotDecision = { action: AutopilotAction; reason: string };

const BLOCKED_ATTENTION: Record<string, string> = {
  changes_requested: "changes were requested",
  conflicts: "it has conflicts",
  checks_failed: "a check failed",
};

export function decide(input: AutopilotInput): AutopilotDecision {
  const wantsMerge = input.afterGreen === "merge" || (input.afterGreen === undefined && input.mergeIntent);
  switch (input.kind) {
    case "green":
    case "no-checks": {
      if (input.afterGreen === "nothing") return { action: "record", reason: "the worker needs nothing on green" };
      if (!wantsMerge) {
        return input.kind === "green"
          ? { action: "record", reason: "green; the worker didn't say it merges" }
          : { action: "record", reason: "no checks; the worker didn't say it merges" };
      }
      if (input.pr?.state === "draft") return { action: "conductor", reason: "the worker meant to merge, but the PR is a draft" };
      const blocked = input.pr ? BLOCKED_ATTENTION[input.pr.attention] : undefined;
      if (blocked) return { action: "conductor", reason: `the worker meant to merge, but ${blocked}` };
      return { action: "merge", reason: "green, and the worker said it merges" };
    }
    case "merged":
      if (input.otherOpenPrs > 0) return { action: "forward", reason: "the thread has more PRs open" };
      if (input.mergedByAutopilot || wantsMerge) return { action: "archive", reason: "its last PR merged as planned" };
      return { action: "record", reason: "merged; left for you to close" };
    case "closed":
    case "timeout":
    case "unreadable":
    case "release":
      return { action: "forward", reason: "the worker has to act on it" };
    default:
      return { action: "conductor", reason: "needs judgement" };
  }
}

// "merge once CI is green", "I'll merge when checks pass", "auto-merge on green".
const MERGE_THEN = /\bmerg(?:e|es|ing)\b[^.\n]{0,60}\b(?:once|when|after|as soon as|on)\b[^.\n]{0,40}\b(?:green|ci|checks?|pass(?:es|ing)?|build)\b/i;
const THEN_MERGE = /\b(?:once|when|after|as soon as)\b[^.\n]{0,40}\b(?:green|ci|checks?|pass(?:es|ing)?)\b[^.\n]{0,40}\bmerg(?:e|es|ing)\b/i;
const AUTO_MERGE = /\bauto-?merg(?:e|es|ing)\b/i;
// "don't merge", "wait for review before merging", "ask before merging": the user decides.
const HOLD = /\b(?:don'?t|do not|won'?t|will not|not yet|never|before)\b[^.\n]{0,25}\bmerg(?:e|ing)\b|\bmerg(?:e|ing)\b[^.\n]{0,30}\b(?:your (?:ok|go|approval)|you (?:say|approve|confirm)|approval|review)\b/i;

/** Whether the worker's own words say it merges once checks pass, and nothing says to hold. */
export function mergeIntent(...texts: Array<string | null | undefined>): boolean {
  const text = texts.filter(Boolean).join("\n");
  if (!text || HOLD.test(text)) return false;
  return MERGE_THEN.test(text) || THEN_MERGE.test(text) || AUTO_MERGE.test(text);
}
