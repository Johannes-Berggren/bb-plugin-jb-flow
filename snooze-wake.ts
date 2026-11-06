// Waking snoozed threads, apart from bb so it can be tested. A due thread comes
// back first, so a send that fails can't leave it hidden, and its note is then
// tried until it's sent. `wakeStarted` is what tells a thread that left Snoozed
// because of this wake from one you moved by hand, whose snooze no longer applies.

/** Attempts before an unsendable note is given up on (about half an hour of 1-minute checks). */
export const MAX_NOTE_FAILURES = 30;

export type SnoozeRecord = {
  until: number;
  note: string | null;
  snoozedAt: number;
  wakeStarted?: boolean | undefined;
  noteFailures?: number | undefined;
};

export type WakeDeps<R extends SnoozeRecord> = {
  now: () => number;
  snoozedSectionId: string | null;
  getThread: (threadId: string) => Promise<{ sectionId: string | null; archivedAt: number | null }>;
  isGoneError: (error: unknown) => boolean;
  /** Stores that the wake has begun, before the thread leaves Snoozed. */
  markStarted: (threadId: string, record: R) => Promise<void>;
  /** Moves the thread back and marks it unread. Safe to repeat. */
  restore: (threadId: string, record: R) => Promise<void>;
  sendNote: (threadId: string, note: string) => Promise<void>;
  warn: (message: string) => void;
  /** Longest wait for one thread's lookup, so one slow thread can't hold up the rest. */
  lookupTimeoutMs?: number;
};

/** Default for `lookupTimeoutMs`. */
export const LOOKUP_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type WakeResult = {
  /** Thread id → the snoozedAt of the record to remove. */
  done: Map<string, number>;
  /** Records whose note failed and stays to be tried again. */
  noteFailures: Map<string, { snoozedAt: number; failures: number }>;
  woken: number;
};

export async function wakeDueSnoozes<R extends SnoozeRecord>(snoozes: Record<string, R>, deps: WakeDeps<R>): Promise<WakeResult> {
  const result: WakeResult = { done: new Map(), noteFailures: new Map(), woken: 0 };
  for (const [threadId, record] of Object.entries(snoozes)) {
    let thread: { sectionId: string | null; archivedAt: number | null };
    try {
      thread = await withTimeout(deps.getThread(threadId), deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS, "thread lookup");
    } catch (error) {
      // Only a thread that's really gone ends its snooze; a failed lookup is tried again next minute.
      if (deps.isGoneError(error)) result.done.set(threadId, record.snoozedAt);
      else deps.warn(`snooze ${threadId}: ${String(error)}`);
      continue;
    }
    if (thread.archivedAt !== null) {
      result.done.set(threadId, record.snoozedAt);
      continue;
    }
    const started = record.wakeStarted === true;
    const inSnoozed = deps.snoozedSectionId !== null && thread.sectionId === deps.snoozedSectionId;
    if (!started) {
      // Moved out of Snoozed by hand: the snooze no longer applies.
      if (!inSnoozed) {
        result.done.set(threadId, record.snoozedAt);
        continue;
      }
      if (record.until > deps.now()) continue;
    }
    try {
      if (!started) await deps.markStarted(threadId, record);
      if (inSnoozed) await deps.restore(threadId, record);
    } catch (error) {
      deps.warn(`wake ${threadId} failed: ${String(error)}`);
      continue;
    }
    if (!started) result.woken += 1;
    if (record.note !== null) {
      try {
        await deps.sendNote(threadId, record.note);
      } catch (error) {
        const failures = (record.noteFailures ?? 0) + 1;
        deps.warn(`snooze note ${threadId} failed: ${String(error)}`);
        if (failures < MAX_NOTE_FAILURES) {
          result.noteFailures.set(threadId, { snoozedAt: record.snoozedAt, failures });
          continue;
        }
        deps.warn(`snooze note ${threadId}: gave up after ${failures} attempts`);
      }
    }
    result.done.set(threadId, record.snoozedAt);
  }
  return result;
}
