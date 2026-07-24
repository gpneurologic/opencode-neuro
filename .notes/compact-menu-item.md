# Compact — Message Actions menu item

## Where it lives
- File: `packages/tui/src/routes/session/dialog-message.tsx`
- Symbol: `Compact` entry in the `DialogSelect` `options=[…]` array inside `DialogMessage`
- Renders as a menu entry in the "Message Actions" dialog (the right-click
  popup described by the user).
- Title: `Compact`
- Description (as confirmed by user): `summarize this message`

## What "Compact" means in this menu
The user-confirmed description is **"summarize this message"** — narrow,
per-message. Clicking Compact on a single message should produce a summary
of just that message's content, replacing or annotating it in place. It is
**not** "compact up to here" and **not** "compact the whole session."

## What the placeholder does today
```ts
onSelect: (dialog) => {
  void sdk.client.session.summarize({ sessionID: props.sessionID }).catch(() => {})
  dialog.clear()
}
```
Calls `sdk.client.session.summarize(...)` with no `messageID` and swallows
errors. As a result, the placeholder currently fires **whole-session**
compaction — the wrong behaviour for a per-message menu item. It will
need to be replaced before this is shippable as anything other than a
demo.

## Open questions / work to plan
1. **Server API**: `session.summarize` (server route
   `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:303`,
   SDK `packages/sdk/js/src/v2/gen/types.gen.ts:10111`) currently accepts
   `{ sessionID, providerID?, modelID?, auto? }` — no `messageID`. To
   match the menu's semantics, the endpoint needs to grow a `messageID`
   (or be replaced by a new `session.summarizeMessage` endpoint) that
   summarises a single message rather than the whole conversation.
2. **Storage of the summary**: where does the generated summary live?
   Options: written back into the message as a new `summary` field on the
   part, stored as a sibling `compaction` part (the pattern already used
   in `packages/tui/src/routes/session/index.tsx:1425` for full-session
   compaction), or kept entirely client-side. The `compaction` part type
   already has a renderer
   (`packages/session-ui/src/components/message-part.tsx:1608` via
   `MessageDivider`), so reusing it is the path of least resistance.
3. **Model selection**: the slash-command version of compact in
   `packages/tui/src/routes/session/index.tsx:554` passes `modelID` /
   `providerID` from `local.model.current()`. The placeholder skips this.
   Confirm whether per-message compaction also needs an explicit model
   choice (and whether to default to the same selector) or whether it
   can fall back to the session's default.
4. **In-flight guard**: if a compaction is already running
   (`session.time.compacting` — see `packages/tui/src/context/sync.tsx:581`),
   the placeholder will fire a second one. Disable the menu item while a
   compaction is in flight, or show a toast (see
   `packages/tui/src/ui/toast.tsx`) like the slash command's "Connect a
   provider" warning.
5. **Error UX**: `.catch(() => {})` silently drops failures. Use
   `toast.show({ variant: "error", ... })` so failures surface.
6. **Refresh after compact**: confirm whether `useSync` propagates the new
   `compaction` part automatically. `packages/tui/src/context/data.tsx:377`
   already handles `session.next.compaction.*` events — verify they
   trigger for per-message compact too, or whether an explicit refetch is
   needed.

## Reference implementations to study when implementing
- `Compact session` slash command at
  `packages/tui/src/routes/session/index.tsx:554` — model for
  provider/model wiring and toast UX (whole-session today, but the
  boilerplate is identical).
- Server route for `session.summarize`:
  `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:303`
  (and the corresponding `SummarizePayload` schema) — the endpoint to
  extend or to mirror for a per-message variant.
- `Compaction` part renderer (`MessageDivider`) at
  `packages/session-ui/src/components/message-part.tsx:1608` — the
  rendering pattern for in-place summary display, if the summary is
  stored as a sibling `compaction` part.
- `revertOption` in `dialog-message.tsx` — closest existing handler to
  model the busy/click-guard pattern.