import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DecisionChips, REPEATED_LIST_ATTR, repeatedList } from "./decision-choices";

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
it("sends plain go when every step is ticked", async () => {
  const reply = vi.fn().mockResolvedValue({ ok: true });
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => ({ mode: "go", options }), thread_reply: reply } },
  );
  fireEvent.click(await slot.findByRole("checkbox", { name: /^Step 1:/ }));
  fireEvent.click(slot.getByRole("checkbox", { name: /^Step 2:/ }));
  fireEvent.click(slot.getByRole("button", { name: "Go" }));
  await slot.findByText("Sent “go”");
  expect(reply.mock.calls[0]).toEqual([{ threadId: "t1", text: "go" }]);
  slot.lifecycle.unmount();
});

const several = {
  mode: "multi" as const,
  options: [
    { n: 1, text: "Lint rule", recommended: true },
    { n: 2, text: "CI check", recommended: true },
    { n: 3, text: "Weekly flag list", recommended: false },
    { n: 4, text: "Draft a note to Alex", recommended: false },
  ],
};

it("ticks the recommended options when several can go together, and sends the picked numbers once", async () => {
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
    { rpc: { decision_options: () => several, thread_reply: reply } },
  );
  const first = await slot.findByRole("checkbox", { name: "Option 1: Lint rule (recommended)" });
  expect(first.getAttribute("aria-checked")).toBe("true");
  expect(slot.getByRole("checkbox", { name: /^Option 3:/ }).getAttribute("aria-checked")).toBe("false");
  expect(slot.getByText("Pick one or more")).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Pick several" })).toBeNull();
  fireEvent.click(slot.getByRole("checkbox", { name: /^Option 2:/ }));
  fireEvent.click(slot.getByRole("checkbox", { name: /^Option 4:/ }));
  const send = slot.getByRole("button", { name: "Send 1, 4" });
  fireEvent.click(send);
  fireEvent.click(send);
  expect(reply).toHaveBeenCalledTimes(1);
  expect(reply.mock.calls[0]).toEqual([{ threadId: "t1", text: "1,4" }]);
  finish({ ok: true });
  await slot.findByText("Sent “1,4”");
  expect(first.hasAttribute("disabled")).toBe(true);
  slot.lifecycle.unmount();
});

it("can't send several with nothing ticked, and lets a failed send be retried", async () => {
  const reply = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true });
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => several, thread_reply: reply } },
  );
  fireEvent.click(await slot.findByRole("checkbox", { name: /^Option 1:/ }));
  fireEvent.click(slot.getByRole("checkbox", { name: /^Option 2:/ }));
  expect(slot.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(slot.getByRole("checkbox", { name: /^Option 3:/ }));
  fireEvent.click(slot.getByRole("button", { name: "Send 3" }));
  expect((await slot.findByRole("alert")).textContent).toContain("Press Send to retry");
  fireEvent.click(slot.getByRole("button", { name: "Send 3" }));
  await slot.findByText("Sent “3”");
  expect(reply).toHaveBeenCalledTimes(2);
  slot.lifecycle.unmount();
});

it("switches a one-number decision to picking several, with the switch or a ⌘-click", async () => {
  const reply = vi.fn().mockResolvedValue({ ok: true });
  const choice = { mode: "choice" as const, options: several.options };
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => choice, thread_reply: reply } },
  );
  const toggle = await slot.findByRole("button", { name: "Pick several" });
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  // Nothing ticked yet: picking several starts empty.
  expect(slot.getAllByRole("checkbox").every((box) => box.getAttribute("aria-checked") === "false")).toBe(true);
  fireEvent.click(toggle);
  expect(slot.queryAllByRole("checkbox")).toHaveLength(0);
  // ⌘-click ticks that option instead of sending it.
  fireEvent.click(slot.getByRole("button", { name: /^Reply 3:/ }), { metaKey: true });
  expect(reply).not.toHaveBeenCalled();
  expect(slot.getByRole("checkbox", { name: /^Option 3:/ }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(slot.getByRole("checkbox", { name: /^Option 1:/ }));
  fireEvent.click(slot.getByRole("button", { name: "Send 1, 3" }));
  await slot.findByText("Sent “1,3”");
  expect(reply.mock.calls[0]).toEqual([{ threadId: "t1", text: "1,3" }]);
  slot.lifecycle.unmount();
});

