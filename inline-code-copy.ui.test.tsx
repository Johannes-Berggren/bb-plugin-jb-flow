import { afterEach, expect, it, vi } from "vitest";
import { COPY_CODE_FLAG, copyableChip, mountInlineCodeCopy } from "./inline-code-copy";

let controller: AbortController;
afterEach(() => {
  controller?.abort();
  document.body.innerHTML = "";
  delete document.documentElement.dataset[COPY_CODE_FLAG];
  vi.restoreAllMocks();
});
function setup(enabled = true) {
  if (enabled) document.documentElement.dataset[COPY_CODE_FLAG] = "";
  document.body.innerHTML = `<div data-timeline-row-id="m1"><p>Paste <code id="chip">under:org/123</code> here.</p>
    <pre><code id="block">npm test</code></pre></div>
    <p>Outside <code id="outside">nope</code></p>`;
  controller = new AbortController();
  mountInlineCodeCopy({ signal: controller.signal });
  return document.querySelector<HTMLButtonElement>(".jf-code-copy")!;
}
const hover = (id: string) => document.getElementById(id)!.dispatchEvent(new Event("pointerover", { bubbles: true }));

it("only treats inline code inside chat messages as copyable", () => {
  setup();
  expect(copyableChip(document.getElementById("chip"))).not.toBeNull();
  expect(copyableChip(document.getElementById("block"))).toBeNull();
  expect(copyableChip(document.getElementById("outside"))).toBeNull();
});

it("shows the button on hover and copies the chip's text", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const button = setup();
  expect(button.hidden).toBe(true);
  hover("chip");
  expect(button.hidden).toBe(false);
  button.click();
  await vi.waitFor(() => expect(button.dataset.copied).toBe("true"));
  expect(writeText).toHaveBeenCalledWith("under:org/123");
});

it("stays hidden when the setting is off, and leaves nothing behind on abort", () => {
  const button = setup(false);
  hover("chip");
  expect(button.hidden).toBe(true);
  controller.abort();
  expect(document.querySelector(".jf-code-copy")).toBeNull();
});
