import assert from "node:assert/strict";
import { test } from "node:test";
import { prFromSubject, repoSlug } from "./unreleased.ts";

test("PR numbers come from squash and merge subjects", () => {
  assert.equal(prFromSubject("feat(assets): New portfolio picker (#10277)"), 10277);
  assert.equal(prFromSubject("Merge pull request #1146 from org/branch"), 1146);
  assert.equal(prFromSubject("Merge branch 'main' into dev"), "skip");
  assert.equal(prFromSubject("hotfix: bump version"), null);
});

test("repo slugs from remotes", () => {
  assert.equal(repoSlug("https://github.com/findable-no/monorepo-apps.git"), "findable-no/monorepo-apps");
  assert.equal(repoSlug("git@github.com:Johannes-Berggren/limit-lifeboat.git"), "Johannes-Berggren/limit-lifeboat");
  assert.equal(repoSlug("https://gitlab.com/a/b.git"), null);
});
