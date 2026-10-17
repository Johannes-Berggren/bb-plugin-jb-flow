import { useState } from "react";
import {
  experimental_useProviders as useProviders,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useComposer,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalSidebarFooterDisclosureProps } from "@get-bb/plugin-sdk/app";
import type { Provider } from "./contract";
import { useLifeboatData } from "./hooks";
import { capacitySummary, composerTarget } from "./context";
import { ageLabel, bytesLabel, primaryWindows, resetLabel } from "./model";
import { LifeboatMark } from "./view";
import "./compact.css";

const POPUP = "lifeboat-capacity";
function useProviderNames() {
  const { providers } = useProviders();
  return {
    claude:
      providers.find((provider) => provider.id === "claude-code")
        ?.displayName ?? "Claude Code",
    codex:
      providers.find((provider) => provider.id === "codex")?.displayName ??
      "Codex",
  };
}
export function LifeboatIcon({ className }: { className?: string }) {
  return (
    <span className={className}>
      <LifeboatMark small />
    </span>
  );
}

function CompactOverview({
  hostId: requestedHost,
  provider,
  dismiss,
  chooseMac = false,
}: {
  hostId?: string | null;
  provider?: Provider | null;
  dismiss: () => void;
  chooseMac?: boolean;
}) {
  const [selected, setSelected] = useState<string | undefined>();
  const data = useLifeboatData(selected ?? requestedHost);
  const names = useProviderNames();
  const navigate = useBbNavigate();
  const host = data.hosts.find((host) => host.id === data.hostId);
  const openDashboard = () => {
    dismiss();
    navigate.toPluginPanel(
      "lifeboat",
      data.hostId ? { subPath: `host/${data.hostId}` } : undefined,
    );
  };
  return (
    <section className="jf-life-compact" aria-label="Lifeboat capacity">
      <header>
        <span className="jf-life-compact-mark">
          <LifeboatMark small />
        </span>
        <div>
          <strong>Lifeboat</strong>
          <span>Account capacity</span>
        </div>
        <button
          className="jf-life-compact-close"
          aria-label="Close Lifeboat"
          title="Close Lifeboat"
          onClick={dismiss}
        >
          ×
        </button>
      </header>
      {chooseMac ? (
        <label className="jf-life-compact-host">
          Mac
          <select
            aria-label="Lifeboat Mac"
            value={data.hostId}
            onChange={(event) => setSelected(event.target.value)}
          >
            {!data.hosts.length && <option value="">No connected Macs</option>}
            {data.hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.name}
                {host.connected ? "" : " · offline"}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="jf-life-compact-machine">
          {host?.name ?? "Choose a Mac in the composer to see its usage"}
        </p>
      )}
      {data.loading ? (
        <p className="jf-life-compact-muted" role="status">
          Reading account capacity…
        </p>
      ) : data.error ? (
        <div className="jf-life-compact-error" role="status">
          <p>{data.error}</p>
          <button onClick={() => void data.run({ command: "status" })}>
            Retry reading
          </button>
        </div>
      ) : !data.hostId ? null : (
        <div className="jf-life-compact-accounts">
          {(provider ? [provider] : (["claude", "codex"] as Provider[])).map(
            (kind) => {
              const summary = capacitySummary(
                data.snapshot,
                kind,
                data.now,
                !host?.connected,
              );
              const windows = summary.account
                ? primaryWindows(summary.account)
                : [];
              return (
                <div
                  className={`jf-life-compact-provider is-${summary.status}`}
                  key={kind}
                >
                  <div className="jf-life-compact-provider-title">
                    <strong>{names[kind]}</strong>
                    <span>{summary.text}</span>
                  </div>
                  {summary.account ? (
                    <>
                      <span className="jf-life-compact-account">
                        {summary.account.label}
                      </span>
                      <div className="jf-life-compact-windows">
                        {windows.map((window) => {
                          const value = Math.max(0, 100 - window.usedPercent);
                          const trusted = summary.value !== null;
                          return (
                            <div key={window.id}>
                              <div>
                                <span>
                                  {window.kind === "session"
                                    ? "Session"
                                    : "Weekly"}
                                </span>
                                <strong>
                                  {trusted
                                    ? `${Math.round(value)}% left`
                                    : "Unconfirmed"}
                                </strong>
                              </div>
                              <div
                                className="jf-life-compact-meter"
                                role="meter"
                                aria-label={`${names[kind]} ${window.kind} remaining`}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={trusted ? value : undefined}
                                aria-valuetext={
                                  trusted
                                    ? `${Math.round(value)}% remaining`
                                    : "Unconfirmed reading; refresh usage to verify"
                                }
                              >
                                <span
                                  style={{
                                    width: trusted ? `${value}%` : "0%",
                                    opacity: trusted ? 1 : 0.3,
                                  }}
                                />
                              </div>
                              <span className="jf-life-compact-reset">
                                {resetLabel(window, data.now)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                      {summary.account.reading && (
                        <span className="jf-life-compact-age">
                          Read{" "}
                          {ageLabel(
                            summary.account.reading.lastRefreshed,
                            data.now,
                          )}
                        </span>
                      )}
                    </>
                  ) : (
                    <p className="jf-life-compact-muted">
                      Capture the CLI login in Lifeboat to confirm which account
                      this Mac uses.
                    </p>
                  )}
                </div>
              );
            },
          )}
        </div>
      )}
      {data.snapshot?.memory && (
        <p className="jf-life-compact-memory">
          <span>
            {bytesLabel(data.snapshot.memory.availableBytes)} available
          </span>
          <span>{data.snapshot.sessions.length} sessions</span>
        </p>
      )}
      {data.snapshot?.source === "legacy" && (
        <p className="jf-life-compact-muted">
          Read-only readings from the Mac app.
        </p>
      )}
      <footer>
        <button className="jf-life-compact-open" onClick={openDashboard}>
          Manage accounts <span aria-hidden="true">↗</span>
        </button>
        <p>
          CLI defaults are shown here. Running sessions may use another login.
        </p>
      </footer>
    </section>
  );
}

export function LifeboatFooter({
  dismiss,
}: ExperimentalSidebarFooterDisclosureProps) {
  const { threadId } = useBbContext();
  const { threads } = useSidebarThreads();
  const hostId = threadId
    ? (threads.find((thread) => thread.id === threadId)?.host?.id ?? undefined)
    : undefined;
  return <CompactOverview hostId={hostId} dismiss={dismiss} chooseMac />;
}
export function LifeboatComposerAction() {
  const composer = useComposer();
  const { threads } = useSidebarThreads();
  const target = composerTarget(composer.scope, composer.selection, threads);
  const data = useLifeboatData(target.provider ? target.hostId : null);
  const names = useProviderNames();
  if (!target.provider) return null;
  const host = data.hosts.find((host) => host.id === data.hostId);
  const summary = capacitySummary(
    data.snapshot,
    target.provider,
    data.now,
    !!data.error || !host?.connected,
  );
  const label = !target.hostId
    ? "Lifeboat"
    : data.loading
      ? "Usage…"
      : summary.text;
  const title = `${names[target.provider]} · ${host?.name ?? "Mac not resolved"} · ${label}. Open Lifeboat capacity. This is the CLI default, which may differ from this session's login.`;
  return (
    <button
      className={`jf-life-capacity-pill is-${summary.status}`}
      title={title}
      aria-label={title}
      onClick={() => composer.experimental_openPopup(POPUP)}
    >
      <LifeboatMark small />
      <span>{label}</span>
    </button>
  );
}
export function LifeboatComposerPopup() {
  const composer = useComposer();
  const { threads } = useSidebarThreads();
  const target = composerTarget(composer.scope, composer.selection, threads);
  return (
    <CompactOverview
      hostId={target.hostId}
      provider={target.provider}
      dismiss={() => composer.experimental_closePopup()}
    />
  );
}
