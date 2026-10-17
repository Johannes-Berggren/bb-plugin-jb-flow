import { describe, expect, it } from "vitest";
import {
  accountStatus,
  historySegments,
  recommended,
  remaining,
  resetLabel,
  STALE_MS,
} from "./model";
import { snapshotSchema, operationSchema } from "./contract";
import {
  fixtureAccount,
  fixtureSnapshot,
  FIXTURE_NOW,
  SPARE_ID,
  CLAUDE_ID,
} from "./fixtures";

describe("Lifeboat capacity policy", () => {
  it("never advertises stale, failed, unknown, or elapsed-reset capacity as ready", () => {
    const account = fixtureAccount();
    expect(accountStatus(account, FIXTURE_NOW)).toBe("ready");
    expect(accountStatus(account, FIXTURE_NOW + STALE_MS)).toBe("stale");
    expect(accountStatus(account, FIXTURE_NOW, "Login rejected")).toBe(
      "attention",
    );
    expect(accountStatus({ ...account, reading: null }, FIXTURE_NOW)).toBe(
      "unknown",
    );
    account.reading!.windows[0].resetsAt = new Date(
      FIXTURE_NOW - 1,
    ).toISOString();
    expect(accountStatus(account, FIXTURE_NOW)).toBe("reset-due");
    expect(resetLabel(account.reading!.windows[0], FIXTURE_NOW)).toContain(
      "refresh to confirm",
    );
  });
  it("uses the most constrained primary window and excludes scoped exhaustion from a generic handoff", () => {
    const state = fixtureSnapshot();
    expect(remaining(state.accounts[0])).toBe(62);
    expect(recommended(state, "claude", FIXTURE_NOW)?.id).toBe(SPARE_ID);
    state.accounts
      .find((account) => account.id === SPARE_ID)!
      .reading!.windows.push({
        id: "weekly-opus",
        kind: "weeklyScoped",
        label: "Opus",
        usedPercent: 100,
        risk: "depleted",
      });
    expect(recommended(state, "claude", FIXTURE_NOW)).toBeNull();
    expect(recommended(state, "claude", FIXTURE_NOW + STALE_MS)).toBeNull();
  });
  it("breaks history at resets, usage drops, and observation gaps", () => {
    const state = fixtureSnapshot();
    const segments = historySegments(state, CLAUDE_ID, "session");
    expect(segments.length).toBeGreaterThan(4);
    expect(
      segments.every((segment) =>
        segment.every(
          (point, index) =>
            index === 0 || point.used >= segment[index - 1].used,
        ),
      ),
    ).toBe(true);
    expect(historySegments(state, CLAUDE_ID, "missing")).toEqual([]);
  });
  it("bounds the wire contract and rejects frontend paths, secret input, and invalid usage", () => {
    expect(snapshotSchema.safeParse(fixtureSnapshot()).success).toBe(true);
    expect(
      operationSchema.safeParse({
        command: "capture",
        provider: "codex",
        dataDir: "/tmp",
      }).success,
    ).toBe(false);
    expect(
      operationSchema.safeParse({
        command: "switch",
        accountID: CLAUDE_ID,
        token: "secret",
      }).success,
    ).toBe(false);
    const state = fixtureSnapshot();
    state.accounts[0].reading!.windows[0].usedPercent = Infinity;
    expect(snapshotSchema.safeParse(state).success).toBe(false);
  });
});
