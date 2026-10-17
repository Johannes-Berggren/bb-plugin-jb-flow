import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readLocalHostId } from "../machines";
import { hostContract, type Operation, type Result } from "./contract";

export function createLifeboat(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const inflight = new Map<string, Promise<Result>>();
  const cache = new Map<string, { at: number; result: Result }>();
  let disposed = false;
  bb.onDispose(() => {
    disposed = true;
    cache.clear();
  });

  async function hosts() {
    return {
      localHostId: readLocalHostId(bb.server.experimental_dataDir),
      hosts: (await bb.sdk.hosts.list()).map((item) => ({
        id: item.id,
        name: item.name,
        connected: item.status === "connected",
      })),
    };
  }
  async function run(hostId: string, operation: Operation): Promise<Result> {
    const list = await hosts();
    if (!list.hosts.some((host) => host.id === hostId && host.connected)) {
      return {
        ok: false,
        error: "This Mac is offline. Connect it to BB, then retry.",
      };
    }
    if (operation.command === "status") {
      const cached = cache.get(hostId);
      if (cached && Date.now() - cached.at < 10_000) return cached.result;
      if (inflight.has(hostId)) return inflight.get(hostId)!;
    } else if (inflight.has(hostId)) {
      return {
        ok: false,
        error:
          "A Lifeboat operation is already running on this Mac. Wait for it to finish, then retry.",
      };
    }
    const task = host
      .call(
        "lifeboat",
        { operation },
        {
          hostId,
          timeoutMs: operation.command === "status" ? 30_000 : 300_000,
        },
      )
      .then(async (result): Promise<Result> => {
        if (disposed) return result;
        cache.set(hostId, { at: Date.now(), result });
        if (result.ok && operation.command !== "status") {
          // Monitor only Macs the user has explicitly brought into Flow.
          if (result.state.source === "flow") {
            const registered =
              (await bb.storage.kv.get<string[]>("lifeboat:hosts")) ?? [];
            await bb.storage.kv.set(
              "lifeboat:hosts",
              [...new Set([...registered, hostId])].slice(-100),
            );
          }
          bb.realtime.publish("lifeboat-changed", { hostId });
        }
        return result;
      })
      .catch((cause): Result => {
        bb.log.warn(
          `Lifeboat host call failed: ${cause instanceof Error ? cause.message : "unknown host error"}`,
        );
        return {
          ok: false,
          error:
            "Lifeboat could not reach this Mac's helper. Check that the Mac is connected and the helper is installed, then retry.",
        };
      })
      .finally(() => inflight.delete(hostId));
    inflight.set(hostId, task);
    return task;
  }
  return { hosts, run };
}
