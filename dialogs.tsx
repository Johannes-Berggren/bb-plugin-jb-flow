// Dialogs opened from the sidebar, rows and commands: snooze, tags, rename,
// sections, confirmations, deadlines and the Focus limit.
import { useEffect, useState } from "react";
import { ThreadTitle, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { useSidebarThreadActions } from "./thread-actions";
import { DUE_PRESETS, SNOOZE_PRESETS, formatDue, formatWhen, parseDue, parseWhen } from "./when";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useFlowState, errorText } from "./flow-state";
// --- dialogs --------------------------------------------------------------------

export function SnoozeDialog({
  threadId,
  open,
  onOpenChange,
}: {
  threadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { rpc, state } = useFlowState();
  const current = state?.snoozes[threadId];
  const [note, setNote] = useState("");
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setNote(current?.note ?? "");
      setCustom("");
      setError(null);
    }
  }, [open, current?.note]);

  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await action();
      onOpenChange(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };
  const snooze = (when: string) =>
    run(() =>
      rpc.call("snooze", {
        threadId,
        when,
        note: note.trim() === "" ? null : note,
        until: parseWhen(when),
      }),
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Snooze thread</DialogTitle>
          <DialogDescription>
            {current
              ? `Snoozed until ${formatWhen(current.until)}.`
              : "Hide it until later. It comes back unread."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {SNOOZE_PRESETS.map((preset) => (
            <Button
              key={preset.when}
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => snooze(preset.when)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (custom.trim() !== "") void snooze(custom.trim());
          }}
        >
          <Input
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder="3d, fri, 2026-10-12…"
            aria-label="Custom snooze time"
          />
          <Button
            type="submit"
            size="sm"
            disabled={pending || custom.trim() === ""}
          >
            Snooze
          </Button>
        </form>
        <Input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Optional: prompt to send on wake-up"
          aria-label="Wake-up prompt"
        />
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {current ? (
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => run(() => rpc.call("unsnooze", { threadId }))}
            >
              Wake now
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function TagDialog({
  threadId,
  tags,
  knownTags,
  onClose,
}: {
  threadId: string;
  tags: readonly string[];
  knownTags: readonly string[];
  onClose: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState<string[]>([...tags]);
  const [input, setInput] = useState("");
  const toggle = (tag: string) =>
    setDraft((current) =>
      current.includes(tag)
        ? current.filter((value) => value !== tag)
        : [...current, tag],
    );
  const save = async () => {
    const next =
      input.trim() === "" ? draft : [...new Set([...draft, input.trim()])];
    await rpc.call("tags_set", { threadId, tags: next });
    onClose();
  };
  const options = [...new Set([...knownTags, ...draft])].sort();
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Tags</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5">
          {options.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => toggle(tag)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs",
                draft.includes(tag)
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground",
              )}
            >
              {tag}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="New tag"
            aria-label="New tag"
          />
          <Button type="submit" size="sm">
            Save
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RenameDialog({
  thread,
  onClose,
}: {
  thread: PluginSidebarThread;
  onClose: () => void;
}) {
  const actions = useSidebarThreadActions();
  const [title, setTitle] = useState(thread.title ?? thread.displayTitle);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename thread</DialogTitle>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() === "") return;
            void actions.rename(thread.id, title.trim()).then(onClose);
          }}
        >
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label="Thread title"
            autoFocus
          />
          <Button type="submit" size="sm" disabled={title.trim() === ""}>
            Save
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SectionNameDialog({
  initial,
  title,
  onSave,
  onClose,
}: {
  initial: string;
  title: string;
  onSave: (name: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() === "") return;
            onSave(name.trim()).then(onClose, (cause: unknown) => setError(errorText(cause)));
          }}
        >
          <Input value={name} onChange={(event) => setName(event.target.value)} aria-label="Section name" autoFocus />
          <Button type="submit" size="sm" disabled={name.trim() === ""}>
            Save
          </Button>
        </form>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() => {
              setPending(true);
              onConfirm().finally(onClose);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DueDialog({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const { rpc, state } = useFlowState();
  const current = state?.due[threadId];
  const [custom, setCustom] = useState("");
  const [reason, setReason] = useState(current?.reason ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const save = async (at: () => number | null) => {
    setPending(true);
    setError(null);
    try {
      const value = at();
      await rpc.call("due_set", { threadId, at: value, reason: value === null || reason.trim() === "" ? null : reason.trim() });
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Due date</DialogTitle>
          <DialogDescription>
            {current
              ? `${formatDue(current.at)}, ${formatWhen(current.at)}. ${current.source === "agent" ? "Set by the agent." : "Set by you."}`
              : "A thread rises to Now as its date gets close."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {DUE_PRESETS.map((preset) => (
            <Button key={preset.when} variant="outline" size="sm" disabled={pending} onClick={() => void save(() => parseDue(preset.when))}>
              {preset.label}
            </Button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (custom.trim() !== "") void save(() => parseDue(custom));
          }}
        >
          <Input value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="fri, 2026-10-12…" aria-label="Custom due date" />
          <Button type="submit" size="sm" disabled={pending || custom.trim() === ""}>
            Set
          </Button>
        </form>
        <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Optional: what falls due" aria-label="What falls due" />
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {current ? (
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => void save(() => null)}>
              Clear date
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Focus is full: drop one to make room, or keep them all. */
export function FocusLimitDialog({
  limit,
  focusedIds,
  onReplace,
  onKeepAll,
  onClose,
}: {
  limit: number;
  focusedIds: readonly string[];
  onReplace: (threadId: string) => void;
  onKeepAll: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Focus is full</DialogTitle>
          <DialogDescription>
            You have {focusedIds.length} threads in Focus, and your limit is {limit}. Pick one to drop, or keep them all.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {focusedIds.map((threadId) => (
            <li key={threadId} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                <ThreadTitle threadId={threadId} />
              </span>
              <Button variant="ghost" size="sm" onClick={() => onReplace(threadId)}>
                Drop
              </Button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={onKeepAll}>
            Keep all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
