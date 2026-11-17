// The plugin's SQLite schema. bb numbers migrations by their index in one list
// and rejects a changed or reused index, so every table lives here, in order.
// Append only: never edit, reorder or remove a statement that has shipped.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const MIGRATIONS = [
  // v0.1.2: PR tracking (prs.ts).
  "CREATE TABLE pr_status (key TEXT PRIMARY KEY, json TEXT NOT NULL)",
  "CREATE TABLE thread_prs (thread_id TEXT PRIMARY KEY, json TEXT NOT NULL)",
  // Conductor inbox (conductor-store.ts): events a workspace's conductor hasn't handled yet.
  "CREATE TABLE conductor_events (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, thread_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', dedupe TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, delivered_at INTEGER, acked_at INTEGER)",
  "CREATE INDEX conductor_events_open ON conductor_events (workspace_id, acked_at, delivered_at)",
  // Conductor activity log: what each conductor did, for its page.
  "CREATE TABLE conductor_log (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, thread_id TEXT, text TEXT NOT NULL)",
  "CREATE INDEX conductor_log_recent ON conductor_log (workspace_id, id)",
];

/** Brings the database up to date. Safe to call more than once: applied statements are skipped. */
export function migrate(bb: BbPluginApi): void {
  bb.storage.migrate(bb.storage.database(), MIGRATIONS);
}
