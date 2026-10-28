# Build a UI that fits Agnes

English | [简体中文](ui-author-guide.zh-CN.md)

[Frontend lifecycle](frontend.md) · [UI consistency](ui-consistency.md) · [Terminology](ui-glossary.md) · [Skins](skins.md)

Use public exports from `@agnes/web-ui` for components and `@agnes/web-client` for registries. Reuse the host's platform singletons; do not import antd directly or bundle another React or registry instance. Keep backend authorization and session facts in their owning services.

## Buttons and page structure

Use `Button` and `IconButton`. Static plugin markup can use the same public CSS contract already supplied by the host:

```html
<button type="button" class="agh-btn agh-btn--primary agh-btn--md">Save</button>
<button type="button" class="agh-btn agh-btn--ghost agh-btn--sm">Details</button>
```

`.agh-btn` is required; choose `--primary`, `--secondary`, `--ghost`, `--danger` or `--link`, and `--sm` or `--md`. Reserve `--danger-filled` for destructive confirmation. Use at most one primary action in each view. Internal aliases such as `.primary-button` are not author APIs. Icon actions need a localized accessible name and tooltip; prefer `IconButton name="…" label="…"` over hand-built SVG controls.

Compose settings with `SettingsSection`, `SettingsGroup` / `SettingsItem` (a setting row: name and description on the left, control on the right), `SettingsDetails`, `SearchBar`, `LabeledSwitch` and `SettingsSaveBar`. The settings hub supplies the page template and its heading; a child panel should not repeat it. Declare the page's one-line description with `SettingsPageDescription` and its actions with `SettingsPageActions`: both land in the hub's header. Keep diagnostics a user rarely needs in `SettingsTechnicalDetails`. `SchemaConfigForm` supplies schema-driven fields. Preserve drafts on failure. Use `SettingsState tone="loading|empty|error|success"`; loading includes a decorative `Skeleton` and a busy live status. Standalone `Skeleton` needs an accompanying localized status message. Use `EmptyState` to explain the next step, and `Tag` only for an actionable exception.

## Workbench registration

```tsx

const dispose = ctx.workbenchPanels.register({
  id: 'example.notes', order: 50, edge: 'right',
  titleKey: 'example.notes.title', icon: 'file',
  visibility: 'contextual',
  when: (context) => Boolean(context.session),
  component: NotesPanel,
})
```

Register en and zh-CN translations before rendering, and bind the returned disposer to the client module lifetime. `icon` names come from the shared icon catalog. Choose `contextual` for panels useful only with relevant content; `when(context)` controls visibility. Omitted `visibility` retains `always` for existing contributions. A dynamic `title(context)` may supply the surface's own title. These hooks affect presentation only and never grant permissions. The shell owns tabs, the More menu, sizing, F6 navigation and focus return. See [workbench panels](../extend/workbench-panels.md).

## Settings groups

Register `SettingsSection` through `settingsSections`, with a stable `id`, `titleKey`, `groupTitleKey`, `group`, `icon`, finite `order` and `component`. Use `general`, `accounts`, `security` or `application` to add a tab to the corresponding everyday group. Use `advanced` for technical controls visible while Show advanced settings is on. Other group IDs appear as individually named sections under Extensions; supply localized titles. Plugins, Skills, MCP and Automation have their own product pages, rather than settings groups. Do not set the built-in `nativePane` or `navigationId` fields for a plugin panel. Set `runtimeCatalog: false` when the panel owns its loading and failure states.

## Intelligent UI summaries

Give each surface a useful `title` and a one-sentence `summary` (up to 1,024 characters). When both `placement.inline` and `placement.workbench` are enabled, the conversation shows the summary and an expand action, and the workbench shows the full interface. When that workbench is open, the inline summary is collapsed to avoid duplicate content. An omitted summary falls back to text content or a localized action count; an explicit summary explains the user's task better. Use the supported presets and preserve their backend action/approval contracts.

## Tokens and accessibility

Use semantic `var(--agnes-*)` colors and shared spacing (`--s4/8/12/16/24/32/48`), radii (`--radius-control/card/surface/pill`), font weights and motion tokens. Keep raw colors in the palette or a skin's paired light/dark overrides. Brand marks the main action, selection, links and focus; status colors accompany text. Do not write private button styles or use `!important` to override shared controls. Preserve `data-agnes-region` hooks.

Before shipping, check both languages and themes at desktop and 390px. Keep Tab order natural, focus visible, dialog/drawer close focus on the opener, and narrow hit targets at least 44px. Shared buttons expand their hit area without enlarging icon visuals; leave room between adjacent actions. Compact custom pointer controls can use `.agh-touch-target` for the same expanded area; read-only code scrollports retain their keyboard scrolling. F6/Shift+F6 cycles visible task regions and leaves modal focus intact. Check loading, empty, failure/retry and success; respect reduced motion. Validate color pairs with the [token contrast test](../../packages/web-ui/test/token-contrast.test.ts), then run the affected behaviour and accessibility checks.

## Offer a standard presentation role

A profile client can declare `presentationRoles: ["deliverables"]` (or `navigation`, `conversation`,
`composer`, `goal`, `interaction`) in its descriptor and register that role through the scoped client
facade. Use a stable `client.id`. An administrator chooses the implementation in **Settings →
Application → Advanced interface choices**, after a consent preview. Installing or registering a
provider does not select it. No application declaration is required; choices can override one role
while preserving the adopted application's brand and other defaults. See [applications](../extend/applications.md).
