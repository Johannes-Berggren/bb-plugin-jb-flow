// The sidebar thread actions jb-flow's own list and menus use. BB's SDK 0.6
// dropped `experimental_useSidebarThreadActions`; this rebuilds the same shape
// from the public navigate API and the thread SDK.
import { useMemo } from "react";
import { useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";

export function useSidebarThreadActions() {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  return useMemo(
    () => ({
      open(threadId: string, options?: { split?: boolean }) {
        navigate.toThread(threadId, options);
      },
      openNewThread(options: { projectId?: string; sectionId?: string; focusPrompt?: boolean } = {}) {
        navigate.toCompose({
          projectId: options.projectId,
          focusPrompt: options.focusPrompt,
          placement: options.sectionId === undefined ? undefined : { sectionId: options.sectionId, pinned: false },
        });
      },
      async setPinned(threadId: string, pinned: boolean) {
        await (pinned ? sdk.threads.pin({ threadId }) : sdk.threads.unpin({ threadId }));
      },
      async setRead(threadId: string, read: boolean) {
        await (read ? sdk.threads.markRead({ threadId }) : sdk.threads.markUnread({ threadId }));
      },
      async rename(threadId: string, title: string) {
        await sdk.threads.update({ threadId, title });
      },
      archive(threadId: string) {
        void sdk.threads.archive({ threadId });
      },
      requestDelete(threadId: string) {
        if (window.confirm("Delete this thread and its child threads? This can't be undone.")) {
          void sdk.threads.delete({ threadId, childThreadsConfirmed: true });
        }
      },
    }),
    [sdk, navigate],
  );
}
