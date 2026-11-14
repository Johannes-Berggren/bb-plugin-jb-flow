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
  /** Its words name more steps after the merge (deploy, rerun, open the next PR): it has to be woken anyway. */
  followUps: boolean;
  /** Its last status report says nothing is left. */
  nothingLeft: boolean;
  /** The PR as last read (prs.ts), or null when it isn't tracked. */
  pr: { state: string; attention: string } | null;
  /** Open PRs on the thread besides this one. */
  otherOpenPrs: number;
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
      // More steps follow the merge: the worker merges and carries on in one turn, so waking it is the saving.
      if (input.followUps) return { action: "forward", reason: "the worker has more to do after merging" };
      if (input.pr?.state === "draft") return { action: "conductor", reason: "the worker meant to merge, but the PR is a draft" };
      const blocked = input.pr ? BLOCKED_ATTENTION[input.pr.attention] : undefined;
      if (blocked) return { action: "conductor", reason: `the worker meant to merge, but ${blocked}` };
      return { action: "merge", reason: "green, and the worker said it merges" };
    }
    case "merged":
      if (input.otherOpenPrs > 0 || input.followUps) return { action: "forward", reason: "the worker has more to do" };
      // Only the worker's own "nothing pending" closes a thread: a merge alone isn't proof the work is done.
      if (input.nothingLeft) return { action: "archive", reason: "its last PR merged and its report says nothing is left" };
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

// What comes after the merge in the same breath: "merge it, then deploy", "merge and close out the cycle".
const AFTER_MERGE = /\bmerg(?:e|es|ing)\b([^.\n]{0,200})/i;
const FOLLOW_UP = /\b(?:then|after that|afterwards|bring|deploy|release|rerun|re-run|open|start|close out|check|verify|monitor|report|approve|ship|publish|tag|backport|cherry-pick|retarget|rebase|update)\b/i;
// "once CI is green", "when checks pass": the condition, not a next step.
const CONDITION = /\b(?:once|when|after|as soon as)\b[^,]*?\b(?:green|ci|checks?|pass(?:es|ing)?)\b/gi;

/** Whether the worker's words name more steps after merging. */
export function followUpsAfterMerge(...texts: Array<string | null | undefined>): boolean {
  for (const text of texts) {
    const after = text ? AFTER_MERGE.exec(text)?.[1] : undefined;
    // "merge once green; nothing pending after that" ends the plan.
    if (after && !NOTHING_LEFT.test(after) && FOLLOW_UP.test(after.replace(CONDITION, ""))) return true;
  }
  return false;
}

const NOTHING_LEFT = /\b(?:nothing (?:pending|left|else|more|to do)|no (?:next step|further steps?|follow-?ups?)|all done)\b/i;

/** Whether a status report's Next says the work is finished. */
export function nothingLeft(next: string | null | undefined): boolean {
  return !!next && NOTHING_LEFT.test(next);
}

/** Whether the worker's own words say it merges once checks pass, and nothing says to hold. */
export function mergeIntent(...texts: Array<string | null | undefined>): boolean {
  const text = texts.filter(Boolean).join("\n");
  if (!text || HOLD.test(text)) return false;
  return MERGE_THEN.test(text) || THEN_MERGE.test(text) || AUTO_MERGE.test(text);
}
