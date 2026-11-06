// Settings panels for triage lanes and the area-tag migration.
import { useMemo, useState } from "react";
import { experimental_useSidebarThreads as useSidebarThreads, useSdk } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarSection } from "@get-bb/plugin-sdk/app";
import { LANE_NAMES, matchLanes, resolveLanes, sectionNames, type LaneId, type LaneSections } from "./lanes";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useFlowState, errorText } from "./flow-state";
const LANES_HINT_KEY = "jb-flow:lanes-hint-hidden";

/** New installs have no lane sections; say so once, with a one-click fix. */
export function MissingLanesHint({ sections, pinned }: { sections: readonly PluginSidebarSection[]; pinned: LaneSections }) {
  const sdk = useSdk();
  const [hidden, setHidden] = useState(() => localStorage.getItem(LANES_HINT_KEY) === "1");
  const [pending, setPending] = useState(false);
  const matched = matchLanes(sections, pinned);
  const missing = (Object.keys(LANE_NAMES) as LaneId[]).filter((lane) => !matched[lane]);
  if (hidden || missing.length === 0) return null;
  return (
    <div className="mx-2 mt-2 rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground">
      {missing.length === 4 ? "No lane sections yet" : `Missing lanes: ${missing.map((lane) => LANE_NAMES[lane]).join(", ")}`}. Number keys
      move a thread into a lane.
      <div className="mt-1 flex gap-2">
        <button
          type="button"
          disabled={pending}
          className="rounded px-1 text-foreground hover:bg-accent"
          onClick={async () => {
            setPending(true);
            try {
              for (const lane of missing) await sdk.threadSections.create({ name: LANE_NAMES[lane] });
            } finally {
              setPending(false);
            }
          }}
        >
          Create {missing.length === 1 ? "it" : "them"}
        </button>
        <button
          type="button"
          className="rounded px-1 hover:bg-accent"
          onClick={() => {
            localStorage.setItem(LANES_HINT_KEY, "1");
            setHidden(true);
          }}
        >
          Hide
        </button>
      </div>
    </div>
  );
}

export function LaneSettings() {
  const sdk = useSdk();
  const { state } = useFlowState();
  const { sections } = useSidebarThreads();
  const matched = matchLanes(sections, state?.laneSections ?? {});
  const missing = (Object.keys(LANE_NAMES) as LaneId[]).filter((lane) => !matched[lane]);
  const [pending, setPending] = useState(false);
  return (
    <div className="jf-settings space-y-3 text-sm">
      <p className="text-muted-foreground">
        The Triage list's lanes (keys 1, 3, 4 and 5) are sections named Priority, Waiting for others, Pick up later and
        Low priority. Active (key 2) is always there. Rename a lane's section later and it keeps its role.
      </p>
      {missing.length === 0 ? (
        <p>All lanes have a section.</p>
      ) : (
        <Button
          size="sm"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            try {
              for (const lane of missing) await sdk.threadSections.create({ name: LANE_NAMES[lane] });
            } finally {
              setPending(false);
            }
          }}
        >
          Create {missing.map((lane) => LANE_NAMES[lane]).join(", ")}
        </Button>
      )}
    </div>
  );
}

export function MigrationSettings() {
  const { rpc, state } = useFlowState();
  const { sections } = useSidebarThreads();
  const lanes = useMemo(() => resolveLanes(sections, state?.laneSections), [sections, sectionNames(sections), state?.laneSections]);
  const laneIds = new Set(lanes.map((lane) => lane.sectionId));
  const candidates = sections.filter(
    (section) =>
      !laneIds.has(section.id) &&
      section.id !== state?.snoozedSectionId,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <div className="jf-settings space-y-3 text-sm">
      <p className="text-muted-foreground">
        Turn "area" sections into tags. Their threads get the tag and move to
        the Active lane, so one thread can be both #Commercial and Waiting. The
        sections themselves are kept.
      </p>
      <div className="space-y-1.5">
        {candidates.map((section) => (
          <label key={section.id} className="flex items-center gap-2">
            <Checkbox
              checked={selected.has(section.id)}
              onCheckedChange={(checked) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (checked === true) next.add(section.id);
                  else next.delete(section.id);
                  return next;
                })
              }
            />
            {section.name}
          </label>
        ))}
      </div>
      <Button
        size="sm"
        disabled={pending || selected.size === 0}
        onClick={async () => {
          setPending(true);
          try {
            const { tagged } = await rpc.call("migrate_areas", {
              sectionIds: [...selected],
              moveToSectionId: null,
            });
            setResult(`Tagged and moved ${tagged} thread(s).`);
            setSelected(new Set());
          } catch (cause) {
            setResult(errorText(cause));
          } finally {
            setPending(false);
          }
        }}
      >
        Convert to tags
      </Button>
      {result === null ? null : (
        <p className="text-muted-foreground">{result}</p>
      )}
    </div>
  );
}
