// A conductor's inbox: routine news about its workspace's threads, kept in the
// plugin's SQLite database until the conductor has read and acknowledged it.
// Adding is idempotent (the same event twice is stored once), so a sender can
// retry without doubling anything.
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ConductorInboxEvent } from "./conductor-routing.ts";

type Db = ReturnType<BbPluginApi["storage"]["database"]>;

export type StoredConductorEvent = {
  id: number;
  workspaceId: string;
  threadId: string;
  kind: string;
  text: string;
  meta: Record<string, unknown>;
  createdAt: number;
  /** When it went out in a wake-up message, or null. */
  deliveredAt: number | null;
  /** When the conductor marked it handled, or null. */
  ackedAt: number | null;
};

type Row = {
  id: number;
  workspace_id: string;
  thread_id: string;
  kind: string;
  text: string;
  meta: string;
  created_at: number;
  delivered_at: number | null;
  acked_at: number | null;
};

const fromRow = (row: Row): StoredConductorEvent => ({
  id: row.id,
  workspaceId: row.workspace_id,
  threadId: row.thread_id,
  kind: row.kind,
  text: row.text,
  meta: JSON.parse(row.meta) as Record<string, unknown>,
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
  ackedAt: row.acked_at,
});

const dedupeKey = (workspaceId: string, threadId: string, event: ConductorInboxEvent) =>
  createHash("sha256").update([workspaceId, threadId, event.kind, event.text].join("\u0000")).digest("hex");

/** `db` returns the open handle; the schema comes from migrations.ts. */
export function createConductorStore(db: () => Db) {
  /** Stores new events. Returns how many weren't already there. */
  function add(workspaceId: string, threadId: string, events: readonly ConductorInboxEvent[], now: number): number {
    const handle = db();
    const insert = handle.prepare(
      "INSERT OR IGNORE INTO conductor_events (workspace_id, thread_id, kind, text, meta, dedupe, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    let added = 0;
    handle.transaction(() => {
      for (const event of events) {
        const result = insert.run(workspaceId, threadId, event.kind, event.text, JSON.stringify(event.meta ?? {}), dedupeKey(workspaceId, threadId, event), now);
        added += result.changes;
      }
    })();
    return added;
  }

  /** Events not yet acknowledged, oldest first. */
  function open(workspaceId: string, limit = 200): StoredConductorEvent[] {
    const rows = db()
      .prepare("SELECT * FROM conductor_events WHERE workspace_id = ? AND acked_at IS NULL ORDER BY id LIMIT ?")
      .all(workspaceId, limit) as Row[];
    return rows.map(fromRow);
  }

  /** Events no wake-up message has carried yet, oldest first. */
  function undelivered(workspaceId: string): StoredConductorEvent[] {
    const rows = db()
      .prepare("SELECT * FROM conductor_events WHERE workspace_id = ? AND acked_at IS NULL AND delivered_at IS NULL ORDER BY id")
      .all(workspaceId) as Row[];
    return rows.map(fromRow);
  }

  function markDelivered(ids: readonly number[], at: number): void {
    const handle = db();
    const update = handle.prepare("UPDATE conductor_events SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL");
    handle.transaction(() => {
      for (const id of ids) update.run(at, id);
    })();
  }

  /** Marks events handled. Only this workspace's: one conductor can't clear another's. Returns how many. */
  function ack(workspaceId: string, ids: readonly number[], at: number): number {
    const handle = db();
    const update = handle.prepare("UPDATE conductor_events SET acked_at = ? WHERE id = ? AND workspace_id = ? AND acked_at IS NULL");
    let acked = 0;
    handle.transaction(() => {
      for (const id of ids) acked += update.run(at, id, workspaceId).changes;
    })();
    return acked;
  }

  /** Forgets events older than `before`, handled or not. Returns how many. */
  function prune(before: number): number {
    return db().prepare("DELETE FROM conductor_events WHERE created_at < ?").run(before).changes;
  }

  return { add, open, undelivered, markDelivered, ack, prune };
}

export type ConductorStore = ReturnType<typeof createConductorStore>;
