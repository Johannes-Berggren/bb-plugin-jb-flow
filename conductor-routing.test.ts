import assert from "node:assert/strict";
import { test } from "node:test";
import { noteEvent, routeNote, splitNotes, type CiNote, type CiNoteKind } from "./conductor-routing.ts";

const note = (kind: CiNoteKind, fields: Partial<CiNote> = {}): CiNote => ({
  kind,
  text: kind,
  repo: "acme/web-app",
  pr: 7,
  ...fields,
});

test("news the worker must act on goes to the worker", () => {
  for (const kind of ["failed", "review", "changes-requested", "comment", "review-hint"] as const) {
    assert.equal(routeNote(note(kind)), "worker", kind);
  }
});

test("routine news goes to the conductor", () => {
  for (const kind of ["merged", "closed", "no-checks", "timeout", "unreadable"] as const) {
    assert.equal(routeNote(note(kind)), "conductor", kind);
  }
});

test("green goes to the worker only when it has more to do", () => {
  assert.equal(routeNote(note("green")), "conductor");
  assert.equal(routeNote(note("green", { afterGreen: "merge" })), "conductor");
  assert.equal(routeNote(note("green", { afterGreen: "nothing" })), "conductor");
  assert.equal(routeNote(note("green", { afterGreen: "continue" })), "worker");
});

test("without a conductor the worker gets every note, in order", () => {
  const notes = [note("green"), note("merged"), note("failed")];
  assert.deepEqual(splitNotes(notes, false), { worker: notes, conductor: [] });
});

test("with a conductor the notes are split, keeping their order", () => {
  const notes = [note("green"), note("failed"), note("merged"), note("review-hint")];
  const { worker, conductor } = splitNotes(notes, true);
  assert.deepEqual(worker.map((n) => n.kind), ["failed", "review-hint"]);
  assert.deepEqual(conductor.map((n) => n.kind), ["green", "merged"]);
});

test("an inbox event keeps the PR and the worker's intent", () => {
  assert.deepEqual(noteEvent(note("green", { afterGreen: "merge", text: "✅ green" })), {
    kind: "green",
    text: "✅ green",
    meta: { repo: "acme/web-app", pr: 7, afterGreen: "merge" },
  });
  assert.deepEqual(noteEvent(note("merged")).meta, { repo: "acme/web-app", pr: 7 });
});