it("keeps what's ticked when the thread changes but its options don't, and starts over when they do", async () => {
  const reply = vi.fn().mockResolvedValue({ ok: true });
  let move: { mode: "choice" | "multi"; options: typeof several.options } = { mode: "choice", options: several.options };
  const read = vi.fn(() => move);
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: read, thread_reply: reply } },
  );
  fireEvent.click(await slot.findByRole("button", { name: "Pick several" }));
  fireEvent.click(slot.getByRole("checkbox", { name: /^Option 3:/ }));
  // Opening the thread marks it read, which moves updatedAt.
  slot.lifecycle.rerender(<DecisionChips threadId="t1" updatedAt={2} idle />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await new Promise((done) => setTimeout(done, 0));
  // Still ticking: this click ticks, it doesn't send.
  fireEvent.click(slot.getByRole("checkbox", { name: /^Option 1:/ }));
  expect(reply).not.toHaveBeenCalled();
  expect(slot.getByRole("button", { name: "Send 1, 3" })).toBeTruthy();
  // A new reply with other options starts over.
  move = { mode: "multi", options: several.options.slice(0, 3) };
  slot.lifecycle.rerender(<DecisionChips threadId="t1" updatedAt={3} idle />);
  await slot.findByText("Pick one or more");
  expect(slot.getByRole("button", { name: "Send 1, 2" })).toBeTruthy();
  slot.lifecycle.unmount();
});

it("moves between options with the arrow keys, and a digit ticks one or only moves to it", async () => {
  const reply = vi.fn().mockResolvedValue({ ok: true });
  const multi = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => several, thread_reply: reply } },
  );
  const first = await multi.findByRole("checkbox", { name: /^Option 1:/ });
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(document.activeElement).toBe(multi.getByRole("checkbox", { name: /^Option 2:/ }));
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement).toBe(multi.getByRole("checkbox", { name: /^Option 4:/ }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  expect(document.activeElement).toBe(multi.getByRole("checkbox", { name: /^Option 3:/ }));
  fireEvent.keyDown(document.activeElement!, { key: "3" });
  expect(multi.getByRole("checkbox", { name: /^Option 3:/ }).getAttribute("aria-checked")).toBe("true");
  fireEvent.keyDown(document.activeElement!, { key: "1" });
  expect(first.getAttribute("aria-checked")).toBe("false");
  expect(document.activeElement).toBe(first);
  multi.lifecycle.unmount();

  const choice = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 2, idle: true },
    { rpc: { decision_options: () => ({ mode: "choice", options: several.options }), thread_reply: reply } },
  );
  const one = await choice.findByRole("button", { name: /^Reply 1:/ });
  one.focus();
  fireEvent.keyDown(one, { key: "4" });
  expect(document.activeElement).toBe(choice.getByRole("button", { name: /^Reply 4:/ }));
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(document.activeElement).toBe(one);
  expect(reply).not.toHaveBeenCalled();
  choice.lifecycle.unmount();
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

function messageWithList(items: string[]) {
  const row = document.createElement("div");
  row.dataset.timelineRowId = "r1";
  row.innerHTML = `<p>Pick one:</p><ol>${items.map((item) => `<li>${item}</li>`).join("")}</ol><p>Reply with the number.</p>`;
  document.body.append(row);
  return row;
}

