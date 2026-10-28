# Frontend extension registries

English | [简体中文](ui-extension-registries.zh-CN.md)

`@agnes/web-client` exports the platform singletons `settingsSections`, `conversationCards` and `homeEntries`, plus `UiExtensionRegistry` for isolated hosts/tests. These are presentation APIs. They do not select session tools, change configuration or grant capabilities. Use the host platform import rather than bundling another copy of web-client.

Register a settings section with `{ group, id, titleKey, groupTitleKey, icon, order, component }`. `runtimeCatalog: false` lets a section use its own service, refresh and loading states without fetching the plugin catalog; the shell still owns its title and navigation. IDs use lowercase letters, digits, dots and hyphens, starting with a letter. IDs must be unique and order must be finite. Register locale keys in the existing host locale service before rendering. `icon` identifies the shared settings icon. `component` receives `{ context }`, with locale text, optional session/resources and host-specific opaque `data`.

```tsx
const dispose = ctx.settingsSections.register({
  group: 'example', id: 'example.inspector', order: 52,
  titleKey: 'example.inspector.title', groupTitleKey: 'example.title',
  icon: 'plug', component: Inspector,
})
```

The settings dialog lists four built-in groups (General, Models, Permissions, Application) and, while the reader's "Show advanced settings" switch is on, an Advanced group. The switch is on by default: only an explicit "off" stored in this browser hides the group, and a missing or unreadable value counts as on. `group` places a section: `general`, `accounts`, `security` or `application` adds it as a tab of that group; `advanced` lists it in the Advanced group, so it is visible only while the switch is on; any other value lists it by its own title under Extensions, always visible. The shell owns navigation, tab keyboard behavior, layout and `?settings=<id>` deep links. The built-in account and general panes use a native-pane lifecycle bridge (`nativePane`, `navigationId`) to preserve their DOM, controllers and skin hooks. Other sections render through the same registry in the dialog's own page host. Plugins, skills, MCP, automation, session search and the archive are no longer settings pages; their old `?settings=<id>` links open the page or sidebar view that replaced them. An advanced option inside a page uses `SettingsAdvanced` from `@agnes/web-ui`, which follows the same switch (`useAdvancedSettings`). The optional opaque runtime context belongs to the host; extension authors should use supported client services for their own reads and actions.

