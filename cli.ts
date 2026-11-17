// The `bb jb-flow` CLI: snooze, deadlines, the digest, Now and Needs me, PRs
// and CI watches, conductors, repo commands, and the Stream Deck snapshot.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { createAwaiting } from "./awaiting";
import type { Conductor } from "./conductor";
import { AFTER_GREEN } from "./conductor-routing";
import type { createDeck } from "./deck";
import { needsAttention, type createFocus } from "./focus";
import type { createLeftovers } from "./leftovers";
import type { createNowQueue } from "./now-queue";
import type { createNowStore } from "./now-store";
import type { createPrCi } from "./pr-ci";
import type { createPrTracker } from "./prs";
import { repoCommandSchema, type createRepoCommands } from "./repo-commands";
import type { FlowState } from "./rpc-contract";
import { quietFor } from "./sidebar-groups";
import type { createSnoozes } from "./snooze";
import type { createStaleDigest } from "./stale-digest";
import { listLiveThreads } from "./thread-list";
import type { createWatchers } from "./watchers";
import { formatDue, formatWhen, parseDue } from "./when";
import type { createWorkspaceStorage } from "./workspace-storage";
import { workspaceSchema } from "./workspaces";

type Snoozes = ReturnType<typeof createSnoozes>;
type NowQueue = ReturnType<typeof createNowQueue>;
type Deck = ReturnType<typeof createDeck>;

export type CliDeps = {
  settings: { get(): Promise<{ nowQueue: boolean }> };
  workspaces: ReturnType<typeof createWorkspaceStorage>;
  snooze: Snoozes["snooze"];
  unsnooze: Snoozes["unsnooze"];
  getSnoozes: Snoozes["getSnoozes"];
  wakeDue: Snoozes["wakeDue"];
  nowStore: ReturnType<typeof createNowStore>;
  watchThreadCi: ReturnType<typeof createPrCi>["watchThreadCi"];
  prTracker: ReturnType<typeof createPrTracker>;
  prRadar: ReturnType<typeof createPrCi>["prRadar"];
  findSnoozedSection: () => Promise<string | null>;
  awaiting: ReturnType<typeof createAwaiting>;
  watchingByThread: () => Promise<FlowState["watching"]>;
  watchers: ReturnType<typeof createWatchers>;
  leftovers: ReturnType<typeof createLeftovers>;
  repo: ReturnType<typeof createRepoCommands>;
  focus: ReturnType<typeof createFocus>;
  waitForDeckChange: (version: number, timeoutMs: number) => Promise<void>;
  deckVersion: () => number;
  deckSnapshot: Deck["deckSnapshot"];
  decisionsFor: Deck["decisionsFor"];
  /** The conductor, or null while it's loading. */
  currentConductor: () => Conductor | null;
  yourMove: NowQueue["yourMove"];
  nextThread: NowQueue["nextThread"];
  currentNow: NowQueue["currentNow"];
  readDigest: ReturnType<typeof createStaleDigest>["readDigest"];
};

