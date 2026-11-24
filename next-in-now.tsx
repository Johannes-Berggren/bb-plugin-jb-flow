import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { experimental_useSidebarThreads as useSidebarThreads, useBbNavigate, useComposer, useSettings } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { useFlowState } from "./flow-state";
import { nextAfter, nowQueue, sidebarNowThread } from "./now-model";
import { sortRows } from "./sidebar-groups";
import { forest, inRowOrder } from "./subthreads";
import { useNow } from "./ui-extras";
import { useSelectedWorkspace, useWorkspaces } from "./workspace-client";
import { inWorkspace } from "./workspaces";

const CHOICE_SENT = "jb-flow:reply-choice-sent";

/** Numbered choices send directly through the thread RPC, outside the native composer. */
export function notifyReplyChoiceSent(threadId: string) {
  window.dispatchEvent(new CustomEvent(CHOICE_SENT, { detail: threadId }));
}

export function NextInNowBanner() {
  const { scope } = useComposer();
  const { values } = useSettings();
  const selected = useSelectedWorkspace();
  const workspaceId = values?.workspaces === true ? selected : null;
  if (scope.kind !== "thread" || values?.nowQueue !== true) return null;
  return <Continuation key={JSON.stringify([scope.threadId, workspaceId])}
    threadId={scope.threadId} workspaceId={workspaceId} byCreation={values.createdRowOrder === true} />;
}

function Continuation({ threadId, workspaceId, byCreation }: { threadId: string; workspaceId: string | null; byCreation: boolean }) {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const { threads, status } = useSidebarThreads();
  const { state } = useFlowState();
  const workspaces = useWorkspaces();
  const now = useNow(60_000);
  const [submittedAt, setSubmittedAt] = useState<number | null>(null);
  useEffect(() => {
    const sent = () => setSubmittedAt(Date.now());
    const choice = (event: Event) => {
      if ((event as CustomEvent<unknown>).detail === threadId) sent();
    };
    const unsubscribe = composer.onSubmitted(sent);
    window.addEventListener(CHOICE_SENT, choice);
    return () => {
      unsubscribe();
      window.removeEventListener(CHOICE_SENT, choice);
    };
  }, [composer, threadId]);

  // Preserve this thread's queue position when reading or answering it removes its ask.
  const previous = useRef<readonly string[]>([]);
  const order = useMemo(() => {
    if (!state || status !== "ready" || (workspaceId !== null && !workspaces.ready)) return null;
    const live = threads.filter((thread) => !thread.isArchived && !thread.isHidden &&
      inWorkspace(thread, workspaceId, workspaces.state, threads));
    const { trees, members } = forest(sortRows(live, byCreation));
    const candidates = members.filter(({ row }) => !row.isPinned).map(({ thread, row }) =>
      sidebarNowThread(thread, state.snoozedSectionId !== null && row.sectionId === state.snoozedSectionId));
    const queue = nowQueue(candidates, state, { now, openThreadId: threadId, previous: previous.current });
    const ranked = queue.now.map((entry) => entry.thread.id);
    return { ranked, ordered: inRowOrder(ranked, trees) };
  }, [threads, state, status, workspaceId, workspaces.ready, workspaces.state, byCreation, now, threadId]);
  useLayoutEffect(() => {
    if (order) previous.current = order.ranked;
  }, [order]);

  const current = threads.find((thread) => thread.id === threadId);
  const askedAgain = submittedAt !== null && !!current && (
    ((current.latestAttentionAt ?? 0) > submittedAt && sidebarNowThread(current, false).blocked !== null) ||
    (state?.awaiting[threadId] ?? 0) > submittedAt
  );
  useEffect(() => {
    if (askedAgain) setSubmittedAt(null);
  }, [askedAgain]);

  if (submittedAt === null || order === null || !current || askedAgain) return null;
  const nextId = nextAfter(order.ordered, threadId);
  const target = nextId && threads.find((thread) => thread.id === nextId);
  const title = target ? target.displayTitle || target.title || target.titleFallback || "Untitled thread" : "";
  return (
    <div className="jf-next-in-now" aria-label="Now queue" role="region">
      <div className="jf-next-result" aria-live="polite">
        {target ? (
          <button type="button" className="jf-next-target" aria-label={`Next in Now: ${title}`} title={title} onClick={() => navigate.toThread(target.id)}>
            <span>Next in Now</span>
            <strong>{title}</strong>
            <Icon name="ArrowRight" className="size-3.5" />
          </button>
        ) : <span>You’re all caught up.</span>}
      </div>
      <button type="button" className="jf-next-dismiss" aria-label="Dismiss Now queue" onClick={() => setSubmittedAt(null)}>
        <Icon name="X" className="size-3.5" />
      </button>
    </div>
  );
}
