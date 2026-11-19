// JB Flow's thread side-panel tabs, as references for opening them: the
// registrations are in app.tsx, and the palette, commands and the header strip
// open them through bb's panel controller.
export const PRS_TAB = { id: "prs", context: { kind: "thread" }, availability: "action" } as const;
export const DEV_SERVERS_TAB = { id: "dev-servers", context: { kind: "thread" }, availability: "action" } as const;
export const REPO_COMMANDS_TAB = { id: "repo-commands", context: { kind: "thread" }, availability: "action" } as const;
export const DEV_AUTORUN = { autorun: "dev" } as const;
