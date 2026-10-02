---
name: jb-flow
description: Snooze BB threads until a date (with an optional wake-up prompt) and review the stale-thread digest with the `bb jb-flow` command or the snooze_thread tool.
---

# jb-flow

## Snooze

Snoozing moves a thread into the hidden "😴 Snoozed" section. Once a minute a
schedule checks for due snoozes. A due thread goes back to the section it came
from and is marked unread. If a note was given, the note is sent to the thread
as a prompt ("⏰ Snooze reminder: …").

- From inside a thread, prefer the `snooze_thread` agent tool: `{ when, note? }`.
- CLI:
  - `bb jb-flow snooze <thread-id|--self> <when> [--note <text>]`
  - `bb jb-flow unsnooze <thread-id|--self>`
  - `bb jb-flow snoozed [--json]`
  - `bb jb-flow wake-now`: runs the due check immediately

`<when>` accepts `30m`, `2h`, `3d`, `1w`, `today` (17:00), `tonight` (20:00),
`tomorrow` (08:00), `mon`…`sun` (next one, 08:00), `next-week`, `YYYY-MM-DD`
(08:00), and `YYYY-MM-DDTHH:MM`. All times are server-local.

Write the note as an instruction to the agent that will wake up, for example:
"Check whether Martin replied in Slack #billing; if so, summarize and propose
next steps."

If a snoozed thread is moved out of the Snoozed section by hand, or is
archived, its snooze is cancelled.

## Stale-thread digest

`bb jb-flow digest [--refresh] [--json]` lists threads that match all of these:

- unsectioned
- unpinned
- not running
- not snoozed
- idle longer than the `staleDays` setting (default 7)

The digest is rebuilt at 08:00 on weekdays and is shown on the BB homepage,
where the user can archive, keep for 14 days, or snooze threads. Never archive
digest threads unless the user asks you to.

## Repo commands (dev servers)

Each project can have repo commands. Running one opens a BB terminal tab in
the thread's side panel. If the command has a URL, a BB browser tab opens too,
as soon as the port accepts connections (the check gives up after 5 minutes).
A command can have several slots, and the first slot whose ports are all free
is used. For example `pnpm dev`, then `pnpm dev:2`, then `pnpm dev:3`, each on
its own ports, so parallel worktrees don't clash.

- `bb jb-flow repo [--self|<thread-id>]`: list pinned commands, root package.json scripts, and runs
- Scripts run as `script:<name>`, e.g. `bb jb-flow repo-run script:lint --self`
- `bb jb-flow repo-run <command-id> [--self|<thread-id>]`, e.g. `bb jb-flow repo-run dev --self`
- `bb jb-flow repo-stop <command-id> [--self|<thread-id>]`
- `bb jb-flow repo-config <project-name> '<json>'|reset`

When the user asks you to start the dev servers, use `repo-run dev --self`.
Don't start `pnpm dev` in your own shell: that leaves the user without the
terminal and browser tabs.
