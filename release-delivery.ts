// Publishing a release is not always delivering it: a later step can still fail. A project can name
// a public JSON field that shows what users actually get, and the "released" message waits for it.

/** A dotted field of parsed JSON, or undefined. */
export function readField(json: unknown, field: string): unknown {
  let value = json;
  for (const part of field.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** Whether a live version value has reached a release tag: the same version, or a newer one. */
export function deliveryReached(live: unknown, tag: string): boolean {
  if (typeof live !== "string" || live === "") return false;
  const parts = (version: string) => version.replace(/^v/, "").split(".").map(Number);
  const have = parts(live);
  const want = parts(tag);
  if ([...have, ...want].some(Number.isNaN)) return live.replace(/^v/, "") === tag.replace(/^v/, "");
  for (let index = 0; index < Math.max(have.length, want.length); index++) {
    const difference = (have[index] ?? 0) - (want[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export type WaiterDelivery = {
  send: (threadId: string) => Promise<unknown>;
  /** True only when the thread is known to be archived or deleted. */
  threadGone: (threadId: string) => Promise<boolean>;
  /** Forget this waiter. Called only once it's been told, or its thread is gone. */
  settle: (waiterId: string) => Promise<void>;
  warn: (message: string) => void;
};

/** Tells each waiter. One that can't be told isn't settled, so it can be tried again. */
export async function deliverToWaiters(
  targets: ReadonlyArray<readonly [string, { threadId: string }]>,
  delivery: WaiterDelivery,
): Promise<{ notified: number; failed: number }> {
  let notified = 0;
  let failed = 0;
  for (const [waiterId, { threadId }] of targets) {
    if (await delivery.threadGone(threadId)) {
      await delivery.settle(waiterId);
      continue;
    }
    try {
      await delivery.send(threadId);
    } catch (error) {
      delivery.warn(`release notify: ${String(error)}`);
      failed += 1;
      continue;
    }
    await delivery.settle(waiterId);
    notified += 1;
  }
  return { notified, failed };
}
