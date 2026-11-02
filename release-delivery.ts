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