it("hides the message's copy of the options while the buttons show, and restores it after", async () => {
  const row = messageWithList([`<strong>Build step 3</strong> for builds and pre-choruses, keeping the existing measurement and full validation intact (recommended)`, options[1].text]);
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => ({ options }) } },
  );
  const section = await slot.findByRole("region", { name: "Reply choices" });
  await waitFor(() => expect(row.querySelector("ol")!.hasAttribute(REPEATED_LIST_ATTR)).toBe(true));
  expect(section.hasAttribute("data-full")).toBe(true);
  slot.lifecycle.unmount();
  expect(row.querySelector("ol")!.hasAttribute(REPEATED_LIST_ATTR)).toBe(false);
  row.remove();
});

it("leaves lists alone that don't match, and everything when the setting is off", async () => {
  const other = messageWithList(["Something else", "Another thing"]);
  expect(repeatedList(document.body, options)).toBeNull();
  other.remove();
  const row = messageWithList(options.map((option) => option.text));
  expect(repeatedList(document.body, options)).toBe(row.querySelector("ol"));
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => ({ options }) }, settings: { hideRepeatedChoices: false } },
  );
  const section = await slot.findByRole("region", { name: "Reply choices" });
  expect(row.querySelector("ol")!.hasAttribute(REPEATED_LIST_ATTR)).toBe(false);
  expect(section.hasAttribute("data-full")).toBe(false);
  slot.lifecycle.unmount();
  row.remove();
});

it("hides the list's reply line with it, and keeps other paragraphs", async () => {
  const row = document.createElement("div");
  row.dataset.timelineRowId = "r1";
  row.innerHTML = `<blockquote><p><strong>Decision needed:</strong> which one?</p><ol>${options
    .map((option) => `<li>${option.text}</li>`)
    .join("")}</ol><p>Reply with the numbers, e.g. <strong>1,2</strong>.</p><p>The rest is up to Sam.</p></blockquote>`;
  document.body.append(row);
  const [question, reply, rest] = Array.from(row.querySelectorAll("p"));
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => ({ mode: "multi", options }) } },
  );
  await slot.findByRole("region", { name: "Reply choices" });
  await waitFor(() => expect(reply!.hasAttribute(REPEATED_LIST_ATTR)).toBe(true));
  expect(question!.hasAttribute(REPEATED_LIST_ATTR)).toBe(false);
  expect(rest!.hasAttribute(REPEATED_LIST_ATTR)).toBe(false);
  slot.lifecycle.unmount();
  expect(reply!.hasAttribute(REPEATED_LIST_ATTR)).toBe(false);
  row.remove();
});

it("keeps a callout's question visible, hiding only its list and reply line, even with rows after its message", async () => {
  const row = document.createElement("div");
  row.dataset.timelineRowId = "r1";
  row.innerHTML = `<p>Done.</p><blockquote data-jf-callout="tip"><p><strong>Path forward:</strong> two snoozes</p><ol>${options
    .map((option) => `<li>${option.text}</li>`)
    .join("")}</ol><p>Reply <strong>go</strong> for all, or <strong>go 1</strong>.</p></blockquote>`;
  const footer = document.createElement("div");
  footer.dataset.timelineRowId = "r1:work-summary:1";
  footer.textContent = "Worked for 2m";
  document.body.append(row, footer);
  const callout = row.querySelector("blockquote")!;
  const [question, replyLine] = Array.from(callout.querySelectorAll("p"));
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => ({ mode: "go", options }) } },
  );
  await slot.findByRole("region", { name: "Reply choices" });
  await waitFor(() => expect(callout.querySelector("ol")!.hasAttribute(REPEATED_LIST_ATTR)).toBe(true));
  expect(replyLine!.hasAttribute(REPEATED_LIST_ATTR)).toBe(true);
  // The question ("Path forward: …") is what you're deciding on: it never hides.
  expect(callout.hasAttribute(REPEATED_LIST_ATTR)).toBe(false);
  expect(question!.hasAttribute(REPEATED_LIST_ATTR)).toBe(false);
  slot.lifecycle.unmount();
  expect(callout.querySelector("ol")!.hasAttribute(REPEATED_LIST_ATTR)).toBe(false);
  row.remove();
  footer.remove();
});

