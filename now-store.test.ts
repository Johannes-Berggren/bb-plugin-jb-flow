import assert from "node:assert/strict";
import { test } from "node:test";
import { createNowStore } from "./now-store.ts";

type Sections = readonly { id: string; name: string }[];

function fake(options: { sections?: Sections; inSection?: Record<string, string[]>; failSections?: boolean } = {}) {
  const data = new Map<string, unknown>();
  const listeners = new Map<string, (payload: { thread: { id: string } }) => unknown>();
  let failSections = options.failSections ?? false;
  const bb = {
    storage: {
      kv: {
        get: async <T,>(key: string) => data.get(key) as T | undefined,
        set: async (key: string, value: unknown) => void data.set(key, value),
      },
    },
    sdk: {
      threadSections: {
        list: async () => {
          if (failSections) throw new Error("down");
          return options.sections ?? [];
        },
      },
      threads: {
        list: async ({ sectionId, offset }: { sectionId?: string; offset: number }) =>
          offset > 0 ? [] : (options.inSection?.[sectionId ?? ""] ?? []).map((id) => ({ id })),
      },
    },
    events: { on: (event: string, listener: (payload: { thread: { id: string } }) => unknown) => void listeners.set(event, listener) },
  };
  let changes = 0;
  const store = createNowStore(bb as never, () => void changes++);
  return {
    store,
    emit: (event: string, id: string) => listeners.get(event)?.({ thread: { id } }),
    changes: () => changes,
    heal: () => (failSections = false),
    data,
  };
}

const PRIORITY = [{ id: "sec_p", name: "Priority" }];

test("a new install has no lanes, so Focus starts empty", async () => {
  const { store } = fake();
  assert.deepEqual(await store.all(), {});
});

test("your Priority lane seeds Focus once, keeping what you changed after", async () => {
  const { store } = fake({ sections: PRIORITY, inSection: { sec_p: ["a", "b"] } });
  assert.deepEqual(Object.keys(await store.all()).sort(), ["a", "b"]);
  await store.set("a", false);
  assert.deepEqual(Object.keys(await store.all()), ["b"]);
});

test("a failed read seeds later instead of never", async () => {
  const { store, heal } = fake({ sections: PRIORITY, inSection: { sec_p: ["a"] }, failSections: true });
  assert.deepEqual(await store.all(), {});
  heal();
  assert.deepEqual(Object.keys(await store.all()), ["a"]);
});

test("setting publishes a change only when something changed", async () => {
  const { store, changes } = fake();
  await store.set("a", true);
  assert.equal(changes(), 1);
  await store.set("a", true);
  assert.equal(changes(), 1);
  await store.set("a", false);
  assert.equal(changes(), 2);
});

test("concurrent writes don't lose each other", async () => {
  const { store } = fake();
  await Promise.all(["a", "b", "c", "d"].map((id) => store.set(id, true)));
  assert.deepEqual(Object.keys(await store.all()).sort(), ["a", "b", "c", "d"]);
});

test("archiving or deleting a thread takes it out of Focus", async () => {
  const { store, emit } = fake();
  await store.set("a", true);
  await store.set("b", true);
  await store.set("c", true);
  await emit("thread.archived", "a");
  await emit("thread.deleted", "b");
  assert.deepEqual(Object.keys(await store.all()), ["c"]);
});

test("prune keeps only live threads", async () => {
  const { store } = fake();
  await store.set("a", true);
  await store.set("b", true);
  await store.prune((id) => id === "b");
  assert.deepEqual(Object.keys(await store.all()), ["b"]);
});
