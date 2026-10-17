import { describe, expect, it } from "vitest";
import { capacitySummary, composerTarget, lifeboatProvider } from "./context";
import { fixtureSnapshot, FIXTURE_NOW } from "./fixtures";
import { STALE_MS } from "./model";

describe("Contextual account capacity", () => {
  it("uses the explicitly selected Mac and never falls back for an unresolved target", () => {
    const scope = { kind: "new-thread", projectId: null } as const;
    expect(
      composerTarget(
        scope,
        {
          providerId: "codex",
          environment: {
            type: "host",
            hostId: "air",
            workspace: { type: "personal" },
          },
        },
        [],
      ),
    ).toEqual({ provider: "codex", hostId: "air" });
    expect(
      composerTarget(
        scope,
        { providerId: "codex", environment: { type: "project-default" } },
        [],
      ),
    ).toEqual({ provider: "codex", hostId: null });
    expect(
      composerTarget(
        { kind: "thread", threadId: "missing" },
        { providerId: "claude-code" },
        [],
      ),
    ).toEqual({ provider: "claude", hostId: null });
    expect(lifeboatProvider("pi")).toBeNull();
    expect(lifeboatProvider("custom-claude-adapter")).toBeNull();
  });
  it("shows an observed CLI account's limiting quota, not pooled or stale capacity", () => {
    const state = fixtureSnapshot();
    expect(capacitySummary(state, "codex", FIXTURE_NOW).text).toBe("14% left");
    expect(capacitySummary(state, "codex", FIXTURE_NOW, true).value).toBeNull();
    expect(
      capacitySummary(state, "codex", FIXTURE_NOW + STALE_MS).value,
    ).toBeNull();
    state.accounts[1].isActive = false;
    expect(capacitySummary(state, "codex", FIXTURE_NOW).text).toBe(
      "Confirm CLI login",
    );
  });
});
