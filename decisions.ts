// Finds the numbered options an agent ends its message with ("1. … 2. …"),
// so the composer can offer them as one-click replies.
export type DecisionOption = { n: number; text: string; recommended: boolean };

const plain = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function parseDecisionOptions(message: string): DecisionOption[] {
  const lines = message.trim().split("\n").slice(-30);
  // Walk up from the end, skipping trailing chatter (timestamps, "Reply with the number").
  let end = lines.length - 1;
  while (end >= 0 && !/^\s*(?:>\s*)*\d+[.)]\s+\S/.test(lines[end]!)) {
    if (lines.length - 1 - end > 6) return [];
    end -= 1;
  }
  const options: DecisionOption[] = [];
  for (let index = end; index >= 0; index -= 1) {
    const match = /^\s*(?:>\s*)*(\d+)[.)]\s+(.+)$/.exec(lines[index]!);
    if (!match) {
      if (/^\s*(?:>\s*)*$/.test(lines[index]!) && options.length === 0) continue;
      break;
    }
    const raw = match[2]!;
    options.unshift({
      n: Number(match[1]),
      text: plain(raw.replace(/\(recommended\)/i, "")).slice(0, 90),
      recommended: /\(recommended\)|\brecommended\b/i.test(raw),
    });
  }
  // A real choice: 2–9 consecutive options numbered from 1.
  if (options.length < 2 || options.length > 9 || options[0]!.n !== 1) return [];
  if (options.some((option, index) => option.n !== index + 1)) return [];
  return options;
}
