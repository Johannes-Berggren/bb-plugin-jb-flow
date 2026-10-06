// Phrases an agent uses when its work is done but not shipped yet ("reaches
// customers with the next release", "not on main"). Such threads are woken
// when the next release of a watched project lands.
export const RELEASE_WAIT = new RegExp(
  [
    String.raw`waiting for (a |the )?(new |next )?(release|deploy)`,
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
