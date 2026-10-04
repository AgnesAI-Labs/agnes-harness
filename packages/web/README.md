# AGH Web workbench

The browser workbench connects to AGH's shared daemon through the browser SDK. It provides tasks, conversation history, streaming output, approvals, model accounts and plugin settings.

## Run locally

From the repository root, follow the [source installation guide](../../docs/guide/install.md). A complete local build includes CLI, daemon, worker and Web assets:

```sh
pnpm --filter @agnes/cli build:local
node packages/cli/dist/local/agnes.mjs serve
```

Open the printed loopback URL. Configure a model account, create a task and confirm its working directory. `AGH_HOME` and `AGNES_PROFILE` select the same instance used by the CLI; closing the Web server does not stop the shared daemon.

New tasks select their execution loop from the backend runtime catalog in the workspace dialog or composer. Unavailable runtimes retain their reason in the selector. After creation, the composer shows the persisted runtime and version as a fixed label; changing the model does not change this identity. Older daemons without runtime discovery retain the Native creation path. A failed connection or an unavailable selected runtime does not select a different loop automatically.

`src/session-pane.ts` owns one session's permission binding, live projection, identity and disposal. Multiple pane owners must use different session IDs and keep separate renderers and plugin session scopes. Disposing a pane releases its subscriptions and permission handler without cancelling backend work. The single-session application uses this owner; the comparison coordinator is a separate backend API, not client-side calls to two prompt endpoints.

The “双线对比” workspace creates two isolated snapshot sessions with a shared model selection and separate runtime choices. First send opens the main content area directly, with the decision graph, JevLoop conversation and Native conversation in that visual order. One workspace switch selects conversation or both traces while preserving the graph, mounted owners and shared replay cut. Results and management remain available in header disclosures. Narrow screens keep the graph above a selectable lane. Persisted left/right identities do not change when the lanes are visually reordered. Each side owns its projection, approval card, native trace panel and cancellation control. Shared input is sent once through the comparison coordinator. Acceptance and completion are displayed separately for each side; uncertain transport results retain their input ID and block further submission until a status query confirms acceptance. The separate “核对持久状态” action explicitly reconciles persisted receipts without opening or executing sessions; ordinary refresh only queries the stored comparison.

Reopening the workspace restores its last comparison within the browser tab. The saved-comparison list reads paginated metadata without opening or resuming sessions. Refresh and load-more preserve that boundary; only selecting an inspectable entry opens its two lanes. Preparing or failed entries remain visible, and missing historical timestamps are shown as unknown. Switching pairs detaches views without cancelling either run and restores each pair’s local draft. An unresolved submission or in-flight operation blocks switching so its input ID and draft are retained. A failed selection preserves the previous comparison. Closing the workspace or navigating to a new session detaches views without cancelling work. Management exposes release and deletion only when the backend lifecycle permits them.

Single Jev sessions use a decision canvas beside the original conversation, with a resizable split and a compact conversation/canvas switch on narrow screens. The composer and approvals stay with the conversation. The canvas supports step selection and read-only history; raw records remain in a collapsed inspector. Historical decisions, dispatch, settlement and cancellation records come from the persisted ledger. Historical raw reads use the existing local-owner diagnostics endpoint; a permission error remains visible.

The decision canvas prioritizes adopted candidates; pending and unconsumed groups expand on demand. Pool ports follow rendered geometry, and collapsing groups releases extra canvas space while preserving the scroll position where possible. Newly observed connections receive one short light pulse during live updates or forward replay. Existing evidence stays static across redraws, and the system's reduced-motion preference disables these pulses. The graph uses the shared theme colors.

Comparison panes reuse the native Trace component, with independent search, selection and tool details. Conversation, graph and trace commit the same shared journal cut; transient assistant previews only overlay the live conversation. Tool detail reads use the selected lane’s exact call/result coordinates and retire replies invalidated by replay or session ownership changes. Raw events remain available in a secondary inspector. Extension renderers and rich artifact interactions remain in the ordinary session view.

## Guides and contracts

- [Web operations](../../docs/guide/web.md) and [first task](../../docs/guide/quickstart.md).
- [Model and account configuration](../../docs/reference/configuration.md).
- [Sessions and recovery](../../docs/guide/sessions.md).
- [Security and trust](../../docs/guide/security.md): exact Origin/Host checks, credential ownership and plugin trust.
- [Frontend plugins](../../docs/develop/frontend.md) and [skin authoring](../../docs/develop/skins.md).

Shared UI components belong in `packages/web-ui`; settings and resource surfaces use the shared renderers. Package-local tests cover transport, rendering and public region contracts. Use a real browser to verify layout, keyboard interaction and downloads for the target release.

Computer Use RPC coordination belongs to Web's internal `src/computer-use-state.ts`. `createComputerUseState` exposes stable, immutable `getSnapshot()` values, `subscribe()` with an unsubscribe function, and the existing status, permission, diagnostic and operation actions. Snapshots contain safe display text, control availability and the last confirmed operation's ID/kind/state/phase. The `src/computer-use.ts` controller keeps the legacy pane and button API by subscribing to this state; a replacement pane receives a fresh owner. `dispose()` retires replies, subscriptions and local polling waits without cancelling backend work. Injected polling waits may accept an optional `AbortSignal` to release their resources. Failed operation submissions remain unconfirmed and require progress refresh before another submission; exhausted or failed polling retains the last confirmed operation. A `not-found` response means no visible record and does not confirm cancellation or completion.

Comparison quote details load on expansion at the shared durable journal cursor, using
`client.comparison.priceDetails`. The panel renders frozen quote sources, rates,
validity/calendar, and per-bucket estimates separately from reported billing;
missing historic quotes and unattested usage remain unknown. Detail paging cannot
advance the replay cursor, and late responses cannot replace a newer cut. Prepared
configuration is explicitly unknown until a durable preparation receipt exists.

Comparison metrics show frozen prepared configuration only when the fixed journal
cut contains both its publication and trusted source evidence. Older comparisons
and earlier cuts remain explicitly unknown. The panel renders actual model slot
settings, permission/enforcement evidence, runtime-specific Jev limits and scoped
fingerprints. It does not reconstruct preparation from current settings; preset
view fingerprints explicitly leave mounted plugin-generation configuration
unattested. Preparation and price details remain collapsed until opened.
