import { afterEach, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { CALLOUT_ATTR, mountCallouts } from "./callouts";

let controller: AbortController;
afterEach(() => {
  controller?.abort();
  document.body.innerHTML = "";
  document.documentElement.classList.remove("jb-flow-shell");
});

function setup(polish: boolean) {
  if (polish) document.documentElement.classList.add("jb-flow-shell");
  document.body.innerHTML = `<div data-timeline-row-id="m1">
    <blockquote id="tip">
<p>[!TIP]
<strong>Decision needed:</strong> which one?</p><ol><li>Merge now</li><li>Wait</li></ol></blockquote>
    <blockquote id="warning"><p>[!warning]</p><p>The deploy touches billing.</p></blockquote>
    <blockquote id="plain"><p>Just a quote with [!TIP] inside.</p></blockquote>
  </div>
  <blockquote id="outside"><p>[!NOTE] Not in a message.</p></blockquote>`;
  controller = new AbortController();
  mountCallouts({ signal: controller.signal });
}
const quote = (id: string) => document.getElementById(id)!;

it("turns a marked quote in a message into a callout and drops the marker", () => {
  setup(true);
  expect(quote("tip").getAttribute(CALLOUT_ATTR)).toBe("tip");
  expect(quote("tip").textContent).not.toContain("[!TIP]");
  expect(quote("tip").querySelector("p")!.textContent).toBe("Decision needed: which one?");
  expect(quote("warning").getAttribute(CALLOUT_ATTR)).toBe("warning");
  // The marker's own paragraph is left empty, for CSS to hide.
  expect(quote("warning").querySelector("p")!.textContent).toBe("");
  expect(quote("plain").hasAttribute(CALLOUT_ATTR)).toBe(false);
  expect(quote("outside").hasAttribute(CALLOUT_ATTR)).toBe(false);
});

it("leaves everything alone without polish, and restores it when polish turns off or the script stops", async () => {
  setup(false);
  expect(quote("tip").hasAttribute(CALLOUT_ATTR)).toBe(false);
  expect(quote("tip").textContent).toContain("[!TIP]");
  document.documentElement.classList.add("jb-flow-shell");
  await waitFor(() => expect(quote("tip").getAttribute(CALLOUT_ATTR)).toBe("tip"));
  document.documentElement.classList.remove("jb-flow-shell");
  await waitFor(() => expect(quote("tip").hasAttribute(CALLOUT_ATTR)).toBe(false));
  expect(quote("tip").textContent).toContain("[!TIP]");
  expect(quote("warning").querySelector("p")!.textContent).toBe("[!warning]");
  document.documentElement.classList.add("jb-flow-shell");
  await waitFor(() => expect(quote("tip").getAttribute(CALLOUT_ATTR)).toBe("tip"));
  controller.abort();
  expect(quote("tip").hasAttribute(CALLOUT_ATTR)).toBe(false);
  expect(quote("tip").textContent).toContain("[!TIP]");
});

it("strips the marker again when a re-render brings it back, and picks up new messages", async () => {
  setup(true);
  const text = quote("tip").querySelector("p")!.firstChild as Text;
  text.nodeValue = "[!TIP]\n";
  await waitFor(() => expect(text.nodeValue).toBe(""));
  const row = document.createElement("div");
  row.dataset.timelineRowId = "m2";
  row.innerHTML = `<blockquote id="later"><p>[!IMPORTANT] Read this first.</p></blockquote>`;
  document.body.append(row);
  await waitFor(() => expect(quote("later").getAttribute(CALLOUT_ATTR)).toBe("important"));
  expect(quote("later").textContent).toBe("Read this first.");
});
