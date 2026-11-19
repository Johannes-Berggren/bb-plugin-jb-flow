// A model menu next to BB's "Approve plan" button (the "Model choice on plan
// approval" setting). Core renderers can't be replaced, so this overlay finds the
// plan card by BB's own test id and portals its controls into the card's footer.
// The approval itself runs on the server (plan-model.ts).
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { useBbContext, useRpc, useSettings, useSidebarSplitLayout } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import type { PlanModels } from "./plan-model";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { usePortalScopeProps } from "@/lib/portal-scope";

const PLAN_BANNER = 'section[data-testid="plan-review-banner"]';
const HOST_CLASS = "jf-plan-model";
/** The model last chosen here; shown as a one-click button while it's offered. */
export const LAST_MODEL_KEY = "jb-flow-plan-model";

/** BB's own Approve plan button in one plan card. */
function approveButtonIn(banner: Element): HTMLButtonElement | null {
  const buttons = Array.from(banner.querySelectorAll<HTMLButtonElement>("button"));
  return buttons.find((button) => button.textContent?.trim() === "Approve plan") ?? null;
}

/**
 * Every plan card on screen with its Approve plan button, and the split pane
 * it sits in. A split can show several, one per pane whose thread has a plan
 * waiting.
 */
export function findPlanCards(root: ParentNode): { approve: HTMLButtonElement; paneId: string | null }[] {
  return Array.from(root.querySelectorAll(PLAN_BANNER)).flatMap((banner) => {
    const approve = approveButtonIn(banner);
    if (!approve) return [];
    return [{ approve, paneId: banner.closest("[data-split-pane-id]")?.getAttribute("data-split-pane-id") ?? null }];
  });
}

type PlanHost = { host: HTMLElement; paneId: string | null };

/** A host element just before each Approve plan button, kept in step with the DOM. */
function usePlanFooterHosts(enabled: boolean): PlanHost[] {
  const [hosts, setHosts] = useState<PlanHost[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let current: (PlanHost & { approve: HTMLButtonElement })[] = [];
    const sync = () => {
      const cards = findPlanCards(document);
      const unchanged =
        cards.length === current.length &&
        cards.every((card, index) => {
          const held = current[index]!;
          return held.approve === card.approve && held.paneId === card.paneId && held.host.nextElementSibling === card.approve;
        });
      if (unchanged) return;
      for (const held of current) held.host.remove();
      current = cards.map(({ approve, paneId }) => {
        const host = document.createElement("span");
        host.className = `${HOST_CLASS} inline-flex items-center gap-1`;
        approve.before(host);
        return { host, paneId, approve };
      });
      setHosts(current.map(({ host, paneId }) => ({ host, paneId })));
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const held of current) held.host.remove();
      setHosts([]);
    };
  }, [enabled]);
  return hosts;
}

function readLastModel(): string | null {
  try {
    return localStorage.getItem(LAST_MODEL_KEY);
  } catch {
    return null;
  }
}

function writeLastModel(model: string | null) {
  try {
    if (model === null) localStorage.removeItem(LAST_MODEL_KEY);
    else localStorage.setItem(LAST_MODEL_KEY, model);
  } catch {
    /* Not remembered on this device. */
  }
}

export function PlanModelPicker() {
  const enabled = useSettings().values?.planModelChoice === true;
  const { threadId: routeThreadId } = useBbContext();
  const split = useSidebarSplitLayout();
  const hosts = usePlanFooterHosts(enabled);
  if (!enabled) return null;
  return (
    <>
      {hosts.map(({ host, paneId }) => {
        // Each card approves its own pane's thread, focused or not. Outside a
        // split, the single pane shows the route's thread.
        const threadId = split ? (split.panes.find((pane) => pane.paneId === paneId)?.threadId ?? null) : routeThreadId;
        return threadId ? createPortal(<PlanModelMenu key={threadId} threadId={threadId} />, host, `${paneId ?? "page"}:${threadId}`) : null;
      })}
    </>
  );
}

/** When to ask again while the server doesn't list the card's plan as waiting yet. */
const RETRIES_MS = [500, 1500, 4000];

export function PlanModelMenu({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const portalScope = usePortalScopeProps();
  const [data, setData] = useState<PlanModels | null>(null);
  const [lastModel, setLastModel] = useState(readLastModel);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    let timer = 0;
    // The card can show a moment before the server lists its plan as waiting:
    // look again a few times before giving up.
    const read = (attempt: number) =>
      rpc.call("plan_models", { threadId }).then(
        (result) => {
          if (!live) return;
          setData(result);
          if (!result.pending && attempt < RETRIES_MS.length) timer = window.setTimeout(() => read(attempt + 1), RETRIES_MS[attempt]);
        },
        () => live && setData(null),
      );
    void read(0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [rpc, threadId]);

  if (!data?.pending || data.models.length < 2) return null;
  const quick = data.models.find((option) => option.model === lastModel && option.model !== data.current);

  const approve = (model: string) => {
    const isCurrent = model === data.current;
    writeLastModel(isCurrent ? null : model);
    setLastModel(isCurrent ? null : model);
    setBusy(true);
    rpc.call("plan_approve", { threadId, model: isCurrent ? null : model }).then(
      () => setBusy(false),
      (cause: unknown) => {
        setBusy(false);
        toast.error(cause instanceof Error ? cause.message : "Couldn't approve the plan.");
      },
    );
  };

  const item =
    "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-state-hover";
  return (
    <>
      {quick && (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => approve(quick.model)}>
          {busy && <Icon name="Spinner" className="size-3 animate-spin" />}
          Approve with {quick.name}
        </Button>
      )}
      <DropdownMenuPrimitive.Root>
        <DropdownMenuPrimitive.Trigger asChild>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label="Approve with another model"
            className="px-2"
          >
            {quick ? null : "Approve with"}
            <Icon name="ChevronDown" className="size-3" />
          </Button>
        </DropdownMenuPrimitive.Trigger>
        <DropdownMenuPrimitive.Portal>
          <DropdownMenuPrimitive.Content
            {...portalScope}
            align="end"
            sideOffset={6}
            className="z-50 min-w-48 max-w-80 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          >
            <DropdownMenuPrimitive.Label className="px-2 pb-1 pt-1.5 text-[11px] text-muted-foreground">
              Approve and implement with
            </DropdownMenuPrimitive.Label>
            {data.models.map((option) => (
              <DropdownMenuPrimitive.Item key={option.model} className={item} onSelect={() => approve(option.model)}>
                {option.model === data.current ? `${option.name} (current)` : option.name}
              </DropdownMenuPrimitive.Item>
            ))}
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Root>
    </>
  );
}
