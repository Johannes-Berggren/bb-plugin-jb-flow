// Lanes are sections with a role (number key, auto-fill for Waiting). Each is
// matched to a section by name once, then pinned by id, so renaming a lane's
// section keeps its role. A pinned section that's gone is matched again.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type LaneId = "priority" | "waiting" | "later" | "low";
export type LaneSections = Partial<Record<LaneId, string>>;

export const LANE_PATTERNS: Record<LaneId, RegExp> = {
  priority: /^\W*priority/i,
  waiting: /waiting/i,
  later: /pick up later/i,
  low: /low priority/i,
};

/** Pins stay while their section exists; missing lanes match by name, skipping sections another lane holds. */
export function matchLanes(sections: readonly { id: string; name: string }[], pinned: LaneSections): LaneSections {
  const ids = new Set(sections.map((section) => section.id));
  const result: LaneSections = {};
  for (const lane of Object.keys(LANE_PATTERNS) as LaneId[]) {
    const id = pinned[lane];
    if (id && ids.has(id)) result[lane] = id;
  }
  const taken = new Set(Object.values(result));
  for (const lane of Object.keys(LANE_PATTERNS) as LaneId[]) {
    if (result[lane]) continue;
    const match = sections.find((section) => !taken.has(section.id) && LANE_PATTERNS[lane].test(section.name));
    if (match) {
      result[lane] = match.id;
      taken.add(match.id);
    }
  }
  return result;
}

export async function laneSections(bb: BbPluginApi): Promise<LaneSections> {
  const pinned = (await bb.storage.kv.get<LaneSections>("laneSections")) ?? {};
  const sections = await bb.sdk.threadSections.list().catch(() => null);
  if (sections === null) return pinned;
  const result = matchLanes(sections, pinned);
  if (JSON.stringify(result) !== JSON.stringify(pinned)) await bb.storage.kv.set("laneSections", result);
  return result;
}
