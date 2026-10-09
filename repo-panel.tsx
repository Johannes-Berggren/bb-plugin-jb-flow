// Side-panel UI for repo commands: a "Scripts" tab listing the project's
// pinned commands plus every script in the root package.json, each with
// run/stop and live status, and a settings editor for pinned commands.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { JsonValue } from "@get-bb/plugin-sdk/app";
import type { DevRun, RepoCommand, RepoScript } from "./repo-commands";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Status = {
  projectName: string;
  commands: RepoCommand[];
  scripts: RepoScript[];
  scriptsError: string | null;
  runs: DevRun[];
};

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const STATUS_LABEL: Record<DevRun["status"], string> = {
  starting: "starting…",
  ready: "running",
  exited: "exited",
  timeout: "port never opened",
};

type Row = { id: string; label: string; detail: string; title: string };

function CommandRow({
  row,
  run,
  pending,
  onRun,
  onStop,
}: {
  row: Row;
  run: DevRun | undefined;
  pending: boolean;
  onRun: () => void;
  onStop: () => void;
}) {
  const live = run !== undefined && run.status !== "exited";
  return (
    <li className="group flex items-center gap-2 px-2 py-1.5" title={row.title}>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          run?.status === "ready"
            ? "bg-green-500"
            : run?.status === "starting"
              ? "animate-pulse bg-amber-500"
              : run?.status === "timeout"
                ? "bg-amber-500"
                : "bg-transparent",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{row.label}</div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {live && run ? `${STATUS_LABEL[run.status]}${run.url ? ` · ${run.url}` : ""}` : row.detail}
        </div>
      </div>
      {live ? (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={pending}
            onClick={onRun}
            aria-label={`Reopen tabs for ${row.label}`}
          >
            <Icon name="PanelRight" className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" disabled={pending} onClick={onStop} aria-label={`Stop ${row.label}`}>
            <Icon name="Square" className="size-3.5" />
          </Button>
        </>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 opacity-60 group-hover:opacity-100"
          disabled={pending}
          onClick={onRun}
          aria-label={`Run ${row.label}`}
        >
          {pending ? <Glyph name="spinner" className="size-3.5 animate-spin" /> : <Icon name="Play" className="size-3.5" />}
        </Button>
      )}
    </li>
  );
}

