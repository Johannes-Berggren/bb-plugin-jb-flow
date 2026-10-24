// Catch up: unread threads one card at a time, like Slack's. The same deck runs
// in the Catch up page and in an overlay (the command, the palette and the home
// page open it). Which threads and in what order lives in catch-up-model.ts;
// this file renders the deck and owns every side effect. Showing a card never
// marks a thread read: only Done, a reply, Go and Snooze do.
import "./catch-up.css";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { z } from "zod";
import {
  Markdown,
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useRpc,
  useSdk,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FlowState, rpcContract } from "./server";
import {
  CATCH_UP_EVENT,
  TIER_LABEL,
  badgeFor,
  buildQueue,
  bulkReadable,
  current,
  freshIds,
  goText,
  needsYou,
  progress,
  pullFresh,
  record,
  recordBulk,
  requeueKept,
  reseen,
  resumable,
  settle,
  startSession,
  stepsFrom,
  stillWorking,
  summary,
  swipeOutcome,
  togglePick,
  undo,
  undoBlocked,
  upcoming,
  type CatchUpBadge,
  type CatchUpItem,
  type Outcome,
  type Session,
  type Since,
  type Steps,
} from "./catch-up-model";
import { ago } from "./palette-model";
import { SNOOZE_PRESETS, formatWhen, parseWhen } from "./when";
import { useSelectedWorkspace, useWorkspaces } from "./workspace-client";
import { inWorkspace } from "./workspaces";
import { PrList, StatusIcon, rowStatus, runInfo, threadPrs, useNow } from "./ui-extras";
import { useSidebarThreadActions } from "./thread-actions";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type CardData = z.infer<(typeof rpcContract)["catch_up_card"]["output"]>;
type Mode = "card" | "reply" | "snooze" | "help" | "confirm-all";
type Strip = { id: number; text: string; undoable: boolean; error?: boolean };

/** How long the undo line stays, and how long an archive waits for an undo before it happens. */
const UNDO_MS = 8_000;

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const short = (text: string) => (text.length > 40 ? `${text.slice(0, 39)}…` : text);

// --- opening -------------------------------------------------------------------------

// The Catch up page, while one is mounted: the command focuses it instead of
// opening a second deck over it.
let pagesMounted = 0;
const FOCUS_PAGE_EVENT = "jb-flow:catch-up-focus";

/** Open state for the overlay; CATCH_UP_EVENT opens it while Catch up is on. */
export function useCatchUpTrigger(enabled: boolean) {
  const [open, setOpen] = useState(false);
  const live = useRef(enabled);
  live.current = enabled;
  useEffect(() => {
    const onOpen = () => {
      if (!live.current) return;
      if (pagesMounted > 0) window.dispatchEvent(new CustomEvent(FOCUS_PAGE_EVENT));
      else setOpen(true);
    };
    window.addEventListener(CATCH_UP_EVENT, onOpen);
    return () => window.removeEventListener(CATCH_UP_EVENT, onOpen);
  }, []);
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);
  const close = useCallback(() => setOpen(false), []);
  return { open, close };
}

// --- one session per window, shared by the page and the overlay -------------------------

let session: Session | null = null;
const sessionListeners = new Set<() => void>();
function setSession(next: Session | null) {
  if (next === session) return;
  session = next;
  for (const listener of sessionListeners) listener();
}
const updateSession = (change: (current: Session) => Session) => {
  if (session !== null) setSession(change(session));
};
const subscribeSession = (listener: () => void) => {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
};
const useSession = () => useSyncExternalStore(subscribeSession, () => session);

// --- cards: loaded once per thread update, the next two ahead of time -------------------

const cards = new Map<string, CardData>();
const latestCards = new Map<string, CardData>();
const loading = new Map<string, Promise<CardData>>();
const cardKey = (threadId: string, updatedAt: number, since: number | null) => `${threadId}:${updatedAt}:${since ?? "new"}`;

/** Forget the session and loaded cards (tests, so one case doesn't resume the last). */
export function forgetCatchUp() {
  session = null;
  cards.clear();
  latestCards.clear();
  loading.clear();
}

function loadCard(rpc: Rpc, threadId: string, updatedAt: number, since: number | null): Promise<CardData> {
  const key = cardKey(threadId, updatedAt, since);
  const hit = cards.get(key);
  if (hit) return Promise.resolve(hit);
  const inflight = loading.get(key);
  if (inflight) return inflight;
  const request = rpc
    .call("catch_up_card", { threadId, since })
    .then((card) => {
      cards.set(key, card);
      latestCards.set(threadId, card);
      if (cards.size > 40) cards.delete(cards.keys().next().value!);
      return card;
    })
    .finally(() => loading.delete(key));
  loading.set(key, request);
  return request;
}

function useCard(threadId: string | null, updatedAt: number, since: number | null): { card: CardData | null; failed: boolean } {
  const rpc = useRpc<typeof rpcContract>();
  const key = threadId === null ? null : cardKey(threadId, updatedAt, since);
  const [loaded, setLoaded] = useState<{ key: string; card: CardData | null } | null>(null);
  useEffect(() => {
    if (threadId === null || key === null || cards.has(key)) return;
    let live = true;
    loadCard(rpc, threadId, updatedAt, since).then(
      (card) => {
        if (live) setLoaded({ key, card });
      },
      () => {
        if (live) setLoaded({ key, card: null });
      },
    );
    return () => {
      live = false;
    };
  }, [key, rpc, since, threadId, updatedAt]);
  if (threadId === null || key === null) return { card: null, failed: false };
  const cached = cards.get(key);
  if (cached) return { card: cached, failed: false };
  if (loaded?.key === key) return { card: loaded.card, failed: loaded.card === null };
  // A newer version is loading: keep the one on screen meanwhile.
  return { card: latestCards.get(threadId) ?? null, failed: false };
}

