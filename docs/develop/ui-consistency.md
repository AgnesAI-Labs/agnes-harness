# Web UI consistency

English | [简体中文](ui-consistency.zh-CN.md)

[Documentation](../README.md) · [Frontend](frontend.md) · [Skins](skins.md) · [UI coverage](ui-coverage.md)

This is a presentation contract for the existing Web interface. It reuses `@agnes/web-ui`, its public exports and the existing theme. It keeps backend decisions, form values and permissions with their owning modules. See [UI coverage](ui-coverage.md) for current surfaces and verification boundaries, and the [source map](source-map.md) for owners.

The workbench layout belongs to `AppShell`. Its controller snapshots and replaceable slot surfaces share one React root and one antd `ConfigProvider`. Use `mountRegion` / `renderRegion` / `unmountRegion` for a controller-owned host: these render application portals, and never create another root. Render translated text in components; locale changes must preserve draft values, focus and controller-bound node IDs. Overlays share the shell container; popups opened from native dialogs stay within their dialog's top layer.

`createExternalStore` keeps controller ownership and defaults to synchronous notifications for controlled inputs. Components use `useStoreSelector` with optional equality. Non-input controller surfaces may opt into `notify: 'animation-frame'`; repeated writes publish at most once per frame, while `flush()` supplies a synchronous boundary for commands and tests. Workbench controller refreshes use frame batching with a synchronous initial mount. Region membership and each region's content use separate stores. Conversation streaming remains in the conversation projection store, outside these shell stores.

Every controller region has a `RegionErrorBoundary`, including separate workbench right/bottom portal boundaries; failures show a translated retry inside that region and enter the redacted browser diagnostic log. Existing plugin boundaries inside `SlotOutlet` continue to own plugin failures. The `--agh-z-*` baselines are dropdown 1000, drawer 1100, modal 1200, tooltip 1300 and notification 1400. `getOverlayContainer` supplies the shared shell outlet and modal-local popup scopes; custom/Radix portals should use the same exported policy so nested menus remain within the active focus trap.

## Page and panel structure

Use `SettingsPage` for an administrative page: one header with the localized title, a short description and page-level actions; a body of `SettingsCard` or flat `SettingsList` / `SettingsRow` sections; then the affected form's footer actions in `SettingsToolbar`. `SettingsPage` already owns the header and body stack; `headingId` and `bodyClassName` preserve existing title IDs and scroll bodies; compose the footer inside the form, rather than introducing another page framework. The settings hub owns the page header: its child panels must not repeat the same title.

Embedded and standalone plugin/resource pages use the same header, body, rows and actions. Keep their existing routes and navigation. The conversation shell retains its sidebar, composer and docks. Workbench panels reuse the same heading/action rhythm and `SettingsState`; conversation cards use `ConversationCardLayout`, with the state and title appropriate to the card. A dock's tab title can supply the panel title; avoid a duplicate heading.

Page actions belong beside the title; row actions belong beside the row; save/cancel actions belong after the fields. At narrow widths, actions wrap in source order and fields become one column. At 390 px, content must remain reachable without horizontal page scrolling. Only code, terminal output, diffs and genuine wide tables may scroll within a labeled region.

The built-in sidebar renders workspace headings, session buttons and action menus in one React tree. Its host `renderNavigation` adapter returns a React node; it does not populate a DOM mount point. Controller updates enter through `useSyncExternalStore`. Workspace selection and renaming use `Dialog`, retaining selector IDs, pending-state dismissal vetoes and focus return. Presentational native dialog hosts preserve skin hooks and the `open` selector while the shared component owns the modal behavior.

## Controls and forms

