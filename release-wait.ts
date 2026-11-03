// Phrases an agent uses when its work is done but not shipped yet ("reaches
// customers with the next release", "not on main"). Such threads are woken
// when the next release of a watched project lands.
import { parseStatusReport } from "./thread-status.ts";

export const RELEASE_WAIT = new RegExp(
  [
    String.raw`waiting for (a |the )?(new |next )?(release|deploy)`,
    String.raw`awaiting (a |the |next )*release`,
    String.raw`once (it'?s|it is|you'?ve|this is|that'?s|everything is|they'?re) (been )?(released|deployed|shipped|live)`,
    String.raw`once (\`?main\`? is|the release is|it'?s) (deployed|out|live|released)`,
    String.raw`(after|with|in|until|ships? in|ships? with|reach(es)? \w+ with|go(es)? out (with|in)) (the )?next release`,
    String.raw`\bnext release\b`,
    String.raw`not (yet )?(been )?released`,
    String.raw`not (yet )?(on|in) \`?(main|prod|production)\`?`,
    String.raw`no release (is )?(pending|open)`,
    String.raw`reply \*{0,2}go\*{0,2} once .{0,40}releas`,
  ].join("|"),
  "i",
);

/** How much of a reply's end counts: a release mentioned far earlier is usually history. */
const WAIT_TAIL = 1500;

/** The reply says it's waiting for a release: near its end, or in a status report's Blocked line, wherever that falls. */
export function releaseWaitStated(reply: string): boolean {
  if (RELEASE_WAIT.test(reply.slice(-WAIT_TAIL))) return true;
  const blocked = parseStatusReport(reply, 0)?.blocked ?? "";
  return RELEASE_WAIT.test(blocked);
}

/**
 * The thread has moved on from a release wait: it gave a full status report that
 * mentions none anywhere. Anything short of a report proves nothing, so a quick
 * "ok" doesn't cancel a real wait.
 */
export function releaseWaitEnded(reply: string): boolean {
  return parseStatusReport(reply, 0) !== null && !RELEASE_WAIT.test(reply);
}
