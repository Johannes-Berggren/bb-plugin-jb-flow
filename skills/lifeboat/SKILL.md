---
name: lifeboat
description: Read the user's saved Claude/Codex account usage and agent memory headroom in JB Flow's Lifeboat panel.
---

# Lifeboat in JB Flow

The sidebar-footer lifebuoy opens a compact Mac-selectable capacity summary.
The composer’s Lifeboat indicator follows the selected provider and resolved
execution Mac. **Manage accounts** opens the full dashboard for that Mac. Neither
compact surface changes credentials. They show observed CLI defaults, which can
differ from the account held by a running session. Unresolved Macs and stale
readings do not show a capacity percentage. All surfaces share cached local
reads; mounting another surface does not refresh provider usage.

Use the Lifeboat navigation item for the account dashboard. `bb jb-flow lifeboat
[--host <id-or-name>] [--json]` is read-only and reports saved readings, their age,
agent processes, and memory on an explicitly selected enrolled Mac. It never
requests credentials or refreshes provider usage. Prefer this over reading
provider auth files, the Keychain, or raw transcript files.

Treat old readings and elapsed resets as unconfirmed. A reset time passing does
not prove that capacity returned. Accounts have independent session, weekly,
and model-scoped quotas; never add their percentages into one pooled quota.

User-driven actions in the panel can import accounts, capture a CLI login,
refresh usage, rename/remove a list entry, and verify/switch a CLI login. The
native helper keeps credentials in Keychain on that Mac; no credential bytes
cross the plugin RPC boundary. Existing agent sessions are not reauthenticated
by switching the CLI's default login. Do not promise that a running BB thread
will adopt a newly selected account.

Setup on each Apple Silicon Mac: run `npm run lifeboat:build` from the plugin
checkout with Xcode installed. It builds and signs the host-local native helper.
The panel shows setup/offline errors and the required next step. Quit the old
Limit Lifeboat Mac app before importing accounts. Keep it closed while Flow
owns refreshing those logins; the old data remains available for rollback.

Background refresh runs every five minutes only on Macs where the user imported
or captured accounts. Disable it with the JB Flow setting **Keep Lifeboat usage
current**. Scheduled Claude checks are read-only; an explicit Refresh may renew
a recoverable saved login using the native engine's credential locks and recovery
journal. Automatic switching, credit/reset redemption, process termination, and
budget automation are not exposed by this port.
