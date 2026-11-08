// The window's one copy of the plugin state, shared by every component, plus
// small helpers (error text, project chips) that read it.
import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import type { FlowState, rpcContract } from "./server";
const DAY_MS = 86_400_000;

// --- shared state -------------------------------------------------------------

// One store for every component in this window: the list, header strip, PR
// tab and snooze header all used to fetch the full state on each change.
type FlowRpc = ReturnType<typeof useRpc<typeof rpcContract>>;
export let flowState: FlowState | null = null;
const flowListeners = new Set<(next: FlowState) => void>();
let flowScheduled = false;
let flowInflight = false;
let flowAgain = false;

function refetchFlowState(rpc: FlowRpc) {
  // Coalesce: every subscribed component hears the same realtime event.
  if (flowScheduled) return;
  flowScheduled = true;
  setTimeout(() => {
    flowScheduled = false;
    fetchFlowState(rpc);
  }, 0);
}

function fetchFlowState(rpc: FlowRpc) {
  if (flowInflight) {
    flowAgain = true;
    return;
  }
  flowInflight = true;
  rpc
    .call("state_get", null)
    .then((next) => {
      projectNaming = next;
      flowState = next;
      for (const listener of flowListeners) listener(next);
    }, () => undefined)
    .finally(() => {
      flowInflight = false;
      if (flowAgain) {
        flowAgain = false;
        fetchFlowState(rpc);
      }
    });
}

export function useFlowState() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [state, setState] = useState<FlowState | null>(flowState);
  useEffect(() => {
    flowListeners.add(setState);
    if (flowState === null) refetchFlowState(rpc);
    else setState(flowState);
    return () => {
      flowListeners.delete(setState);
    };
  }, [rpc]);
  const refetch = useCallback(() => refetchFlowState(rpc), [rpc]);
  useRealtime("jb-flow-changed", refetch);
  useEffect(() => {
    if (connection === "connected") refetchFlowState(rpc);
  }, [connection, rpc]);
  return { rpc, state };
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// --- lanes --------------------------------------------------------------------

// --- project chips ------------------------------------------------------------

let projectNaming: Pick<FlowState, "projectShortNames" | "stripProjectPrefixes"> = {
  projectShortNames: {}, stripProjectPrefixes: [],
};

function shortProjectName(name: string): string {
  const known = projectNaming.projectShortNames[name];
  if (known) return known;
  const prefix = projectNaming.stripProjectPrefixes.find((candidate) => name.startsWith(candidate));
  return (prefix ? name.slice(prefix.length) : name).slice(0, 10);
}

export function ProjectChip({
  project,
}: {
  project: PluginSidebarProject | undefined;
}) {
  if (project === undefined || project.isPersonal) return null;
  return (
    <span
      className="jf-project-chip"
      title={project.name}
    >
      {shortProjectName(project.name)}
    </span>
  );
}
