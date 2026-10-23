# Working on JB Flow

JB Flow is a public plugin in the BB Community marketplace. Anyone can install it, so it must work for a
stranger with a fresh bb install, not only for the maintainer's machine.

## Keep it generic

Never hard-code anything personal into code, defaults, prompts, docs or tests:

- people, companies or customers (no "HitLight", "Findable", colleague names)
- project, repo, plugin, machine or host names from the maintainer's setup
  (no `monorepo-apps`, `hitlight-devops`, "Johannes's Mac Studio")
- paths such as `/Users/...`, `~/.bb/...` (use `bb.server.experimental_dataDir` for bb's data folder), email addresses or account IDs
- personal prompts, templates or working style (status templates, "do it without asking", Stream Deck snippets)

Use made-up examples instead: `acme/web-app`, `billing-api`, "Alex", "Sam".

The maintainer's own preferences go in **their own plugin settings or `local.config.json`**, never in defaults.
If a feature needs data like this, add a setting or a JSON config key and leave the default empty.

## Safe defaults

- A new install starts empty: no seeded workspaces, lanes, commands or watches based on someone's names.
- Anything that restyles bb, replaces a native bb surface (navigation, sidebar, composer, timeline), sends
  messages to threads, or runs on a schedule against external services sits **behind a setting** that turns it
  off. With it off, bb must look and behave exactly as without the plugin.
- Which of those are on by default is the maintainer's product decision. Today: restyle, thread monitor,
  workspaces and expanded plan reviews are on; auto-continue (spends usage quota) and status report at hand-back
  (changes every thread's replies) are off. Don't flip a default
  without asking. Anything that spends money or quota, or messages a thread unprompted, starts off.
- Credential handling, native helpers and anything macOS-only belong in a separate plugin, not here.
- When a change needs a newer bb or plugin SDK, raise `engines` in `package.json` in the same PR.

## Before opening a PR

- `npm test` runs `generic.test.ts`, which fails on known personal names and paths. Don't weaken it to
  get a change through; make the change generic instead.
- Check new settings defaults and new seeds by hand: would a stranger want this on day one?
- README, `PLUGIN_OVERVIEW.md` and `skills/` describe the generic behaviour, not one person's setup.
