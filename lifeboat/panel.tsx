import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_useProviders as useProviders,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { lifeboatRpc, type Operation, type Snapshot } from "./contract";
import { LifeboatView, type Host } from "./view";

export function LifeboatPanel() {
  const rpc = useRpc<typeof lifeboatRpc>();
  const navigate = useBbNavigate();
  const connection = useRealtimeConnectionState();
  const { providers } = useProviders();
  const [hosts, setHosts] = useState<Host[]>([]);
  const [hostId, setHostId] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const currentHost = useRef(hostId);
  currentHost.current = hostId;
  const busyHosts = useRef(new Set<string>());
  const mounted = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const discover = useCallback(async () => {
    try {
      const result = await rpc.call("lifeboat_hosts", null);
      if (!mounted.current) return;
      setHosts(result.hosts);
      setHostId((previous) =>
        result.hosts.some((host) => host.id === previous)
          ? previous
          : (result.hosts.find((host) => host.id === result.localHostId)?.id ??
            result.hosts.find((host) => host.connected)?.id ??
            result.hosts[0]?.id ??
            ""),
      );
      if (!result.hosts.length) {
        setLoading(false);
        setError("Connect a Mac to BB to use Lifeboat.");
      }
    } catch {
      if (mounted.current) {
        setLoading(false);
        setError(
          "The Mac list could not be loaded. Reconnect BB to try again.",
        );
      }
    }
  }, [rpc]);
  useEffect(() => {
    void discover();
  }, [discover, connection]);

  const run = useCallback(
    async (operation: Operation): Promise<boolean> => {
      const requestedHost = hostId;
      if (!requestedHost || busyHosts.current.has(requestedHost)) return false;
      const id = ++generation.current;
      const mutation = operation.command !== "status";
      if (mutation) {
        busyHosts.current.add(requestedHost);
        setBusy(true);
      }
      if (mounted.current) setError(null);
      try {
        const result = await rpc.call("lifeboat_run", {
          hostId: requestedHost,
          operation,
        });
        if (
          !mounted.current ||
          currentHost.current !== requestedHost ||
          generation.current !== id
        )
          return false;
        if (result.ok) {
          setSnapshot(result.state);
          setSetupRequired(false);
          return true;
        }
        setError(result.error);
        setSetupRequired(result.setupRequired ?? false);
        return false;
      } catch {
        if (
          mounted.current &&
          currentHost.current === requestedHost &&
          generation.current === id
        ) {
          setError(
            "BB lost touch with this Mac. An operation already started may still finish there. Reconnect and refresh before trying again.",
          );
        }
        return false;
      } finally {
        if (mutation) busyHosts.current.delete(requestedHost);
        if (mounted.current && currentHost.current === requestedHost) {
          if (mutation) setBusy(false);
          setLoading(false);
        }
      }
    },
    [rpc, hostId],
  );
  useEffect(() => {
    setSnapshot(null);
    setError(null);
    setSetupRequired(false);
    setLoading(!!hostId);
    setBusy(false);
    if (hostId) void run({ command: "status" });
  }, [hostId, run]);
  useRealtime("lifeboat-changed", (payload) => {
    if (
      payload &&
      typeof payload === "object" &&
      "hostId" in payload &&
      payload.hostId === hostId &&
      !busyHosts.current.has(hostId)
    )
      void run({ command: "status" });
  });
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (
        hostId &&
        document.visibilityState === "visible" &&
        !busyHosts.current.has(hostId)
      )
        void run({ command: "status" });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [hostId, run]);
  const providerNames = {
    claude: providers.find((provider) => provider.id === "claude-code")
      ?.displayName,
    codex: providers.find((provider) => provider.id === "codex")?.displayName,
  };
  return (
    <LifeboatView
      hosts={hosts}
      hostId={hostId}
      onHostChange={(next) => {
        generation.current++;
        setHostId(next);
      }}
      snapshot={snapshot}
      busy={busy}
      loading={loading}
      error={error}
      setupRequired={setupRequired}
      now={now}
      providerNames={providerNames}
      onOperation={run}
      onStudio={() => navigate.toPluginPanel("studio")}
    />
  );
}
