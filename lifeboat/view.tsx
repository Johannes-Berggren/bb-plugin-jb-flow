import { useEffect, useState } from "react";
import type { Account, Operation, Snapshot, UsageWindow } from "./contract";
import {
  accountStatus,
  ageLabel,
  bytesLabel,
  historySegments,
  primaryWindows,
  recommended,
  remaining,
  resetLabel,
  STATUS_LABEL,
} from "./model";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import "./lifeboat.css";

export type Host = { id: string; name: string; connected: boolean };
type Pending =
  | { kind: "switch" | "rename" | "remove"; account: Account }
  | { kind: "import" | "capture" }
  | null;
export interface LifeboatViewProps {
  hosts: Host[];
  hostId: string;
  onHostChange: (id: string) => void;
  snapshot: Snapshot | null;
  busy: boolean;
  loading: boolean;
  error: string | null;
  setupRequired?: boolean;
  now: number;
  providerNames?: Partial<Record<Account["provider"], string>>;
  onOperation: (operation: Operation) => Promise<boolean>;
  onStudio?: () => void;
}

export function LifeboatMark({ small = false }: { small?: boolean }) {
  return (
    <svg
      width={small ? 16 : 24}
      height={small ? 16 : 24}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="m6 6 3.5 3.5m5 5L18 18M18 6l-3.5 3.5m-5 5L6 18"
        stroke="currentColor"
        strokeWidth="3"
      />
    </svg>
  );
}
function Arrow() {
  return <span aria-hidden="true">↗</span>;
}
function HelpButton({
  disabledReason,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  disabledReason?: string;
}) {
  return (
    <span
      className="jf-life-control"
      tabIndex={disabledReason ? 0 : undefined}
      aria-label={disabledReason}
    >
      <button {...props} disabled={!!disabledReason || props.disabled}>
        {children}
      </button>
      {disabledReason && (
        <span role="tooltip" className="jf-life-tooltip">
          {disabledReason}
        </span>
      )}
    </span>
  );
}
function WindowMeter({ window, now }: { window: UsageWindow; now: number }) {
  const expired = !!window.resetsAt && Date.parse(window.resetsAt) <= now;
  const value = Math.max(0, 100 - window.usedPercent);
  return (
    <div className={`jf-life-window ${expired ? "is-expired" : ""}`}>
      <div className="jf-life-window-label">
        <span>{window.label}</span>
        <span>
          {expired ? (
            "Awaiting refresh"
          ) : (
            <>
              <strong>{Math.round(value)}%</strong> left
            </>
          )}
        </span>
      </div>
      <div
        className={`jf-life-meter ${window.usedPercent >= 100 ? "is-limited" : window.usedPercent >= 80 ? "is-low" : ""}`}
        role="meter"
        aria-label={`${window.label} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={
          expired
            ? "Reset due; refresh to confirm capacity"
            : `${Math.round(value)}% remaining`
        }
      >
        <span style={{ width: `${value}%` }} />
      </div>
      <span
        className="jf-life-reset"
        title={
          window.resetsAt
            ? new Date(window.resetsAt).toLocaleString()
            : undefined
        }
      >
        {resetLabel(window, now)}
      </span>
    </div>
  );
}
function History({
  snapshot,
  account,
  now,
}: {
  snapshot: Snapshot;
  account: Account;
  now: number;
}) {
  const [windowId, setWindowId] = useState(
    primaryWindows(account)[0]?.id ?? "",
  );
  const windows = primaryWindows(account);
  const segments = historySegments(snapshot, account.id, windowId);
  const points = segments.flat();
  const start = now - 7 * 86400_000;
  const x = (at: number) =>
    22 + Math.max(0, Math.min(1, (at - start) / (now - start))) * 656;
  const y = (used: number) => 14 + (100 - used) * 1.26;
  return (
    <div className="jf-life-history">
      <div className="jf-life-subhead">
        <h3>Usage over time</h3>
        <div className="jf-life-segmented" aria-label="Usage window">
          {windows.map((window) => (
            <button
              key={window.id}
              aria-pressed={windowId === window.id}
              onClick={() => setWindowId(window.id)}
            >
              {window.kind === "session" ? "Session" : "Weekly"}
            </button>
          ))}
        </div>
      </div>
      {points.length < 2 ? (
        <p className="jf-life-no-chart">
          Your usage history will take shape as readings arrive.
        </p>
      ) : (
        <>
          <svg
            className="jf-life-chart"
            viewBox="0 0 700 164"
            role="img"
            aria-label={`${account.label}: ${windows.find((window) => window.id === windowId)?.label ?? "usage"} used over the last seven days. Resets separate the lines.`}
          >
            {[0, 50, 100].map((value) => (
              <g key={value}>
                <line
                  x1="22"
                  x2="678"
                  y1={y(value)}
                  y2={y(value)}
                  className="jf-life-chart-grid"
                />
                <text x="0" y={y(value) + 3} className="jf-life-chart-axis">
                  {value}
                </text>
              </g>
            ))}
            {segments.map((segment, index) => (
              <g key={index}>
                {segment.length > 1 ? (
                  <polyline
                    points={segment
                      .map((point) => `${x(point.at)},${y(point.used)}`)
                      .join(" ")}
                    className="jf-life-chart-line"
                  />
                ) : (
                  <circle
                    cx={x(segment[0].at)}
                    cy={y(segment[0].used)}
                    r="2"
                    className="jf-life-chart-point"
                  />
                )}
              </g>
            ))}
            <text x="22" y="160" className="jf-life-chart-axis">
              7 days ago
            </text>
            <text
              x="678"
              y="160"
              textAnchor="end"
              className="jf-life-chart-axis"
            >
              Now
            </text>
          </svg>
          <details className="jf-life-history-data">
            <summary>View readings</summary>
            <div className="jf-life-data-scroll">
              <table>
                <caption>{account.label} · percent used</caption>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Used</th>
                  </tr>
                </thead>
                <tbody>
                  {points
                    .slice(-60)
                    .reverse()
                    .map((point, index) => (
                      <tr key={index}>
                        <td>{new Date(point.at).toLocaleString()}</td>
                        <td>{Math.round(point.used)}%</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

export function LifeboatView({
  hosts,
  hostId,
  onHostChange,
  snapshot,
  busy,
  loading,
  error,
  setupRequired,
  now,
  providerNames = {},
  onOperation,
  onStudio,
}: LifeboatViewProps) {
  const [filter, setFilter] = useState<"all" | "claude" | "codex">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<Account["provider"]>("claude");
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    setSelected(null);
    setPending(null);
    setNotice(null);
  }, [hostId]);
  const currentHost = hosts.find((host) => host.id === hostId);
  const legacy = snapshot?.source === "legacy";
  const accounts = snapshot?.accounts ?? [];
  const visible = accounts
    .filter((account) => filter === "all" || account.provider === filter)
    .sort(
      (a, b) =>
        Number(b.isActive) - Number(a.isActive) ||
        a.provider.localeCompare(b.provider) ||
        a.priority - b.priority,
    );
  const chosen = accounts.find((account) => account.id === selected) ?? null;
  const fresh = accounts.filter(
    (account) =>
      accountStatus(account, now, snapshot?.issues[account.id]) === "ready",
  );
  const reason = busy
    ? "A Lifeboat operation is in progress. Wait for it to finish."
    : loading
      ? "Wait for this Mac to finish reading the accounts."
      : !currentHost?.connected
        ? "Connect this Mac to BB to use Lifeboat."
        : undefined;
  const name = (provider: Account["provider"]) =>
    providerNames[provider] ??
    (provider === "claude" ? "Claude Code" : "Codex");
  async function perform(operation: Operation, message?: string) {
    setNotice(null);
    if (await onOperation(operation)) {
      setPending(null);
      if (message) setNotice(message);
    }
  }
  const activeLabel = legacy ? "Saved in Lifeboat" : "Current CLI login";
  return (
    <main className="jf-life" aria-label="Lifeboat" aria-busy={loading || busy}>
      <div className="jf-life-inner">
        <header className="jf-life-hero">
          <div>
            <div className="jf-life-eyebrow">
              <LifeboatMark small /> JB FLOW <span>/</span> LIFEBOAT
            </div>
            <h1>
              Room to keep going<span>.</span>
            </h1>
            <p>Your accounts, their limits, and a little breathing room.</p>
          </div>
          <div className="jf-life-hero-actions">
            <label className="jf-life-host">
              <span
                className={`jf-life-dot ${currentHost?.connected ? "is-live" : ""}`}
              />
              <span className="sr-only">Lifeboat Mac</span>
              <select
                aria-label="Lifeboat Mac"
                value={hostId}
                onChange={(event) => onHostChange(event.target.value)}
              >
                {!hosts.length && <option value="">No connected Macs</option>}
                {hosts.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.name}
                    {host.connected ? "" : " · offline"}
                  </option>
                ))}
              </select>
            </label>
            <div className="jf-life-actions">
              <HelpButton
                className="jf-life-button"
                disabledReason={reason}
                onClick={() =>
                  void perform(
                    { command: legacy ? "status" : "refresh" },
                    legacy
                      ? "Preview reread from the Lifeboat store."
                      : "Refresh finished. Accounts with a failed check keep their last reading.",
                  )
                }
              >
                <span className={busy ? "jf-life-spin" : ""} aria-hidden="true">
                  ↻
                </span>
                {busy
                  ? "Working…"
                  : legacy
                    ? "Refresh preview"
                    : "Refresh usage"}
              </HelpButton>
              <HelpButton
                className="jf-life-primary"
                disabledReason={reason}
                onClick={() => setPending({ kind: "capture" })}
              >
                Add account <span aria-hidden="true">＋</span>
              </HelpButton>
            </div>
          </div>
        </header>
        {error && (
          <div className="jf-life-alert" role="alert">
            <strong>
              {setupRequired
                ? "A small setup step on this Mac"
                : "Lifeboat needs a moment"}
            </strong>
            <p>{error}</p>
            {setupRequired && <code>npm run lifeboat:build</code>}
            <HelpButton
              className="jf-life-button"
              disabledReason={busy ? reason : undefined}
              onClick={() => void perform({ command: "status" })}
            >
              Try again
            </HelpButton>
          </div>
        )}
        {notice && (
          <p className="jf-life-notice" role="status">
            {notice}
          </p>
        )}
        {legacy && (
          <div className="jf-life-import">
            <div className="jf-life-import-mark">
              <LifeboatMark />
            </div>
            <div>
              <strong>Your Lifeboat accounts are already here.</strong>
              <p>
                This is a read-only preview. Bring them into Flow to manage them
                here.
              </p>
            </div>
            <HelpButton
              className="jf-life-button"
              disabledReason={reason}
              onClick={() => setPending({ kind: "import" })}
            >
              Bring into Flow <Arrow />
            </HelpButton>
          </div>
        )}
        <section className="jf-life-overview" aria-label="Capacity overview">
          {(["claude", "codex"] as const).map((provider) => {
            const active = accounts.find(
              (account) => account.provider === provider && account.isActive,
            );
            const status =
              active && accountStatus(active, now, snapshot?.issues[active.id]);
            const trusted =
              status === "ready" ||
              status === "near-limit" ||
              status === "limited";
            const value = active ? remaining(active) : null;
            return (
              <div className="jf-life-stat" key={provider}>
                <span className="jf-life-stat-title">
                  <span
                    className={`jf-life-provider jf-life-provider--${provider}`}
                  >
                    {provider === "claude" ? "C" : "O"}
                  </span>
                  {name(provider)}
                </span>
                <div className="jf-life-stat-value">
                  {trusted && value !== null ? (
                    <>
                      {Math.round(value)}
                      <span>% left</span>
                    </>
                  ) : (
                    <span className="jf-life-stat-unknown">
                      {active ? STATUS_LABEL[status!] : "No active login"}
                    </span>
                  )}
                </div>
                <span className="jf-life-stat-caption">
                  {legacy ? "Last saved CLI login" : "Current CLI login"} ·{" "}
                  {
                    accounts.filter((account) => account.provider === provider)
                      .length
                  }{" "}
                  saved
                </span>
              </div>
            );
          })}
          <div className="jf-life-stat">
            <span className="jf-life-stat-title">
              <span className="jf-life-machine-icon" aria-hidden="true">
                ▤
              </span>
              Breathing room
            </span>
            <div className="jf-life-stat-value">
              {snapshot?.memory ? (
                <>
                  {bytesLabel(snapshot.memory.availableBytes)}
                  <span>available</span>
                </>
              ) : (
                <span className="jf-life-stat-unknown">
                  Waiting for this Mac
                </span>
              )}
            </div>
            <span className="jf-life-stat-caption">
              {snapshot?.memory?.additionalSessions == null
                ? `${snapshot?.sessions.length ?? 0} agent sessions`
                : `About ${snapshot.memory.additionalSessions} more sessions`}{" "}
              ·{" "}
              {snapshot?.memory?.level === "critical"
                ? "Memory is tight"
                : "Memory headroom"}
            </span>
          </div>
        </section>
        <section aria-labelledby="jf-life-accounts-title">
          <div className="jf-life-section-heading">
            <div>
              <h2 id="jf-life-accounts-title">
                Your accounts{" "}
                <span>{accounts.length.toString().padStart(2, "0")}</span>
              </h2>
              <p>
                {legacy
                  ? "Saved readings from the Mac app"
                  : `${fresh.length} ${fresh.length === 1 ? "account has" : "accounts have"} comfortable headroom`}
              </p>
            </div>
            <div className="jf-life-segmented" aria-label="Filter accounts">
              {(["all", "claude", "codex"] as const).map((provider) => (
                <button
                  key={provider}
                  aria-pressed={filter === provider}
                  onClick={() => setFilter(provider)}
                >
                  {provider === "all" ? "All accounts" : name(provider)}
                </button>
              ))}
            </div>
          </div>
          {loading && !snapshot ? (
            <div className="jf-life-skeleton" role="status">
              <span>Reading your accounts…</span>
              {[0, 1, 2, 3].map((key) => (
                <div key={key} />
              ))}
            </div>
          ) : !visible.length ? (
            <div className="jf-life-empty">
              <LifeboatMark />
              <h3>
                {accounts.length
                  ? "No accounts in this view"
                  : "A calmer way to stay in flow."}
              </h3>
              <p>
                {accounts.length
                  ? "Choose All accounts to see your saved logins."
                  : "Sign in to Claude Code or Codex on this Mac, then add that login. Each account keeps its own usage and reset times."}
              </p>
              <HelpButton
                className="jf-life-button"
                disabledReason={reason}
                onClick={() =>
                  accounts.length
                    ? setFilter("all")
                    : setPending({ kind: "capture" })
                }
              >
                {accounts.length
                  ? "Show all accounts"
                  : "Add your first account"}{" "}
                <Arrow />
              </HelpButton>
            </div>
          ) : (
            <div className="jf-life-account-grid">
              {visible.map((account) => {
                const issue = snapshot?.issues[account.id];
                const status = accountStatus(account, now, issue);
                const isRecommended =
                  !legacy &&
                  snapshot &&
                  recommended(snapshot, account.provider, now)?.id ===
                    account.id;
                const windows = primaryWindows(account);
                const other =
                  account.reading?.windows.filter(
                    (window) => !windows.includes(window),
                  ) ?? [];
                return (
                  <article
                    key={account.id}
                    className={`jf-life-account ${account.isActive ? "is-active" : ""}`}
                  >
                    <div className="jf-life-account-top">
                      <span
                        className={`jf-life-avatar jf-life-avatar--${account.provider}`}
                      >
                        {account.label.slice(0, 1).toUpperCase()}
                      </span>
                      <div className="jf-life-account-identity">
                        <h3>
                          <button onClick={() => setSelected(account.id)}>
                            {account.label}
                          </button>
                        </h3>
                        <span>
                          {name(account.provider)}
                          {account.plan ? ` · ${account.plan}` : ""}
                        </span>
                      </div>
                      {account.isActive ? (
                        <span className="jf-life-current" title={activeLabel}>
                          {legacy ? "Saved active" : "Current"}
                        </span>
                      ) : isRecommended ? (
                        <span className="jf-life-recommended">Next up</span>
                      ) : null}
                    </div>
                    {account.email && account.email !== account.label && (
                      <p className="jf-life-email">{account.email}</p>
                    )}
                    <div className={`jf-life-health jf-life-health--${status}`}>
                      <span className="jf-life-dot" />
                      {STATUS_LABEL[status]}
                      {status === "ready" && <span> · room to work</span>}
                    </div>
                    <div className="jf-life-windows">
                      {windows.length ? (
                        windows.map((window) => (
                          <WindowMeter
                            key={window.id}
                            window={window}
                            now={now}
                          />
                        ))
                      ) : (
                        <p className="jf-life-muted">
                          Refresh usage to see this account's limits.
                        </p>
                      )}
                      {!!other.length && (
                        <details className="jf-life-scoped">
                          <summary>
                            {other.length} model-specific{" "}
                            {other.length === 1 ? "limit" : "limits"}
                          </summary>
                          {other.map((window) => (
                            <WindowMeter
                              key={window.id}
                              window={window}
                              now={now}
                            />
                          ))}
                        </details>
                      )}
                    </div>
                    {issue && <p className="jf-life-account-issue">{issue}</p>}
                    {account.reading?.extraUsage && (
                      <p className="jf-life-overage">
                        Extra usage · {account.reading.extraUsage}
                      </p>
                    )}
                    <footer className="jf-life-account-footer">
                      <span
                        title={
                          account.reading
                            ? new Date(
                                account.reading.lastRefreshed,
                              ).toLocaleString()
                            : undefined
                        }
                      >
                        {account.reading
                          ? `Read ${ageLabel(account.reading.lastRefreshed, now)}`
                          : "Not checked yet"}
                      </span>
                      <div>
                        <button
                          className="jf-life-text-button"
                          onClick={() => setSelected(account.id)}
                        >
                          Details <Arrow />
                        </button>
                        {!legacy && !account.isActive && (
                          <HelpButton
                            className="jf-life-switch"
                            disabledReason={reason}
                            onClick={() =>
                              setPending({ kind: "switch", account })
                            }
                          >
                            Switch to this
                          </HelpButton>
                        )}
                      </div>
                    </footer>
                  </article>
                );
              })}
            </div>
          )}
        </section>
        <section
          className="jf-life-sessions"
          aria-labelledby="jf-life-sessions-title"
        >
          <div className="jf-life-section-heading">
            <div>
              <h2 id="jf-life-sessions-title">
                On this Mac <span>{snapshot?.sessions.length ?? 0}</span>
              </h2>
              <p>
                {snapshot?.memory?.message ??
                  "Agent sessions and memory, read locally."}
              </p>
            </div>
            {onStudio && (
              <button className="jf-life-text-button" onClick={onStudio}>
                Back to Studio <Arrow />
              </button>
            )}
          </div>
          {snapshot?.sessions.length ? (
            <div className="jf-life-session-list">
              {snapshot.sessions
                .slice()
                .sort((a, b) => b.memoryBytes - a.memoryBytes)
                .slice(0, 12)
                .map((session) => (
                  <div className="jf-life-session" key={session.pid}>
                    <span
                      className={`jf-life-provider jf-life-provider--${session.provider}`}
                    >
                      {session.provider === "claude" ? "C" : "O"}
                    </span>
                    <div>
                      <strong>{session.project}</strong>
                      <span>
                        {name(session.provider)} · PID {session.pid}
                      </span>
                    </div>
                    <span>{bytesLabel(session.memoryBytes)}</span>
                  </div>
                ))}
            </div>
          ) : (
            <p className="jf-life-muted">No agent sessions are running here.</p>
          )}
        </section>
        <footer className="jf-life-page-footer">
          <span>
            <LifeboatMark small /> A little more flow.
          </span>
          <span>
            Credentials stay in Keychain on this Mac. Switching is always your
            choice.
          </span>
        </footer>
      </div>
      <Dialog
        open={!!chosen}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="jf-life-dialog">
          <DialogHeader>
            <DialogTitle>{chosen?.label}</DialogTitle>
            <DialogDescription>
              {chosen
                ? `${name(chosen.provider)}${chosen.plan ? ` · ${chosen.plan}` : ""} · ${chosen.email ?? "Saved account"}`
                : "Account details"}
            </DialogDescription>
          </DialogHeader>
          {chosen && snapshot && (
            <>
              <div className="jf-life-detail-windows">
                {chosen.reading?.windows.map((window) => (
                  <WindowMeter key={window.id} window={window} now={now} />
                ))}
              </div>
              <History
                key={chosen.id}
                snapshot={snapshot}
                account={chosen}
                now={now}
              />
              {chosen.reading && (
                <p className="jf-life-muted jf-life-source">
                  Source: {chosen.reading.source} ·{" "}
                  {new Date(chosen.reading.lastRefreshed).toLocaleString()}
                </p>
              )}
              <div className="jf-life-detail-actions">
                {!legacy && (
                  <>
                    <HelpButton
                      className="jf-life-button"
                      disabledReason={reason}
                      onClick={() =>
                        void perform(
                          { command: "refresh", accountID: chosen.id },
                          "Account reading refreshed.",
                        )
                      }
                    >
                      Refresh this account
                    </HelpButton>
                    <HelpButton
                      className="jf-life-text-button"
                      disabledReason={reason}
                      onClick={() => {
                        setLabel(chosen.label);
                        setSelected(null);
                        setPending({ kind: "rename", account: chosen });
                      }}
                    >
                      Rename
                    </HelpButton>
                    <HelpButton
                      className="jf-life-text-button"
                      disabledReason={reason}
                      onClick={() => {
                        setSelected(null);
                        setPending({ kind: "remove", account: chosen });
                      }}
                    >
                      Remove from list
                    </HelpButton>
                  </>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
      >
        <DialogContent className="jf-life-dialog jf-life-confirm">
          <DialogHeader>
            <DialogTitle>
              {pending?.kind === "switch"
                ? `Switch ${name(pending.account.provider)} to ${pending.account.label}?`
                : pending?.kind === "import"
                  ? "Make yourself at home."
                  : pending?.kind === "rename"
                    ? "Give this account a name"
                    : pending?.kind === "remove"
                      ? "Remove this account from the list?"
                      : "Bring another account aboard."}
            </DialogTitle>
            <DialogDescription>
              {pending?.kind === "switch"
                ? `This changes the ${name(pending.account.provider)} CLI login on ${currentHost?.name ?? "this Mac"}. Existing agent sessions keep their current login. The target is verified before the change, and a failed restore rolls back.`
                : pending?.kind === "import"
                  ? "Copy your saved accounts and encrypted logins into Flow's own store. Your original Lifeboat data stays intact. Quit the Mac app first so Flow can take over refreshing. macOS may ask you to authorize Keychain access on this Mac."
                  : pending?.kind === "rename"
                    ? "A short name makes the right account easy to find."
                    : pending?.kind === "remove"
                      ? "The account leaves this list. Its CLI login stays as it is, and its encrypted credential snapshot is retained for recovery."
                      : "Sign in with the provider's CLI on the selected Mac first. Then capture that login into Flow. macOS may ask you to authorize Keychain access."}
            </DialogDescription>
          </DialogHeader>
          {pending?.kind === "capture" && (
            <div className="jf-life-capture">
              <label htmlFor="jf-life-provider">Provider</label>
              <select
                id="jf-life-provider"
                value={provider}
                onChange={(event) =>
                  setProvider(event.target.value as Account["provider"])
                }
              >
                <option value="claude">{name("claude")}</option>
                <option value="codex">{name("codex")}</option>
              </select>
              <p>
                Run on <strong>{currentHost?.name ?? "this Mac"}</strong>:
              </p>
              <code>
                {provider === "claude" ? "claude auth login" : "codex login"}
              </code>
              <p className="jf-life-muted">
                Use a separate terminal for login, then return here.
              </p>
            </div>
          )}
          {pending?.kind === "rename" && (
            <label className="jf-life-rename">
              Account name
              <input
                autoFocus
                maxLength={80}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
          )}
          {error && (
            <p className="jf-life-dialog-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <button className="jf-life-button" onClick={() => setPending(null)}>
              Cancel
            </button>
            <HelpButton
              className="jf-life-primary"
              disabledReason={
                reason ??
                (pending?.kind === "rename" && !label.trim()
                  ? "Enter a short name for this account."
                  : undefined)
              }
              onClick={() => {
                if (pending?.kind === "capture")
                  void perform(
                    { command: "capture", provider },
                    "CLI login captured. Refresh usage to read its limits.",
                  );
                if (pending?.kind === "import")
                  void perform(
                    { command: "import" },
                    "Your accounts now have a home in Flow. Capture each current CLI login to mark it active.",
                  );
                if (pending?.kind === "switch")
                  void perform(
                    { command: "switch", accountID: pending.account.id },
                    `The ${name(pending.account.provider)} CLI now uses ${pending.account.label}. Existing sessions keep their login.`,
                  );
                if (pending?.kind === "rename")
                  void perform(
                    { command: "rename", accountID: pending.account.id, label },
                    "Account renamed.",
                  );
                if (pending?.kind === "remove")
                  void perform(
                    { command: "remove", accountID: pending.account.id },
                    "Account removed from the list. Its recovery snapshot is retained.",
                  );
              }}
            >
              {busy
                ? "Working…"
                : pending?.kind === "switch"
                  ? "Verify and switch"
                  : pending?.kind === "import"
                    ? "Bring accounts into Flow"
                    : pending?.kind === "rename"
                      ? "Save name"
                      : pending?.kind === "remove"
                        ? "Remove from list"
                        : "Capture CLI login"}
            </HelpButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
