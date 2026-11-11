// What "Update status" sends when the Status report prompt setting is empty.
// The thread monitor parses these fields (see thread-status.ts); the Blocked
// line's release wording is what release-wait.ts looks for.
export const DEFAULT_STATUS_PROMPT = [
  'Session status report. Use exactly this template and order. Leave out any section with nothing real to say; never write "N/A" or filler. No preamble, no closing remarks.',
  "",
  "**Goal:** <one sentence: the goal of the session>",
  "**Done:** <one sentence: what we just did>",
  '**Next:** <one sentence: what we\'re doing next, or "Nothing pending.">',
  '**Blocked:** <only if blocked: what and on whom. Release blocks: "Waiting for release (last: <version>, <date>).">',
  "",
  "### Stack",
  "Only if this work has pull requests or deploys. Oldest → newest, one line each, indented for stacked PRs:",
  "`<icon> [#123 short title](url) · <≤6-word note>`",
  "Icons: ✅ merged · 🚀 deployed · 👀 in review · 📝 draft · ⏳ awaiting release · ❌ failing",
  "Mention CI only when it isn't green.",
  "",
  "### Progress",
  "One fenced block, one line per milestone, aligned columns:",
  "```",
  "[██████████] Milestone A   done",
  "[██████░░░░] Milestone B   60%  ← here",
  "[░░░░░░░░░░] Milestone C",
  "```",
  "",
  "### Architecture",
  "Only if this session changed the backend or architecture. Before / After as two ASCII diagrams in code blocks, ≤10 lines each; mark changed parts with *.",
  "",
  "### Next steps",
  'If there are next steps you can do yourself, recommend a path forward and offer them as a numbered list in a callout, so I can scan it and reply "go". Don\'t start until I reply.',
  "> [!TIP]",
  "> **Path forward:** <one line>",
  "> 1. <step> · <why, ≤8 words>",
  "> 2. <step> · <why>",
  ">",
  "> Reply **go** for all, or **go 1,3**.",
  "",
  "If you need a decision from me instead (product or UX, scope, anything outward-facing or irreversible), ask in the same place:",
  "> [!TIP]",
  "> **Decision needed:** <one line>",
  "> 1. <option> · <why, ≤8 words> (recommended)",
  "> 2. <option> · <why>",
  ">",
  "> Reply with the number.",
  "",
  'When several options can go together, end with "Reply with one or more numbers, e.g. **1,3**." instead.',
  "",
  "_<YYYY-MM-DD HH:MM TZ>_",
  "",
  "Rules: high level and concise. Link every PR, ticket, deploy and doc. Check PR, CI and deploy state live with tools (pr_status or `gh`) instead of from memory, and take the timestamp from `date`.",
].join("\n");

const BLOCKED_LINE = '**Blocked:** <only if blocked: what and on whom. Release blocks: "Waiting for release (last: <version>, <date>).">';
const DUE_LINE = "**Due:** <only if the work has a real outside deadline: YYYY-MM-DD · what falls due>";

/** `withDue` adds the deadline line to the built-in prompt. A prompt of your own stays exactly as you wrote it. */
export function statusPrompt(setting: unknown, withDue = false): string {
  if (typeof setting === "string" && setting.trim() !== "") return setting;
  return withDue ? DEFAULT_STATUS_PROMPT.replace(BLOCKED_LINE, `${BLOCKED_LINE}\n${DUE_LINE}`) : DEFAULT_STATUS_PROMPT;
}

/** Numbered options marked "(recommended)" become one-click replies (see decisions.ts). */
export const DECISION_ASK =
  'Whenever you ask the user to decide something, with or without a report, end the message with a numbered list of options, one line each, mark your recommendation with "(recommended)", and say "Reply with the number." so they can answer with just the number. When several options can go together, say "Reply with one or more numbers, e.g. 1,3." instead.';

/**
 * Thread instructions for the "Status report at hand-back" setting: the agent
 * ends replies that hand the thread back with the report, so the thread
 * monitor stays current without clicking Update status.
 */
export function handBackInstructions(setting: unknown, withDue = false): string {
  return [
    "## Status report when you hand back",
    "When you end a turn that hands the thread back to the user (the work is done, you're blocked, or you need their input or approval), end that reply with a status report in the format below, after your normal reply. Skip it for short answers to quick questions and while work is still in progress. Don't repeat in prose what the report already says.",
    "",
    DECISION_ASK,
    "",
    "Format:",
    "",
    statusPrompt(setting, withDue),
  ].join("\n");
}