The rail uses `data-testid="settings-navigation"`. Entries use `settings-nav-<id>` (a built-in page with tabs uses its first section's ID); tabs use `settings-nav-<id>-tab`, `role="tab"`, `aria-selected` and roving focus. Built-in controller IDs remain available. Runtime sections use `settings-page-<id>`; `SettingsPage`, `SettingsCard`, `Field`, shared form controls and `SettingsState` own the visual patterns.

A conversation registration has `{ id, order, matches, component }`. `matches` receives `{ kind, data }`; the first matching registration by order, then ID, renders. Predicates should inspect presentation data without requests or side effects. Components receive `{ card, context }`. Register more specific renderers before broad fallbacks. Built-ins register question, plan, deliverable, job, child, workflow, goal, schedule, plugin and tool categories. Plugin slot ownership and resource authorization continue through the existing slot and client resource services.

```tsx
const disposeCard = ctx.conversationCards.register({
  id: 'example.result', order: -10,
  matches: (card) => card.kind === 'example-result',
  component: ResultCard,
})
```

Use `ConversationCardLayout` for the surface and `SettingsState` for feedback. Card state is `ready`, `loading`, `empty`, `error` or `disabled`. Keep stable `<kind>-card` test IDs and meaningful form/article/log roles; job, child-agent and goal cards retain their IDs. Official questions, deliverable lists and workflow/reminder tables use the [Intelligent UI catalog](intelligent-ui-web.md) and its surface/form/action IDs.

### Home entries

Declared primary profile entries keep a host-owned loading page while a runtime generation awaits activation or its backend revision. The old module and its authority are revoked immediately; a ready roster replaces the loading page. Disabled, removed or failed contributions lose the entry.

`homeEntries` lists the pages a person opens from the home sidebar. A registration has `{ id, icon, titleKey, order, component }`, with optional `subtitleKey` (a quiet second label) and `badge`. Selecting the entry shows `component` as a full page in the main area in place of the conversation; the sidebar stays. The built-in Business agents, Plugins and Automation entries register through the same registry. Entries from plugins list after those three whatever `order` they declare, sorted by `order` then ID; more than three collapse into one “More” menu. Disposing the registration removes the entry, and a page that was showing returns to the conversation.

```tsx
import { homeNavigation } from '@agnes/web-client'
const dispose = ctx.homeEntries.register({
  id: 'example.board', order: 100, icon: 'activity',
  titleKey: 'example.board.title', component: BoardPage,
})
homeNavigation.open('example.board', { tab: 'week' })
```

`component` receives `{ context }`: `context.t` resolves host locale keys, and `context.selection` is the opaque value passed to `homeNavigation.open(id, selection)`. `badge` is `{ subscribe, getSnapshot }` returning a count; zero shows nothing. `icon` names a shared icon and falls back to the plugin icon. `homeNavigation.close()` returns to the conversation; `subscribe`/`getSnapshot` expose the requested `{ id, selection }`. The host mirrors the request in the address as `?page=<id>`, plus `&tab=<name>` when the selection is `{ tab: string }`, so a link opens the page once its entry registers. Page and tab changes enter browser history; Back and Forward restore the requested page without changing the session or workspace query parameters. Replacing a registration starts a new component lifetime, even when its ID and component function are reused. Entries are navigation only: they grant no capability and select no session tools. The sidebar uses `data-testid="home-entries"` and `home-entry-<id>`; a page built with the host frame uses `home-page-<id>`.

Registration returns an idempotent, identity-bound disposer. Bind it to the client module's effect/disposal scope; disposing an old registration cannot remove a later registration with the same ID. `subscribe` and `getSnapshot` support reactive hosts; `entries` returns registrations in render order, and `get` resolves an ID. Disposed selected settings sections fall back to the first built-in section; disposed home entries reveal the conversation. UI registration lifetimes must follow the installed module lifetime.

Session tool-group/session-info shapes remain backend-owned. `SessionToolsPanel` is the isolated renderer for `SessionCapabilitySet`, including enabled/disabled items and `source`/`rule` provenance, with an optional legacy `toolGroups` fallback; the registries do not normalize, expand or persist this data. Declare configuration sections with `createSchemaSettingsComponent` from the [configuration UI API](../extend/configuration-ui.md); save/test adapters do not change backend permissions.

[Session workbench panels](../extend/workbench-panels.md) describes registered right/bottom dock contributions.

### Contextual workbench panels

`WorkbenchPanel.visibility` defaults to `always`. Use `contextual` with a presentation-only `when(context)` predicate for panels that need session content. `icon` names a shared icon; optional `title(context)` supplies a content title. Neither field changes authorization. Built-in panels use the right dock; the `bottom` edge remains available to plugins.

## Profile home entries and packaged examples

Installed modules register home entries through `ctx.homeEntries.register`, with matching `client.homeEntries` declarations and `client.lifetime: "profile"`. Each declaration has an `id` and `placement: "primary" | "secondary"`. Built-in pages also declare primary placement. Primary entries always stay in the sidebar; secondary entries overflow together when there are more than three. Entries sort by order and then ID. Registration rejects duplicate IDs, more than 64 entries or more than 32 primary entries, without replacing an accepted entry. An omitted placement remains secondary.

The daemon roster supplies `binding` (owner, package, integrity, profile, activation, lifetime and availability). `ctx.availability` exposes a read-only snapshot and subscription. Profile modules use current activation regardless of the selected session; session modules retain their pinned history. Disable revokes global registrations before asynchronous cleanup and leaves recorded session content readable. Availability is presentation information; backend authorization still decides every operation. Split profile pages and session renderers into separate client contributions. A managed service's health is separate from static page availability.

A shipped example declares `metadata.exampleOf` naming its parent, an optional `pageEntry`, the parent dependency, and its own `bundles.<id>.launch` with an explicit preset. The relationship only grants the restricted example-management facade; it grants no arbitrary service or administration access. Ordinary agents use the host launch menu.

Profile modules use `ctx.profile.examples.list/inspect/enable/read/stop/inspectRemove/remove` and `ctx.profile.launch.prepare/start/openPage`. Inspection returns a five-minute review bound to the caller, activation, content and capabilities. Enable confirms those exact bytes through install, trust and checked activation. After stopping an example, `inspectRemove` creates a distinct removal review; `remove` accepts that review ID and a stable operation ID and retains the normal package reference/pin checks. Activation reviews cannot authorize removal. A launch selects the example's declared bundle and preset; a stable operation ID creates one session and one reviewed draft, including after a lost receipt. Missing bundles, presets, dependencies, changed content or revoked activation refuse the request. Unknown external outcomes remain visible through `read`; they are not replayed automatically. The browser facade accepts no package source or arbitrary administration method. SDK consumers can use `createExampleClient` with an authenticated host transport.

An example's profile module registers its declared component through `ctx.examplePages.register`. Its parent calls `ctx.examplePages.render(exampleId, context)` and subscribes to that registry's snapshots. The component retains its own module scope; it receives no parent admin connection. Keep simulation lifetime in the profile module's effect scope, so changing pages only detaches the scene. Dispose connections and stop work when the example is disabled or its owning browser closes. Reuse the existing workbench panel API for session tabs.

Declare scene resources in `client.assets`, relative to the same descriptor as `entry`. Supported formats include glTF/GLB, binary buffers, PNG/JPEG/WebP, KTX2 and WebAssembly. Installation rejects traversal and escaping symlinks. Immutable snapshots bind every file's hash and length and verify them on reads. Code files retain the 4 MiB per-file and 16 MiB combined limits; scene resources have a 32 MiB per-file and 128 MiB combined snapshot limit. Unsupported or oversized assets fail publication. Decoder execution must satisfy the deployment CSP; a served WebAssembly file does not imply that the browser can execute it. Scene loading failures must be surfaced by the example and must not be reported as device readiness. The launcher’s private asset read supports the same 32 MiB resource limit, including base64 overhead. Local and SEA packaging check declared client files, literal `new URL(..., import.meta.url)` references, CSS URLs and glTF buffer/image references against the shipped payload; prefer literal asset URLs so missing files fail the build.

A profile primary declaration may include `navigation: { title, titles?, icon, order }`. `titles` maps UI language tags to labels; `title` is the fallback. The host publishes navigation from the ready, enabled roster before importing code, then loads the module on first open. Its ordinary `ctx.homeEntries.register` claims the same entry under the existing declaration and ownership checks. Missing metadata preserves eager loading. Failed or revoked contributions remove their navigation immediately. This metadata grants no authority.

## Replace the deliverables presentation

A profile client first declares an explicit `client.id` and `presentationRoles` in its descriptor. Standard product roles are `navigation`, `conversation`, `composer`, `goal`, `interaction` and `deliverables`. The current [application](../extend/applications.md) or explicit user choice filters candidates before priority; installing an unselected provider cannot replace the current product. Ordinary non-product roles keep their existing priority semantics. A profile-lifetime client module can register `ctx.presentationRoles.register({ role: 'deliverables', priority: 0, mount })`. `mount` returns a synchronous disposer for every slot, card, panel and subscription it creates. The role uses the existing single-slot priority rule: the lowest number wins, equal priorities refuse registration, and the former owner yields before the next mounts. The default `@agnes/deliverables-ui` registers at 100. Roster revocation removes a provider before asynchronous module disposal; disabling a replacement restores the default. A role grants no backend authority.

Use `DeliverablesStore(ctx.agnes, ctx.session)` from `@agnes/web-client`; dispose it with the presentation. Its immutable `DeliverableRecord` contains `id`, `sessionId`, `laneId`, source owner/call, owning `turnId` when known, presentation `seq`, name/description, inline/workbench placement and the existing full `ArtifactRef`. Same-name history is a display grouping, not proof of lineage. A delivered version retains its snapshot when the workspace source changes. New deliveries persist a `structured` tool result alongside the existing deliverables event; historical Intelligent UI file lists remain readable. Intelligent UI is optional: recorded files remain available as a plain list without its renderer.

Register turn cards through `conversation.chat.turnTail` (owner `{ turn: UITurn, nodes: readonly UINode[] }`), the tab through `workbenchPanels`, and artifact components through `conversationCards` with kind `artifact-file` (data `{ file, sessionId, laneId }`). A card matching kind `intelligent-ui.surface` with a `UiSurfaceRecord` claims that whole surface for its own presentation, so the generic Views panel yields it. Return all these disposers from the role mount; do not rely on asynchronous unload to remove a tab. Open/download through `ctx.resources.documents/files` with the recorded lane and complete artifact reference. Never use the source path as a download URL.

See [the independent gallery example](../../examples/community/deliverables-gallery/README.md). The example covers current profile activation, historical recovery, takeover and restoration without Web host imports.

### Goals and interaction presentations

The default bundled `@agnes/goal-ui` and `@agnes/interaction-ui` packages own the
`goal` and `interaction` presentation roles, respectively (priority 100). A
replacement normally registers at priority 0. Role cleanup removes the complete
experience: cards, panels, composer commands, question dock, answer receipts and
folding policy. Backend goals, cost admission and execution authorization are
unaffected by presentation election. The conversation frame owns `conversation.view`;
interaction renderers register through `ctx.slots.inject()` so they follow that
parent declaration across module load ordering, frame replacement and restoration.

A client descriptor can declare `requiresBackendRows: ["ext:vendor/feature"]`.
These are optional presentation dependencies on exact backend row identities.
The daemon mounts the client only when every dependency is present and enabled
in the last successful runtime target (or the desired target before a first
successful activation). Missing/unobserved dependencies fail closed. This is a
visibility condition and grants no services, projections or execution rights.
All declarations and assets remain in the immutable snapshot while a dependency
is disabled, so enable/restart can restore the same reviewed client bytes.
The official descriptors name `ext:agnes/goal` and `ext:agnes/intelligent-ui`;
the host applies the same rule to every client, without package-name dispatch.

`readGoal(timeline)` returns the validated public `GoalView` (`StatusLinePayload`
with optional `GoalSnapshot`). It prefers the live `status.line` projection,
including an explicit clear/error, and recovers historical slot nodes when no
live fill exists. `goalCommand(input)` formats a human command request; send it
through the ordinary session input path. It does not authorize automatic
execution or change any platform budget. Durable goal facts and their existing
projection remain authoritative.

The generic conversation-card inputs used by these clients are:

| Kind | Data/context |
| --- | --- |
| `session.actions` | `{ timeline, disabled, command(text) }` |
| `composer.before-input` | Composer presentation outlet |
| `conversation.turn-tail` | `{ turn, nodes }` |
| `conversation.turn-actions` | `{ turn, nodes }` |
| `conversation.node` | The `UINode`; `context.data` is the native fallback |

A card can optionally provide `hiddenNodeIds(nodes, turns)` when its own visible
receipt replaces those nodes. On unregister the host restores native nodes.
The `composerCommands` registry accepts `{ id, order, route({text, sessionId,
busy}) }`; return `handled` for a completed presentation action, `steer` to
request the normal server-admitted steer path, or `undefined` to leave ordinary
input handling in place. Register and dispose these within the same role.

`ctx.presentation` exposes optional host navigation (`revealConversation`,
`focusApproval`) and authenticated custom-component roster reads/subscriptions
(`listComponents`, `subscribeComponents`). These are presentation seats only.
Question/form reads and actions continue through the existing authorized SDK
UI protocol; clients must never infer permission from an answer.


## Author tasks and lifetime

Use **pages**, **view positions**, **tool result cards**, **interaction cards**, **settings sections** and **takeover** as in the [UI glossary](ui-glossary.md). Add a page with `ctx.homeEntries`, a dock view with `ctx.workbenchPanels`, a recorded tool result with `ctx.conversationCards`, and a settings section with `ctx.settingsSections`. The minimal template appends content; it does not replace the sidebar.

Every author registration goes through the `ClientContext` facade, including slots, commands, file viewer actions and locale catalogs. It synchronously revokes before asynchronous disposal. A throwing or timed-out disposer cannot reserve an id or revive a revoked scope. Raw exported registries remain host/test APIs, not author registration paths. These lifecycle guards do not sandbox trusted JavaScript.

Global registrations require `lifetime: profile` and `availability: active`; an active session contribution cannot register global panels, settings or commands. A session contribution may render recorded session slots; it cannot register global pages, brand, roles, settings, panels or commands, open profile streams, or call profile management services. Current backend authorization still controls reads and actions.

`ctx.session.readiness` has `getSnapshot()` and `subscribe(listener)`. Readiness subscriptions are separate from the identity notifications of `ctx.session.subscribe`: reconnecting the same session updates readiness, and unmounting a presentation does not change session identity or clear draft attachments. Snapshots contain `status` (`no-session`, `connecting`, `ready`, `history-only`, `failed`), `sessionId` when bound, and a monotonically invalidated `epoch`. Wait for `ready` before live session queries. Capture the snapshot, ignore results if it changes, and re-query on every binding change. Never automatically retry an effect. The [service panel example](../../examples/packages/client-service-panel/v1/extensions/main/client/index.js) demonstrates cold mount and stale-result rejection.

Hosts can bind a presentation identity with `SessionService.setSession(id, 'connecting' | 'history-only')` without briefly publishing `ready`. Web publishes `ready` after the admitted conversation's opening, event subscription and controls are established; interactive presenters then share that subscription rather than attaching from the beginning during mounting.

A **lazy page module delivers only its page**: its other registrations would otherwise wait until the first page open. Put settings, dock views and roles in a separate eager client descriptor without lazy home-navigation metadata. Profile pages need no session.

The release defaults `@agnes/navigation-ui` and `@agnes/conversation-ui` backfill through the same bundled-package mechanism as goal, interaction and deliverables. They consume public `ctx.presentation.navigation/conversation/composer` ports and scoped registries. The conversation package registers `conversation` and `composer` independently. Host ports own current projections/actions, session binding, submission and queued work; mount/unmount never cancels a background session. Outer landmarks, settings/recovery/admin, dock containers and authorization remain host-owned.

Register a takeover with `mount(child)`: use **the child context** for every registration and `child.effect` for subscriptions. A bad mount automatically reclaims partial registrations before restoring the default. Cleanup must synchronously revoke; asynchronous cleanup can drain afterward. Equal-priority conflicts expose the role and both source owners through `presentationRoles.getSnapshot()/subscribe`, also shown on the plugins page. Application selection filters candidates before priority, and the release default remains the fallback.

The three runnable [Intelligent UI examples](../../examples/ui/README.md) cover a component library, the complete interaction presentation and a tool result card. Their Loop waits for authenticated action-result input; model HTML/JS is data, never executable content. A public service provider registration transaction derives its owner from the admitted row, supports `bindOwn`, rolls back failed claims and releases on dispose. Choosing a provider id cannot impersonate the semantic `UI_OWNER`. Queue reads, transitions and notifications are isolated by the admitted owner. Each registration has a separate lease: reusing the same provider object after revocation cannot restore old instances or pending opens.

Result delivery by an ordinary owner uses the Host-admitted extension Actor. Only an explicitly admitted semantic UI implementation can restore a human identity from a Host-authenticated receipt bound to the session, command and original request. A provider-written `action.received` or its Actor payload is never a credential. Older receipts without Host authentication cannot deliver human-identity results; recorded data remains renderable.
