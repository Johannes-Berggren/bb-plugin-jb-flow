// Which threads are conductors, for surfaces that treat them differently (the
// thread monitor stays out of a conductor's own conversation).
import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

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
