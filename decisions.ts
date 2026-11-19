// Finds the numbered options an agent ends its message with ("1. … 2. …"),
// so the composer can offer them as one-click replies.
import { MULTI_REPLY, parseStatusReport, plain } from "./thread-status.ts";

export type DecisionOption = { n: number; text: string; recommended: boolean };
/**
 * "go": steps to run, answered with "go" or "go 1,3". "choice": answered with
 * one number. "multi": several can go together, answered with "1,3".
 */
export type DecisionMode = "go" | "choice" | "multi";


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

/** `start`: where the list begins in the lines searched, its intro line included. */
type Decision = { options: DecisionOption[]; intro: string; outro: string; start: number };
const none = (): Decision => ({ options: [], intro: "", outro: "", start: 0 });

/** The trailing choice list, with the line before it and the lines after it. */
function findDecision(message: string, strict: boolean): Decision {
  return findDecisionIn(message.trim().split("\n"), strict);
}

function findDecisionIn(all: readonly string[], strict: boolean, minOptions = 2): Decision {
  const offset = Math.max(0, all.length - 30);
  const lines = all.slice(offset);
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
  let introAt = first - 1;
  while (introAt >= 0 && (lines[introAt]!.trim() === "" || /^\s*(?:>\s*)*$/.test(lines[introAt]!))) introAt -= 1;
  const intro = introAt >= 0 ? lines[introAt]! : "";
  if (/\bI('ll| will|'m going to)\b[^?]*:\s*\**\s*$/i.test(intro) && !options.some((option) => option.recommended)) return none();
  // "Summary of changes: 1. Renamed… 2. Added…" reports what happened.
  const recommended = options.some((option) => option.recommended);
  const summaryIntro = /\b(summary|changes|changed|what (i|we) did|completed|fixed|shipped|included)\b[^?]*:\s*\**\s*$/i.test(intro);
  const pastTense = options.every(
    (option) => /^(?!(need|feed|seed|speed|proceed|succeed|exceed)\b)(\w{3,}ed|built|wrote|made|ran|set|kept|put|left|found|took|got|sent|split|cut)\b/i.test(option.text),
  );
  // "Set", "Put", "Cut" read as past tense too: a line after the list that asks
  // for an answer ("Reply go", "Reply with the number") settles it.
  const outro = lines.slice(end + 1).join("\n");
  const answerAsked = CHOICE_OUTRO.test(outro) || GO_REPLY.test(outro);
  if ((summaryIntro || pastTense) && !recommended && !answerAsked) return none();
  // A real choice: 2–9 consecutive options numbered from 1.
  if (options.length < minOptions || options.length > 9 || options[0]!.n !== 1) return none();
  if (options.some((option, index) => option.n !== index + 1)) return none();
  // "Manual fallback: 1. Finance verifies… 2. …" describes steps; no buttons.
  // A heading after the list starts a new section: the list isn't what the message ends with.
  if (/^\s*(?:>\s*)*#{1,6}\s/m.test(outro)) return none();
  const asks = CHOICE_INTRO.test(lastSentence(intro)) || CHOICE_OUTRO.test(outro) || MULTI_REPLY.test(`${intro}\n${outro}`);
  if (strict && !recommended && !asks) return none();
  return { options, intro, outro, start: offset + (introAt >= 0 ? introAt : first) };
}

/** A numbered list the user answers on its own, and what it is about. */
export type DecisionGroup = {
  mode: DecisionMode;
  /** The line that introduces the list, without markup: "Decision needed: which rollout?" */
  title: string;
  /** Its bold lead-in when it has one ("Decision needed"), to name it in a combined reply. */
  label: string;
  options: DecisionOption[];
};

const modeOf = (around: string): DecisionMode => (GO_REPLY.test(around) ? "go" : MULTI_REPLY.test(around) ? "multi" : "choice");

/**
 * The choice lists a message ends with, in order, when there are several: a
 * status report can end with a path forward (answered with "go") and a
 * decision (answered with a number). Each list counts only with its own
 * intro and reply line, and only what sits between the lists separates
 * them, so a list further up in the message isn't one. At most three.
 */
export function decisionGroups(message: string): DecisionGroup[] {
  const lines = message.trim().split("\n");
  const groups: DecisionGroup[] = [];
  let cut = lines.length;
  while (groups.length < 3) {
    const found = findDecisionIn(lines.slice(0, cut), true);
    if (found.options.length === 0) break;
    const title = plain(found.intro.replace(/^\s*(?:>\s*)*/, "")).replace(/\s+/g, " ").trim().slice(0, 300);
    const label = /^\s*(?:>\s*)*\*\*([^*\n]{1,40}?):?\*\*/.exec(found.intro)?.[1]?.replace(/:$/, "").trim() ?? "";
    groups.unshift({ mode: modeOf(`${found.intro}\n${found.outro}`), title, label, options: found.options });
    cut = found.start;
  }
  return groups;
}

/**
 * What "Your next move" offers for a thread's last reply: a status report's
 * next steps, or else a trailing numbered choice, and whether it's answered
 * with "go", one number, or several.
 */
export function nextMove(message: string): { mode: DecisionMode; options: DecisionOption[] } {
  // Several lists: the last one, with its own way of answering, not the first one's "go".
  const groups = decisionGroups(message);
  if (groups.length > 1) return { mode: groups.at(-1)!.mode, options: groups.at(-1)!.options };
  const steps = parseStatusReport(message, 0)?.steps;
  if (steps) {
    return {
      mode: steps.mode,
      options: steps.items.map((text, index) => ({ n: index + 1, text, recommended: steps.recommended.includes(index + 1) })),
    };
  }
  const { options, intro, outro } = findDecision(message, true);
  if (options.length === 0) {
    // One step to run, "Reply go to run it": a single Go, never a one-option choice.
    const single = findDecisionIn(message.trim().split("\n"), true, 1);
    if (single.options.length === 1 && GO_REPLY.test(`${single.intro}\n${single.outro}`)) return { mode: "go", options: single.options };
    return { mode: "choice", options };
  }
  const tail = message.trim().split("\n").slice(-30).join("\n");
  if (GO_REPLY.test(tail)) return { mode: "go", options };
  // Only the lines around the list: "several" earlier in the message isn't about it.
  return { mode: MULTI_REPLY.test(`${intro}\n${outro}`) ? "multi" : "choice", options };
}

/**
 * Every list the last reply asks you to answer: one per list when it ends
 * with several, else the one `nextMove` finds (a status report's next steps
 * included). Empty when it asks nothing.
 */
export function nextMoves(message: string): DecisionGroup[] {
  const groups = decisionGroups(message);
  if (groups.length > 1) return groups;
  const move = nextMove(message);
  if (move.options.length === 0) return [];
  return [{ ...move, title: groups[0]?.title ?? "", label: groups[0]?.label ?? "" }];
}