const pathForward = {
  mode: "go" as const,
  title: "Path forward: make the records match",
  label: "Path forward",
  options: [
    { n: 1, text: "Record the churn", recommended: false },
    { n: 2, text: "Expire the contract", recommended: false },
    { n: 3, text: "Move the deal", recommended: false },
  ],
};
const decisionNeeded = {
  mode: "choice" as const,
  title: "Decision needed: two customers use it without an agreement",
  label: "Decision needed",
  options: [
    { n: 1, text: "Add a line to the renewal", recommended: true },
    { n: 2, text: "Leave them open for free", recommended: false },
  ],
};

function nextStepsMessage() {
  const markup = (group: typeof pathForward | typeof decisionNeeded) => group.options
    .map(({ text, recommended }) => `<li>${text}${recommended ? " (recommended)" : ""}</li>`).join("");
  const row = document.createElement("div");
  row.dataset.timelineRowId = "r1";
  row.innerHTML = `<div data-markdown-preview>
    <p><strong>Done:</strong> Checked the records.</p>
    <h3>Next steps</h3>
    <blockquote>
      <p>[!TIP]<br>${decisionNeeded.title}</p>
      <ol>${markup(decisionNeeded)}</ol>
      <p>Reply with the number.</p>
      <p>${pathForward.title}</p>
      <ol>${markup(pathForward)}</ol>
      <p>Reply <strong>go</strong> for all, or <strong>go 1,3</strong>.</p>
    </blockquote>
    <p><em>2026-11-24 10:08 CET</em></p>
  </div>`;
  document.body.append(row);
  return row;
}

it("hides a fully repeated Next steps callout while both titled lists show, preserving the timestamp", async () => {
  const row = nextStepsMessage();
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => ({ mode: "go", options: pathForward.options, groups: [decisionNeeded, pathForward] }) } },
  );
  expect(await slot.findByRole("group", { name: decisionNeeded.title })).toBeTruthy();
  expect(slot.getByRole("group", { name: pathForward.title })).toBeTruthy();
  expect(slot.getByRole("radio", { name: /Add a line to the renewal \(recommended\)/ })).toBeTruthy();
  expect(slot.getByRole("checkbox", { name: /Move the deal/ })).toBeTruthy();
  const [report, heading, callout, timestamp] = Array.from(row.querySelector("[data-markdown-preview]")!.children);
  await waitFor(() => expect(callout!.hasAttribute(REPEATED_LIST_ATTR)).toBe(true));
  expect(heading!.hasAttribute(REPEATED_LIST_ATTR)).toBe(true);
  expect(report!.hasAttribute(REPEATED_LIST_ATTR)).toBe(false);
  expect(timestamp!.hasAttribute(REPEATED_LIST_ATTR)).toBe(false);
  slot.lifecycle.unmount();
  expect(row.querySelectorAll(`[${REPEATED_LIST_ATTR}]`)).toHaveLength(0);
  row.remove();
});

it.each([
  ["li:nth-child(2)", "Leave them open for free until Friday"],
  ["li:nth-child(2)", "<code>Leave them open  for free</code>"],
  ["li:first-child", "Add a line (recommended) to the renewal"],
  ["li:first-child", "<code>Add a line to the renewal (recommended)</code>"],
  ["ol + p + p + ol li", '<a href="https://example.com/records">Record the churn</a>'],
  ["ol + p", "Reply with the number. Only proceed after the invoice clears."],
  ["p:first-child", "[!TIP] Decision needed: two customers use it without an agreement, and one renews today"],
])("keeps the callout when %s contains material the reply controls omit", async (selector, content) => {
  const row = nextStepsMessage();
  const original = row.querySelector(`blockquote ${selector}`)!;
  original.innerHTML = content;
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => ({ mode: "go", options: pathForward.options, groups: [decisionNeeded, pathForward] }) } },
  );
  await slot.findByRole("group", { name: pathForward.title });
  expect(original.closest(`[${REPEATED_LIST_ATTR}]`)).toBeNull();
  expect(row.querySelector(`h3[${REPEATED_LIST_ATTR}]`)).toBeNull();
  slot.lifecycle.unmount();
  row.remove();
});

