# bb-plugin-jb-flow

A [bb](https://getbb.app) plugin for people who run a lot of agent threads at once. It adds a Triage sidebar that puts threads waiting on you at the top, snooze, a stale-thread digest, PR and CI tracking that wakes threads instead of having agents poll, and dev-server buttons in the side panel.

## Requirements

- bb 0.46 or later **with Plugin SDK 0.6.54 or later**. Workspace navigation uses APIs newer than the SDK bundled with early 0.46.1 builds; update BB before installing this version.
- The [GitHub CLI](https://cli.github.com) (`gh`), logged in with `gh auth login`, for everything PR-related: PR tracking, `wait_for_ci`, `pr_status`, the release watcher and the Unreleased section. Repos must be on github.com. Snooze, the digest and the Triage list work without it.
- Auto-continue after usage limits recognises Claude Code's limit message only. Everything else works with any provider.

## Features

### Workspaces

On by default (turn off under Settings → JB Flow → **Workspaces**). Choose **JB Flow workspaces** under Settings → Appearance → Sidebar navigation
if another navigation provider is pinned. A new install has no workspaces yet: the bar shows **Create your first workspace**, which
opens a form to name it and pick its projects. After that your workspaces, plus **All** and
**No workspace**, appear as tabs (**+** adds another, the gear manages them) across the top of the BB window and filter its threads, sections
and home-page follow-ups. Tab badges show the total number of top-level threads, muted; a small dot marks attention. With **Now and Focus** on, a filled pill in the workspace's color replaces the dot when threads in that tab's Now are waiting on you right now: blocked, your answer, or overdue. **Thread counts on workspace tabs** off leaves only that pill. So work in another tab stays visible. A subthread that needs you counts on its own for the dot and the number, as in the Triage list's chips, but isn't added to the total. It goes with its row: not counted while the row is snoozed, and out of Now while the row is pinned.
Hover a tab for both counts. Switching restores
the last thread for that workspace in this browser tab; a new-thread button
uses its first available project. Opening a thread from another workspace
reveals its workspace automatically. Switching does not stop agents.

A new install starts with no workspaces of its own. Use the **Manage workspaces** settings icon beside the tabs
or Settings → JB Flow → Workspaces to create or rename workspaces, choose
projects, assign sections and select tools. Selecting a project or section
moves that grouping from its previous workspace. Tools may belong to several
workspaces; unassigned tools remain shared. **More tools** always reaches the
other tools without changing their global visibility settings. This controls
navigation visibility, not plugin execution, credentials or permissions.

A thread uses an explicit workspace assignment first, then inherits its
parent's assignment, then its section or project. Use **Move to workspace** in
the sidebar context menu or BB's thread menu to override this, choose
**No workspace**, or restore **Automatic**. Removing a workspace keeps its
threads, projects and native sections. Explicit assignments to the removed
workspace move to No workspace. Section order is saved per workspace; workflow
lanes remain available with that workspace's threads. Workspace configuration
and thread assignments sync between clients. The active tab and remembered
threads belong to this browser session.

A workspace can carry one of eight colors (red, orange, amber, green, teal, blue,
violet, pink), picked in its settings. A new workspace starts on the first color
no other workspace uses; pick another or **No color** before saving. The color shows as a dot and the selected
underline on its tab, in the Ctrl+` switcher, on that workspace's panes in a
split (see [Split panes](#split-panes)), and as a dot on its threads' rows in the
**All** tab, where rows of every workspace sit together.

On macOS the tabs sit beside the native window and navigation controls, with
the thread title and header in a separate row directly below. Browser and mobile
clients reserve a row above the sidebar and conversation. The bar remains available when the sidebar is closed;
its shell spacing is removed when the plugin unloads. The settings icon opens
a focused dialog with searchable Projects, Sections and Tools lists. Workspace
settings are also available in plugin settings.

The same operations are available over RPC (`workspaces_get`, `workspace_save`,
`workspace_remove`, `workspace_assign`) and CLI:

```sh
bb jb-flow workspaces
bb jb-flow workspaces assign <thread-id> <workspace-id>
bb jb-flow workspaces assign <thread-id> auto
bb jb-flow workspaces assign <thread-id> unassigned
bb jb-flow workspaces save '{"id":null,"name":"Personal","projectIds":[],"sectionIds":[],"pluginIds":[],"sectionOrder":[],"color":"teal"}'
bb jb-flow workspaces remove <workspace-id>
```

`save` returns the saved workspace, including its generated ID. Pass an existing
ID to edit it; names must be unique. These commands return JSON.

### Command palette (⌘K)

On by default (turn off under Settings → JB Flow → **⌘K opens the JB Flow palette**).
The key BB uses for Search threads (⌘K, or Ctrl+K on Windows and Linux, unless you
rebound it under Settings → Keyboard) opens JB Flow's palette instead. Press the key
again or Escape to close it.

- **An empty query shows your triage.** Sections: *Now* (with **Now and Focus** on, in the sidebar's order), *Needs you* (oldest first),
  *Running*, *PRs to act on* (failing checks, changes requested, conflicts, ready to
  merge), *Recent* (the threads you visited) and *This thread*.
- **Inside a workspace tab, the palette searches that workspace.** Its threads, their
  messages (archived ones too) and their PRs; threads in other workspaces stay out, as in
  the sidebar. Workspaces, projects and actions are still listed, so you can switch. On
  *All* it searches everything.
- **Typing searches everything at once.**
  - Threads match on their title, project, branch, PR numbers and titles, tags,
    workspace and section. The ones you pick often and the ones waiting on you rank first.
  - BB's full-text search adds message matches, with snippets, and archived threads.
  - Pull requests, workspaces, projects and actions are ranked into the same list,
    below the threads: thread title matches first, then message matches.
  - The last row always starts a new thread with what you typed. Press Tab on it to
    pick the project.
- **Narrow the scope.**
  - Prefixes: `>` for actions, `#` for pull requests (`#123` finds that PR), `@` for
    workspaces, projects, lanes and sections, `/` for files in the open thread's checkout (Enter
    opens one in the thread's panel, like `bb thread open <path>`; ⌘Enter opens it
    in your editor). Backspace on an empty query
    clears the scope.
  - A group with more matches than fit ends in *Show all N …*. For threads, messages
    and archived matches, that opens *Threads & messages*: every match, up to 50 per
    group from BB's full-text search.
  - Filters: `is:needs`, `is:running`, `is:snoozed`, `is:unread`, `is:pinned`, `is:pr`,
    `is:focus` and `is:due` narrow threads, with or without text.
  - Place filters: `in:billing-api` (a project), `ws:ops` (a workspace) and `lane:priority`
    (a lane or section) narrow threads to that place. The start of any word in the name
    is enough (`in:bill`), and while you type one the palette offers the matching names
    first: Enter or Tab completes it. `project:` and `section:` work too.
- **Browse a place instead of the sidebar.** Tab (or →) on a project, workspace, lane or
  section lists all its threads, grouped the way the sidebar groups them: a project by
  lane, then section, a workspace by project. Enter on a lane or section does the same.
  Typing searches only that place, messages and archived threads included. *Browse …
  threads* in the actions opens the open thread's project or workspace.
- **Act without opening.**
  - Enter opens the selected item. ⌘Enter opens a thread in a split, or a PR's thread.
  - Tab (or →) lists everything you can do to the selected thread, ready to filter:
    - reply to a numbered decision
    - snooze (type `tomorrow` or `3d` for "Snooze until …")
    - move to a lane, section or workspace
    - add (`tag urgent`) or remove tags
    - add to or remove from Focus, or set a due date (type `due fri`)
    - open its PRs or watch their CI
    - stop a run
    - copy its ID
    - BB's own and other plugins' thread actions (archive, pin, rename, copy link, …)
  - Escape, Shift+Tab or ← goes back.
- **Triage with one key, and the palette stays open.** On a selected thread row (the
  home, search results or a place's threads), the Triage list's row keys work with ⌥
  (Alt on Windows and Linux):
  - ⌥E archives it (with Undo; pinned threads are refused)
  - ⌥S lists snooze times; picking one returns to the list
  - ⌥F adds it to or removes it from Focus (with **Now and Focus** on)
  - ⌥U marks it read or unread
  - ⌥1–5 moves it to that lane
  - When the row leaves the list, the next one is selected, so you can work down it
    without the sidebar. A line above the footer lists the keys, and a thread's
    actions show them. On a Mac, an ⌥ key that types a character (⌥2 is `@` on Nordic
    keyboards) still types it; Tab on the thread gets you the same action.

Rows show the same status icon as the Triage list, plus project, workspace, PR state,
tags, snooze and branch. On wide windows a pane beside the results previews the
selected thread: its goal, next step or blocker, PRs and details, as in the Triage
hover card. When the selection isn't a thread, the pane shows the scopes and keys.

Close the palette without running anything and reopen it within 30 seconds: your
query and scope come back, selected, so typing replaces them. Running something
clears them. The command *Open JB Flow palette* (in BB's quick palette, rebindable
under Settings → Keyboard) opens the palette even with the setting off.

The setting is off, or the plugin is disabled? Then the key is BB's Search threads
again. BB's own search also stays reachable through the quick palette → *Search
threads…*. A message match opens its thread, but it can't scroll to the message yet,
because the plugin SDK has no way to do that. Recent picks and visits are stored in
this browser only.

### Ctrl+Tab switcher

On by default (turn off under Settings → JB Flow → **Ctrl+Tab switches threads and
workspaces**). Hold Ctrl and tap Tab: a card lists the threads you viewed most recently,
the one you're in first. Each Tab steps further back, Shift+Tab steps forward, and letting
go of Ctrl opens the selected thread. A quick Ctrl+Tab flips straight to the previous
thread without showing the card. With workspaces on, Ctrl+` (or ↑ from the top thread)
moves to a row of workspace tabs, most recently used first; letting go switches workspace.
Escape cancels, and clicking a row opens it. BB's desktop app only: in a web browser,
Ctrl+Tab switches browser tabs. Visit history is stored in this browser only.

### Catch up

On by default (turn off under Settings → JB Flow → **Catch up**). Goes through your
unread threads one card at a time, each with the thread itself, so you can read and
answer them without opening each one.
Open it from the **Catch up** page in the navigation (its badge counts unread threads
in the current workspace), with ⌥⇧C (*Catch up on unread threads*, rebindable under
Settings → Keyboard), from ⌘K, or from the *Catch up · N unread* line on the home page.

- **What's in it.** Unread top-level threads (and forks) in the current workspace tab;
  the chip in the header switches to all workspaces. Snoozed, archived and hidden
  threads stay out, and so do threads still working, unless they're waiting on you.
  They join when they finish.
- **Order.** Threads that need you come first: a prompt or permission, a failure,
  then an agent that handed the next step to you. Then PRs to act on, then other
  updates, each group oldest first. The order is fixed when you start, so cards never
  move under you. New arrivals wait behind an *N new* pill (or `n`).
- **Each card** starts with a short summary: the thread's status, project and age,
  what happened since you last read it (turns, prompts from you, automated prompts
  such as CI results and snooze reminders, PRs merged since) and its open PRs, with
  merged and closed ones folded away. Below it is the thread itself, live, with its
  composer where you can read the conversation, answer a prompt or permission, pick from *Your
  next move*, or write a reply, as in the thread view. Showing a card doesn't mark
  the thread read; writing in its composer does, as anywhere in bb.
- **Keys:**

  | Key | Action |
  | --- | --- |
  | `→` or `d` | Done: mark read and go on |
  | `←` or `u` | Keep unread and go on |
  | `r` | Write in the thread's composer (Esc comes back to these keys) |
  | `s` | Snooze (`1`–`5` for a preset, or type `3d`, `fri`) |
  | `e` | Archive |
  | `o` or Enter | Open the thread (`⇧O` or ⌘Enter opens it in a split) |
  | `z` or ⌘Z | Undo |
  | `?` | List the keys |

  Snooze also marks the thread read. Keep unread puts back a thread you wrote in.
- **Touch.** Swipe a card's summary right for Done and left to keep it unread; a long
  press opens Snooze. On small screens the overlay is a bottom sheet.
- **Undo** reverses the last actions in order: read, snooze and Mark all read are
  reverted, and an archive waits 8 seconds before it happens (bb removes an archived
  thread's worktree), so undoing it in time changes nothing. A sent message can't be
  undone.
- **Mark all read** clears the remaining updates and PR cards in one step; threads
  that need you stay in the deck.
- **The end** shows what you did, offers the threads you kept unread again, and picks
  up new arrivals. Reopen within 15 minutes and the deck carries on where you left off.

With the setting off, the command, palette entry, home-page line and badge are gone and
the page says it's off. bb's own navigation rail still lists the page, because a
plugin page can't hide itself yet; JB Flow's workspace navigation hides it.

### Split panes

**Frame the active split pane** (Settings → JB Flow, on by default) draws a frame
around the pane you're working in whenever two or more panes are open, in its
workspace's color or BB's accent color when it has none. The other panes get a
thin line in their own workspace's color, so each pane shows where it belongs.
Nothing is dimmed. With a single thread open, a line in its workspace's color
tops the page header instead. With the setting off, BB's panes look as they do
without the plugin.

**Scroll split panes sideways** (on by default) lets a split grow wider than the
window. BB fits every pane into the window, so with many panes each one gets
narrow. With this on, each pane gets at least **Minimum pane width** (640
pixels unless you change it): once the panes no longer fit, the split scrolls
sideways and snaps to pane edges. Focusing a pane, with a click or BB's
pane-focus keys, brings it into view. Your pane proportions and BB's dividers
keep working, so dragging a divider can still make one pane narrower than the
minimum, and the side panel stays in place.

With **Pane strip in the workspace bar** on (the default, and it needs
Workspaces on), the far end of the workspace bar lists the open panes while a
split is open: one chip per pane, left to right, with its workspace's color, the
thread's title and a dot for what it is doing (working, waiting on you, stopped
with an error, finished and unread, or idle). "Waiting on you" includes a
thread whose last message asks you something, even after you've read it, as in
Your move. The focused pane's chip is
outlined and the chips of the panes on screen are lit, so a thread that needs
you is visible even when its pane is scrolled out of view. Click a chip to go
to its pane.

While the split scrolls, a slim tab on each edge shows how many panes lie
beyond it. It turns amber and counts the ones waiting on you when any do; hover
it for the full text. Clicking it scrolls that pane into view without focusing
it, so nothing is marked read.

- BB opens at most eight panes in a split; this setting doesn't change that.
- The split fits the window again while a pane is maximized, and returns to
  the focused pane when you restore it.
- It relies on BB's own page structure. After a BB update that changes it, the
  split falls back to fitting the window until the plugin catches up.

Two commands work on the whole split. Both are in BB's command palette and the
JB Flow palette:

- **Open what needs me side by side** (Alt+Shift+O) opens the threads that need
  you as panes beside the ones already open, most urgent first, until the split
  is full, and ends on the most urgent one. It uses the same order as **Open the
  next thread that needs me**: Now, or Needs me with Now and Focus off. Threads
  already open are skipped. Where splits are off it opens the first thread only.
- **Update status in every open pane…** lists the open panes whose status
  report is out of date (none yet, the agent has replied since, or over 6 hours
  old) and asks them all with one click. A thread that is working, stopped on
  an error or waiting on your answer is never asked. Nothing is sent until you
  confirm: each thread gets the **Status report prompt**, and each reply uses
  your agent's quota. It needs the thread monitor on.

### App-wide appearance

**Polish the entire BB interface** (Settings → JB Flow, on by default) applies
across the standard BB interface: inset sidebar selections, refined section
headings and rail controls, layered page surfaces, elevated composers, panel tabs,
menus, dialogs, and the command palette. The selected workspace tab and Triage row
share a color accent. Open thread titles use BB’s interface typeface, with
a subtle workspace tint across the header when pane highlighting is enabled.
Callouts in chat messages (`> [!TIP]`,
`[!NOTE]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`), which BB shows as literal
text, become tinted boxes with a label. It works with any palette; Graphite adds
coordinated sidebar, card, popover, and recessed colors in light and dark mode.

**Graphite**, under **Settings → Appearance**, is an optional app-wide palette:
charcoal in dark mode, warm ivory in light mode, and a soft violet accent.

Turn the setting off to restore standard shell styling while keeping the palette. The content script removes its root class and event listeners on
reload or disable. Reduced motion and forced colors are respected. BB continues
to own navigation, panel resizing, conversations, touch targets, and scrolling.
This setting changes shell styling; Workspaces separately uses BB's navigation
and app-overlay APIs to arrange its tabs and tools. Shell selectors use the current host's DOM attributes and
need visual rechecking after BB upgrades.

### Live agent activity

The composer combines the current action, a two-line goal summary, usage, and
linked PR status in one compact activity panel. Visible meters distinguish plan
and workflow step completion from goal token-budget consumption and context
usage (marked estimated when the host reports an estimate). Active work without
known totals uses an indeterminate activity bar. Percentages are never presented
as goal completion. An animated live indicator and local elapsed clock keep work
visible; quiet, waiting, stopping, and disconnected states have distinct labels.

**Details** contains the full goal and its Clear goal control, current command,
task models/usage, workflow progress, recent tool activity, and the plan. Read-only
PR and goal/to-do summaries are consolidated only when their replacement data and
controls are available; native Git, parent-thread and PR merge controls remain.
PR links preserve BB's navigation preference and reject unsupported URL schemes.

The card uses a bounded public timeline snapshot, refreshed by thread realtime
events (bursts coalesce over 750ms), and resyncs after reconnecting. Its one-second
clock updates locally. No network polling or estimated completion percentage is
used. The native background/workflow callouts are hidden only in the same
composer after a successful card render; they return if the request fails or
shell styling is switched off. Git summary controls stay native, with larger
styling. Reduced-motion preferences disable decorative animation.

### Compact thread controls

**Your next move**, **Status**, and the PR count share one row above the
composer. Panels start closed and open one at a time. Each panel scrolls within
its own height limit. Close a panel by pressing its button again or pressing
Escape inside it. Closing **Your next move** restores its content in the
transcript and keeps your selections. From the PR panel, **Open in side panel**
opens the full Pull requests tab. Turn **Compact thread controls** off to use
separate controls above the composer.

### Persistent thread monitor

On by default (**Thread monitor** in the plugin settings). The **Status** panel
shows the last report when the agent is idle, including **Done**, **Next**, **Blocked** and **Goal**, with milestone
bars and context use under **Details** in the footer. When the report is out of date (the agent replied since, it's
over 6 hours old, or there is none), a call-out at the top of the report says why and offers a large **Update status**
button, and the old report is dimmed (Blocked stays readable). When it's current, the caption says "up to date" and a
small refresh icon in the header does the same.

If the report ends with numbered **Next steps** (the built-in prompt asks for a recommended path forward in a callout),
they appear in **Your next move** (see Decision buttons), and a **Doing now** line shows what the
agent is already doing. **Auto-prompt** in its footer (with a count, or "off") opens a menu of everything that will message the thread on
its own: continuing after a usage limit resets, and each CI/review watch and release wait (see Watchers). Untick one
to stop it.

**Update status** sends the **Status report prompt** setting to this thread, preserving your composer draft.
Empty uses the built-in report: **Goal**, **Done**, **Next** and **Blocked** (plus **Due** with Now and Focus on),
then a **Stack** of the thread's PRs and deploys, **Progress** bars, before/after **Architecture** diagrams when
the backend changed, **Next steps** or a **Decision needed** callout, and a timestamp. Sections with nothing to say
are left out. It runs only when clicked.
**Status report at hand-back** (on by default) skips the button: agents end every reply that hands the
thread back to you (done, blocked, or waiting for your input) with that report, and end any question with numbered
options marked *(recommended)*, so the monitor keeps itself current and the reply buttons appear. Threads pick it up
when their session next starts.
The monitor refreshes on thread
events and reconnects. Running agents retain the live command/workflow view;
idle headers reflect pending input, errors and JB Flow watches. Milestone bars
show the values reported by the agent, separately from measured plan, workflow,
context and token-budget meters. No overall completion percentage is inferred.
Saved information remains visible during refresh failures; native activity
controls return if the live timeline is unavailable.

### Compact live tool trace

With **Polish the entire BB interface** on, active native command bundles keep running work prominent in a bordered activity
card with an indeterminate sweep. Earlier completed commands and thinking steps
fold behind **Show trace**, with a live step count. Errors and explicitly opened
output stay visible. Native approvals and questions remain outside these bundles.
The enhancement preserves native nodes, controls and output; it restores the
original view when work finishes, the shell setting is disabled, or the plugin
unloads. Unrecognized markup stays native. Reduced motion disables the sweep.

### Reply choices

Numbered decisions appear as one compact list with a row per option: a number
badge, up to two lines of text, and a Recommended label on the right. A long
list scrolls inside a capped box instead of pushing the composer. Choosing
one sends only its number, with visible sending/sent feedback. Duplicate clicks
are blocked; failed sends show an error and allow retry. Choices reset when the
thread or source reply changes. Motion respects reduced-motion preferences.

When the agent asks for several ("Reply with the numbers, e.g. 1,3", "pick one or
more", "all that apply"), the options are checkboxes with the recommended ones
already ticked, and **Send 1, 3** replies `1,3`. Any other decision can be
switched to the same ticking with **Pick several** in the header, or by
⌘/Ctrl-clicking an option. Go-lists work the same way with **Go**; ticking every
step sends plain `go`. A single step to run ("Reply **go** to run it") shows that
step and a **Go** button.

A reply can end with more than one list, such as a path forward (answered with
`go`) and a decision (answered with a number). Then each list gets its own
titled block: steps to tick or **Go with all**, a single pick, or several. One
**Send** answers them together, one line per list, named after its bold lead-in:
`Path forward: go 1,3` and `Decision needed: 1`. A list you leave unanswered is
left out. Nothing is sent until you press **Send**.

With focus in the list, ↑/↓ and Home/End move between options, and a digit ticks
that option (or, where a click sends, moves to it so Enter sends).

While the choices show, the agent's **Next steps** callout hides if the controls
fully repeat its questions, options and standard reply instructions. Questions
and options in the hidden callout appear in full in the controls. Any extra
context or links stay visible in the message. Turn off **Hide options the reply
buttons repeat** to show both.

### Triage sidebar
A replacement thread list. **Installing JB Flow switches your sidebar to it**: bb uses the first installed thread-list plugin while **Settings → Appearance → Thread list** is on *Automatic*. Switch back there at any time. The list offers to create its lane sections the first time (or use **Settings → JB Flow → Triage lanes**).

- **Groups**, top to bottom:
  - **Now** (with **Now and Focus** on, the default; otherwise **Needs me** sits here, without the ranking): one ranked list of what to do next. It holds threads blocked on a prompt, a permission or a failure, unread threads whose last message asks you something, threads you marked as **Focus** that want something from you, and threads with something for you to do before a deadline. Unread status updates stay in their section, in bold. A subthread that needs you brings its parent's row here, with the subthread under it saying why (its conductor headline, if it has one). While the subthread is folded away, the parent's row says it instead.
    - **Focus** is a mark on the thread, separate from its section: press `f` on a row, or use the right-click menu. A star shows on the row. Marking more than the **Focus limit** (default 7) asks you to drop one, or keep them all. The first time, threads in your Priority lane start in Focus.
    - **Due dates:** press `d` on a row or use the right-click menu; `bb jb-flow due` does the same. Agents set them too, with the `set_thread_due` tool or a `**Due:** YYYY-MM-DD · what falls due` line in a status report, for real outside deadlines only. A day means the end of that day. A date you set is never changed by an agent, and a date you clear isn't proposed again. The hover preview shows who set it and why.
    - **When a deadline counts:** within 48 hours, a thread that wants something from you joins Now without Focus. Idle threads and threads waiting on someone else keep their deadline in their existing group. A snoozed thread with an action for you comes back into Now once its deadline is within 24 hours.
    - **Order:** Focus or soon-due threads that are blocked, then anything overdue or due within 24 hours (soonest first), then Focus threads waiting on you (longest wait first), then threads due within 48 hours, then everything else, oldest first. Seven rows show before *Show N more*.
    - **Reading doesn't clear it.** A Focus thread stays until the agent is moving again. A second line explains why the thread is here, such as *Waiting for your answer* or *Checks failed*. Hover the reason to see the wait. The wait is counted from when the thread asked, so opening it doesn't reset it.
    - After you send a reply, including a queued message or a reply choice, **Next in Now** shows the title of the next thread in this workspace. Click it or focus it with Tab and press Enter to open that thread. When there’s no other thread in Now, the composer shows **You’re all caught up.**
    - The thread you have open keeps its row until you open another.
  - **Moving** (collapsed, only when there are some): Focus threads that don't need you right now: an agent is running, a watch is active, someone else has the next step, or the agent has finished with no next step for you.
  - A status report is read by its fields, not its wording: a **Decision needed** callout or a **Blocked** line naming you counts as waiting on you, and a **Blocked** line naming anything else goes to Waiting for others. Keywords only apply to replies without a report.
  - **Stalled** (only when there are some): the agent said it would report back ("I'll report when it finishes", "I'm checking every 30 seconds") but the thread has been idle for over an hour with nothing watching it. **Nudge all** asks each one to check and continue.
  - **Lanes**: Priority, Active, Waiting for others, Pick up later, Low priority. Each is matched to one of your sections by name the first time, then remembered by id, so you can rename a lane's section (right-click → Rename…) and it keeps its number key and behaviour. Active is the unsectioned bucket and can't be renamed.
  - **Waiting for others** fills itself (marked *auto*): unfiled threads whose agent says it's waiting on someone else ("Alex is the only pending reviewer", "once he sends the invoices", "tell me when he replies"), or whose open PRs all wait on a reviewer. Threads you file there yourself go back to Active by themselves when a turn ends without waiting on anyone. Snoozed threads that were waiting on someone ("when it wakes, I'll check for Sam's reply") wake into Waiting for others instead of their old section.
  - Any other sections, collapsed.
  - **Done**, collapsed: unfiled threads idle for 2+ hours whose PRs are all merged or closed, with Archive all. The thread you have open never moves here. A thread counts only once everything under it is finished too (idle for 2+ hours, nothing running, waiting on you or open), because archiving a thread archives its subthreads with it.
  - Snoozed threads, collapsed.
- **Filters** opens a compact toolbar above the list. Its choices (Needs me, Your move, Running and so on) narrow the list while keeping your sections, each expanded. Done stays one list, with Archive all. The collapsed toolbar names the active filters and offers **Clear**. It remembers whether you left it open. Filters, tags and their counts include subthreads: a matching subthread shows under its parent, which stays for context, and subthreads that don't match (and have no match under them) are left out. A match shows even under a folded parent.
- **Machines**: once threads run on more than one machine, each machine gets a filter chip with its thread count (e.g. *Mac Studio 48*, *MacBook Air 2*); click one to see that machine's threads across all sections. The row preview names the machine.
- **Rows** give the title its own line. Hover a row or open its context menu and choose **Thread details** for its project, machine, branch, tags and pull requests.
- **Subthreads** (threads an agent spawned under another, and forks) sit under their parent's row, indented, at any depth. They start unfolded, as in bb's own list. The chevron beside a parent, or `←`/`→` on its row, folds them into a count. The count turns amber when a folded subthread needs you, and blue while one runs. `←` on a subthread with nothing to fold moves to its parent. A subthread whose parent is archived gets a row of its own. Folds of threads that are gone are forgotten.
- **Keyboard**, on a focused row:
  - `1`–`5` move it to a lane
  - `s` snooze
  - `t` tag
  - `f` add to or remove from Focus
  - `d` set or clear a due date
  - `e` archive (pinned threads are skipped)
  - `u` toggle unread
  - `←`/`→` fold or unfold its subthreads; `←` on a subthread with nothing to fold moves to its parent
  - `j`/`k` move up and down
- **Right-click menu:**
  - open / open in split view
  - pin, read/unread, rename
  - move to a section (or **Move to → New section…** to create one in the current workspace and file the thread there), snooze, tags
  - copy link or ID
  - archive, delete
- Drag a row into the main area to open it in a split, or onto another section to move it there.
- Drag a section header to reorder sections, or use Move up / Move down in its right-click menu. Lanes (Priority, Active, …) and your own sections share one order.
- **Section project:** right-click a section → *Project for new threads* to give it a project. *New thread here* (shown as *New thread in &lt;project&gt;*) then opens the composer with that project selected and files the thread in the section.
- **Tags** allow several per thread. A settings button converts "area" sections (e.g. Commercial) into tags.

### Snooze
- A Snooze button in the thread header ("Snoozed until …" while it's snoozed), `bb jb-flow snooze <thread|--self> <when> [--note …]`, and a `snooze_thread` agent tool.
- A snoozed thread moves to a "😴 Snoozed" section, which the Triage list keeps collapsed at the bottom.
- When it's due, it goes back to its previous section and is marked unread. If a note was set, the note is sent as a prompt. A note that fails to send is tried again every minute, for about half an hour.
- `<when>` accepts `2h`, `3d`, `1w`, `tomorrow`, `mon`…`sun`, `next-week`, or `YYYY-MM-DD[THH:MM]`.
- Unsnoozing puts the thread back in the section it came from.

### Stale-thread digest
- A home page section listing unsectioned threads idle for more than N days (default 7), each with a one-line summary. Idle means nothing has happened in the thread: opening it doesn't reset the count.
- Bulk actions: Archive, Keep 14 days, Snooze 1 week. Nothing is archived without a click.
- Rebuilt at 08:00 on weekdays. Run it from the CLI with `bb jb-flow digest`.

### Scripts and dev servers (side panel)
- **Scripts** (in the side panel's Actions) lists every script in the thread checkout's root `package.json`. The package manager is detected from the lockfile.
- Running a script opens a terminal tab. If the script contains a port, a browser tab opens once that port responds.
- **Pinned commands** per project can have fallback slots, e.g. `pnpm dev` → `pnpm dev:2` → `pnpm dev:3`. The first slot whose ports are free is used, so parallel worktrees don't collide.
- **Start dev servers** runs a project's pinned `dev` command in one click.

### Plan reviews
- On by default (**Expand plan reviews** in the plugin settings).
- Plans awaiting approval open expanded and use up to 75% of the window height instead of 288px.
- Drag the handle on top of a plan to make it taller or shorter; double-click it to reset. The height is remembered in this browser.
- This is a content script, so it depends on bb's plan-banner markup.

### Approve a plan with another model
- On by default (**Model choice on plan approval** in the plugin settings).
- A menu next to **Approve plan** lists the thread's models, from whichever provider the thread uses. Pick one to approve the plan and have it implemented on that model, e.g. plan on a strong reasoning model and build on a faster one.
- The approval sets the thread's model, then sends a short steer message with it just before approving. bb holds the steer while the plan waits and adds it to the running turn as soon as the approval goes through, which switches the live session to the new model. It joins that turn rather than starting a new one, and later turns stay on the new model.
- bb can't approve and switch models in one step, so the switch lands just after the agent resumes: its first step after approval can still run on the planning model, and the rest of the implementation runs on the new one.
- The last choice is remembered on this device and shown as a one-click **Approve with …** button. Picking the current model clears it.
- Every plan card on screen gets the menu, including in split panes that aren't focused; each one approves its own pane's thread. The menu shows only when the thread's provider lists at least two models. It depends on bb's plan-banner markup.

### Multi-PR threads (stacked and cross-repo)
- Every PR a thread opens with `gh pr create` is linked automatically, in any repo. You can also link PRs manually.
- One batched GitHub GraphQL query every 3 minutes keeps their state current: checks, review, conflicts, draft or merged.
- PRs whose base branch is another PR's head are shown as a stack. Trunk branches like `dev` and `main` are ignored for this.
- Rows show the PR that most needs attention plus a count. A **Pull requests** side-panel tab lists the stack, lets you link or unlink PRs, and starts a CI watch for all of them.
- Threads whose PRs are all merged or closed go into a **ready to archive** group, with **Archive all**. Threads waiting on a release or CI, or in Priority, are left out.

### Decisions and "Your move"
- **Decision buttons:** when an agent's last message ends with numbered options, open **Your next move** above the composer to answer. The recommended one is highlighted. A decision sends the option's number in one click; **Pick several** (or ⌘-click) ticks several and sends `1,3`. A decision that asks for several numbers opens ticked to the recommended ones. A list of steps to run with go (a status report's **Next steps**, or a list ending "Reply go for all, or go 1,3") lets you tick steps, then **Go** sends `go`, or `go 1,3` with steps ticked.
- **Leftover worktrees:** bb removes a thread's worktree when it's archived, but extra checkouts an agent adds next to it (cross-repo work) and failed teardowns stay on disk. A weekly scan (Mondays 08:00) lists them under the stale digest with their PR state, uncommitted changes and node_modules, plus a button that deletes the merged, clean ones. Also `bb jb-flow leftovers`.
- **Ready to go:** a status report that only offers steps with **Reply go** means nothing is stuck on you, so these threads aren't in Needs me or Your move. A **Ready to go** filter above the list collects them, and they stay out of Done.
- **Your move:** a home-page section lists threads whose agent handed the next step to you, oldest first. With Catch up on, a *Catch up · N unread* line above it opens the deck. Threads waiting 3+ days are flagged, and each has Snooze 3d and Archive. Also `bb jb-flow your-move`.
- **Unreleased:** a home-page section (above Your move) lists the PRs merged into the selected project's default branch that haven't been released yet, newest first, with author, age and a compare link. If the repo has a `main` branch next to its default branch (`dev`), unreleased means on `dev` but not yet on `main`; otherwise it means merged since the latest release or `v*` tag. Cached for 5 minutes; Refresh reads GitHub again. With no project picked in the composer, a workspace tab reports on the first of its projects with a GitHub repo and names that repo. Where there is none (on **All**, or a project without a GitHub repo), the section is hidden, title included.
- **`pr_status` agent tool:** all of a thread's PRs in one call, so agents stop running `gh pr view` / `gh pr checks` loops.

### Thread status at a glance
- **Row icon:** needs input / failed / running / stuck / watched / PR state.
- **Running threads:** show elapsed time. After 15 minutes without output they're flagged "stuck", and you can stop them from the row menu or the status strip's chip.
- **Hover preview:** hovering a row shows the last reply, the PR stack, what's being watched, and the run time.
- **Status strip:** shows run time or stuck and active watches above the composer. With compact thread controls off, the strip also shows a PR summary that opens the Pull requests tab.
- **Command palette:**

  | Shortcut | Command |
  |---|---|
  | Alt+Shift+S | Snooze this thread |
  | Alt+Shift+N | Open the next thread that needs me. With **Now and Focus** on, it steps through Now in order from the thread you're on, across every workspace, because threads stay in Now after you read them. A subthread that needs you is opened itself, in the order the list shows it: under its parent's row, after the parent if the parent is in Now too |
  | Alt+Shift+O | Open what needs me side by side, as split panes (see Split panes) |
  | Alt+Shift+F | Add this thread to Focus, or remove it |
  | Alt+Shift+E | Archive and open the next one (a pinned thread is left as is) |
  | Alt+Shift+D | Start dev servers |
  | Alt+Shift+P | Show pull requests |
  | Alt+Shift+W | Watch CI |
  | BB's Search threads key (⌘K) | Open the JB Flow palette (see above) |

### Watchers (no polling)
- **Auto-continue after usage limits** (switch per thread in the thread monitor; the setting *Continue after usage-limit resets* is the default for threads, off unless you change it): when Claude Code stops with "You've hit your session limit · resets 10pm", "continue" is scheduled for 90 seconds after the reset.
  - If you resume the thread yourself first, the scheduled message is cancelled.
  - Spend limits are left alone, since they need a human to raise them.
- **Release watcher:** threads that go idle "waiting for release" are woken with a "released: …" message.
  - This happens once a PR matching `titlePattern` merges into `base` and its workflow runs finish.
  - If the release workflow fails, the message names the failed runs instead.
  - A thread that later gives a status report no longer mentioning a release stops waiting. A reply without a report leaves the wait alone.
  - Configure it per project with `releaseWatch` (see [Configuration](#configuration)).
- **CI and review watcher:** agents call the `wait_for_ci` tool (or `bb jb-flow wait-ci`) and end their turn, instead of polling `gh`.
  - The plugin polls once every 2 minutes for all watches. Once a watch is only waiting for reviews, it reads GitHub every 10 minutes.
  - It messages the thread when checks finish (with the failed log), when reviews or comments arrive, or when the PR merges.
  - A thread that is still working gets nothing. Once it goes idle, the next check sends one message with the current state of all its PRs.
  - Checks are waited for up to 3 hours and reviews up to 7 days. The thread is told when a watch runs out.
  - Agents can say what they'll do once checks pass with `after_green`: `merge`, `continue` (more work follows) or `nothing`.
- **Wake-ups aren't lost.** A CI or release watch ends only after its message has been sent. A failed send is tried again on the next check, for about an hour, unless the thread is gone.

### Conductor (one per workspace, off by default)
A conductor is a permanent agent thread that looks after one workspace. Its worker threads stop being woken for routine news; the plugin and the conductor handle that news, so you aren't left with a pile of unread threads that only say "merged".
- **Routing.** With a conductor running, the CI watcher and the release watcher split each thread's news:
  - CI failures and review feedback still wake the worker straight away.
  - CI green, merged or closed PRs, "no checks", timeouts and released builds go to the conductor's inbox. The exception is green when the worker said `after_green: "continue"`.
  - Without a conductor, or with the setting off, every thread hears its own news as before.
- **Headlines from the workers' own words, at no cost.** In Now, a thread that needs you says what it needs instead of who holds it: the decision it asks for, what it's blocked on, or the question its reply ends with (hover for its recommendation). They're built from its own status report; no agent is involved. A headline older than the thread's latest news isn't shown.
- **Batched wake-ups.** The conductor agent is woken only for judgement calls. Once the oldest one has waited *Conductor: minutes to collect news* (default 10) and the conductor is idle, it gets one message with everything since. The first wake-up of each day compacts its conversation first, so a permanent thread stays small.
- **Autopilot: routine PR work, done without an agent.** The plugin itself acts on the routed news:
  - **Merges.** CI green on a PR whose worker said it merges once checks pass (`after_green: "merge"`, or its status report says so): it merges with the repo's default method, only the commit that went green, never bypassing protection. A refusal goes to the conductor.
  - **Archives.** A worker that reports completion after its last PR can be archived automatically. JB Flow checks the thread and the workers BB would archive with it for unfinished work, and checks managed workspaces for uncommitted changes or files in non-Git folders. An archive hold is recorded in Activity.
  - **Notes.** Green the worker didn't ask about is only noted; nobody is woken.
  - **Forwards.** What a worker must act on (a closed PR, a watch that ran out, a release) is passed on to it.
  - **Done for you.** On the home page, *Done for you* lists what autopilot did today and how many wake-ups that spared, costed at each thread's last turn. Archives can be undone.
- **The conductor (an agent) only gets judgement calls:** a merge GitHub refused, a PR autopilot couldn't handle, anything unusual. When it has something for you, its headline replaces the automatic one for that thread in Now. It never decides product, scope or outward-facing questions for you. `bb jb-flow conductor briefing <workspace-id>` prints its current items.
- **Permanent.** The thread is hidden from the thread list. Archiving it brings it straight back, and a deleted one is started again at the next wake-up. Preferences you state ("always merge dependency bumps") are kept with its `conductor_memory` tool and included in its instructions.
- **Only its own workspace.** Its tools (`conductor_inbox`, `fleet_status`, `thread_brief`, `merge_pr`, `rerun_failed`, `forward_to_thread`, `thread_action`, `post_briefing`, `conductor_memory`) are given to conductor threads only. They act only on threads and PRs of its workspace.
- **The Conductor page.** Each conductor has its own page, reached from the conductors listed in *Done for you* or under *More tools* (JB Flow's sidebar doesn't list it, since the conductor comes to you). It has three tabs:
  - **Conversation.** Ask “Which threads are stuck, and which can I archive?” for a read-only review with links and next steps. Ask it to archive specific candidates when ready. It checks their latest replies, the threads BB archives with them, and their managed workspaces before acting.
  - **Threads.** Workspace triage groups visible threads and subthreads by what needs attention, what is waiting or running, and which workers report completion. A thread opens beside the page.
  - **Activity.** What the conductor did: merges, reruns, forwards, archives and wake-ups.
- **Starting one.** Turn on **Conductor** in the settings, then start one under **Settings → Conductors**, on the Conductor page, or with `bb jb-flow conductor start <workspace-id>`.
  - It lives in the workspace's first project unless you choose another.
  - Its agent defaults to that project's default; Settings → Conductors or `--provider`/`--model` pick another.
  - Stopping turns routing off and keeps the thread for next time.

### Focus tracking (for Stream Deck and scripts)
- Every BB window reports which thread is focused, including the focused pane in a split view.
- External controllers can then act on the focused thread without simulating keystrokes:
  - `bb jb-flow focused` prints the focused thread
  - `bb jb-flow decisions` lists the numbered options it's waiting on (the Stream Deck turns them into keys)
  - `bb jb-flow tell <text>` sends a message to it
  - `bb jb-flow stop` stops its run
  - `bb jb-flow needs-me` lists threads waiting on you, subthreads included
  - `bb jb-flow next` opens the next waiting thread
  - `bb jb-flow now` lists Now in the Triage list's order (a row's subthreads right after it), with what's Moving
- `bb jb-flow deck` prints one JSON snapshot with all of the above, for a Stream Deck or a status bar script. With **Now and Focus** on, it also has `now`: the count and the top thread. `focused.workspace` is the focused thread's workspace: its `id`, `name`, `color` name and the same color as `hex`, for a key that should wear it (null outside a workspace; `color` and `hex` are null when the workspace has none). `focused.panes` says where the focused pane sits in a split, `{"index": 2, "total": 5}` counting left to right, so a key can show "2/5" (null without a split).

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

- **Polish the entire BB interface**: restyles bb, shows `> [!TIP]` callouts as callouts and folds finished commands behind *Show trace* (on by default).
- **Frame the active split pane**: a frame on the active pane in a split, each pane's workspace color, and a line in that color over a lone thread's header (on by default).
- **Scroll split panes sideways**: a split with more panes than fit scrolls sideways instead of squeezing them (on by default).
- **Minimum pane width**: the width each pane of a scrolling split gets, in pixels (640).
- **Pane strip in the workspace bar**: one chip per open split pane with its color, title and state; click to go to it (on by default).
- **Thread monitor**: the activity card with live activity and the last status report (on by default).
- **Compact thread controls**: reply choices, status and PRs share one row above the composer (on by default).
- **Workspaces**: workspace tabs across the top of bb (on by default).
- **Thread counts on workspace tabs**: each tab's thread total beside its name (on by default). Off leaves only the count of threads waiting on you.
- **Swipe between workspaces**: a two-finger sideways swipe on the sidebar moves to the next or previous workspace tab, and the sidebar slides as the workspace changes (off by default).
- **⌘K opens the JB Flow palette**: the palette takes over BB's Search threads key (on by default).
- **Catch up**: the Catch up page, the ⌥⇧C command, its palette entry and home-page line (on by default).
- **Now and Focus**: the ranked Now group, the Focus mark and due dates, including the `set_thread_due` agent tool (on by default). Off restores Needs me.
- **Focus limit**: how many threads can be in Focus before marking another one asks you to drop one (default 7).
- **Keep threads in creation order**: Triage list rows stay put, newest thread first, instead of moving to the top on new activity (off by default).
- **Status report prompt**: what *Update status* sends; empty uses the built-in report described under Persistent thread monitor.
- **Status report at hand-back**: agents end replies that hand the thread back with the status report and end questions with numbered options, so the monitor and reply buttons stay current (on by default).
- **Stale after (days)**: when an unsectioned thread shows up in the digest (default 7).
- **Continue after usage-limit resets**: whether threads auto-continue after a Claude Code usage limit unless switched in the monitor (off by default).
- **Expand plan reviews**: expanded, resizable plan reviews (on by default).
- **Model choice on plan approval**: a model menu next to *Approve plan* to implement on another of the thread's models (on by default).
- **Hide options the reply buttons repeat**: while the reply choices show, hide the same numbered list and its "Reply with…" line in the agent's message (on by default).
- **Copy buttons on code**: hovering an inline code snippet in a chat message shows a copy button (off by default). Fenced code blocks already have BB's own *Copy code*.
- **Conductor**: allows one conductor thread per workspace (off by default). It uses your agent's quota. See [Conductor](#conductor-one-per-workspace-off-by-default).
- **Conductor: minutes to collect news before waking it** (default 10).
- **Conductor: your instructions**: added to every conductor's instructions, e.g. which PRs it may merge on its own (empty by default).
- **Advanced config (JSON)**: see below.
- **Triage lanes**, **Repo commands**, **Area tags** and **Conductors** have their own sections.

## Configuration

Release watches and sidebar chip names are set in JSON in the **Advanced config** setting. A `local.config.json` in the plugin folder (gitignored; see `local.config.example.json`) still works, and is copied into the setting the first time the plugin loads with the setting empty, because a marketplace update replaces the plugin folder. The setting wins key by key. Reload the plugin after a change.

- `repoCommands`: pinned side-panel commands, keyed by bb project name. A command has `id`, `label`, and `slots[]`. Each slot has a `command`, a `url` (or `null`), and the `ports` it binds. These can also be edited per project under **Settings → JB Flow → Repo commands**, which overrides the JSON.
- `projectShortNames`: the label shown on a project's sidebar chip.
- `stripProjectPrefixes`: prefixes removed from project names on chips.
- `releaseWatch`: per project, either `{ "base": "main", "titlePattern": "^Release\\b" }` (a merged release PR counts, after its workflows finish) or `{ "mode": "release" }` (a published GitHub release counts). Both take an optional `"repo": "owner/name"`. In release mode, an optional `"deliveredWhen": { "url": "https://example.com/version.json", "field": "version" }` holds the message until that public JSON shows the release's version or a newer one, for releases that still have steps after publishing. If it never does, threads are told after two hours that the release was published but not delivered.

## CLI

```
bb jb-flow snooze <thread-id|--self> <when> [--note <text>]
bb jb-flow unsnooze <thread-id|--self>
bb jb-flow snoozed [--json]
bb jb-flow due <thread-id|--self> <when|none> [--reason <text>]
bb jb-flow digest [--refresh] [--json]
bb jb-flow wait-ci [--pr <n>] [--repo owner/name] [--for checks|reviews|both] [--after-green merge|continue|nothing] [--self|<thread-id>]
bb jb-flow release-wait [--self|<thread-id>]
bb jb-flow prs [--self|<thread-id>] [--json]
bb jb-flow pr-link <pr-url> [--self|<thread-id>] [--remove]
bb jb-flow watches [--json]
bb jb-flow conductor [status|start <workspace-id> [--project <id>] [--provider <id>] [--model <id>]|stop|wake|inbox|briefing|log <workspace-id>] [--json]
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
bb jb-flow now [--json]
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
