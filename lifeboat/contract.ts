import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const timestamp = z.string().datetime({ offset: true });
export const providerSchema = z.enum(["claude", "codex"]);
export type Provider = z.infer<typeof providerSchema>;
export const windowSchema = z.object({
  id: z.string().max(100),
  kind: z.string().max(40),
  label: z.string().max(160),
  usedPercent: z.number().finite().min(0).max(100),
  risk: z.string().max(40),
  resetsAt: timestamp.nullish(),
});
export const accountSchema = z.object({
  id: z.string().uuid(),
  provider: providerSchema,
  label: z.string().max(300),
  email: z.string().max(300).nullish(),
  organization: z.string().max(300).nullish(),
  plan: z.string().max(160).nullish(),
  isActive: z.boolean(),
  priority: z.number().int(),
  reading: z
    .object({
      risk: z.string().max(40),
      mostConstrainedPercent: z.number().min(0).max(100).nullish(),
      windows: z.array(windowSchema).max(30),
      lastRefreshed: timestamp,
      ageSeconds: z.number().int().nonnegative(),
      source: z.string().max(200),
      extraUsage: z.string().max(300).nullish(),
    })
    .nullish(),
});
export const snapshotSchema = z.object({
  schema: z.literal(1),
  generatedAt: timestamp,
  source: z.enum(["legacy", "flow"]),
  accounts: z.array(accountSchema).max(200),
  issues: z.record(z.string(), z.string().max(1000)),
  history: z
    .array(
      z.object({
        timestamp,
        accountID: z.string().uuid(),
        windows: z
          .array(
            z.object({
              id: z.string(),
              kind: z.string(),
              usedPercent: z.number().finite().min(0).max(100),
              resetDate: timestamp.nullish(),
              windowMinutes: z.number().nullish(),
            }),
          )
          .max(30),
      }),
    )
    .max(3000),
  sessions: z
    .array(
      z.object({
        pid: z.number().int().positive(),
        provider: providerSchema,
        project: z.string().max(500),
        memoryBytes: z.number().nonnegative(),
        startedAt: timestamp,
      }),
    )
    .max(200),
  memory: z
    .object({
      level: z.string(),
      availableBytes: z.number().nonnegative(),
      sessionBytes: z.number().nonnegative(),
      additionalSessions: z.number().int().nonnegative().nullable(),
      message: z.string().max(1000),
    })
    .optional(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Account = z.infer<typeof accountSchema>;
export type UsageWindow = z.infer<typeof windowSchema>;

export const operationSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("status") }).strict(),
  z.object({ command: z.literal("import") }).strict(),
  z
    .object({ command: z.literal("capture"), provider: providerSchema })
    .strict(),
  z
    .object({
      command: z.literal("refresh"),
      accountID: z.string().uuid().optional(),
    })
    .strict(),
  z.object({ command: z.literal("background") }).strict(),
  z
    .object({ command: z.literal("switch"), accountID: z.string().uuid() })
    .strict(),
  z
    .object({
      command: z.literal("rename"),
      accountID: z.string().uuid(),
      label: z.string().trim().min(1).max(80),
    })
    .strict(),
  z
    .object({ command: z.literal("remove"), accountID: z.string().uuid() })
    .strict(),
]);
export type Operation = z.infer<typeof operationSchema>;
export const resultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), state: snapshotSchema }),
  z.object({
    ok: z.literal(false),
    error: z.string().max(2000),
    setupRequired: z.boolean().optional(),
  }),
]);
export type Result = z.infer<typeof resultSchema>;

export const hostContract = defineRpcContract({
  lifeboat: {
    input: z.object({ operation: operationSchema }).strict(),
    output: resultSchema,
  },
});
export const lifeboatRpc = defineRpcContract({
  lifeboat_hosts: {
    input: z.null(),
    output: z.object({
      localHostId: z.string().nullable(),
      hosts: z.array(
        z.object({ id: z.string(), name: z.string(), connected: z.boolean() }),
      ),
    }),
  },
  lifeboat_run: {
    input: z
      .object({
        hostId: z.string().min(1).max(100),
        operation: operationSchema,
      })
      .strict(),
    output: resultSchema,
  },
});