it("shows a single question above its options when the original callout is hidden", async () => {
  const row = nextStepsMessage();
  const callout = row.querySelector("blockquote")!;
  while (callout.children.length > 3) callout.lastElementChild!.remove();
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => ({ mode: "choice", options: decisionNeeded.options, groups: [decisionNeeded] }) } },
  );
  const group = await slot.findByRole("group", { name: decisionNeeded.title });
  expect(group.previousElementSibling?.textContent).toBe(decisionNeeded.title);
  expect(callout.hasAttribute(REPEATED_LIST_ATTR)).toBe(true);
  slot.lifecycle.unmount();
  row.remove();
});

it("answers a path forward and a decision in one reply, one line each", async () => {
  const reply = vi.fn(async () => ({ ok: true }));
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    {
      rpc: {
        decision_options: () => ({ mode: "choice", options: decisionNeeded.options, groups: [pathForward, decisionNeeded] }),
        thread_reply: reply,
      },
    },
  );
  expect(await slot.findByRole("group", { name: pathForward.title })).toBeTruthy();
  expect(slot.getByRole("group", { name: decisionNeeded.title })).toBeTruthy();
  const send = slot.getByRole("button", { name: "Send" });
  // Nothing picked: nothing to send, and a click on an option sends nothing by itself.
  expect(send.hasAttribute("disabled")).toBe(true);
  fireEvent.click(slot.getByRole("checkbox", { name: "Path forward 1: Record the churn" }));
  fireEvent.click(slot.getByRole("checkbox", { name: "Path forward 3: Move the deal" }));
  fireEvent.click(slot.getByRole("radio", { name: "Decision needed 2: Leave them open for free" }));
  // A second pick in a one-number list replaces the first.
  fireEvent.click(slot.getByRole("radio", { name: "Decision needed 1: Add a line to the renewal (recommended)" }));
  expect(reply).not.toHaveBeenCalled();
  expect(slot.container.querySelector(".jf-choices-preview")!.textContent).toBe("Path forward: go 1,3 · Decision needed: 1");
  fireEvent.click(send);
  await slot.findByText("Reply sent");
  expect(reply.mock.calls[0]).toEqual([{ threadId: "t1", text: "Path forward: go 1,3\nDecision needed: 1" }]);
  slot.lifecycle.unmount();
});

it("Go with all answers a path forward with plain go, and an unanswered list is left out", async () => {
  const reply = vi.fn(async () => ({ ok: true }));
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => ({ mode: "choice", options: [], groups: [pathForward, decisionNeeded] }), thread_reply: reply } },
  );
  fireEvent.click(await slot.findByRole("button", { name: "Go with all" }));
  fireEvent.click(slot.getByRole("button", { name: "Send" }));
  await slot.findByText("Reply sent");
  expect(reply.mock.calls[0]).toEqual([{ threadId: "t1", text: "Path forward: go" }]);
  slot.lifecycle.unmount();
});

it("a single step to run shows the step and a Go, nothing to tick", async () => {
  const reply = vi.fn(async () => ({ ok: true }));
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => ({ mode: "go", options: [{ n: 1, text: "Set the after-amount", recommended: false }] }), thread_reply: reply } },
  );
  expect(await slot.findByText("Set the after-amount")).toBeTruthy();
  expect(slot.queryByRole("checkbox")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Go" }));
  await waitFor(() => expect(reply).toHaveBeenCalledWith({ threadId: "t1", text: "go" }));
  slot.lifecycle.unmount();
});
