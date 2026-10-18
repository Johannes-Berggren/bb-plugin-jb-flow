// What "Update status" sends when the Status report prompt setting is empty.
// The thread monitor parses these fields (see thread-status.ts).
export const DEFAULT_STATUS_PROMPT = [
  "Give a short status report in exactly this format, then stop. Leave out any line or section with nothing real to say.",
  "",
  "**Goal:** <one sentence>",
  "**Done:** <what was just done, one sentence>",
  '**Next:** <the next step, or "Nothing pending.">',
  "**Blocked:** <only if blocked: on what or whom>",
  "",
  "### Progress",
  "One fenced block, one line per milestone:",
  "```",
  "[██████████] Milestone A   done",
  "[██████░░░░] Milestone B   60%  ← here",
  "[░░░░░░░░░░] Milestone C",
  "```",
].join("\n");

export function statusPrompt(setting: unknown): string {
  return typeof setting === "string" && setting.trim() !== "" ? setting : DEFAULT_STATUS_PROMPT;
}
