import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { findPlanCards, LAST_MODEL_KEY, PlanModelMenu, PlanModelPicker } from "./plan-model-picker";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const models = {
  pending: true,
  current: "acme-small",
  models: [
    { model: "acme-small", name: "Acme Small" },
    { model: "acme-large", name: "Acme Large" },
  ],
};

function openMenu(slot: ReturnType<typeof renderSlot>, trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return slot.findByRole("menuitem", { name: "Acme Large" });
}

it("approves on the chosen model and offers it as one click next time", async () => {
  const approve = vi.fn(async () => ({ ok: true }));
  const slot = renderSlot(
    { component: PlanModelMenu },
    { threadId: "t1" },
    { rpc: { plan_models: () => models, plan_approve: approve } },
  );
  const trigger = await slot.findByRole("button", { name: "Approve with another model" });
  expect(slot.queryByRole("button", { name: /^Approve with Acme/ })).toBeNull();
  fireEvent.click(await openMenu(slot, trigger));
  await waitFor(() => expect(approve).toHaveBeenCalledWith({ threadId: "t1", model: "acme-large" }));
  expect(localStorage.getItem(LAST_MODEL_KEY)).toBe("acme-large");
  await slot.findByRole("button", { name: "Approve with Acme Large" });
  slot.lifecycle.unmount();
});

it("approving on the current model sends no model and forgets the remembered one", async () => {
  localStorage.setItem(LAST_MODEL_KEY, "acme-large");
  const approve = vi.fn(async () => ({ ok: true }));
  const slot = renderSlot(
    { component: PlanModelMenu },
    { threadId: "t1" },
    { rpc: { plan_models: () => models, plan_approve: approve } },
  );
  await slot.findByRole("button", { name: "Approve with Acme Large" });
  await openMenu(slot, slot.getByRole("button", { name: "Approve with another model" }));
  fireEvent.click(slot.getByRole("menuitem", { name: "Acme Small (current)" }));
  await waitFor(() => expect(approve).toHaveBeenCalledWith({ threadId: "t1", model: null }));
  expect(localStorage.getItem(LAST_MODEL_KEY)).toBeNull();
  slot.lifecycle.unmount();
});

it("shows nothing without a waiting plan or a second model", async () => {
  const listed = vi.fn(() => ({ ...models, models: models.models.slice(0, 1) }));
  const slot = renderSlot(
    { component: PlanModelMenu },
    { threadId: "t1" },
    { rpc: { plan_models: listed, plan_approve: vi.fn() } },
  );
  await waitFor(() => expect(listed).toHaveBeenCalled());
  expect(slot.queryByRole("button")).toBeNull();
  slot.lifecycle.unmount();
});

it("finds every plan card's Approve plan button, with the pane it sits in", () => {
  const card = `<section data-testid="plan-review-banner"><button>Keep planning</button><button> Approve plan</button></section>`;
  const root = document.createElement("div");
  root.innerHTML = card;
  expect(findPlanCards(root).map((found) => [found.approve.textContent?.trim(), found.paneId])).toEqual([["Approve plan", null]]);
  root.innerHTML = `<div data-split-pane-id="p1">${card}</div><div data-split-pane-id="p2">${card}</div>`;
  expect(findPlanCards(root).map((found) => found.paneId)).toEqual(["p1", "p2"]);
});

it("in a split, each plan card gets a menu for its own pane's thread, focused or not", async () => {
  const card = `<section data-testid="plan-review-banner"><button>Keep planning</button><button>Approve plan</button></section>`;
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div id="qa-split"><div data-split-pane-id="p1"></div><div data-split-pane-id="p2">${card}</div><div data-split-pane-id="p3">${card}</div></div>`,
  );
  const asked: string[] = [];
  const slot = renderSlot(
    { component: PlanModelPicker },
    {},
    {
      settings: { planModelChoice: true },
      rpc: {
        plan_models: ({ threadId }: { threadId: string }) => (asked.push(threadId), models),
        plan_approve: vi.fn(),
      },
      // The focused pane has no plan; the two others do.
      sidebarSplitLayout: {
        panes: ["t1", "t2", "t3"].map((threadId, index) => ({
          paneId: `p${index + 1}`,
          threadId,
          isFocused: index === 0,
          rect: { x: index / 3, y: 0, width: 1 / 3, height: 1 },
        })),
      },
    } as never,
  );
  await waitFor(() => expect(document.querySelectorAll('button[aria-label="Approve with another model"]')).toHaveLength(2));
  expect([...asked].sort()).toEqual(["t2", "t3"]);
  expect(document.querySelector('[data-split-pane-id="p1"] .jf-plan-model')).toBeNull();
  slot.lifecycle.unmount();
  document.getElementById("qa-split")?.remove();
});

it("asks again when the card shows before the server lists the plan as waiting", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let calls = 0;
  const slot = renderSlot(
    { component: PlanModelMenu },
    { threadId: "t1" },
    { rpc: { plan_models: () => (calls += 1) > 1 ? models : { pending: false, current: null, models: [] }, plan_approve: vi.fn() } },
  );
  await waitFor(() => expect(calls).toBe(1));
  await vi.advanceTimersByTimeAsync(600);
  await slot.findByRole("button", { name: "Approve with another model" });
  vi.useRealTimers();
  slot.lifecycle.unmount();
});