// --- scope, queue and badge ---------------------------------------------------------------

function useQueue(flow: FlowState | null, everywhere: boolean) {
  const { status, threads, projects } = useSidebarThreads();
  const { state: workspaceState, ready: workspacesReady } = useWorkspaces();
  const selected = useSelectedWorkspace();
  const scope = everywhere ? null : selected;
  const include = useCallback(
    (thread: PluginSidebarThread) => inWorkspace(thread, scope, workspaceState, threads),
    [scope, threads, workspaceState],
  );
  const queue = useMemo(() => buildQueue(threads, flow, include), [flow, include, threads]);
  return {
    queue,
    threads,
    projects,
    include,
    scope,
    selected,
    workspaceName: workspaceState.workspaces.find((workspace) => workspace.id === selected)?.name ?? (selected === "unassigned" ? "No workspace" : null),
    ready: status === "ready" && flow !== null && (scope === null || workspacesReady),
  };
}

/** The Catch up page's badge: unread threads in the current workspace. */
export function useCatchUpBadge(flow: FlowState | null, enabled: boolean): CatchUpBadge | null {
  const { queue, ready } = useQueue(flow, false);
  return enabled && ready ? badgeFor(queue) : null;
}

/** "Catch up · 9 unread (2 need you)" above Your move on the home page. */
export function CatchUpHomeEntry({ flow }: { flow: FlowState | null }) {
  const enabled = useSettings().values?.catchUp === true;
  const { queue, ready } = useQueue(flow, false);
  if (!enabled || !ready || queue.length === 0) return null;
  const need = queue.filter((entry) => needsYou(entry.tier)).length;
  return (
    <button type="button" className="jf-catchup-home" onClick={() => window.dispatchEvent(new CustomEvent(CATCH_UP_EVENT))}>
      <Icon name="MailOpen" className="size-4" />
      <span className="jf-catchup-home-text">
        <strong>Catch up</strong> · {queue.length} unread{need > 0 ? ` (${need} need${need === 1 ? "s" : ""} you)` : ""}
      </span>
      <Icon name="ArrowRight" className="size-3.5" />
    </button>
  );
}

// --- the overlay and the page ----------------------------------------------------------

export function CatchUpOverlay({ flow, onClose }: { flow: FlowState | null; onClose: () => void }) {
  const mode = useRef<Mode>("card");
  const root = useRef<HTMLDivElement>(null);
  const onModeChange = useCallback((next: Mode) => {
    mode.current = next;
  }, []);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        hideCloseButton
        className="jf-catchup-dialog top-[8%] max-w-[720px] translate-y-0 gap-0 overflow-hidden p-0 sm:rounded-xl"
        onEscapeKeyDown={(event) => {
          // Escape leaves a reply, snooze or help first; the deck handles that.
          if (mode.current !== "card") event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          root.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">Catch up</DialogTitle>
        <DialogDescription className="sr-only">
          Unread threads one at a time. Right arrow marks read, left arrow keeps unread, Z undoes, question mark lists every key.
        </DialogDescription>
        <CatchUpDeck flow={flow} variant="overlay" onClose={onClose} rootRef={root} onModeChange={onModeChange} />
      </DialogContent>
    </Dialog>
  );
}

export function CatchUpPage({ flow }: { flow: FlowState | null }) {
  const enabled = useSettings().values?.catchUp === true;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!enabled) return;
    pagesMounted += 1;
    const focus = () => root.current?.focus();
    window.addEventListener(FOCUS_PAGE_EVENT, focus);
    return () => {
      pagesMounted -= 1;
      window.removeEventListener(FOCUS_PAGE_EVENT, focus);
    };
  }, [enabled]);
  if (!enabled) {
    return (
      <div className="jf-catchup-page">
        <p className="jf-catchup-empty">Catch up is off. Turn it on under Settings → JB Flow.</p>
      </div>
    );
  }
  return (
    <div className="jf-catchup-page">
      <CatchUpDeck flow={flow} variant="page" rootRef={root} />
    </div>
  );
}

// --- the deck --------------------------------------------------------------------------

