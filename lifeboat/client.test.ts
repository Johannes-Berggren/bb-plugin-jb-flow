// @vitest-environment node
import { describe, expect, it, vi, afterEach } from "vitest";
import { createLifeboatClient } from "./client";
import { fixtureSnapshot } from "./fixtures";

afterEach(() => vi.useRealTimers());
function setup() {
  const client = createLifeboatClient();
  const call = vi.fn(
    async (method: string): Promise<unknown> =>
      method === "lifeboat_hosts"
        ? {
            localHostId: "studio",
            hosts: [
              { id: "studio", name: "Studio", connected: true },
              { id: "air", name: "Air", connected: true },
            ],
          }
        : { ok: true, state: fixtureSnapshot() },
  );
  const release = client.acquire({ call } as unknown as Parameters<
    typeof client.acquire
  >[0]);
  return { client, call, release };
}
describe("Shared Lifeboat reads", () => {
  it("shares one read across all consumers and stops its clock after the last one leaves", async () => {
    vi.useFakeTimers();
    const { client, call, release } = setup();
    await client.discover();
    const a = client.watch("studio");
    const b = client.watch("studio");
    await client.run("studio", { command: "status" });
    expect(
      call.mock.calls.filter(([method]) => method === "lifeboat_run"),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      call.mock.calls.filter(([method]) => method === "lifeboat_run"),
    ).toHaveLength(2);
    a();
    b();
    release();
    expect(vi.getTimerCount()).toBe(0);
    client.reset();
  });
  it("updates only the requested Mac, and keeps its last snapshot when a read fails", async () => {
    const { client, call, release } = setup();
    await client.discover();
    await client.run("studio", { command: "status" });
    call.mockImplementationOnce(async () => ({ ok: false, error: "Offline" }));
    await client.run("air", { command: "status" }, true);
    expect(
      client.getSnapshot().readings.studio.snapshot?.accounts,
    ).toHaveLength(4);
    expect(client.getSnapshot().readings.air.snapshot).toBeNull();
    call.mockImplementationOnce(async () => ({
      ok: false,
      error: "Read failed",
    }));
    await client.run("studio", { command: "status" }, true);
    expect(
      client.getSnapshot().readings.studio.snapshot?.accounts,
    ).toHaveLength(4);
    expect(client.getSnapshot().readings.studio.error).toBe("Read failed");
    release();
    client.reset();
  });
});
