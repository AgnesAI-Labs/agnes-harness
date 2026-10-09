# Frontend extension registries

English | [简体中文](ui-extension-registries.zh-CN.md)

`@agnes/web-client` exports the platform singletons `settingsSections` and `conversationCards`, plus `UiExtensionRegistry` for isolated hosts/tests. These are presentation APIs. They do not select session tools, change configuration or grant capabilities. Use the host platform import rather than bundling another copy of web-client.

Register a settings section with `{ group, id, titleKey, groupTitleKey, icon, order, component }`. `runtimeCatalog: false` lets a section use its own service, refresh and loading states without fetching the plugin catalog; the shell still owns its title and navigation. IDs use lowercase letters, digits, dots and hyphens, starting with a letter. IDs must be unique and order must be finite. Register locale keys in the existing host locale service before rendering. `icon` identifies the shared settings icon. `component` receives `{ context }`, with locale text, optional session/resources and host-specific opaque `data`.

```tsx
import { settingsSections } from '@agnes/web-client'
const dispose = settingsSections.register({
  group: 'tools', id: 'example.inspector', order: 52,
  titleKey: 'example.inspector.title', groupTitleKey: 'settings-shell.group.tools',
  icon: 'tools', component: Inspector,
})
```

The settings shell owns group navigation, tab keyboard behavior, layout and `?settings=<id>` deep links. Built-in account, resource, archive, Computer Use and general panes use a native-pane lifecycle bridge (`nativePane`, `navigationId`) to preserve their existing DOM, controllers and skin hooks. Other sections render through the same registry in the runtime pane. The optional opaque runtime context belongs to the host; extension authors should use supported client services for their own reads and actions.

The rail uses `data-testid="settings-navigation"`. Group buttons use `settings-nav-<first-section-id>`; group tabs use `settings-nav-<id>-tab`, `role="tab"`, `aria-selected` and roving focus. Built-in controller IDs remain available. Runtime sections use `settings-page-<id>`; `SettingsPage`, `SettingsCard`, `Field`, shared form controls and `SettingsState` own the visual patterns.

A conversation registration has `{ id, order, matches, component }`. `matches` receives `{ kind, data }`; the first matching registration by order, then ID, renders. Predicates should inspect presentation data without requests or side effects. Components receive `{ card, context }`. Register more specific renderers before broad fallbacks. Built-ins register question, plan, deliverable, job, child, workflow, goal, schedule, plugin and tool categories. Plugin slot ownership and resource authorization continue through the existing slot and client resource services.

```tsx
const disposeCard = conversationCards.register({
  id: 'example.result', order: -10,
  matches: (card) => card.kind === 'example-result',
  component: ResultCard,
})
```

Use `ConversationCardLayout` for the surface and `SettingsState` for feedback. Card state is `ready`, `loading`, `empty`, `error` or `disabled`. Keep stable `<kind>-card` test IDs and meaningful form/article/log roles; job, child-agent and goal cards retain their IDs. Official questions, deliverable lists and workflow/reminder tables use the [Intelligent UI catalog](intelligent-ui-web.md) and its surface/form/action IDs.

Registration returns an idempotent, identity-bound disposer. Bind it to the client module's effect/disposal scope; disposing an old registration cannot remove a later registration with the same ID. `subscribe` and `getSnapshot` support reactive hosts; `entries` returns registrations in render order, and `get` resolves an ID. Disposed selected sections fall back to the first built-in section. UI registration lifetimes must follow the installed module lifetime.

Session tool-group/session-info shapes remain backend-owned. `SessionToolsPanel` is the isolated renderer for `SessionCapabilitySet`, including enabled/disabled items and `source`/`rule` provenance, with an optional legacy `toolGroups` fallback; the registries do not normalize, expand or persist this data. Declare configuration sections with `createSchemaSettingsComponent` from the [configuration UI API](../extend/configuration-ui.md); save/test adapters do not change backend permissions.

[Session workbench panels](../extend/workbench-panels.md) describes registered right/bottom dock contributions.