| Need | Public web-ui component | Contract to retain |
| --- | --- | --- |
| Text, search, URL, password, numeric input | `SettingsInput` | `type`, ID, ref, autocomplete, limits, validation and change handler |
| Multiline text, Markdown and command drafts | `SettingsTextArea` | Selection, IME, keyboard shortcuts, ref and draft ownership; `presentation="plain"` retains specialized terminal surfaces. The composer draft uses `Sender` from `@agnes/web-ui/x` |
| Select with existing native form/controller semantics | `SettingsSelect` / `SettingsOptionSelect` | Native value, options, form submission and events |
| Searchable or rich picker | `Select`; `createSelectPicker` for its supported DOM bridge | Accessible name, keyboard selection, caller-owned state and popup lifecycle |
| Boolean setting | `Switch` or `StateSwitch` | Controlled checked/disabled state; `StateSwitch` retains row propagation semantics |
| Labeled compact checkbox | `SettingsCheckbox` | Checked state, name/value, accessible label and form semantics |
| Choice group | `SettingsChoice` | Preserve radio semantics, arrow-key behavior and existing name/value selectors |
| Action | `Button`; `createSettingsButton` for controller-owned DOM actions | `htmlType`, disabled/loading state, accessible name and existing handler |
| Related views | `Tabs` | Current IDs, focus behavior, `aria-controls` and selected state |
| Overlay / anchored picker | `Dialog` / `Popover` | Escape, focus return, layering and cleanup |
| Field | `Field`; `SchemaConfigForm` / `PluginSchemaFields` for declared schemas | Label, hint, error and authoritative caller-owned data |

Native elements **inside web-ui** are legitimate component implementation: the current settings wrappers intentionally preserve native form semantics. Consumers must use the exports; a CSS class on a raw input is not a component migration. Do not force native-select controllers to use an antd value/event contract as a styling-only change. External UI dependencies remain confined to web-ui.

Put a visible label above the control, followed by help text and any field error. Preserve `htmlFor`/ID, `aria-describedby`, `aria-invalid`, required/disabled state and stable test IDs. A placeholder does not replace a label. Keep schema limits, revision checks and credential references unchanged. Do not nest an independent label/interactive action inside `Field`'s label. Read-only text uses ordinary copy or `SettingsCode`, rather than a disabled editable control.

## Lists, states and status

Reuse `PluginList`, `ResourceListContent`, `SettingsList` and `SettingsRow`. Rows have a title, secondary metadata and an action group. Keep semantic tables with caption and scoped headers, and contain overflow within the table region. Technical details use `SettingsDetails`; avoid nested full cards for each property.

Use `SettingsState` with explicit `loading`, `empty`, `error` or `success` tone. Loading keeps context and uses `aria-busy`; empty explains what is absent and provides an existing useful action when available; error gives a localized failure and an existing retry action; success confirms the operation. Preserve a draft on failure. A paragraph with `role="alert"` alone does not receive the error visual style. Conversation cards use the equivalent `ConversationCardLayout` state. Keep complex existing resource empty-state guidance when wrapping it in the shared presentation.

Use `Tag tone="warn|bad|info"` for actionable exceptions, at most one per row/card. Normal enabled/connected/running states do not need badges; descriptive information uses `MetaText`. Existing `Badge` / `StateLights` retain their public tones. Status color always accompanies localized text. Read `--agnes-status-success-*`, `--agnes-status-warning-*`, `--agnes-status-danger-*`, `--agnes-status-info-text` and neutral text tokens; do not invent page-specific colors or map a failed read to success.

## Dialogs and icons

Use a localized title, optional description, scrollable body, field/operation feedback, then one footer action group. Put cancel before the primary action; destructive actions retain their explicit confirmation. Existing native `<dialog>` hosts may remain: shared content can render inside them while their controller keeps `showModal()`, Escape, focus return and public skin hooks. Do not nest a second modal inside such a host. The initial setup guide keeps its existing backdrop and progress layout.

Use the existing `.icon` SVG presentation and the `SettingsIcon` component for settings navigation. Decorative icons are `aria-hidden`; icon-only buttons have localized accessible names. Do not replace icons with emoji or expose raw identifiers as operation labels.

## Scale and themes

The authority is `packages/web/public/styles/01-tokens.css`; `packages/web-ui/src/tokens.css` bridges semantic roles to static antd variables. Use these existing scales, rather than duplicating literal values:

| Purpose | Existing tokens |
| --- | --- |
| Spacing | `--s2`, `--s4`, `--s8`, `--s10`, `--s12`, `--s16`, `--s20`, `--s24`, `--s32`, `--s48` |
| Type | `--font-sans`, `--font-mono`, `--font-size-xs` (12), `--font-size-sm` (13), `--font-size-body` (14), `--font-size-md` (16), `--font-size-lg` (18), `--font-size-xl` (20), `--font-size-2xl` (24 px at default scale) |
| Line height | `--line-xs`, `--line-sm`, `--line-md`, `--line-lg` |
| Controls | `--control-height`, `--control-height-form`, `--control-height-touch` |
| Surface geometry | `--radius-*`, `--shadow-*`, `--admin-content-width`, `--dialog-max-height` |

