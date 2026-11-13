// Finds the numbered options an agent ends its message with ("1. … 2. …"),
// so the composer can offer them as one-click replies.
import { MULTI_REPLY, parseStatusReport } from "./thread-status.ts";

export type DecisionOption = { n: number; text: string; recommended: boolean };
/**
 * "go": steps to run, answered with "go" or "go 1,3". "choice": answered with
 * one number. "multi": several can go together, answered with "1,3".
 */
export type DecisionMode = "go" | "choice" | "multi";

const plain = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

// Words in the line before a list that make it a choice for the user. Only its
// last sentence counts, and "which", "reply", "either" and "paths" only in their
// asking sense: "With the reply to Olai sent, two things remain open." and
// "#8438, which you knew about, plus four more:" introduce a plain list.
const CHOICE_INTRO =
  /\?\s*$|^(which|reply|either)\b|\breply (with|["“']?go\b)|[:—–]\s*(which|reply)\b|\bwhich (one|ones|options?|of (these|them|the)|(do|would|should) (you|i|we))\b|\b(options?|alternatives?|choose|choices?|pick|prefer|decide|decision|want me to|should (i|we)|shall (i|we)|how (should|do) (i|we)|what (should|do) (i|we)|recommended|your call|ways? (forward|to)|approaches|paths? (forward|to))\b/i;
/** The last sentence of the line before a list, without markup or quote markers. */
const lastSentence = (line: string) => plain(line.replace(/^\s*(?:>\s*)*/, "")).split(/(?<=[.!?])\s+(?=[A-Z])/).pop() ?? "";
// "Reply go for all, or go 1,3", "Reply `go` for the next slice": the list is answered with go.
const GO_REPLY = /\b(reply|say|write|type|send)\s+[*_`"“']*go\b|\bgo[*_`]*\s+(for all|\d)/i;
// Text after a list that asks for one of its numbers.
const CHOICE_OUTRO =
  /\b(reply|answer|respond|write|type|say|send)\b[^.\n]{0,40}\b(numbers?|option|one of)\b|\bpick (one|a number|an option)\b|\bwhich (one|option)\b|\bgo\**\s+(for all|\d)/i;

/**
 * Numbered options the user can pick from, for one-click replies. A numbered
 * list is only a choice when something says so: an option marked recommended,
 * an intro that asks or offers, or a closing line asking for a number. With
 * `{ strict: false }` any trailing list counts (the "does this need me" check,
 * where a to-do list for the user is also an ask).
 */
export function parseDecisionOptions(message: string, { strict = true }: { strict?: boolean } = {}): DecisionOption[] {
  return findDecision(message, strict).options;
}

type Decision = { options: DecisionOption[]; intro: string; outro: string };
const none = (): Decision => ({ options: [], intro: "", outro: "" });

/** The trailing choice list, with the line before it and the lines after it. */
function findDecision(message: string, strict: boolean): Decision {
  const lines = message.trim().split("\n").slice(-30);
  // Walk up from the end, skipping trailing chatter (timestamps, "Reply with the number").
  let end = lines.length - 1;
  while (end >= 0 && !/^\s*(?:>\s*)*\d+[.)]\s+\S/.test(lines[end]!)) {
    if (lines.length - 1 - end > 6) return none();
    end -= 1;
  }
  const options: DecisionOption[] = [];
  let first = end;
  for (let index = end; index >= 0; index -= 1) {
    const match = /^\s*(?:>\s*)*(\d+)[.)]\s+(.+)$/.exec(lines[index]!);
    if (!match) {
      if (/^\s*(?:>\s*)*$/.test(lines[index]!) && options.length === 0) continue;
      break;
    }
    const raw = match[2]!;
    first = index;
    options.unshift({
      n: Number(match[1]),
      text: plain(raw.replace(/\(recommended\)/i, "")).slice(0, 500),
      recommended: /\(recommended\)|\brecommended\b/i.test(raw),
    });
  }
  // "When it's green, I'll: 1. Merge 2. Release" is the agent's own plan, not a choice.
  const intro = lines.slice(0, first).reverse().find((line) => line.trim() !== "" && !/^\s*(?:>\s*)*$/.test(line)) ?? "";
  if (/\bI('ll| will|'m going to)\b[^?]*:\s*\**\s*$/i.test(intro) && !options.some((option) => option.recommended)) return none();
  // "Summary of changes: 1. Renamed… 2. Added…" reports what happened.
  const recommended = options.some((option) => option.recommended);
  const summaryIntro = /\b(summary|changes|changed|what (i|we) did|completed|fixed|shipped|included)\b[^?]*:\s*\**\s*$/i.test(intro);
  const pastTense = options.every(
    (option) => /^(?!(need|feed|seed|speed|proceed|succeed|exceed)\b)(\w{3,}ed|built|wrote|made|ran|set|kept|put|left|found|took|got|sent|split|cut)\b/i.test(option.text),
  );
  if ((summaryIntro || pastTense) && !recommended) return none();
  // A real choice: 2–9 consecutive options numbered from 1.
  if (options.length < 2 || options.length > 9 || options[0]!.n !== 1) return none();
  if (options.some((option, index) => option.n !== index + 1)) return none();
  // "Manual fallback: 1. Finance verifies… 2. …" describes steps; no buttons.
  const outro = lines.slice(end + 1).join("\n");
  // A heading after the list starts a new section: the list isn't what the message ends with.
  if (/^\s*(?:>\s*)*#{1,6}\s/m.test(outro)) return none();
  const asks = CHOICE_INTRO.test(lastSentence(intro)) || CHOICE_OUTRO.test(outro) || MULTI_REPLY.test(`${intro}\n${outro}`);
  if (strict && !recommended && !asks) return none();
  return { options, intro, outro };
}

/**
 * What "Your next move" offers for a thread's last reply: a status report's
 * next steps, or else a trailing numbered choice, and whether it's answered
 * with "go", one number, or several.
 */
export function nextMove(message: string): { mode: DecisionMode; options: DecisionOption[] } {
  const steps = parseStatusReport(message, 0)?.steps;
  if (steps) {
    return {
      mode: steps.mode,
      options: steps.items.map((text, index) => ({ n: index + 1, text, recommended: steps.recommended.includes(index + 1) })),
    };
  }
  const { options, intro, outro } = findDecision(message, true);
  if (options.length === 0) return { mode: "choice", options };
  const tail = message.trim().split("\n").slice(-30).join("\n");
  if (GO_REPLY.test(tail)) return { mode: "go", options };
  // Only the lines around the list: "several" earlier in the message isn't about it.
  return { mode: MULTI_REPLY.test(`${intro}\n${outro}`) ? "multi" : "choice", options };
}