export function registerCli(bb: BbPluginApi, deps: CliDeps) {
  const {
    settings,
    workspaces,
    snooze,
    unsnooze,
    getSnoozes,
    wakeDue,
    nowStore,
    watchThreadCi,
    prTracker,
    prRadar,
    findSnoozedSection,
    awaiting,
    watchingByThread,
    watchers,
    leftovers,
    repo,
    focus,
    waitForDeckChange,
    deckVersion,
    deckSnapshot,
    decisionsFor,
    currentConductor,
    yourMove,
    nextThread,
    currentNow,
    readDigest,
  } = deps;

  const usage = [
    "Usage:",
    "  bb jb-flow snooze <thread-id|--self> <when> [--note <text>]",
    "  bb jb-flow unsnooze <thread-id|--self>",
    "  bb jb-flow due <thread-id|--self> <when|none> [--reason <text>]",
    "  bb jb-flow snoozed [--json]",
    "  bb jb-flow wake-now",
    "  bb jb-flow digest [--refresh] [--json]",
    "  bb jb-flow focused [--json]                          The thread focused in BB",
    "  bb jb-flow stop [<thread-id>|--focused]",
    "  bb jb-flow tell <text…> [--thread <id>]              Send a message (default: focused thread)",
    "  bb jb-flow needs-me [--json]                         Threads waiting on you",
    "  bb jb-flow next                                      Open the next thread that needs you",
    "  bb jb-flow wait-ci [--pr <n>] [--repo owner/name] [--for checks|reviews|both] [--after-green merge|continue|nothing] [--self|<thread-id>]",
    "  bb jb-flow watches [--json]                          Auto-continues, release waiters, CI watches",
    "  bb jb-flow conductor [status|start|stop|wake|inbox|briefing|log] [<workspace-id>] [--json]",
    "  bb jb-flow prs [--self|<thread-id>] [--json]         PRs a thread created (all repos, stack order)",
    "  bb jb-flow pr-link <pr-url> [--self|<thread-id>] [--remove]",
    "  bb jb-flow release-wait [--self|<thread-id>]         Wake this thread on the next release",
    "  bb jb-flow check-now                                 Run the release and CI checks immediately",
    "  bb jb-flow repo [--self|<thread-id>]                 List repo commands and runs",
    "  bb jb-flow repo-run <command-id> [--self|<thread-id>]",
    "  bb jb-flow repo-stop <command-id> [--self|<thread-id>]",
    "  bb jb-flow repo-config <project-name> <json|reset>",
    "",
    "<when>: 30m, 2h, 3d, 1w, today, tonight, tomorrow, mon…sun, next-week, YYYY-MM-DD, YYYY-MM-DDTHH:MM",
  ].join("\n");

  bb.cli.register({
    name: "jb-flow",
    summary: "Snooze threads and review the stale-thread digest",
    commands: [
      { name: "workspaces", summary: "List workspaces or save/remove/assign using JSON", usage: 'bb jb-flow workspaces [save <json>|remove <id>|assign <thread-id> <workspace-id|unassigned|auto>]' },
      {
        name: "snooze",
        summary: "Snooze a thread until a time",
        usage: "bb jb-flow snooze <thread-id|--self> <when> [--note <text>]",
      },
      {
        name: "due",
        summary: "Set or clear a thread's deadline",
        usage: "bb jb-flow due <thread-id|--self> <when|none> [--reason <text>]",
      },
      {
        name: "unsnooze",
        summary: "Wake a snoozed thread now",
        usage: "bb jb-flow unsnooze <thread-id|--self>",
      },
      { name: "snoozed", summary: "List snoozed threads", usage: "bb jb-flow snoozed [--json]" },
      { name: "wake-now", summary: "Run the due-snooze check immediately", usage: "bb jb-flow wake-now" },
      { name: "leftovers", summary: "Worktree checkouts bb no longer tracks (--clean removes the merged ones)", usage: "bb jb-flow leftovers [--refresh] [--json] [--clean]" },
      { name: "deck", summary: "One JSON snapshot for the Stream Deck: focused thread, Needs me, Your move, PRs", usage: "bb jb-flow deck [--wait <version>]" },
      { name: "pr-radar", summary: "Threads with a PR to fix or merge (--open: jump to the next one)", usage: "bb jb-flow pr-radar [--json] [--open]" },
      { name: "your-move", summary: "Threads waiting on a decision from you, oldest first", usage: "bb jb-flow your-move [--json] [--open]" },
      { name: "focus-clients", summary: "Debug: the BB windows reporting focus, most recently used first", usage: "bb jb-flow focus-clients" },
      { name: "focused", summary: "Print the thread focused in BB", usage: "bb jb-flow focused [--json]" },
      { name: "decisions", summary: "Numbered options the focused thread is waiting on", usage: "bb jb-flow decisions [<thread-id>] [--json]" },
      { name: "stop", summary: "Stop a thread's run (default: focused)", usage: "bb jb-flow stop [<thread-id>|--focused]" },
      { name: "tell", summary: "Send a message to a thread (default: focused)", usage: "bb jb-flow tell <text…> [--thread <id>]" },
      { name: "needs-me", summary: "List threads waiting on you", usage: "bb jb-flow needs-me [--json]" },
      { name: "next", summary: "Open the next thread that needs you", usage: "bb jb-flow next" },
      { name: "now", summary: "List the Now queue in order, and what's Moving", usage: "bb jb-flow now [--json]" },
      { name: "wait-ci", summary: "Message a thread when its PR's CI finishes or reviews arrive", usage: "bb jb-flow wait-ci [--pr <n>] [--repo owner/name] [--for checks|reviews|both] [--after-green merge|continue|nothing] [--self|<thread-id>]" },
      { name: "prs", summary: "List the PRs a thread created, across repos, in stack order", usage: "bb jb-flow prs [--self|<thread-id>] [--json]" },
      { name: "pr-link", summary: "Link (or --remove) a PR to a thread", usage: "bb jb-flow pr-link <pr-url> [--self|<thread-id>] [--remove]" },
      { name: "watches", summary: "List auto-continues, release waiters and CI watches", usage: "bb jb-flow watches [--json]" },
      { name: "release-wait", summary: "Wake a thread on the next release", usage: "bb jb-flow release-wait [--self|<thread-id>]" },
      { name: "check-now", summary: "Run the release and CI checks immediately", usage: "bb jb-flow check-now" },
      { name: "repo", summary: "List repo commands and runs for a thread", usage: "bb jb-flow repo [--self|<thread-id>]" },
      { name: "repo-run", summary: "Run a repo command in the thread's terminal", usage: "bb jb-flow repo-run <command-id> [--self|<thread-id>]" },
      { name: "repo-stop", summary: "Stop a running repo command", usage: "bb jb-flow repo-stop <command-id> [--self|<thread-id>]" },
      { name: "repo-config", summary: "Set or reset a project's repo commands", usage: "bb jb-flow repo-config <project-name> <json|reset>" },
      {
        name: "digest",
        summary: "List stale unsectioned threads",
        usage: "bb jb-flow digest [--refresh] [--json]",
      },
      {
        name: "conductor",
        summary: "Workspace conductors: status, start, stop, wake, inbox, briefing, log",
        usage: "bb jb-flow conductor [status|start <workspace-id> [--project <id>] [--provider <id>] [--model <id>]|restart <workspace-id>|stop <workspace-id>|wake <workspace-id>|inbox <workspace-id>|briefing <workspace-id>|log <workspace-id>] [--json]",
      },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const refresh = argv.includes("--refresh");
      const noteIndex = argv.indexOf("--note");
      const note = noteIndex === -1 ? null : argv.slice(noteIndex + 1).join(" ");
      const reasonIndex = argv.indexOf("--reason");
      const reason = reasonIndex === -1 ? null : argv.slice(reasonIndex + 1).join(" ").trim() || null;
      const beforeText = Math.min(...[noteIndex, reasonIndex].map((index) => (index === -1 ? argv.length : index)));
      const positional = argv.slice(0, beforeText).filter(
        (arg) => arg !== "--json" && arg !== "--refresh",
      );
      const [command, ...args] = positional;
      const resolveThread = (value: string | undefined) =>
        value === "--self" ? ctx.threadId : value === "--focused" ? focus.focusedThreadId() ?? undefined : value;
      try {
        switch (command) {
          case "workspaces": {
            if (args[0] === "save") {
              const input = workspaceSchema.extend({ id: z.string().nullable() }).parse(JSON.parse(args.slice(1).join(" ")));
              return { exitCode: 0, stdout: JSON.stringify(await workspaces.save(input)) };
            }
            if (args[0] === "remove" && args[1]) await workspaces.remove(args[1]);
            else if (args[0] === "assign" && args[1] && args[2]) await workspaces.assign(args[1], ["auto", "unassigned"].includes(args[2]) ? null : args[2], args[2] === "auto");
            else if (args.length > 0) throw new Error("Use workspaces [save <json>|remove <id>|assign <thread-id> <workspace-id|unassigned|auto>]");
            return { exitCode: 0, stdout: JSON.stringify(await workspaces.read()) };
          }
          case "snooze": {
            const threadId = resolveThread(args[0]);
            const when = args.slice(1).join(" ");
            if (threadId === undefined || when === "") break;
            const record = await snooze(threadId, when, note);
            return {
              exitCode: 0,
              stdout: json
                ? JSON.stringify(record)
                : `Snoozed ${threadId} until ${formatWhen(record.until)}.`,
            };
          }
          case "due": {
            const threadId = resolveThread(args[0]);
            const when = args.slice(1).join(" ");
            if (threadId === undefined || when === "") break;
            const at = when.toLowerCase() === "none" ? null : parseDue(when);
            const { due } = await nowStore.setDue(threadId, at, at === null ? null : reason, "you");
            if (json) return { exitCode: 0, stdout: JSON.stringify(due) };
            return { exitCode: 0, stdout: at === null ? `Cleared the deadline on ${threadId}.` : `${threadId}: ${formatDue(at)} (${formatWhen(at)}).` };
          }
          case "unsnooze": {
            const threadId = resolveThread(args[0]);
            if (threadId === undefined) break;
            return (await unsnooze(threadId))
              ? { exitCode: 0, stdout: `Woke ${threadId}.` }
              : { exitCode: 1, stderr: `${threadId} is not snoozed.` };
          }
          case "snoozed": {
            const snoozes = Object.entries(await getSnoozes()).sort(
              (a, b) => a[1].until - b[1].until,
            );
            if (json) return { exitCode: 0, stdout: JSON.stringify(Object.fromEntries(snoozes)) };
            const lines = await Promise.all(
              snoozes.map(async ([threadId, record]) => {
                const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
                return `${formatWhen(record.until).padEnd(16)} ${threadId}  ${thread?.title ?? ""}${record.note ? `  — ${record.note}` : ""}`;
              }),
            );
            return { exitCode: 0, stdout: lines.length === 0 ? "Nothing snoozed." : lines.join("\n") };
          }
          case "wait-ci": {
            const prFlag = args.indexOf("--pr");
            const forFlag = args.indexOf("--for");
            const repoFlag = args.indexOf("--repo");
            const afterFlag = args.indexOf("--after-green");
            const positional = args.filter((arg, index) => {
              if (prFlag !== -1 && (index === prFlag || index === prFlag + 1)) return false;
              if (forFlag !== -1 && (index === forFlag || index === forFlag + 1)) return false;
              if (repoFlag !== -1 && (index === repoFlag || index === repoFlag + 1)) return false;
              if (afterFlag !== -1 && (index === afterFlag || index === afterFlag + 1)) return false;
              return true;
            });
            const threadId = resolveThread(positional[0] ?? "--self");
            if (threadId === undefined) break;
            const watchFor = forFlag === -1 ? undefined : z.enum(["checks", "reviews", "both"]).parse(args[forFlag + 1]);
            const watches = await watchThreadCi(threadId, {
              pr: prFlag === -1 ? undefined : Number(args[prFlag + 1]),
              watchFor,
              repo: repoFlag === -1 ? undefined : args[repoFlag + 1],
              afterGreen: afterFlag === -1 ? undefined : z.enum(AFTER_GREEN).parse(args[afterFlag + 1]),
            });
            return {
              exitCode: 0,
              stdout: `Watching ${watches.map((watch) => `${watch.repo}#${watch.pr}`).join(", ")} for ${watches[0]!.watchFor}; ${threadId} will be messaged.`,
            };
          }
          case "prs": {
            const threadId = resolveThread(args[0] ?? "--self");
            if (threadId === undefined) break;
            await prTracker.refreshThread(threadId);
            const prs = (await prTracker.byThread())[threadId] ?? [];
            if (json) return { exitCode: 0, stdout: JSON.stringify(prs) };
            const lines = prs.map(
              (pr) => `${pr.stackedOn !== null ? "  └ " : ""}${pr.repo}#${pr.number}  ${pr.attention.padEnd(17)} ${pr.title}`,
            );
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "No PRs linked." };
          }
          case "classify": {
            const snoozedSection = await findSnoozedSection();
            // Debug view: where each open thread lands in the triage sidebar, with
            // the tail of its last agent message to check the call against.
            const [threads, awaitingAll, byThread, watching, sections, promised, waitingOthers, readyToGo] = await Promise.all([
              listLiveThreads(bb),
              awaiting.all(),
              prTracker.byThread(),
              watchingByThread(),
              bb.sdk.threadSections.list(),
              awaiting.promised(),
              awaiting.waitingOthers(),
              awaiting.readyToGo(),
            ]);
            const sectionName = new Map(sections.map((section) => [section.id, section.name]));
            const rows = [];
            for (const thread of threads) {
              if (thread.archivedAt !== null || thread.visibility !== "visible" || thread.parentThreadId !== null) continue;
              const snoozed = snoozedSection !== null && thread.sectionId === snoozedSection;
              const busy = thread.status === "active" || thread.status === "starting";
              const prs = (byThread[thread.id] ?? []).map((pr) => `${pr.repo.split("/")[1]}#${pr.number}:${pr.attention}`);
              const open = (byThread[thread.id] ?? []).filter((pr) => pr.state === "open" || pr.state === "draft");
              const settled = (byThread[thread.id] ?? []).every((pr) => pr.state === "merged" || pr.state === "closed");
              const needs = !snoozed && needsAttention(thread, awaitingAll);
              const group = snoozed
                ? "snoozed"
                : needs
                ? "needs-me"
                : thread.pinnedAt
                  ? "pinned"
                  : busy
                    ? "running"
                    : promised[thread.id] !== undefined && !watching[thread.id] && quietFor(thread, Date.now()) > 3_600_000
                      ? "stalled"
                      : awaitingAll[thread.id] !== undefined
                      ? "your-move"
                      : readyToGo[thread.id] !== undefined
                      ? "ready"
                      : thread.sectionId === null &&
                          (waitingOthers[thread.id] !== undefined ||
                            (open.length > 0 && open.every((pr) => pr.attention === "review_requested")))
                        ? "waiting"
                      : thread.sectionId === null && !watching[thread.id] && settled && quietFor(thread, Date.now()) > 2 * 3_600_000
                        ? "done"
                        : "lane";
              const output = await bb.sdk.threads.output({ threadId: thread.id }).catch(() => ({ output: null }));
              rows.push({
                id: thread.id,
                title: thread.title,
                status: thread.status,
                section: thread.sectionId === null ? "Active" : sectionName.get(thread.sectionId) ?? thread.sectionId,
                group,
                awaiting: awaitingAll[thread.id] !== undefined,
                watching: watching[thread.id] ?? null,
                openPrs: open.map((pr) => `${pr.repo.split("/")[1]}#${pr.number}:${pr.attention}`),
                prs: prs.length,
                idleHours: Math.round(quietFor(thread, Date.now()) / 3_600_000),
                tail: (output.output ?? "").trim().slice(-1500),
              });
            }
            return { exitCode: 0, stdout: JSON.stringify(rows) };
          }
          case "leftovers": {
            if (argv.includes("--clean")) {
              const { removed, kept } = await leftovers.clean();
              return { exitCode: 0, stdout: `Removed ${removed.length}, kept ${kept.length}.\n${kept.map((path) => `  kept ${path}`).join("\n")}` };
            }
            const report = await leftovers.read(refresh);
            if (json) return { exitCode: 0, stdout: JSON.stringify(report) };
            const lines = report.items.map(
              (item) =>
                `${item.safe ? "safe" : "KEEP"}  ${item.repo.padEnd(28)} ${item.branch.padEnd(40)} ${item.pr ? `${item.pr} ${item.prState}` : "no PR"}${item.dirty ? ` · ${item.dirty} uncommitted` : ""}${item.nodeModules ? " · node_modules" : ""}`,
            );
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "No leftover worktrees." };
          }
          case "deck": {
            // --wait <version>: block (max 25s) until something changes, then answer.
            const waitIndex = argv.indexOf("--wait");
            if (waitIndex !== -1) await waitForDeckChange(Number(argv[waitIndex + 1]), 25_000);
            const version = deckVersion();
            return { exitCode: 0, stdout: JSON.stringify({ version, ...(await deckSnapshot()) }) };
          }
          case "pr-radar": {
            const { broken, ready } = await prRadar();
            if (argv.includes("--open")) {
              const focused = focus.focusedThreadId();
              const queue = [...broken, ...ready];
              const next = queue.find((item) => item.threadId !== focused) ?? queue[0];
              if (next === undefined) return { exitCode: 0, stdout: "No PR needs you." };
              await bb.sdk.threads.open({ threadId: next.threadId, file: null });
              return { exitCode: 0, stdout: `Opened ${next.threadId}  ${next.title} (${next.pr})` };
            }
            if (json) return { exitCode: 0, stdout: JSON.stringify({ broken, ready }) };
            const lines = [
              ...broken.map((item) => `fix    ${item.pr.padEnd(22)} ${item.title}`),
              ...ready.map((item) => `merge  ${item.pr.padEnd(22)} ${item.title}`),
            ];
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "No PR needs you." };
          }
          case "pr-link": {
            const remove = args.includes("--remove");
            const rest = args.filter((arg) => arg !== "--remove");
            const url = rest[0];
            const threadId = resolveThread(rest[1] ?? "--self");
            const match = url ? /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url) : null;
            if (!match || threadId === undefined) break;
            await prTracker.link(threadId, { repo: match[1]!, number: Number(match[2]) }, remove);
            return { exitCode: 0, stdout: `${remove ? "Unlinked" : "Linked"} ${match[1]}#${match[2]}.` };
          }
          case "conductor": {
            const conductor = currentConductor();
            if (!conductor) throw new Error("The conductor isn't loaded.");
            const [action = "status", workspaceId] = args;
            const flag = (name: string) => {
              const index = args.indexOf(name);
              return index === -1 ? undefined : args[index + 1];
            };
            const out = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
            if (action === "status") {
              const all = await conductor.status();
              return out(
                all,
                all.length === 0
                  ? "No conductors. Turn on Conductor in the settings, then: bb jb-flow conductor start <workspace-id>"
                  : all
                      .map((entry) => `${entry.workspaceId}  ${entry.name}  ${entry.active ? "on" : "off"}  thread ${entry.threadId ?? "-"}  inbox ${entry.open} open, ${entry.undelivered} waiting`)
                      .join("\n"),
              );
            }
            if (!workspaceId) throw new Error(`Use conductor ${action} <workspace-id>; bb jb-flow workspaces lists them.`);
            switch (action) {
              case "start": {
                const result = await conductor.start(workspaceId, { projectId: flag("--project"), providerId: flag("--provider"), model: flag("--model") });
                return out(result, `Conductor for ${workspaceId}: ${result.threadId}`);
              }
              case "restart": {
                const result = await conductor.restart(workspaceId);
                return out(result, `Conductor for ${workspaceId}: ${result.threadId}${result.previous ? ` (archived ${result.previous})` : ""}`);
              }
              case "stop":
                return out({ stopped: await conductor.stop(workspaceId) }, `Stopped the conductor for ${workspaceId}; its thread stays.`);
              case "wake": {
                const result = await conductor.wake(workspaceId, true);
                return out({ result }, result);
              }
              case "inbox": {
                const events = conductor.inbox(workspaceId);
                return out(events, events.length === 0 ? "Inbox empty." : events.map((event) => `#${event.id} [${event.kind}] ${event.threadId} ${event.deliveredAt ? "sent" : "waiting"} · ${event.text}`).join("\n"));
              }
              case "briefing": {
                const briefing = await conductor.briefing(workspaceId);
                return out(
                  briefing,
                  briefing === null
                    ? "No briefing yet."
                    : [
                        `Briefing from ${formatWhen(briefing.at)}:`,
                        ...briefing.items.map((item, index) => `${index + 1}. [${item.kind}] ${item.threadId} · ${item.summary}${item.recommendation ? ` → ${item.recommendation}` : ""}`),
                        ...briefing.handled.map((entry) => `✓ ${entry.what}`),
                      ].join("\n"),
                );
              }
              case "log": {
                const entries = conductor.log(workspaceId, 50);
                return out(entries, entries.map((entry) => `${formatWhen(entry.at)}  ${entry.kind.padEnd(13)} ${entry.threadId ?? ""}  ${entry.text}`).join("\n") || "Nothing logged.");
              }
            }
            throw new Error("Use conductor status|start|restart|stop|wake|inbox|briefing|log.");
          }
          case "watches": {
            const result = await watchers.status();
            if (json) return { exitCode: 0, stdout: JSON.stringify(result) };
            const lines = [
              ...Object.entries(result.autoContinue).map(([id, entry]) => `continue    ${id}  at ${formatWhen(entry.resetsAt + 90_000)}`),
              ...Object.values(result.releaseWaiters).map((waiter) => `release     ${waiter.threadId}  (${waiter.projectName})`),
              ...Object.entries(result.pendingReleases).map(([key, release]) => `deploying   ${key}  ${release.title}`),
              ...Object.values(result.ciWatches).map((watch) => `ci          ${watch.threadId}  ${watch.repo}#${watch.pr} (${watch.watchFor})`),
            ];
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "Nothing watched." };
          }
          case "release-wait": {
            const threadId = resolveThread(args[0] ?? "--self");
            if (threadId === undefined) break;
            await watchers.registerReleaseWaiter(await bb.sdk.threads.get({ threadId }));
            return { exitCode: 0, stdout: `${threadId} will be woken on the next release (if its project has releaseWatch configured).` };
          }
          case "check-now":
            await watchers.checkReleases();
            await watchers.checkCi(true);
            return { exitCode: 0, stdout: "Checked releases and CI watches." };
          case "your-move": {
            const { items } = await yourMove({ withAsk: !argv.includes("--open") });
            if (argv.includes("--open")) {
              // Oldest first; skip the one you're already looking at.
              const focused = focus.focusedThreadId();
              const next = items.find((item) => item.threadId !== focused) ?? items[0];
              if (next === undefined) return { exitCode: 0, stdout: "Nothing is waiting on you." };
              await bb.sdk.threads.open({ threadId: next.threadId, file: null });
              return { exitCode: 0, stdout: `Opened ${next.threadId}  ${next.title}` };
            }
            if (json) return { exitCode: 0, stdout: JSON.stringify({ count: items.length, items }) };
            const lines = items.map((item) => `${formatWhen(item.since).padEnd(16)} ${item.threadId}  ${item.title}`);
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "Nothing is waiting on you." };
          }
          case "focus-clients": {
            const rows = focus.clients().map((entry) => ({
              clientId: entry.clientId,
              threadId: entry.threadId,
              windowFocused: entry.windowFocused,
              interacted: entry.interactedAt ? formatWhen(entry.interactedAt) : "never",
              reported: formatWhen(entry.at),
              origin: entry.origin ?? "?",
              userAgent: entry.userAgent ?? "?",
            }));
            return { exitCode: 0, stdout: JSON.stringify(rows, null, 2) };
          }
          case "focused": {
            const threadId = focus.focusedThreadId();
            if (threadId === null) return { exitCode: 1, stderr: "No focused thread." };
            const thread = await bb.sdk.threads.get({ threadId });
            return {
              exitCode: 0,
              stdout: json
                ? JSON.stringify({ threadId, projectId: thread.projectId, title: thread.title, status: thread.status })
                : `${threadId}  ${thread.title ?? ""}`,
            };
          }
          case "decisions": {
            const result = await decisionsFor(resolveThread(args[0] ?? "--focused") ?? null);
            const options = result.options;
            return {
              exitCode: 0,
              stdout: json
                ? JSON.stringify(result)
                : options.map((option) => `${option.n}. ${option.text}${option.recommended ? " (recommended)" : ""}`).join("\n") ||
                  "No open decision.",
            };
          }
          case "stop": {
            const threadId = resolveThread(args[0] ?? "--focused");
            if (threadId === undefined) return { exitCode: 1, stderr: "No focused thread." };
            await bb.sdk.threads.stop({ threadId });
            return { exitCode: 0, stdout: `Stopped ${threadId}.` };
          }
          case "tell": {
            const flag = args.indexOf("--thread");
            const target = flag === -1 ? await focus.requireFocused() : args[flag + 1];
            const text = (flag === -1 ? args : args.slice(0, flag)).join(" ").trim();
            if (target === undefined || text === "") break;
            await bb.sdk.threads.send({
              threadId: target,
              mode: "queue-if-active",
              input: [{ type: "text", text, mentions: [] }],
            });
            return { exitCode: 0, stdout: `Sent to ${target}.` };
          }
          case "needs-me": {
            const threads = await focus.needsMe();
            if (json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  count: threads.length,
                  threads: threads.map((thread) => ({ id: thread.id, title: thread.title, status: thread.status })),
                }),
              };
            }
            return {
              exitCode: 0,
              stdout: threads.length === 0 ? "Nothing needs you." : threads.map((thread) => `${thread.id}  ${thread.title ?? ""}`).join("\n"),
            };
          }
          case "next": {
            const focused = focus.focusedThreadId();
            const nextId = await nextThread(focused, focused);
            if (nextId === null) return { exitCode: 0, stdout: "Nothing needs you." };
            await bb.sdk.threads.open({ threadId: nextId, file: null });
            const next = await bb.sdk.threads.get({ threadId: nextId }).catch(() => null);
            return { exitCode: 0, stdout: `Opened ${nextId}  ${next?.title ?? ""}` };
          }
          case "now": {
            if (!(await settings.get()).nowQueue) return { exitCode: 1, stderr: "Now and Focus is turned off in the plugin settings." };
            const queue = await currentNow(await listLiveThreads(bb));
            if (json) return { exitCode: 0, stdout: JSON.stringify({ count: queue.now.length, threads: queue.now, moving: queue.moving }) };
            const line = (entry: (typeof queue.now)[number]) => `${entry.focused ? "*" : " "} ${entry.id}  ${entry.title}  [${entry.reason}]`;
            return {
              exitCode: 0,
              stdout: [...(queue.now.length ? queue.now.map(line) : ["Nothing in Now."]), ...(queue.moving.length ? ["", "Moving:", ...queue.moving.map(line)] : [])].join("\n"),
            };
          }
          case "repo": {
            const threadId = resolveThread(args[0] ?? "--self");
            if (threadId === undefined) break;
            const result = await repo.status(threadId);
            if (json) return { exitCode: 0, stdout: JSON.stringify(result) };
            const runLabel = (id: string) => {
              const run = result.runs.find((candidate) => candidate.commandId === id);
              return run ? `  [${run.status}${run.url ? ` ${run.url}` : ""}]` : "";
            };
            const pinned = result.commands.map((command) => `${command.id.padEnd(16)} ${command.label}${runLabel(command.id)}`);
            const scripts = result.scripts.map((script) => `${script.id.padEnd(16)} ${script.command}${runLabel(script.id)}`);
            const out = [result.projectName];
            if (pinned.length) out.push("", "Pinned:", ...pinned);
            if (scripts.length) out.push("", "Scripts:", ...scripts);
            else if (result.scriptsError) out.push("", `Scripts: ${result.scriptsError}`);
            if (!pinned.length && !scripts.length && !result.scriptsError) out.push("No commands or scripts.");
            return { exitCode: 0, stdout: out.join("\n") };
          }
          case "repo-run":
          case "repo-stop": {
            const threadId = resolveThread(args[1] ?? "--self");
            if (args[0] === undefined || threadId === undefined) break;
            if (command === "repo-stop") {
              return (await repo.stop(threadId, args[0]))
                ? { exitCode: 0, stdout: `Stopped ${args[0]}.` }
                : { exitCode: 1, stderr: `${args[0]} is not running in ${threadId}.` };
            }
            const run = await repo.run(threadId, args[0]);
            return {
              exitCode: 0,
              stdout: json ? JSON.stringify(run) : `Started ${run.label} (terminal ${run.terminalId})${run.url ? `; browser opens at ${run.url} once the port is up` : ""}.`,
            };
          }
          case "repo-config": {
            const [projectNameArg, ...rest] = args;
            const value = rest.join(" ");
            if (projectNameArg === undefined || value === "") break;
            const commands = value === "reset" ? null : z.array(repoCommandSchema).parse(JSON.parse(value));
            await repo.setCommands(projectNameArg, commands);
            return { exitCode: 0, stdout: commands === null ? "Reset." : `Saved ${commands.length} command(s).` };
          }
          case "wake-now":
            return { exitCode: 0, stdout: `Woke ${await wakeDue()} thread(s).` };
          case "digest": {
            const digest = await readDigest(refresh);
            if (json) return { exitCode: 0, stdout: JSON.stringify(digest) };
            const lines = digest.items
              .slice(0, 100)
              .map((item) => `${String(item.idleDays).padStart(3)}d  ${item.threadId}  ${item.title}`);
            const more =
              digest.items.length > 100 ? `\n… and ${digest.items.length - 100} more` : "";
            return {
              exitCode: 0,
              stdout: `${digest.items.length} stale thread(s), generated ${new Date(digest.generatedAt).toLocaleString()}\n${lines.join("\n")}${more}`,
            };
          }
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };
        }
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