New code uses `--s4/8/12/16/24/32/48`, `--radius-control/card/surface/pill`, `--elevation-0/1/2`, three shared font weights and `--motion-fast/base/ease`; old scales remain aliases for existing callers. Prefer 8–12 px within a field/row, 16–24 px between sections, and 24–32 px for page insets, through the corresponding tokens. Reuse shared component spacing before adding CSS. Do not round specialized trace/diff geometry into this scale if that changes its behavior.

Consume semantic `--agnes-*` colors. `.dark` supplies theme overrides and `color-scheme`; do not add a second theme switch or runtime ConfigProvider palette. Use `--agnes-input-surface` for editable fields and preserve focused, hovered, disabled and validation states. Any newly needed semantic color must have both light and dark values and follow the existing public skin-token generation contract. Keep `data-agnes-region` hooks and their surface specificity. Honor reduced motion and retain keyboard focus indicators.

All host-provided labels, help, empty states and errors have en and zh-CN entries. Format dates/numbers with the active locale; plugin/model identifiers, user content and protocol values remain literal.

## Documented native exceptions and acceptance

The composer uses `SettingsInput` for its hidden browser file chooser (`attachment-file-input`), retaining its native upload and accessibility contract. Approval, queue, turn and tool actions use `Button`. The turn-action clipboard fallback uses the shared control factory and removes its temporary textarea in `finally`. Native controls inside shared primitives remain implementation details.

Static HTML/template shells must not retain duplicate editable controls after migration. Fixed forms declare `template[data-agnes-control]`; web-ui's `materializeSettingsControls` creates shared token-styled native equivalents before controller binding, preserving IDs, options, validation and host node ownership. Remove obsolete fallback form markup or move it into shared React content, preserving DOM IDs, selectors, public hooks and controller lifetimes. Hidden duplicates are not accepted exceptions.

Review each inventory surface in en and zh-CN, light and dark, at desktop and 390 px, including overflow, keyboard focus and each relevant state. Capture evidence using the repository's existing screenshot harness with one browser page at a time. Record the source revision, theme, locale, viewport and any missing baseline explicitly. Screenshot capture is evidence, not a claim that behavior tests passed.

## Shared presentation primitives

`@agnes/web-ui` owns `Button`, `IconButton`, `Icon`, `Tag`, `MetaText`, `Count`,
`Menu`, `Tooltip`, `Toast`, `EmptyState`, `Banner`, `ListRow`, `Drawer`, `Skeleton`, `Field`,
`SettingsPageHeader` and `SettingsSaveBar`. Existing props and hooks remain supported.

`ListRow` supports `variant="file"` for compact file cards; it reuses the existing deliverable skin hooks and tokens. Keep previews outside the row so actions remain independent.
`Button` additionally accepts `appearance="primary|secondary|ghost|danger|link"`;
`dangerFilled` is reserved for destructive confirmations. Use `disabledReason` to
explain unavailable actions. Icon actions require a label and shared tooltip.
Menus contain actions (`role="menu"`); value pickers use `role="listbox"`. Native `positionSubmenu`
prefers the right/left side and falls back above/below the parent when neither side fits.
`Toast` accepts `tone="success|info|error"` (default `success`). Use `info` for navigation
notices and `error` for failed operations. Its `duration` remains milliseconds.

Settings pages compose heading → notice → toolbar → content → dirty save bar.
Use `SettingsPage variant="form|list"` (720/960px maximum), and toolbar `search`,
`filters`, `controls` slots. The caller owns dirty/busy state and all persistence.
Fields connect their help/error to controls; an error replaces help. `Drawer` is
480px on desktop and full screen at ≤767px; close other modals before opening.
`Dialog size="sm|md|lg"` uses 420/560/720px and a narrow bottom sheet.
Native hosts use `bindDialogSheets(document)`: dragging requests native cancellation,
so pending-state vetoes and focus restoration stay with the host. Release the returned
binding on pagehide. Closed/removed dialogs release their listeners; locale changes
update the handle's accessible name.

During page migration the app retains its existing narrow 32px minimum for legacy
compact controls. The expanded hit area is 44px at ≤767px; new `IconButton` keeps
28px visuals. Do not lower the existing narrow acceptance threshold.

