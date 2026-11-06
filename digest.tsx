// The home page's stale-thread digest and leftover-checkout report.
import { useWorkspaces, useSelectedWorkspace } from "./workspace-client";
import { inWorkspace } from "./workspaces";
import { useCallback, useEffect, useMemo, useState } from "react";
import { experimental_useSidebarThreads as useSidebarThreads, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { DigestItem, rpcContract } from "./server";
import { useSidebarThreadActions } from "./thread-actions";
import type { Leftover } from "./leftovers";
import { formatWhen, parseWhen } from "./when";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { errorText, ProjectChip } from "./flow-state";
import { ConfirmDialog } from "./dialogs";
import { EmptyState } from "./triage-list";
export function DigestSection() {
  const { state: workspaceState } = useWorkspaces();
  const selectedWorkspace = useSelectedWorkspace();
  const { threads: workspaceThreads } = useSidebarThreads();
  const rpc = useRpc<typeof rpcContract>();
  const actions = useSidebarThreadActions();
  const { projects } = useSidebarThreads();
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const [digest, setDigest] = useState<{
    generatedAt: number;
    items: DigestItem[];
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(
    (refresh: boolean) => {
      if (refresh) setPending(true);
      rpc
        .call("digest_list", { refresh })
        .then(
          (result) => {
            setDigest(result);
            setSelected((current) => {
              const ids = new Set(result.items.map((item) => item.threadId));
              return new Set([...current].filter((id) => ids.has(id)));
            });
            setError(null);
          },
          (cause: unknown) => setError(errorText(cause)),
        )
        .finally(() => {
          if (refresh) setPending(false);
        });
    },
    [rpc],
  );
  useEffect(() => load(false), [load]);
  useRealtime("jb-flow-changed", () => load(false));

  const act = async (action: () => Promise<unknown>) => {
    setPending(true);
    try {
      await action();
      setSelected(new Set());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };
  useEffect(() => { setSelected(new Set()); setShowAll(false); }, [selectedWorkspace]);
  const items = (digest?.items ?? []).filter((item) => {
    const thread = workspaceThreads.find((thread) => thread.id === item.threadId);
    return selectedWorkspace === null || (thread !== undefined && inWorkspace(thread, selectedWorkspace, workspaceState, workspaceThreads));
  });
  const ids = items.filter((item) => selected.has(item.threadId)).map((item) => item.threadId);
  const shown = showAll ? items : items.slice(0, 15);
  const allSelected =
    items.length > 0 && items.every((item) => selected.has(item.threadId));
  const toggleOne = (threadId: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(threadId);
      else next.delete(threadId);
      return next;
    });

  return (
    <div className="jf-home jf-digest space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">
          {digest === null
            ? "Loading…"
            : `${items.length} idle thread${items.length === 1 ? "" : "s"} without a section · updated ${formatWhen(digest.generatedAt)}`}
        </span>
        <div className="ml-auto flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => load(true)}
          >
            <Icon name="RotateCcw" className="size-3.5" /> Refresh
          </Button>
          {ids.length > 0 && <><Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              act(() => rpc.call("digest_keep", { threadIds: ids, days: 14 }))
            }
          >
            Keep 14d
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || ids.length === 0}
            onClick={() =>
              act(() =>
                Promise.all(
                  ids.map((threadId) =>
                    rpc.call("snooze", { threadId, when: "1w", note: null, until: parseWhen("1w") }),
                  ),
                ),
              )
            }
          >
            Snooze 1w
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending || ids.length === 0}
            onClick={() => act(() => rpc.call("archive", { threadIds: ids }))}
          >
            Archive{ids.length > 0 ? ` ${ids.length}` : ""}
          </Button></>}
        </div>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {digest === null ? null : items.length === 0 ? (
        <EmptyState>No stale threads.</EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          <li className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground">
            <Checkbox
              checked={allSelected}
              onCheckedChange={(checked) =>
                setSelected(
                  checked === true
                    ? new Set(items.map((item) => item.threadId))
                    : new Set(),
                )
              }
              aria-label="Select all"
            />
            Select all
          </li>
          {shown.map((item) => (
            <li
              key={item.threadId}
              className="flex items-start gap-3 px-3 py-2 text-sm"
            >
              <Checkbox
                className="mt-0.5"
                checked={selected.has(item.threadId)}
                onCheckedChange={(checked) =>
                  toggleOne(item.threadId, checked === true)
                }
                aria-label={`Select "${item.title}"`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="truncate text-left font-medium hover:underline"
                    onClick={() => actions.open(item.threadId)}
                  >
                    {item.title}
                  </button>
                  <ProjectChip project={projectById.get(item.projectId)} />
                  <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                    {item.idleDays}d
                  </span>
                </div>
                {item.summary ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {item.summary}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
          {items.length > shown.length ? (
            <li className="px-3 py-2">
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShowAll(true)}
              >
                Show all {items.length}
              </button>
            </li>
          ) : null}
        </ul>
      )}
      <LeftoversBlock />
    </div>
  );
}

// --- settings: area-section → tag migration ---------------------------------------

// Worktree checkouts bb no longer tracks (see leftovers.ts). Shown only when there are some.
function LeftoversBlock() {
  const rpc = useRpc<typeof rpcContract>();
  const [report, setReport] = useState<{ checkedAt: number; items: Leftover[] } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("leftovers_get", { refresh: false }).then(setReport, (cause: unknown) => setError(errorText(cause)));
  }, [rpc]);
  if (!report || report.items.length === 0) return error ? <p className="text-sm text-destructive">{error}</p> : null;
  const safe = report.items.filter((item) => item.safe);
  return (
    <details className="jf-leftovers space-y-2">
      <summary><Icon name="FolderGit" className="size-4" /><span>Worktree cleanup</span><span>{report.items.length} checkouts</span><Icon name="ChevronDown" className="size-3" /></summary>
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">Leftover worktrees</span>
        <span className="text-muted-foreground">
          {report.items.length} checkout(s) bb no longer tracks · checked {formatWhen(report.checkedAt)}
        </span>
        {safe.length > 0 ? (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setConfirming(true)}>
            Delete {safe.length} merged
          </Button>
        ) : null}
      </div>
      <ul className="divide-y divide-border rounded-md border border-border text-xs">
        {report.items.map((item) => (
          <li key={item.path} className="flex items-center gap-2 px-3 py-1.5" title={item.path}>
            <span className="font-medium">{item.repo}</span>
            <span className="truncate text-muted-foreground">{item.branch}</span>
            <span className="ml-auto shrink-0 text-muted-foreground">
              {[item.pr ? `${item.pr} ${item.prState}` : "no PR", item.dirty ? `${item.dirty} uncommitted` : null, item.nodeModules ? "node_modules" : null]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {item.safe ? null : <span className="shrink-0 text-amber-600">keep</span>}
          </li>
        ))}
      </ul>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {confirming ? (
        <ConfirmDialog
          title={`Delete ${safe.length} leftover checkout(s)?`}
          body="Only checkouts whose PR is merged (or that have no commits of their own) and that have no uncommitted changes are removed. Branches stay on GitHub."
          confirmLabel="Delete"
          onConfirm={() => rpc.call("leftovers_clean", null).then(() => rpc.call("leftovers_get", { refresh: false }).then(setReport))}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </details>
  );
}
