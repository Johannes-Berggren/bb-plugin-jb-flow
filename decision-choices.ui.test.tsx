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
