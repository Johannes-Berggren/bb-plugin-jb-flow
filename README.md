# bb-plugin-jb-flow

A personal [bb](https://getbb.app) plugin for triaging a lot of agent threads. It adds snooze, a stale-thread digest, a Triage sidebar, dev-server buttons in the side panel, and expanded plan reviews.

## Features

### Triage sidebar
A replacement thread list. Pick it under **Settings → Appearance → Thread list → Triage**.

- **Groups**, top to bottom:
  - **Needs me**: unread finished threads, errors, and threads waiting for input.
  - **Lanes**: Priority, Active, Waiting for others, Pick up later, Low priority. They map onto your existing sections by name.
  - Any other sections, collapsed.
  - **Done**, collapsed: unfiled threads idle for 2+ hours whose PRs are all merged or closed, with Archive all. The thread you have open never moves here.
  - Snoozed threads, collapsed.
- **Rows** show a project chip with a stable colour per project, tags, and an age fade for idle threads.
- **Keyboard**, on a focused row:
  - `1`–`5` move it to a lane
  - `s` snooze
  - `t` tag
  - `e` archive
  - `u` toggle unread
  - `j`/`k` move up and down
- **Right-click menu:**
  - open / open in split view
  - pin, read/unread, rename
  - move to a section, snooze, tags
  - copy link or ID
  - archive, delete
- Drag a row into the main area to open it in a split, or onto another section to move it there.
- Drag a section header to reorder sections, or use Move up / Move down in its right-click menu. Lanes (Priority, Active, …) and your own sections share one order.
- **Tags** allow several per thread. A settings button converts "area" sections (e.g. Commercial) into tags.

### Snooze
- A clock button in the thread header, `bb jb-flow snooze <thread|--self> <when> [--note …]`, and a `snooze_thread` agent tool.
- A snoozed thread moves to a hidden "😴 Snoozed" section.
- When it's due, it goes back to its previous section and is marked unread. If a note was set, the note is sent as a prompt.
- `<when>` accepts `2h`, `3d`, `1w`, `tomorrow`, `mon`…`sun`, `next-week`, or `YYYY-MM-DD[THH:MM]`.

### Stale-thread digest
- A home page section listing unsectioned threads idle for more than N days (default 7), each with a one-line summary.
- Bulk actions: Archive, Keep 14 days, Snooze 1 week. Nothing is archived without a click.
- Rebuilt at 08:00 on weekdays. Run it from the CLI with `bb jb-flow digest`.

### Scripts and dev servers (side panel)
- **Scripts** (in the side panel's Actions) lists every script in the thread checkout's root `package.json`. The package manager is detected from the lockfile.
- Running a script opens a terminal tab. If the script contains a port, a browser tab opens once that port responds.
- **Pinned commands** per project can have fallback slots, e.g. `pnpm dev` → `pnpm dev:2` → `pnpm dev:3`. The first slot whose ports are free is used, so parallel worktrees don't collide.
- **Start dev servers** runs a project's pinned `dev` command in one click.

### Plan reviews
- Plans awaiting approval open expanded and can use up to 75% of the window height instead of 288px.
- This is a content script, so it depends on bb's plan-banner markup.

### Multi-PR threads (stacked and cross-repo)
- Every PR a thread opens with `gh pr create` is linked automatically, in any repo. You can also link PRs manually.
- One batched GitHub GraphQL query every 3 minutes keeps their state current: checks, review, conflicts, draft or merged.
- PRs whose base branch is another PR's head are shown as a stack. Trunk branches like `dev` and `main` are ignored for this.
- Rows show the PR that most needs attention plus a count. A **Pull requests** side-panel tab lists the stack, lets you link or unlink PRs, and starts a CI watch for all of them.
- Threads whose PRs are all merged or closed go into a **ready to archive** group, with **Archive all**. Threads waiting on a release or CI, or in Priority, are left out.

### Decisions and "Your move"
- **Decision buttons:** when an agent's last message ends with numbered options, they appear as one-click replies above the composer. The recommended one is highlighted.
- **Your move:** a home-page section lists threads whose agent handed the next step to you, oldest first. Threads waiting 3+ days are flagged, and each has Snooze 3d and Archive. Also `bb jb-flow your-move`.
- **`pr_status` agent tool:** all of a thread's PRs in one call, so agents stop running `gh pr view` / `gh pr checks` loops.

### Thread status at a glance
- **Row icon:** needs input / failed / running / stuck / watched / PR state.
- **Running threads:** show elapsed time. After 15 minutes without output they're flagged "stuck", and you can stop them from the row menu or the header chip.
- **Hover preview:** hovering a row shows the last reply, the PR stack, what's being watched, and the run time.
- **Thread header strip:** shows run time or stuck, the watch, and the PR summary. Clicking the PR summary opens the PR panel.
- **Command palette:**

  | Shortcut | Command |
  |---|---|
  | Alt+Shift+S | Snooze this thread |
  | Alt+Shift+N | Open the next thread that needs me |
  | Alt+Shift+E | Archive and open the next one |
  | Alt+Shift+D | Start dev servers |
  | Alt+Shift+P | Show pull requests |
  | Alt+Shift+W | Watch CI |

### Watchers (no polling)
- **Auto-continue after usage limits:** when Claude Code stops with "You've hit your session limit · resets 10pm", "continue" is scheduled for 90 seconds after the reset.
  - If you resume the thread yourself first, the scheduled message is cancelled.
  - Spend limits are left alone, since they need a human to raise them.
- **Release watcher:** threads that go idle "waiting for release" are woken with a "released: …" message.
  - This happens once a PR matching `titlePattern` merges into `base` and its workflow runs finish.
  - If the release workflow fails, the message names the failed runs instead.
  - Configure it per project in `local.config.json` → `releaseWatch`.
- **CI and review watcher:** agents call the `wait_for_ci` tool (or `bb jb-flow wait-ci`) and end their turn, instead of polling `gh`.
  - The plugin polls once every 2 minutes for all watches.
  - It messages the thread when checks finish (with the failed log), when reviews or comments arrive, or when the PR merges.

### Focus tracking (for Stream Deck and scripts)
- Every BB window reports which thread is focused, including the focused pane in a split view.
- External controllers can then act on the focused thread without simulating keystrokes:
  - `bb jb-flow focused` prints the focused thread
  - `bb jb-flow decisions` lists the numbered options it's waiting on (the Stream Deck turns them into keys)
  - `bb jb-flow tell <text>` sends a message to it
  - `bb jb-flow stop` stops its run
  - `bb jb-flow needs-me` lists threads waiting on you
  - `bb jb-flow next` opens the next waiting thread
- Built for [streamdeck-controller](https://github.com/Johannes-Berggren/streamdeck-controller), a private repo.

## Install

```sh
git clone https://github.com/Johannes-Berggren/bb-plugin-jb-flow
cd bb-plugin-jb-flow
npm install
cp local.config.example.json local.config.json   # optional, see below
bb plugin build
bb plugin install . --yes
```

After code changes: `bb plugin build && bb plugin reload jb-flow`.

## Local config

`local.config.json` is gitignored. It holds machine-specific setup:

- `repoCommands`: pinned side-panel commands, keyed by bb project name. A command has `id`, `label`, and `slots[]`. Each slot has a `command`, a `url` (or `null`), and the `ports` it binds.
- `projectShortNames`: the label shown on a project's sidebar chip.
- `stripProjectPrefixes`: prefixes removed from project names on chips.
- `releaseWatch`: per project, `{ "base": "main", "titlePattern": "^Release\\b", "repo"?: "owner/name" }`.

Pinned commands can also be edited per project under **Settings → JB Flow → Repo commands**. Those edits override the file. Reload the plugin after editing the file.

## CLI

```
bb jb-flow snooze <thread-id|--self> <when> [--note <text>]
bb jb-flow unsnooze <thread-id|--self>
bb jb-flow snoozed [--json]
bb jb-flow digest [--refresh] [--json]
bb jb-flow wait-ci [--pr <n>] [--repo owner/name] [--for checks|reviews|both] [--self|<thread-id>]
bb jb-flow release-wait [--self|<thread-id>]
bb jb-flow prs [--self|<thread-id>] [--json]
bb jb-flow pr-link <pr-url> [--self|<thread-id>] [--remove]
bb jb-flow watches [--json]
bb jb-flow check-now
bb jb-flow your-move [--json] [--open]
bb jb-flow pr-radar [--json] [--open]
bb jb-flow classify            # debug: where every open thread lands, with its last message
bb jb-flow focused [--json]
bb jb-flow decisions [<thread-id>] [--json]
bb jb-flow tell <text…> [--thread <id>]
bb jb-flow stop [<thread-id>|--focused]
bb jb-flow needs-me [--json]
bb jb-flow next
bb jb-flow repo [--self|<thread-id>]
bb jb-flow repo-run <command-id|script:<name>> [--self|<thread-id>]
bb jb-flow repo-stop <command-id|script:<name>> [--self|<thread-id>]
bb jb-flow repo-config <project-name> '<json>'|reset
```

## Development

```sh
npm run typecheck
npm test          # when.ts date parsing
```

Several bb APIs used here are `experimental_` and may change between bb releases.
