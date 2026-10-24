import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DecisionChips } from "./decision-choices";

afterEach(cleanup);
const options = [
  {
    n: 1,
    text: "Build step 3 for builds and pre-choruses, keeping the existing measurement and full validation intact",
    recommended: true,
  },
  { n: 2, text: "Stop here; the measurement is enough", recommended: false },
];
it("shows full choice text and recommendation, sends only the number, and prevents duplicate replies", async () => {
  let finish!: (value: { ok: boolean }) => void;
  const reply = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    {
      rpc: { decision_options: () => ({ options }), thread_reply: reply },
    },
  );
  const button = await slot.findByRole("button", {
    name: `Reply 1: ${options[0].text} (recommended)`,
  });
  expect(slot.getByText("Recommended")).toBeTruthy();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(reply).toHaveBeenCalledTimes(1);
  expect(reply.mock.calls[0]).toEqual([{ threadId: "t1", text: "1" }]);
  expect(slot.getByText("Sending…")).toBeTruthy();
  finish({ ok: true });
  await slot.findByText("Reply sent");
  expect(slot.getByRole("status").textContent).toBe("Reply 1 sent");
  expect(button.hasAttribute("disabled")).toBe(true);
  slot.lifecycle.unmount();
});
it("shows a failed send and re-enables every choice for retry", async () => {
  const reply = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ ok: true });
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    {
      rpc: { decision_options: () => ({ options }), thread_reply: reply },
    },
  );
  const button = await slot.findByRole("button", {
    name: `Reply 2: ${options[1].text}`,
  });
  fireEvent.click(button);
  await slot.findByRole("alert");
  expect(button.hasAttribute("disabled")).toBe(false);
  fireEvent.click(button);
  await slot.findByRole("status");
  expect(reply).toHaveBeenCalledTimes(2);
  slot.lifecycle.unmount();
});
it("fetches nothing while running or without a thread, and ignores results after unmount", async () => {
  const read = vi.fn(() => ({ options }));
  const running = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: false },
    { rpc: { decision_options: read } },
  );
  expect(read).not.toHaveBeenCalled();
  expect(running.queryByRole("region")).toBeNull();
  running.lifecycle.unmount();
  let finish!: (value: { options: typeof options }) => void;
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    {
      rpc: {
        decision_options: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    },
  );
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  slot.lifecycle.unmount();
  finish({ options });
});
it("offers a go-list as steps to tick and Go, sending go or go with the picked steps", async () => {
  const steps = { mode: "go" as const, options: [...options, { n: 3, text: "Tidy the docs", recommended: false }] };
  const reply = vi.fn().mockResolvedValue({ ok: true });
  const all = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => steps, thread_reply: reply } },
  );
  fireEvent.click(await all.findByRole("button", { name: "Go" }));
  await all.findByText("Sent “go”");
  expect(reply.mock.calls[0]).toEqual([{ threadId: "t1", text: "go" }]);
  expect(all.getByRole("checkbox", { name: /Tidy the docs/ }).hasAttribute("disabled")).toBe(true);
  all.lifecycle.unmount();

  const some = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 2, idle: true },
    { rpc: { decision_options: () => steps, thread_reply: reply } },
  );
  fireEvent.click(await some.findByRole("checkbox", { name: /Tidy the docs/ }));
  fireEvent.click(some.getByRole("checkbox", { name: `Step 1: ${options[0].text} (recommended)` }));
  expect(some.getByRole("checkbox", { name: /Tidy the docs/ }).getAttribute("aria-checked")).toBe("true");
  const go = some.getByRole("button", { name: "Go with 1, 3" });
  fireEvent.click(go);
  fireEvent.click(go);
  await some.findByText("Sent “go 1,3”");
  expect(reply).toHaveBeenCalledTimes(2);
  expect(reply.mock.calls[1]).toEqual([{ threadId: "t1", text: "go 1,3" }]);
  some.lifecycle.unmount();
});
it("lets a failed Go be retried", async () => {
  const reply = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true });
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => ({ mode: "go", options }), thread_reply: reply } },
  );
  fireEvent.click(await slot.findByRole("button", { name: "Go" }));
  await slot.findByRole("alert");
  fireEvent.click(slot.getByRole("button", { name: "Go" }));
  await slot.findByText("Sent “go”");
  expect(reply).toHaveBeenCalledTimes(2);
  slot.lifecycle.unmount();
});
