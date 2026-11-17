// Machine-local config from local.config.json and the "Advanced config"
// setting. server.ts copies the file into the setting once at startup.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { repoCommandSchema } from "./repo-commands";
import { releaseWatchSchema } from "./watchers";

// Machine-local setup: pinned repo commands, how project names are shortened in
// the sidebar, and release watches. Comes from local.config.json in the plugin
// folder (see local.config.example.json) and/or the "Advanced config" setting,
// which wins key by key.
export const localConfigSchema = z.object({
  repoCommands: z.record(z.string(), z.array(repoCommandSchema)).default({}),
  projectShortNames: z.record(z.string(), z.string()).default({}),
  stripProjectPrefixes: z.array(z.string()).default([]),
  /** Projects (by BB name) whose release-blocked threads are woken on release. */
  releaseWatch: z.record(z.string(), releaseWatchSchema).default({}),
});
export type LocalConfig = z.infer<typeof localConfigSchema>;

export function loadLocalConfig(bb: BbPluginApi, settingJson: string): LocalConfig {
  const file = readLocalConfigFile(bb);
  if (!settingJson.trim()) return file;
  try {
    const fromSetting = localConfigSchema.partial().parse(JSON.parse(settingJson));
    return { ...file, ...Object.fromEntries(Object.entries(fromSetting).filter(([, value]) => value !== undefined)) };
  } catch (error) {
    bb.log.warn(`ignoring invalid Advanced config setting: ${String(error)}`);
    return file;
  }
}

export function readLocalConfigFile(bb: BbPluginApi): LocalConfig {
  // The bundle may run from the plugin root or from dist/, so try both.
  for (const relative of ["./local.config.json", "../local.config.json"]) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    try {
      return localConfigSchema.parse(JSON.parse(text));
    } catch (error) {
      bb.log.warn(`ignoring invalid ${path}: ${String(error)}`);
    }
  }
  return localConfigSchema.parse({});
}
