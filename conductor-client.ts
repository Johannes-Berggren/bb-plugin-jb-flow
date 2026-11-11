// Which threads are conductors, for surfaces that treat them differently (the
// thread monitor stays out of a conductor's own conversation).
import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { ConductorBrief, ConductorFeed, rpcContract } from "./server";

const NONE: ReadonlySet<string> = new Set();

export function useConductorThreadIds(): ReadonlySet<string> {
  const enabled = useSettings().values?.conductor === true;
  const rpc = useRpc<typeof rpcContract>();
  const [ids, setIds] = useState<ReadonlySet<string>>(NONE);
  const load = useCallback(() => {
    if (!enabled) {
      setIds(NONE);
      return;
    }
    rpc.call("conductor_list", null).then(
      (list) => setIds(new Set(list.conductors.flatMap((entry) => (entry.threadId ? [entry.threadId] : [])))),
      () => undefined,
    );
  }, [enabled, rpc]);
  useEffect(load, [load]);
  useRealtime("jb-flow-changed", load);
  return ids;
}

/** The conductor's current brief per thread (the ones that need you), for Catch up and Now. */
export function useConductorBriefs(): ReadonlyMap<string, ConductorBrief> {
  const enabled = useSettings().values?.conductor === true;
  const rpc = useRpc<typeof rpcContract>();
  const [briefs, setBriefs] = useState<ReadonlyMap<string, ConductorBrief>>(EMPTY_BRIEFS);
  const load = useCallback(() => {
    if (!enabled) {
      setBriefs(EMPTY_BRIEFS);
      return;
    }
    rpc.call("conductor_briefs", null).then(
      (result) => setBriefs(new Map(result.briefs.map((brief) => [brief.threadId, brief]))),
      () => undefined,
    );
  }, [enabled, rpc]);
  useEffect(load, [load]);
  useRealtime("jb-flow-changed", load);
  return briefs;
}
const EMPTY_BRIEFS: ReadonlyMap<string, ConductorBrief> = new Map();

/** Local midnight: the feed counts "today". */
export function startOfToday(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** What autopilot did today, kept current. Null while the conductor is off or before the first read. */
export function useConductorFeed(): ConductorFeed | null {
  const enabled = useSettings().values?.conductor === true;
  const rpc = useRpc<typeof rpcContract>();
  const [feed, setFeed] = useState<ConductorFeed | null>(null);
  const load = useCallback(() => {
    if (!enabled) {
      setFeed(null);
      return;
    }
    rpc.call("conductor_feed", { since: startOfToday() }).then(setFeed, () => undefined);
  }, [enabled, rpc]);
  useEffect(load, [load]);
  useRealtime("jb-flow-changed", load);
  return feed;
}

/** "1.4M", "820k": a token count as people say it. */
export function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}
