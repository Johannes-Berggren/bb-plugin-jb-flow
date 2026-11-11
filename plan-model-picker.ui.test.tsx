import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { findApproveButton, LAST_MODEL_KEY, PlanModelMenu } from "./plan-model-picker";

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

it("finds BB's Approve plan button only when one plan card is on screen", () => {
  const card = `<section data-testid="plan-review-banner"><button>Keep planning</button><button> Approve plan</button></section>`;
  const root = document.createElement("div");
  root.innerHTML = card;
  expect(findApproveButton(root)?.textContent?.trim()).toBe("Approve plan");
  root.innerHTML = card + card;
  expect(findApproveButton(root)).toBeNull();
});
