import type { Account, Snapshot } from "./contract";
export const FIXTURE_NOW = Date.parse("2026-10-17T10:30:00Z");
export const CLAUDE_ID = "11111111-1111-4111-8111-111111111111";
export const CODEX_ID = "22222222-2222-4222-8222-222222222222";
export const SPARE_ID = "33333333-3333-4333-8333-333333333333";
export const PERSONAL_ID = "44444444-4444-4444-8444-444444444444";
const at = (hours: number) =>
  new Date(FIXTURE_NOW + hours * 3600_000).toISOString();
export function fixtureAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: CLAUDE_ID,
    provider: "claude",
    label: "Work",
    email: "work@example.com",
    plan: "Max 20×",
    isActive: true,
    priority: 0,
    reading: {
      risk: "healthy",
      mostConstrainedPercent: 38,
      ageSeconds: 120,
      source: "Account usage API",
      lastRefreshed: at(-1 / 30),
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Current session",
          usedPercent: 38,
          risk: "healthy",
          resetsAt: at(2.75),
        },
        {
          id: "weekly-all",
          kind: "weekly",
          label: "Weekly · all models",
          usedPercent: 26,
          risk: "healthy",
          resetsAt: at(76),
        },
      ],
    },
    ...overrides,
  };
}
export function fixtureSnapshot(): Snapshot {
  const accounts: Account[] = [
    fixtureAccount(),
    fixtureAccount({
      id: CODEX_ID,
      provider: "codex",
      label: "Studio",
      email: "studio@example.com",
      plan: "Pro",
      reading: {
        risk: "warning",
        mostConstrainedPercent: 86,
        ageSeconds: 60,
        source: "Codex app server",
        lastRefreshed: at(-1 / 60),
        windows: [
          {
            id: "codex-300",
            kind: "session",
            label: "Current session",
            usedPercent: 86,
            risk: "warning",
            resetsAt: at(1.4),
          },
          {
            id: "codex-10080",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 44,
            risk: "healthy",
            resetsAt: at(42),
          },
        ],
      },
    }),
    fixtureAccount({
      id: SPARE_ID,
      label: "Personal",
      email: "personal@example.com",
      isActive: false,
      priority: 1,
      plan: "Pro",
      reading: {
        risk: "healthy",
        mostConstrainedPercent: 12,
        ageSeconds: 180,
        source: "Account usage API",
        lastRefreshed: at(-0.05),
        windows: [
          {
            id: "session",
            kind: "session",
            label: "Current session",
            usedPercent: 8,
            risk: "healthy",
            resetsAt: at(4.3),
          },
          {
            id: "weekly-all",
            kind: "weekly",
            label: "Weekly · all models",
            usedPercent: 12,
            risk: "healthy",
            resetsAt: at(120),
          },
        ],
      },
    }),
    fixtureAccount({
      id: PERSONAL_ID,
      provider: "codex",
      label: "Personal",
      email: "personal@example.com",
      isActive: false,
      priority: 1,
      plan: "Plus",
      reading: {
        risk: "healthy",
        mostConstrainedPercent: 22,
        ageSeconds: 120,
        source: "Codex app server",
        lastRefreshed: at(-1 / 30),
        windows: [
          {
            id: "codex-300",
            kind: "session",
            label: "Current session",
            usedPercent: 5,
            risk: "healthy",
            resetsAt: at(4.8),
          },
          {
            id: "codex-10080",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 22,
            risk: "healthy",
            resetsAt: at(65),
          },
        ],
      },
    }),
  ];
  return {
    schema: 1,
    generatedAt: at(0),
    source: "flow",
    accounts,
    issues: {},
    history: accounts.flatMap((account) =>
      Array.from({ length: 32 }, (_, index) => ({
        timestamp: at(-167 + index * 5.35),
        accountID: account.id,
        windows: account.reading!.windows.map((window) => ({
          id: window.id,
          kind: window.kind,
          usedPercent:
            window.kind === "session" ? (index % 5) * 16 : index * 0.7,
          resetDate:
            window.kind === "session"
              ? at(-167 + (Math.floor(index / 5) + 1) * 27)
              : window.resetsAt,
        })),
      })),
    ),
    sessions: [
      {
        pid: 17240,
        provider: "codex",
        project: "jb-flow",
        memoryBytes: 1.8 * 1024 ** 3,
        startedAt: at(-0.4),
      },
      {
        pid: 16382,
        provider: "claude",
        project: "hitlight-app",
        memoryBytes: 1.2 * 1024 ** 3,
        startedAt: at(-1.1),
      },
      {
        pid: 15803,
        provider: "codex",
        project: "findable",
        memoryBytes: 0.8 * 1024 ** 3,
        startedAt: at(-2),
      },
    ],
    memory: {
      level: "ok",
      availableBytes: 18.4 * 1024 ** 3,
      sessionBytes: 3.8 * 1024 ** 3,
      additionalSessions: 11,
      message: "Plenty of room for the work ahead.",
    },
  };
}
