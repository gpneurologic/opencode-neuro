# Archive — Message Actions menu item

## Where it lives
- File: `packages/tui/src/routes/session/dialog-message.tsx`
- Symbol: `Archive` entry in the `DialogSelect` `options=[…]` array inside `DialogMessage`
- Renders as a menu entry in the "Message Actions" dialog (the right-click
  popup described by the user).
- Title: `Archive`
- Description (as confirmed by user): `replace message with summary and file reference`

## What "Archive" means in this menu
The user-confirmed description is **"replace message with summary and
file reference."** Archive is an **in-place collapse** of a single
message — the message stays visible in the timeline, but its body is
swapped for a shorter summary plus a pointer to where the full original
content lives (presumably a file on disk).

This is **not** deletion, **not** hide-from-view, and **not**
whole-session archive. The full content is preserved off-screen; only
its rendered form in the timeline is reduced.

## What the placeholder does today
```ts
onSelect: (dialog) => {
  // PLACEHOLDER: archive this message (or its session).
  dialog.clear()
}
```
No-op — closes the dialog, nothing else. No SDK call, no local state
change.

## Open questions / work to plan
1. **Data model**: the archived message has three pieces:
   - a short summary (where? inline `summary` field on the message? a
     sibling part?)
   - a reference to where the full content lives (a file path? a
     content-addressed hash? a session-relative URL?)
   - the original message still has its full content somewhere —
     decide where (replaced inline with a stub, or kept on the message
     and just not rendered?)
   Reusing the existing `compaction` part type
   (`packages/session-ui/src/components/message-part.tsx:1608`,
   `MessageDivider`) is the path of least resistance for the summary
   rendering — the same pattern full-session compaction uses.
2. **Server API**: no per-message archive endpoint exists today. The
   session-level `archived` field
   (`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:55`)
   is for whole-session archive and is **not** what's wanted here. Add
   a new endpoint — likely `session.archiveMessage` taking
   `{ sessionID, messageID }` — that writes the summary, writes the file
   reference, and returns the updated message. SDK is auto-generated
   (`packages/sdk/js/src/v2/gen/types.gen.ts`) so re-run httpapi-codegen
   after.
3. **File-on-disk format**: confirm where the full content is written
   and how it's referenced. Candidates: a dedicated `archive/` directory
   in the session storage, a content-addressed blob store, or the
   existing `part` storage. The reference in the timeline should be
   enough for the user to recover the full text on demand (e.g. by
   clicking the summary to expand it back).
4. **Round-trip with Compact**: Archive and Compact both produce a
   summary. Decide whether Archive reuses Compact's summarisation
   pipeline (so they share the model selection, prompt, and on-disk
   format) or whether Archive has its own simpler path (since "summarise
   this message" is exactly what Compact is supposed to do). Sharing the
   pipeline eliminates duplicated work; verify the Compact placeholder
   evolves to match.
5. **Expand-back UX**: with the body collapsed, can the user click the
   summary / file reference to see the original content again? If yes,
   the file reference should be rendered as a link; if no, document that
   the original is read-only from disk once archived.
6. **Confirmation**: archiving mutates the message (replaces its body).
   Consider whether to confirm via `DialogConfirm`
   (`packages/tui/src/ui/dialog-confirm.tsx`). Note that the existing
   Delete menu entry does **not** confirm — pick a consistent policy.
7. **Toggle vs set**: the menu label is "Archive" (imperative). Should
   re-clicking an already-archived message *unarchive* it (restore the
   original body) or be a no-op? The description doesn't disambiguate.
8. **Error UX**: use `toast.show({ variant: "error", ... })` from
   `packages/tui/src/ui/toast.tsx` rather than silently swallowing.
9. **Refetch**: confirm the message update flows back through `useSync`
   automatically (see `packages/tui/src/context/sync.tsx` and
   `data.tsx`), or whether the handler needs an explicit invalidation.

## Reference implementations to study when implementing
- `compaction` part renderer (`MessageDivider`) at
  `packages/session-ui/src/components/message-part.tsx:1608` — the
  rendering pattern already used for in-place summarisation in
  full-session compaction; strong candidate to reuse for the summary
  display.
- `packages/opencode/src/session/compaction.ts` — the compactor's
  summarisation pipeline. If Archive shares it (see Open Question #4),
  this is the integration point.
- `Compact` placeholder in `dialog-message.tsx` — companion menu item
  with closely-related semantics; Archive's implementation will likely
  sit beside it.
- `revertOption` in `dialog-message.tsx` — closest existing handler to
  model the busy/click-guard pattern and the destructive-action UX.