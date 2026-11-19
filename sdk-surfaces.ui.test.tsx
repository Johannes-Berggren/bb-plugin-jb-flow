// The bb surfaces JB Flow moved to with SDK 0.6.132: thread tabs, the Snooze
// header button, the status strip above the composer, and branch PRs read
// from bb's GitHub PR Status plugin.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useBranchPr } from "./branch-pr";
import { PRS_TAB } from "./panel-tabs";
import { ThreadStatusStrip } from "./ui-extras";

afterEach(() => cleanup());

const pr = {
  number: 12,
  title: "Fix export",
  url: "https://github.com/acme/web-app/pull/12",
  state: "open" as const,
  attention: "checks_failed",
};

function BranchPr({ environmentId }: { environmentId: string | null }) {
  const branch = useBranchPr(environmentId);
  return <p>{branch ? `#${branch.number} ${branch.attention}` : "none"}</p>;
}

describe("bb SDK surfaces", () => {
  it("registers the side-panel tabs as thread action tabs", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const ours = app.tabs.filter((tab) => ["prs", "dev-servers", "repo-commands"].includes(tab.id));
    expect(ours.map((tab) => [tab.id, tab.context.kind, tab.availability])).toEqual([
      ["prs", "thread", "action"],
      ["dev-servers", "thread", "action"],
      ["repo-commands", "thread", "action"],
    ]);
  });

  it("puts Snooze in the thread header, labelled with the snooze, and opens the dialog", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const snooze = app.threadActions.find((action) => action.id === "snooze")!;
    expect(snooze.placement).toBe("header");
    const input = (data: unknown) => ({ thread: { id: "thr_a" }, data }) as never;
    expect(snooze.item(input({}))!.label).toBe("Snooze");
    expect(snooze.item(input({ thr_a: { until: Date.now() + 86_400_000 } }))!.label).toMatch(/^Snoozed until /);
    const opened: string[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent<string>).detail);
    window.addEventListener("jb-flow:snooze", listener);
    await snooze.item(input({}))!.run({} as never);
    window.removeEventListener("jb-flow:snooze", listener);
    expect(opened).toEqual(["thr_a"]);
  });

  it("shows the status strip in the context row above the composer", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.threadContextSegments.map((segment) => segment.id)).toContain("status");
    expect(app.threadActions.some((action) => action.id === "status")).toBe(false);
  });

  it("reads a branch's PR from GitHub PR Status, and shows none when it has none", async () => {
    const found = renderSlot({ component: () => <BranchPr environmentId="env_1" /> }, {}, {
      rpc: { pullRequests: () => ({ env_1: { outcome: "available", pullRequest: pr } }) } as never,
    });
    await waitFor(() => expect(found.container.textContent).toBe("#12 checks_failed"));
    cleanup();
    const absent = renderSlot({ component: () => <BranchPr environmentId="env_2" /> }, {}, {
      rpc: { pullRequests: () => ({ env_2: { outcome: "absent" } }) } as never,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(absent.container.textContent).toBe("none");
    cleanup();
    const noEnvironment = renderSlot({ component: () => <BranchPr environmentId={null} /> }, {});
    expect(noEnvironment.container.textContent).toBe("none");
  });

  it("opens the Pull requests tab from the strip's PR chip", async () => {
    const state = { threadPrs: { thr_a: [{ ...pr, repo: "acme/web-app", stackedOn: null }] }, running: {}, watching: {} };
    const slot = renderSlot({ component: () => <ThreadStatusStrip threadId="thr_a" state={state as never} branchPr={null} /> }, {}, {
      experimental_panel: { openTab: () => true },
    });
    fireEvent.click(slot.getByRole("button", { name: "#12" }));
    expect(slot.experimental_panelCalls).toEqual([{ method: "openTab", options: { tab: PRS_TAB, title: "Pull requests" } }]);
  });
});
