// The app keeps one copy of the plugin state and the workspaces per window, in
// module scope. A test file loads the app once, so without this each test would
// start from the last one's state, or get it late from that test's fetch.
import { afterEach } from "vitest";
import { forgetFlowState } from "./flow-state";
import { forgetWorkspaces } from "./workspace-client";

afterEach(() => {
  forgetFlowState();
  forgetWorkspaces();
});