function CatchUpDeck({
  flow,
  variant,
  onClose,
  rootRef,
  onModeChange,
}: {
  flow: FlowState | null;
  variant: "overlay" | "page";
  onClose?: () => void;
  rootRef: RefObject<HTMLDivElement | null>;
  onModeChange?: (mode: Mode) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const actions = useSidebarThreadActions();
  const workspacesOn = useSettings().values?.workspaces === true;
  const [everywhere, setEverywhere] = useState(false);
  const { queue, threads, projects, include, scope, selected, workspaceName, ready } = useQueue(flow, everywhere);
  const now = useNow(30_000);
  const shared = useSession();
  const liveById = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);

  // Deal once the threads and the plugin state are in, or carry on a recent session.
  const [dealtFor, setDealtFor] = useState<{ scope: string | null } | null>(null);
  const [resumedWith, setResumedWith] = useState<number | null>(null);
  useEffect(() => {
    if (!ready || (dealtFor !== null && dealtFor.scope === scope)) return;
    const at = Date.now();
    if (dealtFor === null && resumable(session, scope, at)) {
      setResumedWith(session.items.filter((entry) => entry.outcome === null).length);
      setSession({ ...session, touchedAt: at });
    } else {
      setResumedWith(null);
      setSession(startSession(queue, scope, at));
    }
    setDealtFor({ scope });
  }, [dealtFor, queue, ready, scope]);
  const active = dealtFor !== null && shared !== null && shared.scope === dealtFor.scope ? shared : null;
  // Nothing was dealt (or the threads arrived late): deal what's there now.
  const emptyDeal = active !== null && active.items.length === 0;
  useEffect(() => {
    if (emptyDeal && queue.length > 0) setSession(startSession(queue, scope, Date.now()));
  }, [emptyDeal, queue, scope]);

  // Threads an undo is marking unread again: not "read elsewhere" while that lands.
  const restoring = useRef(new Set<string>());
  useEffect(() => {
    if (ready) updateSession((current) => settle(current, liveById, flow, Date.now(), restoring.current));
  }, [flow, liveById, ready]);

  const item = active ? current(active) : null;
  const thread = item ? (liveById.get(item.threadId) ?? null) : null;
  const { card, failed } = useCard(thread?.id ?? null, thread?.updatedAt ?? 0, item?.since ?? null);
  const steps = useMemo(() => (card ? stepsFrom(card.move, card.report?.steps?.question ?? "") : null), [card]);

  const ahead = active ? upcoming(active, 2) : [];
  const aheadKey = ahead.map((entry) => entry.threadId).join(",");
  useEffect(() => {
    for (const entry of ahead) {
      const next = liveById.get(entry.threadId);
      if (next) loadCard(rpc, next.id, next.updatedAt, entry.since).catch(() => undefined);
    }
    // aheadKey stands for `ahead`; thread updates refetch through useCard.
  }, [aheadKey, rpc]);

  const [mode, setModeState] = useState<Mode>("card");
  const modeRef = useRef<Mode>("card");
  const modeChanged = useRef(onModeChange);
  modeChanged.current = onModeChange;
  const setMode = useCallback(
    (next: Mode) => {
      modeRef.current = next;
      setModeState(next);
      modeChanged.current?.(next);
      if (next === "card") window.setTimeout(() => rootRef.current?.focus({ preventScroll: true }), 0);
    },
    [rootRef],
  );
  const [picked, setPicked] = useState<number[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // A new card starts clean; a reply or snooze sheet belonged to the last one.
  const itemKey = active ? `${active.index}:${item?.threadId ?? ""}` : "";
  useEffect(() => {
    setPicked([]);
    setNotice(null);
    if (modeRef.current === "reply" || modeRef.current === "snooze") setMode("card");
  }, [itemKey, setMode]);
  // What's on screen is what you've seen; a refresh while you read says so.
  const shown = useRef<{ threadId: string; card: CardData } | null>(null);
  const threadId = thread?.id ?? null;
  const attentionAt = thread?.latestAttentionAt ?? 0;
  useEffect(() => {
    if (card === null || threadId === null) return;
    const before = shown.current;
    if (before?.threadId === threadId && before.card === card) return;
    shown.current = { threadId, card };
    if (before?.threadId === threadId) setNotice("Updated with new activity.");
    updateSession((current) => reseen(current, attentionAt));
  }, [attentionAt, card, threadId]);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, [rootRef]);

  const [strip, setStrip] = useState<Strip | null>(null);
  useEffect(() => {
    if (strip === null) return;
    const timer = window.setTimeout(() => setStrip(null), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [strip]);
  const say = useCallback((text: string, undoable = true, error = false) => setStrip({ id: Date.now(), text, undoable, error }), []);
  const fail = useCallback((cause: unknown) => say(errorText(cause), false, true), [say]);

  // An archive waits out the undo window: bb removes an archived thread's worktree.
  const pendingArchive = useRef<{ threadId: string; timer: number } | null>(null);
  const commitArchive = useCallback(() => {
    const due = pendingArchive.current;
    if (due === null) return;
    window.clearTimeout(due.timer);
    pendingArchive.current = null;
    rpc.call("archive", { threadIds: [due.threadId] }).catch(fail);
  }, [fail, rpc]);
  useEffect(() => () => commitArchive(), [commitArchive]);

  const title = thread?.displayTitle ?? "this thread";
  const act = (outcome: Outcome) => updateSession((current) => record(current, outcome, Date.now()));

  const done = () => {
    if (!item || !thread) return;
    if (thread.latestAttentionAt > item.seenAt) {
      updateSession((current) => reseen(current, thread.latestAttentionAt));
      setNotice("New activity since this card opened. Press → again to mark it read.");
      return;
    }
    act("done");
    say(`Marked “${short(title)}” read`);
    actions.setRead(thread.id, true).catch(fail);
  };
  const keep = () => {
    if (!item) return;
    act("kept");
    say(`Kept “${short(title)}” unread`);
  };
  const send = async (text: string) => {
    if (!thread || sending) return;
    const threadId = thread.id;
    setSending(true);
    try {
      await rpc.call("thread_reply", { threadId, text });
    } catch (cause) {
      setSending(false);
      say(`Couldn't send: ${errorText(cause)}`, false, true);
      return;
    }
    setSending(false);
    act("replied");
    say(`Sent “${short(text)}” to “${short(title)}”`, false);
    actions.setRead(threadId, true).catch(() => undefined);
  };
  const sendPick = () => {
    if (!steps) return;
    const text = goText(steps, picked);
    if (text === null) setNotice("Pick an option first (1–9).");
    else void send(text);
  };
  const snooze = async (when: string) => {
    if (!thread) return;
    const threadId = thread.id;
    let until: number;
    try {
      until = parseWhen(when);
    } catch (cause) {
      say(errorText(cause), false, true);
      return;
    }
    try {
      await rpc.call("snooze", { threadId, when, note: null, until });
    } catch (cause) {
      fail(cause);
      return;
    }
    act("snoozed");
    say(`Snoozed “${short(title)}” until ${formatWhen(until)}`);
    actions.setRead(threadId, true).catch(() => undefined);
  };
  const archive = () => {
    if (!thread) return;
    commitArchive();
    pendingArchive.current = { threadId: thread.id, timer: window.setTimeout(commitArchive, UNDO_MS) };
    act("archived");
    say(`Archived “${short(title)}”`);
  };
  const open = (split: boolean) => {
    if (!thread) return;
    const threadId = thread.id;
    act("opened");
    commitArchive();
    const go = () => navigate.toThread(threadId, split ? { split: true } : undefined);
    if (variant === "overlay") {
      onClose?.();
      // After the dialog unmounts and gives focus back, like the palette.
      window.setTimeout(go, 0);
    } else go();
  };
  const restore = (threadIds: string[], work: (threadId: string) => Promise<unknown>) => {
    for (const threadId of threadIds) restoring.current.add(threadId);
    void inChunks(threadIds, (threadId) =>
      work(threadId)
        .catch(fail)
        .finally(() => restoring.current.delete(threadId)),
    );
  };
  const takeBack = () => {
    if (!active) return;
    if (undoBlocked(active)) {
      say("A sent reply can't be undone.", false);
      return;
    }
    const result = undo(active, Date.now());
    if (result === null) return;
    setSession(result.session);
    setStrip(null);
    const { entry } = result;
    if (entry.kind === "bulk") {
      restore(entry.indices.map((index) => active.items[index]!.threadId), (threadId) => actions.setRead(threadId, false));
      return;
    }
    const threadId = active.items[entry.index]!.threadId;
    if (entry.outcome === "done") restore([threadId], (id) => actions.setRead(id, false));
    if (entry.outcome === "snoozed") restore([threadId], (id) => rpc.call("unsnooze", { threadId: id }).then(() => actions.setRead(id, false)));
    if (entry.outcome === "archived") {
      if (pendingArchive.current?.threadId === threadId) {
        window.clearTimeout(pendingArchive.current.timer);
        pendingArchive.current = null;
      } else restore([threadId], (id) => sdk.threads.unarchive({ threadId: id }));
    }
  };
  const readable = active ? bulkReadable(active) : [];
  const markAll = () => {
    if (!active) return;
    const threadIds = readable.map((entry) => entry.threadId);
    updateSession((current) => recordBulk(current, Date.now()));
    setMode("card");
    say(`Marked ${plural(threadIds.length, "update")} read`);
    void inChunks(threadIds, (threadId) => actions.setRead(threadId, true).catch(() => undefined));
  };
  const fresh = active ? freshIds(active, queue) : [];
  const pull = () => updateSession((current) => pullFresh(current, queue, Date.now()));

  const presets = useMemo(
    () =>
      SNOOZE_PRESETS.filter((preset) => {
        try {
          return parseWhen(preset.when) > now;
        } catch {
          return false;
        }
      }),
    [now],
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (event.key === "Escape") {
      if (mode !== "card") {
        event.preventDefault();
        event.stopPropagation();
        setMode("card");
      }
      return;
    }
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      takeBack();
      return;
    }
    if (mod && event.key === "Enter" && item) {
      event.preventDefault();
      open(true);
      return;
    }
    if (mod || event.altKey) return;
    // Enter on a focused button presses it.
    if (event.key === "Enter" && target.closest("button, a")) return;
    let handled = true;
    const key = event.key;
    if (mode === "snooze" && /^[1-9]$/.test(key)) {
      const preset = presets[Number(key) - 1];
      if (preset) void snooze(preset.when);
    } else if (mode === "confirm-all" && key === "Enter") {
      markAll();
    } else if (key === "z") {
      takeBack();
    } else if (key === "n") {
      pull();
    } else if (key === "?") {
      setMode(mode === "help" ? "card" : "help");
    } else if (item === null) {
      handled = false;
    } else if (key === "ArrowRight" || key === "d") {
      done();
    } else if (key === "ArrowLeft" || key === "u") {
      keep();
    } else if (key === "g") {
      sendPick();
    } else if (key === "r") {
      setMode("reply");
    } else if (key === "s") {
      setMode("snooze");
    } else if (key === "e") {
      archive();
    } else if (key === "o" || key === "Enter") {
      open(false);
    } else if (key === "O") {
      open(true);
    } else if (/^[1-9]$/.test(key) && steps) {
      setPicked((previous) => togglePick(steps, previous, Number(key)));
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const swipe = useSwipe({ enabled: item !== null && thread !== null && mode === "card", onDone: done, onKeep: keep, onLongPress: () => setMode("snooze") });

  const position = active ? progress(active) : null;
  const projectName = (projectId: string) => projects.find((project) => project.id === projectId);
  const working = stillWorking(threads, flow, include);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="jf-catchup"
      data-variant={variant}
      onKeyDown={onKeyDown}
      aria-label="Catch up"
    >
      <header className="jf-catchup-bar">
        <div className="jf-catchup-heading">
          <Icon name="MailOpen" className="size-4" />
          <span className="jf-catchup-name">Catch up</span>
          {position && position.of > 0 && item ? (
            <span className="jf-catchup-count" aria-live="polite">
              {position.at} of {position.of}
            </span>
          ) : null}
          {resumedWith !== null && item ? <span className="jf-catchup-resumed">Resuming · {resumedWith} left</span> : null}
        </div>
        <div className="jf-catchup-tools">
          {fresh.length > 0 ? (
            <button type="button" className="jf-catchup-pill" onClick={pull} title="Add them at the end (N)">
              {fresh.length} new
            </button>
          ) : null}
          {workspacesOn && selected !== null ? (
            <button
              type="button"
              className="jf-catchup-chip"
              aria-pressed={everywhere}
              title={everywhere ? `Only ${workspaceName ?? "this workspace"}` : "Include every workspace"}
              onClick={() => setEverywhere((value) => !value)}
            >
              {everywhere ? "All workspaces" : (workspaceName ?? "This workspace")}
            </button>
          ) : null}
          {readable.length > 0 && item ? (
            <button type="button" className="jf-catchup-tool" onClick={() => setMode(mode === "confirm-all" ? "card" : "confirm-all")}>
              Mark all read
            </button>
          ) : null}
          <button type="button" className="jf-catchup-icon" aria-label="Keyboard shortcuts" title="Keys (?)" onClick={() => setMode(mode === "help" ? "card" : "help")}>
            ?
          </button>
          {variant === "overlay" ? (
            <button type="button" className="jf-catchup-icon" aria-label="Close" title="Close (Esc)" onClick={onClose}>
              <Icon name="X" className="size-4" />
            </button>
          ) : null}
        </div>
        {position && position.of > 0 ? (
          <div className="jf-catchup-progress" aria-hidden="true">
            <span style={{ width: `${(position.handled / position.of) * 100}%` }} />
          </div>
        ) : null}
      </header>

      {mode === "confirm-all" && active ? (
        <div className="jf-catchup-confirm" role="alertdialog" aria-label="Mark all read">
          <span>
            Mark {plural(readable.length, "update")} read?{staysLine(pendingNeedsYou(active))}
          </span>
          <button type="button" className="jf-catchup-primary" onClick={markAll}>
            Mark read <kbd>↵</kbd>
          </button>
          <button type="button" className="jf-catchup-tool" onClick={() => setMode("card")}>
            Cancel
          </button>
        </div>
      ) : null}

      <div className="jf-catchup-stage">
        {!ready || active === null ? (
          <p className="jf-catchup-empty">Loading…</p>
        ) : active.items.length === 0 ? (
          <div className="jf-catchup-end">
            <Icon name="Check" className="jf-catchup-end-icon" />
            <p className="jf-catchup-end-title">Nothing unread</p>
            <p className="jf-catchup-end-detail">
              {working > 0 ? `${plural(working, "thread")} still working; they'll be here when they finish.` : "You're all caught up."}
            </p>
          </div>
        ) : item === null ? (
          <EndScreen
            session={active}
            working={working}
            fresh={fresh.length}
            onKept={() => updateSession((current) => requeueKept(current, Date.now()))}
            onFresh={pull}
            onClose={variant === "overlay" ? onClose : undefined}
          />
        ) : thread === null ? (
          <div className="jf-catchup-end">
            <p className="jf-catchup-end-title">This thread is gone</p>
            <button type="button" className="jf-catchup-primary" onClick={() => act("elsewhere")}>
              Next
            </button>
          </div>
        ) : (
          <CardView
            key={`${active.index}:${thread.id}`}
            thread={thread}
            item={item}
            card={card}
            failed={failed}
            flow={flow}
            now={now}
            steps={steps}
            picked={picked}
            onPick={(n) => setPicked((previous) => (steps ? togglePick(steps, previous, n) : previous))}
            onSend={sendPick}
            sending={sending}
            project={projectName(thread.projectId)?.name ?? null}
            notice={notice}
            swipe={swipe}
            next={ahead[0] ? (liveById.get(ahead[0].threadId)?.displayTitle ?? null) : null}
          />
        )}
      </div>

      {item && thread && mode === "reply" ? (
        <ReplyBox
          title={title}
          sending={sending}
          onCancel={() => setMode("card")}
          onSend={(text) => void send(text)}
        />
      ) : null}
      {item && thread && mode === "snooze" ? (
        <div className="jf-catchup-sheet" role="group" aria-label="Snooze until">
          <span className="jf-catchup-sheet-label">Snooze until</span>
          <div className="jf-catchup-presets">
            {presets.map((preset, index) => (
              <button key={preset.when} type="button" className="jf-catchup-tool" onClick={() => void snooze(preset.when)}>
                <kbd>{index + 1}</kbd> {preset.label}
              </button>
            ))}
          </div>
          <form
            className="jf-catchup-custom"
            onSubmit={(event) => {
              event.preventDefault();
              const value = new FormData(event.currentTarget).get("when");
              if (typeof value === "string" && value.trim() !== "") void snooze(value.trim());
            }}
          >
            <input name="when" placeholder="3d, fri, 2026-10-12…" aria-label="Custom snooze time" />
            <button type="submit" className="jf-catchup-tool">
              Snooze
            </button>
          </form>
        </div>
      ) : null}
      {mode === "help" ? <KeyHelp /> : null}

      {item && thread ? (
        <footer className="jf-catchup-actions">
          <button type="button" className="jf-catchup-action" onClick={keep} title="Keep unread and go on (← or U)">
            <kbd>←</kbd> Keep unread
          </button>
          <span className="jf-catchup-actions-middle">
            <button type="button" className="jf-catchup-action" onClick={() => setMode(mode === "snooze" ? "card" : "snooze")} title="Snooze (S, or long-press)">
              <kbd>S</kbd> Snooze
            </button>
            <button type="button" className="jf-catchup-action" onClick={archive} title="Archive (E)">
              <kbd>E</kbd> Archive
            </button>
            <button type="button" className="jf-catchup-action" onClick={() => setMode(mode === "reply" ? "card" : "reply")} title="Reply (R)">
              <kbd>R</kbd> Reply
            </button>
            <button type="button" className="jf-catchup-action" onClick={() => open(false)} title="Open the thread (O; ⇧O in a split)">
              <kbd>O</kbd> Open
            </button>
          </span>
          <button type="button" className="jf-catchup-action jf-catchup-done" onClick={done} title="Mark read and go on (→ or D)">
            Done <kbd>→</kbd>
          </button>
        </footer>
      ) : null}

      {strip ? (
        <div className={cn("jf-catchup-strip", strip.error && "jf-catchup-strip-error")} role="status" key={strip.id}>
          <span>{strip.text}</span>
          {strip.undoable && !strip.error ? (
            <button type="button" onClick={takeBack}>
              Undo <kbd>Z</kbd>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const staysLine = (count: number) =>
  count === 0 ? "" : count === 1 ? " The thread that needs you stays." : ` The ${count} that need you stay.`;
const pendingNeedsYou = (active: Session) => active.items.filter((entry) => entry.outcome === null && needsYou(entry.tier)).length;

async function inChunks(ids: readonly string[], run: (id: string) => Promise<unknown>) {
  for (let index = 0; index < ids.length; index += 8) await Promise.allSettled(ids.slice(index, index + 8).map(run));
}

// --- one card ------------------------------------------------------------------------

function sinceLine(item: CatchUpItem, since: Since | undefined, now: number): string {
  if (item.since === null) return "New: you haven't opened this thread yet";
  const head = `Since you looked ${ago(item.since, now)}`;
  if (since === undefined) return head;
  const parts: string[] = [];
  const more = since.more ? "+" : "";
  if (since.turns > 0) parts.push(`${since.turns}${more} turn${since.turns === 1 && !more ? "" : "s"}`);
  if (since.yourPrompts > 0) parts.push(`${plural(since.yourPrompts, "prompt")} from you`);
  if (since.otherPrompts > 0) parts.push(`${since.otherPrompts} automated`);
  return parts.length > 0 ? `${head}: ${parts.join(" · ")}` : head;
}

function CardView({
  thread,
  item,
  card,
  failed,
  flow,
  now,
  steps,
  picked,
  onPick,
  onSend,
  sending,
  project,
  notice,
  swipe,
  next,
}: {
  thread: PluginSidebarThread;
  item: CatchUpItem;
  card: CardData | null;
  failed: boolean;
  flow: FlowState | null;
  now: number;
  steps: Steps | null;
  picked: readonly number[];
  onPick: (n: number) => void;
  onSend: () => void;
  sending: boolean;
  project: string | null;
  notice: string | null;
  swipe: Swipe;
  next: string | null;
}) {
  const { pullRequest } = useSidebarThreadPullRequest(thread.id);
  const prs = threadPrs(flow?.threadPrs[thread.id], pullRequest);
  const busy = thread.status === "active" || thread.status === "starting";
  const status = rowStatus(thread, busy, flow?.watching[thread.id], prs, runInfo(flow?.running[thread.id], now));
  const since = item.since;
  const merged = (flow?.threadPrs[thread.id] ?? []).filter((pr) => since !== null && (pr.mergedAt ?? 0) > since);
  const [expanded, setExpanded] = useState(false);
  const report = card?.report ?? null;
  const reportFields = report
    ? ([
        ["Goal", report.goal],
        ["Done", report.done],
        ["Next", report.next],
        ["Blocked", report.blocked],
      ] as const).filter(([, value]) => value)
    : [];
  const sendLabel = steps ? goText(steps, picked) : null;
  return (
    <article
      className="jf-catchup-card"
      data-tier={item.tier}
      style={swipe.style}
      data-swiping={swipe.dx !== 0 || undefined}
      {...swipe.handlers}
    >
      {swipe.dx !== 0 ? (
        <span className="jf-catchup-swipe-hint" data-side={swipe.dx > 0 ? "done" : "kept"} aria-hidden="true">
          {swipe.dx > 0 ? "Read" : "Keep unread"}
        </span>
      ) : null}
      <header className="jf-catchup-card-head">
        <StatusIcon status={status} />
        <div className="jf-catchup-titles">
          <div className="jf-catchup-meta">
            <span className={cn("jf-catchup-tier", needsYou(item.tier) && "jf-catchup-tier-needs")}>{TIER_LABEL[item.tier]}</span>
            {project ? <span>{project}</span> : null}
            <span>{ago(thread.latestAttentionAt, now)}</span>
          </div>
          <h2 className="jf-catchup-title">{thread.displayTitle}</h2>
        </div>
      </header>
      <p className="jf-catchup-since">
        {sinceLine(item, card?.since, now)}
        {merged.length > 0 ? ` · ${merged.map((pr) => `#${pr.number} merged`).join(" · ")}` : ""}
      </p>
      {notice ? (
        <p className="jf-catchup-notice" role="status">
          {notice}
        </p>
      ) : null}
      {item.tier === 0 ? (
        <p className="jf-catchup-callout">
          {thread.indicatorLabel ?? "Waiting for your answer"}. Press <kbd>O</kbd> to answer in the thread.
        </p>
      ) : item.tier === 1 ? (
        <p className="jf-catchup-callout jf-catchup-callout-error">{thread.indicatorLabel ?? "The last turn failed"}. Open the thread to retry.</p>
      ) : null}

      <div className="jf-catchup-body">
        {card === null ? (
          failed ? (
            <p className="jf-catchup-muted">Couldn't load the latest reply. Open the thread to read it.</p>
          ) : (
            <div className="jf-catchup-skeleton" aria-label="Loading" />
          )
        ) : (
          <>
            {reportFields.length > 0 ? (
              <dl className="jf-catchup-report">
                {reportFields.map(([label, value]) => (
                  <div key={label} data-field={label.toLowerCase()}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {report?.doingNow ? <p className="jf-catchup-muted">Doing now: {report.doingNow}</p> : null}
            {steps ? (
              <div className="jf-catchup-steps" data-mode={steps.mode}>
                {steps.question ? <p className="jf-catchup-steps-question">{steps.question}</p> : null}
                <ol>
                  {steps.items.map((step) => (
                    <li key={step.n}>
                      <button type="button" aria-pressed={picked.includes(step.n)} onClick={() => onPick(step.n)}>
                        <kbd>{step.n}</kbd>
                        <span className="jf-catchup-step-text">{step.text}</span>
                        {step.recommended ? <span className="jf-catchup-step-tag">recommended</span> : null}
                      </button>
                    </li>
                  ))}
                </ol>
                <div className="jf-catchup-steps-send">
                  <button type="button" className="jf-catchup-primary" disabled={sendLabel === null || sending} onClick={onSend}>
                    {sending
                      ? "Sending…"
                      : steps.mode === "go"
                        ? picked.length
                          ? `Go with ${picked.join(", ")}`
                          : "Go"
                        : picked.length
                          ? `Send ${picked[0]}`
                          : "Pick one"}{" "}
                    <kbd>G</kbd>
                  </button>
                </div>
              </div>
            ) : null}
            {card.reply.trim() !== "" ? (
              report ? (
                <details className="jf-catchup-full" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
                  <summary>Full reply</summary>
                  <Markdown content={card.reply} className="jf-catchup-markdown" />
                </details>
              ) : (
                <div className={cn("jf-catchup-reply", expanded && "jf-catchup-reply-open")}>
                  <Markdown content={card.reply} className="jf-catchup-markdown" />
                  {!expanded ? (
                    <button type="button" className="jf-catchup-more" onClick={() => setExpanded(true)}>
                      Show more
                    </button>
                  ) : null}
                </div>
              )
            ) : report === null ? (
              <p className="jf-catchup-muted">No reply yet.</p>
            ) : null}
            {card.truncated ? <p className="jf-catchup-muted">The reply is longer; open the thread for the rest.</p> : null}
          </>
        )}
      </div>

      {prs.length > 0 ? (
        <div className="jf-catchup-prs">
          <PrList prs={prs} compact />
        </div>
      ) : null}
      {next ? <p className="jf-catchup-next">Next: {next}</p> : null}
    </article>
  );
}

function ReplyBox({ title, sending, onCancel, onSend }: { title: string; sending: boolean; onCancel: () => void; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const submit = () => {
    if (text.trim() !== "") onSend(text.trim());
  };
  return (
    <form
      className="jf-catchup-sheet jf-catchup-replybox"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={ref}
        value={text}
        maxLength={2000}
        rows={3}
        placeholder={`Reply to “${short(title)}”…`}
        aria-label="Reply"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="jf-catchup-replybox-actions">
        <span className="jf-catchup-muted">
          <kbd>↵</kbd> send · <kbd>⇧↵</kbd> new line · <kbd>esc</kbd> cancel
        </span>
        <button type="button" className="jf-catchup-tool" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="jf-catchup-primary" disabled={sending || text.trim() === ""}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}

function EndScreen({
  session: done,
  working,
  fresh,
  onKept,
  onFresh,
  onClose,
}: {
  session: Session;
  working: number;
  fresh: number;
  onKept: () => void;
  onFresh: () => void;
  onClose?: () => void;
}) {
  const counts = summary(done);
  const parts = (
    [
      ["read", counts.done],
      ["replied", counts.replied],
      ["kept unread", counts.kept],
      ["snoozed", counts.snoozed],
      ["archived", counts.archived],
      ["opened", counts.opened],
      ["read elsewhere", counts.elsewhere],
    ] as const
  ).filter(([, count]) => count > 0);
  return (
    <div className="jf-catchup-end">
      <Icon name="Check" className="jf-catchup-end-icon" />
      <p className="jf-catchup-end-title">You're all caught up</p>
      {parts.length > 0 ? <p className="jf-catchup-end-detail">{parts.map(([label, count]) => `${count} ${label}`).join(" · ")}</p> : null}
      {working > 0 ? <p className="jf-catchup-muted">{plural(working, "thread")} still working; they'll join when they finish.</p> : null}
      <div className="jf-catchup-end-actions">
        {fresh > 0 ? (
          <button type="button" className="jf-catchup-primary" onClick={onFresh}>
            Catch up on {fresh} new
          </button>
        ) : null}
        {counts.kept > 0 ? (
          <button type="button" className="jf-catchup-tool" onClick={onKept}>
            Go through the {counts.kept} you kept unread
          </button>
        ) : null}
        {onClose ? (
          <button type="button" className="jf-catchup-tool" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>
    </div>
  );
}

const KEYS: ReadonlyArray<[string, string]> = [
  ["→  D", "Done: mark read, next"],
  ["←  U", "Keep unread, next"],
  ["1–9", "Pick next steps or an option"],
  ["G", "Send the pick (go, go 1,3, or the option)"],
  ["R", "Reply"],
  ["S", "Snooze (or long-press a card)"],
  ["E", "Archive"],
  ["O  ↵", "Open the thread (⇧O or ⌘↵ in a split)"],
  ["Z", "Undo"],
  ["N", "Add new arrivals"],
  ["Esc", "Back, then close"],
];

function KeyHelp() {
  return (
    <div className="jf-catchup-sheet jf-catchup-help" role="note" aria-label="Keyboard shortcuts">
      <dl>
        {KEYS.map(([keys, label]) => (
          <div key={keys}>
            <dt>
              <kbd>{keys}</kbd>
            </dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
      <p className="jf-catchup-muted">On touch screens, swipe right for Done and left to keep unread.</p>
    </div>
  );
}

// --- swipe ---------------------------------------------------------------------------

type Swipe = {
  dx: number;
  style: CSSProperties | undefined;
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: () => void;
  };
};

/** Touch and pen only: the mouse keeps selecting text. Long-press opens snooze. */
function useSwipe({ enabled, onDone, onKeep, onLongPress }: { enabled: boolean; onDone: () => void; onKeep: () => void; onLongPress: () => void }): Swipe {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; at: number; width: number; horizontal: boolean | null; pressed: number | null } | null>(null);
  const latest = useRef({ onDone, onKeep, onLongPress });
  latest.current = { onDone, onKeep, onLongPress };
  const reset = useCallback(() => {
    if (start.current?.pressed != null) window.clearTimeout(start.current.pressed);
    start.current = null;
    setDx(0);
  }, []);
  useEffect(() => reset, [reset]);
  return {
    dx,
    style: dx === 0 ? undefined : { transform: `translateX(${dx}px) rotate(${(dx / 40).toFixed(2)}deg)` },
    handlers: {
      onPointerDown: (event) => {
        if (!enabled || event.pointerType === "mouse") return;
        if ((event.target as HTMLElement).closest("button, a, input, textarea, summary")) return;
        const pressed = window.setTimeout(() => {
          if (start.current && start.current.horizontal === null) {
            reset();
            navigator.vibrate?.(10);
            latest.current.onLongPress();
          }
        }, 500);
        start.current = { x: event.clientX, y: event.clientY, at: event.timeStamp, width: event.currentTarget.clientWidth, horizontal: null, pressed };
      },
      onPointerMove: (event) => {
        const begun = start.current;
        if (begun === null) return;
        const moveX = event.clientX - begun.x;
        const moveY = event.clientY - begun.y;
        if (begun.horizontal === null && Math.hypot(moveX, moveY) > 8) {
          begun.horizontal = Math.abs(moveX) > Math.abs(moveY);
          if (begun.pressed !== null) window.clearTimeout(begun.pressed);
          begun.pressed = null;
          if (!begun.horizontal) {
            // A vertical drag scrolls the reply instead.
            start.current = null;
            return;
          }
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }
        if (begun.horizontal) setDx(moveX);
      },
      onPointerUp: (event) => {
        const begun = start.current;
        if (begun === null) return;
        const moveX = event.clientX - begun.x;
        const velocity = moveX / Math.max(1, event.timeStamp - begun.at);
        const outcome = begun.horizontal ? swipeOutcome(moveX, begun.width, velocity) : null;
        reset();
        if (outcome === "done") latest.current.onDone();
        if (outcome === "kept") latest.current.onKeep();
      },
      onPointerCancel: reset,
    },
  };
}
