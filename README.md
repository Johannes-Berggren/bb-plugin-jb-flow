# bb-plugin-jb-flow

A [bb](https://getbb.app) plugin for people who run a lot of agent threads at once. It adds a Triage sidebar that puts threads waiting on you at the top, snooze, a stale-thread digest, PR and CI tracking that wakes threads instead of having agents poll, and dev-server buttons in the side panel.

## Requirements

- bb 0.44 or later.
- The [GitHub CLI](https://cli.github.com) (`gh`), logged in with `gh auth login`, for everything PR-related: PR tracking, `wait_for_ci`, `pr_status`, the release watcher and the Unreleased section. Repos must be on github.com. Snooze, the digest and the Triage list work without it.
- Auto-continue after usage limits recognises Claude Code's limit message only. Everything else works with any provider.

## Features

### Triage sidebar
A replacement thread list. Pick it under **Settings → Appearance → Thread list → Triage**, then create the lane sections under **Settings → JB Flow → Triage lanes** (one click).

- **Groups**, top to bottom:
  - **Needs me**: threads blocked on a prompt or permission, failed threads, and unread threads whose last message asks you something. Unread status updates stay in their section, in bold.
  - **Stalled** (only when there are some): the agent said it would report back ("I'll report when it finishes", "I'm checking every 30 seconds") but the thread has been idle for over an hour with nothing watching it. **Nudge all** asks each one to check and continue.
  - **Lanes**: Priority, Active, Waiting for others, Pick up later, Low priority. Each is matched to one of your sections by name the first time, then remembered by id, so you can rename a lane's section (right-click → Rename…) and it keeps its number key and behaviour. Active is the unsectioned bucket and can't be renamed.
  - **Waiting for others** fills itself (marked *auto*): unfiled threads whose agent says it's waiting on someone else ("Alex is the only pending reviewer", "once he sends the invoices", "tell me when he replies"), or whose open PRs all wait on a reviewer. Threads you file there yourself go back to Active by themselves when a turn ends without waiting on anyone. Snoozed threads that were waiting on someone ("when it wakes, I'll check for Sam's reply") wake into Waiting for others instead of their old section.
  - Any other sections, collapsed.
  - **Done**, collapsed: unfiled threads idle for 2+ hours whose PRs are all merged or closed, with Archive all. The thread you have open never moves here.
  - Snoozed threads, collapsed.
- **Machines**: once threads run on more than one machine, each machine gets a filter chip with its thread count (e.g. *Mac Studio 48*, *MacBook Air 2*); click one to see that machine's threads across all sections. Rows on a machine other than the one BB runs on carry a short tag (*Air*, *MBP*), and the hover preview always names the machine.
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
- **Section project:** right-click a section → *Project for new threads* to give it a project. *New thread here* (shown as *New thread in &lt;project&gt;*) then opens the composer with that project selected and files the thread in the section.
- **Tags** allow several per thread. A settings button converts "area" sections (e.g. Commercial) into tags.

### Snooze
- A clock button in the thread header, `bb jb-flow snooze <thread|--self> <when> [--note …]`, and a `snooze_thread` agent tool.
- A snoozed thread moves to a "😴 Snoozed" section, which the Triage list keeps collapsed at the bottom.
- When it's due, it goes back to its previous section and is marked unread. If a note was set, the note is sent as a prompt.
- `<when>` accepts `2h`, `3d`, `1w`, `tomorrow`, `mon`…`sun`, `next-week`, or `YYYY-MM-DD[THH:MM]`.
- Unsnoozing puts the thread back in the section it came from.
- Works with the [Focus Board](https://github.com/cristoslc/bb-plugin-focus-board) plugin when it's installed. A jb-flow snooze also snoozes the card on the board, and a snooze set on the board moves the thread to Snoozed here within two minutes. Unsnoozing on either side clears both.

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
- Off by default; turn on **Expand plan reviews** in the plugin settings.
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
- **Leftover worktrees:** bb removes a thread's worktree when it's archived, but extra checkouts an agent adds next to it (cross-repo work) and failed teardowns stay on disk. A weekly scan (Mondays 08:00) lists them under the stale digest with their PR state, uncommitted changes and node_modules, plus a button that deletes the merged, clean ones. Also `bb jb-flow leftovers`.
- **Your move:** a home-page section lists threads whose agent handed the next step to you, oldest first. Threads waiting 3+ days are flagged, and each has Snooze 3d and Archive. Also `bb jb-flow your-move`.
- **Unreleased:** a home-page section (above Your move) lists the PRs merged into the selected project's default branch that haven't been released yet, newest first, with author, age and a compare link. If the repo has a `main` branch next to its default branch (`dev`), unreleased means on `dev` but not yet on `main`; otherwise it means merged since the latest release or `v*` tag. Cached for 5 minutes; Refresh reads GitHub again.
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
- **Auto-continue after usage limits** (off by default, setting *Continue after usage-limit resets*): when Claude Code stops with "You've hit your session limit · resets 10pm", "continue" is scheduled for 90 seconds after the reset.
  - If you resume the thread yourself first, the scheduled message is cancelled.
  - Spend limits are left alone, since they need a human to raise them.
- **Release watcher:** threads that go idle "waiting for release" are woken with a "released: …" message.
  - This happens once a PR matching `titlePattern` merges into `base` and its workflow runs finish.
  - If the release workflow fails, the message names the failed runs instead.
  - Configure it per project with `releaseWatch` (see [Configuration](#configuration)).
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
- `bb jb-flow deck` prints one JSON snapshot with all of the above, for a Stream Deck or a status bar script.

## Install

Install **JB Flow** from the bb plugin marketplace, or from source:

```sh
git clone https://github.com/Johannes-Berggren/bb-plugin-jb-flow
cd bb-plugin-jb-flow
npm install
bb plugin build
bb plugin install . --yes
```

After code changes: `bb plugin build && bb plugin reload jb-flow`.

## Settings

Under **Settings → JB Flow**:

- **Stale after (days)**: when an unsectioned thread shows up in the digest (default 7).
- **Continue after usage-limit resets**: auto-continue for Claude Code (off by default).
- **Cmd+N opens the new thread in a split**: replaces bb's own Cmd+N (off by default). The *New thread in a split* command works either way.
- **Expand plan reviews** (off by default).
- **Advanced config (JSON)**: see below.
- **Triage lanes**, **Repo commands** and **Area tags** have their own sections.

## Configuration

Release watches and sidebar chip names are set in JSON, either in the **Advanced config** setting or in `local.config.json` in the plugin folder (gitignored; see `local.config.example.json`). The setting wins key by key. Reload the plugin after a change.

- `repoCommands`: pinned side-panel commands, keyed by bb project name. A command has `id`, `label`, and `slots[]`. Each slot has a `command`, a `url` (or `null`), and the `ports` it binds. These can also be edited per project under **Settings → JB Flow → Repo commands**, which overrides the JSON.
- `projectShortNames`: the label shown on a project's sidebar chip.
- `stripProjectPrefixes`: prefixes removed from project names on chips.
- `releaseWatch`: per project, either `{ "base": "main", "titlePattern": "^Release\\b" }` (a merged release PR counts, after its workflows finish) or `{ "mode": "release" }` (a published GitHub release counts). Both take an optional `"repo": "owner/name"`.

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
bb jb-flow deck                 # one cheap JSON snapshot for the Stream Deck
bb jb-flow leftovers [--refresh] [--json] [--clean]
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
npm test
```

Several bb APIs used here are `experimental_` and may change between bb releases.
