import { afterEach, expect, it } from "vitest";
import { mountTimelineActivity } from "./timeline-activity";

let controller: AbortController;
afterEach(() => { controller?.abort(); document.body.innerHTML = ""; document.documentElement.classList.remove("jb-flow-shell"); });
const tick = () => new Promise(resolve => setTimeout(resolve, 45));
function setup() {
  document.documentElement.classList.add("jb-flow-shell");
  document.body.innerHTML = `<div data-timeline-row-id="t:work-summary:1">
    <button aria-expanded="true"><span class="animate-shine">Running 3 commands</span></button>
    <div data-timeline-row-list="bundle">
      <div data-timeline-row-id="past"><span class="opacity-40">Ran command</span></div>
      <div data-timeline-row-id="thought"><span class="opacity-40">Thought 5s</span></div>
      <div data-timeline-row-id="error"><span class="opacity-40">Ran command <span>error</span></span></div>
      <div data-timeline-row-id="live"><button aria-expanded="false"><span class="animate-shine">Running tests</span></button></div>
    </div></div><div data-timeline-row-id="message">User message</div>`;
  controller = new AbortController();
  mountTimelineActivity({ signal: controller.signal });
  return document.querySelector<HTMLElement>('[data-timeline-row-id="t:work-summary:1"]')!;
}
it("condenses earlier steps, keeps live work and failures visible, and toggles without moving native nodes", () => {
  const group = setup();
  const past = group.querySelector('[data-timeline-row-id="past"]')!;
  const parent = past.parentElement;
  expect(group.dataset.jbFlowTrace).toBe("compact");
  expect(past.hasAttribute("data-jb-flow-trace-past")).toBe(true);
  expect(group.querySelector('[data-timeline-row-id="error"]')!.hasAttribute("data-jb-flow-trace-past")).toBe(false);
  expect(group.querySelector('[data-timeline-row-id="live"]')!.hasAttribute("data-jb-flow-trace-past")).toBe(false);
  const toggle = group.querySelector<HTMLButtonElement>('[data-jb-flow-trace-toggle]')!;
  expect(toggle.textContent).toBe("Show trace · 2 earlier steps");
  toggle.click();
  expect(group.dataset.jbFlowTrace).toBe("expanded");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(past.parentElement).toBe(parent);
  expect(document.querySelector('[data-timeline-row-id="message"]')!.attributes.length).toBe(1);
});
it("follows live updates and restores native UI on completion, disable and abort", async () => {
  const group = setup();
  group.querySelector('[data-timeline-row-id="live"] .animate-shine')!.className = "opacity-40";
  await tick();
  expect(group.hasAttribute("data-jb-flow-trace")).toBe(false);
  expect(group.querySelector('[data-jb-flow-trace-past]')).toBeNull();
  group.querySelector('[data-timeline-row-id="live"] span')!.className = "animate-shine";
  await tick();
  expect(group.dataset.jbFlowTrace).toBe("compact");
  document.documentElement.classList.remove("jb-flow-shell");
  await tick();
  expect(group.querySelector('[data-jb-flow-trace-toggle]')).toBeNull();
  document.documentElement.classList.add("jb-flow-shell");
  await tick();
  controller.abort();
  expect(group.hasAttribute("data-jb-flow-trace")).toBe(false);
  expect(group.querySelector('[data-jb-flow-trace-toggle]')).toBeNull();
});
it("leaves explicitly opened output and unfamiliar structures alone", () => {
  const group = setup();
  controller.abort();
  group.querySelector('[data-timeline-row-id="past"]')!.innerHTML = '<button aria-expanded="true" class="opacity-40">Ran command</button>';
  controller = new AbortController();
  mountTimelineActivity({ signal: controller.signal });
  expect(group.querySelector('[data-timeline-row-id="past"]')!.hasAttribute('data-jb-flow-trace-past')).toBe(false);
});
