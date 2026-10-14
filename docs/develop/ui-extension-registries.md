# Frontend extension registries

English | [简体中文](ui-extension-registries.zh-CN.md)

`@agnes/web-client` exports the platform singletons `settingsSections`, `conversationCards` and `homeEntries`, plus `UiExtensionRegistry` for isolated hosts/tests. These are presentation APIs. They do not select session tools, change configuration or grant capabilities. Use the host platform import rather than bundling another copy of web-client.

Register a settings section with `{ group, id, titleKey, groupTitleKey, icon, order, component }`. `runtimeCatalog: false` lets a section use its own service, refresh and loading states without fetching the plugin catalog; the shell still owns its title and navigation. IDs use lowercase letters, digits, dots and hyphens, starting with a letter. IDs must be unique and order must be finite. Register locale keys in the existing host locale service before rendering. `icon` identifies the shared settings icon. `component` receives `{ context }`, with locale text, optional session/resources and host-specific opaque `data`.

```tsx
import { settingsSections } from '@agnes/web-client'
const dispose = settingsSections.register({
  group: 'example', id: 'example.inspector', order: 52,
  titleKey: 'example.inspector.title', groupTitleKey: 'example.title',
  icon: 'plug', component: Inspector,
})
```

The settings dialog lists three built-in pages (General, Models & accounts, Permissions & security) and, while the reader's "Show advanced settings" switch is on, an Advanced group. The switch is on by default: only an explicit "off" stored in this browser hides the group, and a missing or unreadable value counts as on. `group` places a section: `general`, `accounts` or `security` adds it as a tab of that page; `advanced` lists it in the Advanced group, so it is visible only while the switch is on; any other value lists it by its own title under Extensions, always visible. The shell owns navigation, tab keyboard behavior, layout and `?settings=<id>` deep links. The built-in account and general panes use a native-pane lifecycle bridge (`nativePane`, `navigationId`) to preserve their DOM, controllers and skin hooks. Other sections render through the same registry in the dialog's own page host. Plugins, skills, MCP, automation, session search and the archive are no longer settings pages; their old `?settings=<id>` links open the page or sidebar view that replaced them. An advanced option inside a page uses `SettingsAdvanced` from `@agnes/web-ui`, which follows the same switch (`useAdvancedSettings`). The optional opaque runtime context belongs to the host; extension authors should use supported client services for their own reads and actions.

The rail uses `data-testid="settings-navigation"`. Entries use `settings-nav-<id>` (a built-in page with tabs uses its first section's ID); tabs use `settings-nav-<id>-tab`, `role="tab"`, `aria-selected` and roving focus. Built-in controller IDs remain available. Runtime sections use `settings-page-<id>`; `SettingsPage`, `SettingsCard`, `Field`, shared form controls and `SettingsState` own the visual patterns.

A conversation registration has `{ id, order, matches, component }`. `matches` receives `{ kind, data }`; the first matching registration by order, then ID, renders. Predicates should inspect presentation data without requests or side effects. Components receive `{ card, context }`. Register more specific renderers before broad fallbacks. Built-ins register question, plan, deliverable, job, child, workflow, goal, schedule, plugin and tool categories. Plugin slot ownership and resource authorization continue through the existing slot and client resource services.

```tsx
const disposeCard = conversationCards.register({
  id: 'example.result', order: -10,
  matches: (card) => card.kind === 'example-result',
  component: ResultCard,
})
```

Use `ConversationCardLayout` for the surface and `SettingsState` for feedback. Card state is `ready`, `loading`, `empty`, `error` or `disabled`. Keep stable `<kind>-card` test IDs and meaningful form/article/log roles; job, child-agent and goal cards retain their IDs. Official questions, deliverable lists and workflow/reminder tables use the [Intelligent UI catalog](intelligent-ui-web.md) and its surface/form/action IDs.

### Home entries

`homeEntries` lists the pages a person opens from the home sidebar. A registration has `{ id, icon, titleKey, order, component }`, with optional `subtitleKey` (a quiet second label) and `badge`. Selecting the entry shows `component` as a full page in the main area in place of the conversation; the sidebar stays. The built-in Business agents, Plugins and Automation entries register through the same registry. Entries from plugins list after those three whatever `order` they declare, sorted by `order` then ID; more than three collapse into one “More” menu. Disposing the registration removes the entry, and a page that was showing returns to the conversation.

```tsx
import { homeEntries, homeNavigation } from '@agnes/web-client'
const dispose = homeEntries.register({
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
