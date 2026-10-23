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
  "",
  "### Next steps",
  "If there are steps you can do yourself, recommend a path forward and offer them as a numbered list in a callout. Don't start them until I reply.",
  "> [!TIP]",
  "> **Path forward:** <one line>",
  "> 1. <step> · <why, a few words>",
  "> 2. <step> · <why>",
  ">",
  "> Reply **go** for all, or **go 1,3**.",
  "",
  "If you need a decision from me instead, ask in the same place:",
  "> [!TIP]",
  "> **Decision needed:** <question>",
  "> 1. <option> · <why> (recommended)",
  "> 2. <option> · <why>",
  ">",
  "> Reply with the number.",
].join("\n");

export function statusPrompt(setting: unknown): string {
  return typeof setting === "string" && setting.trim() !== "" ? setting : DEFAULT_STATUS_PROMPT;
}
