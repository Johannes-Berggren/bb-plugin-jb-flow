import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { LifeboatView, type LifeboatViewProps } from "./view";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { fixtureSnapshot, FIXTURE_NOW, SPARE_ID } from "./fixtures";

afterEach(cleanup);
function mount(overrides: Partial<LifeboatViewProps> = {}) {
  installTestPluginRuntime();
  const onOperation = vi.fn().mockResolvedValue(true);
  const props: LifeboatViewProps = {
    hosts: [{ id: "mac", name: "Mac Studio", connected: true }],
    hostId: "mac",
    onHostChange: vi.fn(),
    snapshot: fixtureSnapshot(),
    busy: false,
    loading: false,
    error: null,
    now: FIXTURE_NOW,
    onOperation,
    ...overrides,
  };
  return { ...render(<LifeboatView {...props} />), onOperation };
}
describe("Lifeboat interaction", () => {
  it("filters provider accounts and explains depleted windows", () => {
    const ui = mount();
    expect(ui.getAllByRole("article")).toHaveLength(4);
    fireEvent.click(
      within(ui.getByLabelText("Filter accounts")).getByRole("button", {
        name: "Codex",
      }),
    );
    expect(ui.getAllByRole("article")).toHaveLength(2);
    expect(ui.getByText("Running low")).toBeTruthy();
    expect(ui.getAllByRole("meter", { name: "Weekly remaining" })).toHaveLength(
      2,
    );
  });
  it("requires a deliberate confirmation and names the selected Mac before switching", async () => {
    const ui = mount();
    const card = ui
      .getAllByRole("article")
      .find(
        (card) =>
          within(card).queryByText("Next up") &&
          within(card).queryByText("Claude Code · Pro"),
      )!;
    fireEvent.click(
      within(card).getByRole("button", { name: "Switch to this" }),
    );
    expect(ui.onOperation).not.toHaveBeenCalled();
    expect(ui.getByRole("dialog").textContent).toContain("Mac Studio");
    fireEvent.click(ui.getByRole("button", { name: "Verify and switch" }));
    expect(ui.onOperation).toHaveBeenCalledWith({
      command: "switch",
      accountID: SPARE_ID,
    });
    expect(await ui.findByText(/CLI now uses Personal/)).toBeTruthy();
  });
  it("keeps legacy preview read-only until import is explicitly chosen", () => {
    const state = fixtureSnapshot();
    state.source = "legacy";
    const ui = mount({ snapshot: state });
    expect(ui.queryByRole("button", { name: "Switch to this" })).toBeNull();
    fireEvent.click(ui.getByRole("button", { name: /Bring into Flow/ }));
    expect(ui.onOperation).not.toHaveBeenCalled();
    expect(ui.getByRole("dialog").textContent).toContain(
      "Your original Lifeboat data stays intact",
    );
    fireEvent.click(
      ui.getByRole("button", { name: "Bring accounts into Flow" }),
    );
    expect(ui.onOperation).toHaveBeenCalledWith({ command: "import" });
  });
  it("keeps the last reading visible on error and explains disabled controls on focus", () => {
    const ui = mount({
      error: "Mac disconnected",
      hosts: [{ id: "mac", name: "Mac Studio", connected: false }],
    });
    expect(ui.getByRole("alert").textContent).toContain("Mac disconnected");
    expect(ui.getAllByRole("article")).toHaveLength(4);
    const button = ui.getByRole("button", { name: /Refresh usage/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.parentElement?.getAttribute("tabindex")).toBe("0");
    expect(button.parentElement?.textContent).toContain("Connect this Mac");
  });
});
