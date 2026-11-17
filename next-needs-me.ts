// "Open the next thread that needs me", optionally archiving the one you're on
// (Alt+Shift+E, the palette). The bb calls are passed in so it can be tested
// without the whole server; server.ts wires it to the next_needs_me rpc.

export type NextNeedsMeDeps = {
  /** The thread after `current` in the Now / needs-me order, never `skip`. */
  nextThread: (current: string | null, skip: string | null) => Promise<string | null>;
  focusedThreadId: () => string | null;
  getThread: (threadId: string) => Promise<{ pinnedAt: number | null }>;
  archive: (threadId: string) => Promise<unknown>;
  open: (threadId: string) => Promise<unknown>;
};

export async function nextNeedsMe(archiveThreadId: string | null, deps: NextNeedsMeDeps): Promise<{ opened: string | null }> {
  // Worked out before archiving: the archived thread's place says where "next" is.
  const nextId = await deps.nextThread(archiveThreadId ?? deps.focusedThreadId(), archiveThreadId);
  // Pinned threads are kept on purpose: a shortcut moves on from them but never archives them.
  const pinned = archiveThreadId !== null && (await deps.getThread(archiveThreadId).catch(() => null))?.pinnedAt;
  if (archiveThreadId !== null && !pinned) await deps.archive(archiveThreadId);
  if (nextId === null) return { opened: null };
  await deps.open(nextId);
  return { opened: nextId };
}
