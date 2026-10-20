// JB Flow is public: nothing from one person's setup may ship in it (see
// AGENTS.md). This fails on known personal names, companies, repos and paths in
// any tracked file. Make the change generic instead of loosening the list.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const PERSONAL = [
  /hitlight/i,
  /findable/i,
  /berggren/i,
  /johannes/i,
  /monorepo-(apps|ai)/i,
  /infrastructure_v2/i,
  /openclaw/i,
  /limit-lifeboat/i,
  /\/Users\//,
  /\b(knut|nikolai|håkon|silje|xledger|løvenskiold|boas)\b/i,
];

// Files that may name the maintainer: the licence, these rules and this test.
const SKIP = new Set(["LICENSE", "AGENTS.md", "CLAUDE.md", "generic.test.ts", "package-lock.json"]);
// The plugin's own repository URL is fine.
const OWN_REPO = /github\.com\/Johannes-Berggren\/bb-plugin-jb-flow/g;

test("no personal names, companies, repos or paths in tracked files", () => {
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((file) => file && !SKIP.has(file) && !/\.(png|jpe?g|webp|ico|woff2?)$/i.test(file));
  const hits: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").replace(OWN_REPO, "").split("\n");
    lines.forEach((line, index) => {
      const match = PERSONAL.find((pattern) => pattern.test(line));
      if (match) hits.push(`${file}:${index + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, [], `Personal data found (see AGENTS.md):\n${hits.join("\n")}`);
});
