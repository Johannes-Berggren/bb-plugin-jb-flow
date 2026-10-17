import { useEffect, useSyncExternalStore } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { lifeboatRpc } from "./contract";
import { EMPTY_READING, lifeboatClient } from "./client";

/** undefined selects this BB server's Mac; null deliberately requests no Mac. */
export function useLifeboatData(requestedHost?: string | null) {
  const rpc = useRpc<typeof lifeboatRpc>();
  const connection = useRealtimeConnectionState();
  const state = useSyncExternalStore(
    lifeboatClient.subscribe,
    lifeboatClient.getSnapshot,
  );
  const hostId =
    requestedHost === null
      ? ""
      : (requestedHost ??
        state.localHostId ??
        state.hosts.find((host) => host.connected)?.id ??
        state.hosts[0]?.id ??
        "");
  useEffect(() => lifeboatClient.acquire(rpc), [rpc]);
  useEffect(() => {
    if (hostId && state.inventoryLoaded) return lifeboatClient.watch(hostId);
  }, [hostId, state.inventoryLoaded]);
  useRealtime("lifeboat-changed", (payload) => {
    if (
      payload &&
      typeof payload === "object" &&
      "hostId" in payload &&
      typeof payload.hostId === "string"
    )
      lifeboatClient.invalidate(payload.hostId);
  });
  useEffect(() => {
    lifeboatClient.connectionChanged(connection);
  }, [connection]);
  const reading = state.readings[hostId] ?? EMPTY_READING;
  return {
    ...reading,
    ...state,
    hostId,
    loading:
      !state.inventoryLoaded ||
      (!!hostId && !state.readings[hostId]) ||
      reading.loading,
    error: state.inventoryError ?? reading.error,
    run: async (operation: Parameters<typeof lifeboatClient.run>[1]) => {
      if (operation.command === "status") await lifeboatClient.discover(true);
      const latest = lifeboatClient.getSnapshot();
      const resolved =
        requestedHost === null
          ? ""
          : (requestedHost ??
            latest.localHostId ??
            latest.hosts.find((host) => host.connected)?.id ??
            latest.hosts[0]?.id ??
            "");
      return lifeboatClient.run(resolved, operation, true);
    },
  };
}