The stable public CSS API is `@agnes/web-ui/components.css`: `.agh-btn` with
`--primary|secondary|ghost|danger|link`, `--sm|md`, `--icon`, `--danger-filled`,
plus `.agh-tag` (`data-tone="warn|bad|info"`), `.agh-meta`, `.agh-count`,
`.agh-banner`, `.agh-empty-state`, `.agh-list-row` and `.agh-field`.
The Web theme bridge includes these rules. Static buttons can use the same classes.
`.primary-button`, `.secondary-button` and `.icon-button` are internal aliases;
new business code must use the public components/contracts and semantic colors.
The internal `--agnes-ui-input-font-size` role keeps explicit picker, archive and
terminal input variants at the desktop scale and at least 16px on phones, even
when the user selects a small font scale.
The presentation guard permits only the recorded legacy baseline until those pages
migrate. Do not add new allowances for page styling.

## Navigation, loading and keyboard

The [UI author guide](ui-author-guide.md) describes public registrations and classes. Settings has eight everyday groups plus Advanced. The workbench keeps Files, Goal, Changes and Activity record, with business views and terminals shown contextually. Dual-placement Intelligent UI uses a conversation summary. Use shared SettingsState/Skeleton for loading. F6/Shift+F6 cycles visible sidebar, conversation or trace, workbench, plugin panels and composer; modals retain their focus. Closing drawers/dialogs returns focus. Narrow tests retain 375/768px and add 390px; phone targets must reach 44px, including clickable pseudo-elements, and icon controls need accessible names.

## Async state ownership

Session facts, execution results and authorization belong to the backend and SDK projection. The app coordination layer owns current session selection, connection and subscription lifetime. Remote snapshots (settings, lists and rosters) belong to the scoped resource store; components own drafts, expansion and local interactions.

A resource write commits a new version. Reads started before that commit cannot publish either data or errors over it; writes to the same resource share a queue across component lifetimes. Autosave coalesces each editor's unsent full-value replacements at the latest intent's position; an older failure cannot stop the newer value. Operations that read and modify the latest snapshot keep FIFO ordering. After an await, session and roster operations must recheck their selection or request identity before changing shared state. Obsolete work may release its own handles, but cannot reset another selection's renderer or recovery target. Module loads remain independent, with failures isolated to their region and registrations removed on unmount.

Finishing a routed page always replaces its current URL with the parent stack, even when the page came from a deep link with no owned history state. Reload and history restoration must keep that completed page closed.

Incidental URL updates preserve the raw `view` and `settings` route encoding, so page boundaries and identifiers containing slashes survive session and account metadata changes.

Completed operations publish localized results through the shell-owned feedback sink. Use one 3-second, polite `Toast` per operation ID, with no focus change. Keep field validation in `Field.error`, failures next to their operation in `StatusMessage` with an actual recovery action, and unresolved restart/rescan/reconnect/enable consequences in one notice per resource. Pending, unknown and partial outcomes are never success. Scope-only effects belong in a second toast sentence and stable help. `SettingsSaveBar` only handles unsaved edits.

Use `SettingsInput`, `SettingsTextArea`, `SettingsSelect`, `Select` and `SearchBar` for fields. They share `--agnes-input-surface` and state tokens; preserve unavailable saved values. Eligible fixed short-choice groups use `Segmented`: the same measured sliding thumb and track as the conversation/trace switch, native radio arrow keys and a visible focus state. Theme preview tiles and multi-select chips keep their own semantics. New raw inputs/selects and color literals outside web-ui are rejected by the explicit legacy ratchet.


Segmented is only for **2–5 short labels**, with a fixed small option count, no descriptions or sub-text, and labels that fit one line in both Chinese and English. A `radiogroup` is a selection semantic, not a presentation requirement. Use the existing descriptive `SettingsChoice` radio option list for titles with descriptions, source/version/capabilities, or long labels; use `Select` for long lists. Runtime/plugin-driven choices use descriptive rows or a Select, never Segmented. Preserve all option information and existing save/confirmation behavior. Do not shorten labels or remove descriptions to make a group fit Segmented. The UI guard permits descriptive radio groups and rejects hand-written segmented presentation, dynamic counts and out-of-range fixed counts. Translation fit is reviewed in both locales.
