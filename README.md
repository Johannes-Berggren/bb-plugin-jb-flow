# bb-plugin-jb-flow

A personal [bb](https://getbb.app) plugin for triaging a lot of agent threads. It adds snooze, a stale-thread digest, a Triage sidebar, dev-server buttons in the side panel, and expanded plan reviews.

## Features

### Triage sidebar
A replacement thread list. Pick it under **Settings → Appearance → Thread list → Triage**.

- **Groups**, top to bottom:
  - **Needs me**: unread finished threads, errors, and threads waiting for input.
  - **Lanes**: Priority, Active, Waiting for others, Pick up later, Low priority. They map onto your existing sections by name.
  - Any other sections, collapsed.
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
- Drag a row into the main area to open it in a split.
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

Pinned commands can also be edited per project under **Settings → JB Flow → Repo commands**. Those edits override the file. Reload the plugin after editing the file.

## CLI

```
bb jb-flow snooze <thread-id|--self> <when> [--note <text>]
bb jb-flow unsnooze <thread-id|--self>
bb jb-flow snoozed [--json]
bb jb-flow digest [--refresh] [--json]
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
