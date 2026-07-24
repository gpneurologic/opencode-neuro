# Pin — Message Actions menu item

## Where it lives
- File: `packages/tui/src/routes/session/dialog-message.tsx`
- Symbol: `Pin` entry in the `DialogSelect` `options=[…]` array inside `DialogMessage`
- Renders as a menu entry in the "Message Actions" dialog (the right-click
  popup described by the user).
- Title: `Pin`
- Description (as confirmed by user): `prevent message being automatically compacted`

## What "Pin" means in this menu
The user-confirmed description is **"prevent message being automatically
compacted."** Pin is a **protection flag against future automatic
compaction**, not a bookmark / save-for-later feature. When the
auto-compactor sweeps a long session, pinned messages are skipped — their
content stays intact in the timeline even if everything around them gets
summarised.

This is a per-message boolean, conceptually close to a "lock" against the
compactor. It does **not** surface pinned messages in any special UI
list — its only effect is to keep that specific message out of the
compactor's reach.

## What the placeholder does today
```ts
onSelect: (dialog) => {
  // PLACEHOLDER: pin / unpin this message.
  dialog.clear()
}
```
No-op — closes the dialog, nothing else. No SDK call, no local state
change.

## Open questions / work to plan
1. **Data model**: needs a `pinned: boolean` (or `pinnedAt: timestamp`
   mirroring the existing `Session.ArchivedTimestamp` pattern at
   `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:55`)
   on the `Message` schema. Decide between:
   - boolean (`pinned: boolean`) — simplest, no temporal info
   - timestamp (`pinnedAt?: number`) — consistent with the existing
     `Session.ArchivedTimestamp` pattern, lets you derive the boolean
2. **Server API**: no `session.pin` / `session.unpin` /
   `session.setPinned` route exists today. Add a `session.setMessagePinned`
   (or similar) endpoint that takes `{ sessionID, messageID, pinned:
   boolean }` and returns the updated message. The SDK client
   (`packages/sdk/js/src/v2/gen/types.gen.ts`) is auto-generated from the
   OpenAPI spec — the httpapi-codegen task will need to be re-run after
   the route is added.
3. **Compactor integration**: confirm where the auto-compactor reads
   from and ensure it filters out pinned messages. Likely candidates:
   - `packages/opencode/src/session/compaction.ts` — the compactor
     implementation
   - any per-session compaction policy the compactor consults before
     summarising
   The menu is meaningless if the compactor ignores the flag.
4. **Toggle vs set**: the menu label is "Pin" (imperative). Decide
   whether clicking on an already-pinned message *unpins* it (toggle) or
   is a no-op (idempotent set). The rest of the menu uses imperative
   labels (Revert, Copy, Fork, Compact, Archive), so toggle behaviour
   matches that convention; the description doesn't disambiguate.
5. **UI indicator**: should pinned messages show a visible marker
   (icon, colour, divider) so users know which messages are protected?
   The menu description doesn't promise one — confirm with product before
   adding — but without an indicator, users have no way to see whether a
   message is currently pinned short of re-opening this menu.
6. **Optimistic update**: confirm whether `useSync` will push the pin
   change back through `sync.data.message[…]` automatically (see
   `packages/tui/src/context/sync.tsx` and `data.tsx`), or whether the
   handler needs to locally mutate `sync.data` for an immediate UI
   flip.
7. **Persistence**: confirm pin state survives session reload — likely
   yes if added to the DB-backed Message model, but verify.

## Reference implementations to study when implementing
- `Session.ArchivedTimestamp` in
  `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:55`
  — closest existing schema analogue (optional timestamp field).
- `packages/opencode/src/session/compaction.ts` — the auto-compactor
  that will need to read the new flag.
- `session.summarize` SDK call in
  `packages/tui/src/routes/session/dialog-message.tsx` (the `Compact`
  entry) — model for how a per-message mutation is called from the TUI.
- `revertOption` in `dialog-message.tsx` — closest existing handler to
  model the busy/click-guard pattern.