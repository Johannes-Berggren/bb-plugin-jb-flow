import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useRpc,
  useSettings,
  useSidebarSplitLayout,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { MAX_PANES, OPEN_QUEUE_EVENT, queuePicks, STATUS_PANES_EVENT } from "./pane-commands-model";
import { paneOrder, paneState } from "./pane-strip-model";
import { STATUS_AGE_LABEL, statusAge, type StatusAge } from "./status-age";
import { statusPrompt } from "./status-prompt";
import "./pane-commands.css";

/** For the commands' availability checks, which run outside React. */
export const paneCommands = { statusAvailable: false };

const errorText = (cause: unknown) => (cause instanceof Error && cause.message ? cause.message : String(cause)).slice(0, 200);
/** Long enough for BB to place one pane before the next is asked for. */
const BETWEEN_PANES_MS = 60;
const pause = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export function PaneCommandsHost() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const split = useSidebarSplitLayout();
  const { threadId: routeThreadId } = useBbContext();
  const threadMonitor = useSettings().values?.threadMonitor === true;
  const [statusOpen, setStatusOpen] = useState(false);
  // The events arrive from outside React: they read the latest layout from here.
  const live = useRef({ rpc, navigate, split, routeThreadId });
  live.current = { rpc, navigate, split, routeThreadId };
  useEffect(() => {
    paneCommands.statusAvailable = threadMonitor;
    return () => {
      paneCommands.statusAvailable = false;
    };
  }, [threadMonitor]);
  useEffect(() => {
    let busy = false;
    const openQueue = async () => {
      if (busy) return;
      busy = true;
      try {
        const { threadIds } = await live.current.rpc.call("needs_me_queue", null);
        const { split: layout, routeThreadId: current } = live.current;
        const open = layout ? layout.panes.map((pane) => pane.threadId) : [current];
        const paneCount = layout?.panes.length ?? 1;
        const picks = queuePicks(threadIds, open, paneCount);
        if (picks.length === 0) {
          const waiting = threadIds.filter((id) => !open.includes(id)).length;
          toast(waiting > 0 ? `The split is full: BB opens at most ${MAX_PANES} panes.` : threadIds.length > 0 ? "Everything that needs you is already open." : "Nothing needs you right now.");
          return;
        }
        for (const [index, threadId] of picks.entries()) {
          live.current.navigate.toThread(threadId, { split: true });
          await pause(BETWEEN_PANES_MS);
          // Splits are off (a narrow window, or the setting): the first thread is open, and that is all it can do.
          if (index === 0 && paneCount === 1 && live.current.split === null) return;
        }
        // End on the most urgent one; the scrolling split brings it into view.
        if (picks.length > 1) live.current.navigate.toThread(picks[0]!, { split: true });
      } catch (cause) {
        toast.error(`Could not open the queue: ${errorText(cause)}`);
      } finally {
        busy = false;
      }
    };
    const onOpenQueue = () => void openQueue();
    const onStatus = () => setStatusOpen(true);
    window.addEventListener(OPEN_QUEUE_EVENT, onOpenQueue);
    window.addEventListener(STATUS_PANES_EVENT, onStatus);
    return () => {
      window.removeEventListener(OPEN_QUEUE_EVENT, onOpenQueue);
      window.removeEventListener(STATUS_PANES_EVENT, onStatus);
    };
  }, []);
  return statusOpen && threadMonitor ? <StatusPanesDialog onClose={() => setStatusOpen(false)} /> : null;
}

type Outdated = { threadId: string; title: string; age: Exclude<StatusAge, null> };

/**
 * Lists the open panes whose status report is out of date and, on confirm,
 * sends each the status prompt. It messages threads and uses the agent's
 * quota, so nothing is sent before the button is pressed.
 */
function StatusPanesDialog({ onClose }: { onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const settings = useSettings().values;
  const split = useSidebarSplitLayout();
  const { threadId: routeThreadId } = useBbContext();
  const { threads } = useSidebarThreads();
  const [outdated, setOutdated] = useState<Outdated[] | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Checked once, for the panes as they are when the dialog opens.
  const opened = useRef({ split, routeThreadId, threads });
  useEffect(() => {
    let disposed = false;
    const { split: layout, routeThreadId: current, threads: known } = opened.current;
    const byId = new Map(known.map((thread) => [thread.id, thread]));
    const ids = layout ? paneOrder(layout.panes).map((pane) => pane.threadId) : [current];
    // Only a thread at rest is asked: not one that is working, stopped on an error or waiting on an answer.
    const resting = [...new Set(ids)].flatMap((id) => {
      const thread = id === null ? undefined : byId.get(id);
      return thread && ["idle", "unread"].includes(paneState(thread)) ? [thread] : [];
    });
    void Promise.all(
      resting.map(async (thread): Promise<Outdated | null> => {
        const status = await rpc.call("thread_status", { threadId: thread.id, refresh: true }).catch(() => undefined);
        // A status that can't be read is left alone rather than guessed at.
        const age = status === undefined ? null : statusAge(status, Date.now());
        return age === null ? null : { threadId: thread.id, title: thread.displayTitle, age };
      }),
    ).then((checked) => {
      if (!disposed) setOutdated(checked.filter((entry): entry is Outdated => entry !== null));
    });
    return () => {
      disposed = true;
    };
  }, [rpc]);
  const count = outdated?.length ?? 0;
  const send = async () => {
    if (!outdated) return;
    setSending(true);
    setError(null);
    const text = statusPrompt(settings?.statusPrompt, settings?.nowQueue === true);
    const failed: Outdated[] = [];
    for (const entry of outdated) {
      await rpc.call("thread_reply", { threadId: entry.threadId, text }).catch(() => failed.push(entry));
    }
    setSending(false);
    const asked = outdated.length - failed.length;
    if (failed.length === 0) {
      toast.success(`Asked ${asked} thread${asked === 1 ? "" : "s"} for a status update.`);
      onClose();
      return;
    }
    // Keep the ones that failed, so the button retries only those.
    setOutdated(failed);
    setError(`${asked > 0 ? `Asked ${asked}. ` : ""}Could not reach ${failed.length} thread${failed.length === 1 ? "" : "s"}. Try again.`);
  };
  return (
    <Dialog open onOpenChange={(open) => (open || sending ? undefined : onClose())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Update status in open panes</DialogTitle>
          <DialogDescription>
            {outdated === null
              ? "Checking the open panes…"
              : count === 0
                ? "Every open pane that is at rest has a current status report."
                : `${count} open pane${count === 1 ? " has" : "s have"} a status report that is out of date. Asking sends each thread the status prompt, and each reply uses your agent's quota.`}
          </DialogDescription>
        </DialogHeader>
        {count > 0 ? (
          <ul className="jf-status-panes" aria-label="Threads to ask">
            {outdated!.map((entry) => (
              <li key={entry.threadId}>
                <span className="jf-status-panes-title">{entry.title}</span>
                <span className="jf-status-panes-reason">{STATUS_AGE_LABEL[entry.age]}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="jf-status-panes-error">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={sending} onClick={onClose}>
            {count === 0 ? "Close" : "Cancel"}
          </Button>
          {count > 0 ? (
            <Button size="sm" disabled={sending} onClick={() => void send()}>
              {sending ? "Asking…" : `Ask ${count} thread${count === 1 ? "" : "s"}`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