export function RepoCommandsPanel({
  threadId,
  params,
}: {
  threadId: string;
  params: JsonValue | null;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const autoran = useRef(false);

  const refetch = useCallback(() => {
    rpc.call("repo_status", { threadId }).then(
      (result) => {
        setStatus(result);
        setError(null);
      },
      (cause: unknown) => setError(errorText(cause)),
    );
  }, [rpc, threadId]);
  useEffect(refetch, [refetch]);
  useRealtime("jb-flow-changed", refetch);

  const act = useCallback(
    async (commandId: string, action: "run" | "stop") => {
      setPending(commandId);
      setError(null);
      try {
        if (action === "run") await rpc.call("repo_run", { threadId, commandId });
        else await rpc.call("repo_stop", { threadId, commandId });
      } catch (cause) {
        setError(errorText(cause));
      } finally {
        setPending(null);
        refetch();
      }
    },
    [rpc, threadId, refetch],
  );

  // Opened from "Start dev servers": run once, on first mount only.
  const autorun =
    params !== null && typeof params === "object" && !Array.isArray(params) && typeof params.autorun === "string"
      ? params.autorun
      : null;
  useEffect(() => {
    if (autorun === null || autoran.current || status === null) return;
    autoran.current = true;
    if (status.commands.some((command) => command.id === autorun)) void act(autorun, "run");
    // No pinned command: fall back to the package.json script of that name.
    else if (status.scripts.some((script) => script.id === `script:${autorun}`)) void act(`script:${autorun}`, "run");
  }, [autorun, status, act]);

  if (status === null) {
    return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
  }

  const query = filter.trim().toLowerCase();
  const matches = (row: Row) => query === "" || `${row.label} ${row.title}`.toLowerCase().includes(query);
  const pinnedRows: Row[] = status.commands.map((command) => ({
    id: command.id,
    label: command.label,
    detail:
      command.slots.length > 1
        ? `${command.slots[0]!.command} · falls back to ${command.slots
            .slice(1)
            .map((slot) => slot.command.replace(/^\S+ (run )?/, ""))
            .join(", ")} if ports are busy`
        : command.slots[0]!.command,
    title: command.slots
      .map((slot, index) => `${index === 0 ? "Runs" : "else"} ${slot.command}${slot.ports.length ? ` (ports ${slot.ports.join(", ")})` : ""}`)
      .join("\n"),
  }));
  const scriptRows: Row[] = status.scripts.map((script) => ({
    id: script.id,
    label: script.name,
    detail: script.script,
    title: `${script.command}\n\n${script.script}`,
  }));
  const runFor = (id: string) => status.runs.find((candidate) => candidate.commandId === id);
  const renderRows = (rows: Row[]) => (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {rows.filter(matches).map((row) => (
        <CommandRow
          key={row.id}
          row={row}
          run={runFor(row.id)}
          pending={pending === row.id}
          onRun={() => act(row.id, "run")}
          onStop={() => act(row.id, "stop")}
        />
      ))}
    </ul>
  );

  return (
    <div className="space-y-3 text-sm">
      {scriptRows.length + pinnedRows.length > 8 ? (
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={`Filter ${status.projectName} scripts`}
          aria-label="Filter scripts"
          className="h-8 w-full rounded-md border border-border bg-transparent px-2 text-sm"
        />
      ) : null}
      {pinnedRows.some(matches) ? (
        <section className="space-y-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">Pinned</h3>
          {renderRows(pinnedRows)}
        </section>
      ) : null}
      <section className="space-y-1.5">
        <h3 className="text-xs font-medium text-muted-foreground">package.json</h3>
        {status.scriptsError !== null ? (
          <p className="text-xs text-muted-foreground">{status.scriptsError}</p>
        ) : scriptRows.some(matches) ? (
          renderRows(scriptRows)
        ) : (
          <p className="text-xs text-muted-foreground">No matching scripts.</p>
        )}
      </section>
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        Runs in a terminal tab here. Scripts with a <code>--port</code> open in a browser tab once the
        port is up.
      </p>
    </div>
  );
}

const EXAMPLE = `[
  {
    "id": "dev",
    "label": "Start dev servers",
    "slots": [
      { "command": "pnpm dev", "url": "http://localhost:3000", "ports": [3000] }
    ]
  }
]`;

export function RepoCommandsSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState<{
    defaults: Record<string, RepoCommand[]>;
    overrides: Record<string, RepoCommand[]>;
  } | null>(null);
  const [project, setProject] = useState("");
  const [text, setText] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    rpc.call("repo_config_get", null).then(setConfig, (cause: unknown) => setMessage(errorText(cause)));
  }, [rpc]);
  useEffect(load, [load]);

  const select = (name: string) => {
    setProject(name);
    setMessage(null);
    const commands = config?.overrides[name] ?? config?.defaults[name];
    setText(commands ? JSON.stringify(commands, null, 2) : EXAMPLE);
  };

  const names = config
    ? [...new Set([...Object.keys(config.defaults), ...Object.keys(config.overrides)])].sort()
    : [];

  const save = async (reset: boolean) => {
    try {
      const commands = reset ? null : (JSON.parse(text) as RepoCommand[]);
      await rpc.call("repo_config_set", { projectName: project.trim(), commands });
      setMessage(reset ? "Reset to defaults." : "Saved.");
      load();
    } catch (cause) {
      setMessage(errorText(cause));
    }
  };

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Buttons shown in a thread's side panel under "Repo commands", keyed by BB project name.
        Give a command several slots (e.g. <code>pnpm dev</code>, <code>pnpm dev:2</code>) so
        parallel worktrees each pick one whose ports are free.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {names.map((name) => (
          <Button
            key={name}
            size="sm"
            variant={name === project ? "default" : "outline"}
            onClick={() => select(name)}
          >
            {name}
            {config?.overrides[name] ? " *" : ""}
          </Button>
        ))}
      </div>
      <input
        value={project}
        onChange={(event) => setProject(event.target.value)}
        placeholder="BB project name, e.g. my-app"
        aria-label="Project name"
        className="h-8 w-full rounded-md border border-border bg-transparent px-2 text-sm"
      />
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        rows={14}
        aria-label="Commands JSON"
        className="w-full rounded-md border border-border bg-transparent p-2 font-mono text-xs"
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={project.trim() === ""} onClick={() => save(false)}>
          Save
        </Button>
        {config?.overrides[project] && config.defaults[project] ? (
          <Button size="sm" variant="ghost" onClick={() => save(true)}>
            Reset to defaults
          </Button>
        ) : null}
      </div>
      {message === null ? null : <p className="text-muted-foreground">{message}</p>}
    </div>
  );
}
