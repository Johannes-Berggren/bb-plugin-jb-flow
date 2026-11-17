// Telling the windows and the Stream Deck that something changed: changed()
// publishes one realtime signal per burst of store writes, and bumps the
// version that `bb jb-flow deck --wait` long-polls on.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const CHANGED = "jb-flow-changed";

export function createChanges(bb: BbPluginApi) {
  // One thread event can change several stores within milliseconds; publish
  // once after they settle so every window refetches once, not four times.
  // Async work can finish after a reload disposed this instance; publishing on
  // the stale handle throws inside a timer, which takes the whole BB server down.
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  function changed() {
    if (disposed) return;
    bumpDeck();
    if (publishTimer !== null) return;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      if (disposed) return;
      try {
        bb.realtime.publish(CHANGED, {});
      } catch (error) {
        bb.log.warn(`publish failed: ${String(error)}`);
      }
    }, 250);
  }
  bb.onDispose(() => {
    disposed = true;
    if (publishTimer !== null) clearTimeout(publishTimer);
  });

  // The Stream Deck long-polls `deck --wait <version>`: the call returns as soon
  // as something it shows may have changed (focus, a thread starting/stopping,
  // plugin state), so switching threads updates the keys at once.
  let deckVersion = 0;
  const deckWaiters = new Set<() => void>();
  function bumpDeck() {
    deckVersion += 1;
    for (const wake of deckWaiters) wake();
    deckWaiters.clear();
  }
  function waitForDeckChange(version: number, timeoutMs: number): Promise<void> {
    if (version !== deckVersion) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        deckWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      deckWaiters.add(done);
    });
  }
  bb.onDispose(() => {
    for (const wake of deckWaiters) wake();
  });

  return { changed, bumpDeck, waitForDeckChange, deckVersion: () => deckVersion };
}
