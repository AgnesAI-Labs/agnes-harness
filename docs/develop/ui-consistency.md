# Web UI consistency

English | [简体中文](ui-consistency.zh-CN.md)

[Documentation](../README.md) · [Frontend](frontend.md) · [Skins](skins.md) · [UI coverage](ui-coverage.md)

This is a presentation contract for the existing Web interface. It reuses `@agnes/web-ui`, its public exports and the existing theme. It does not change navigation, backend decisions, form values or permissions. The [source inventory and implementation sequence](ui-consistency-audit.md) distinguish existing components from work still needed.

## Page and panel structure

Use `SettingsPage` for an administrative page: one header with the localized title, a short description and page-level actions; a body of `SettingsCard` or flat `SettingsList` / `SettingsRow` sections; then the affected form's footer actions in `SettingsToolbar`. `SettingsPage` already owns the header and body stack; compose the footer inside the form, rather than introducing another page framework. The settings hub owns the page header: its child panels must not repeat the same title.

Embedded and standalone plugin/resource pages use the same header, body, rows and actions. Keep their existing routes and navigation. The conversation shell retains its sidebar, composer and docks. Workbench panels reuse the same heading/action rhythm and `SettingsState`; conversation cards use `ConversationCardLayout`, with the state and title appropriate to the card. A dock's tab title can supply the panel title; avoid a duplicate heading.

Page actions belong beside the title; row actions belong beside the row; save/cancel actions belong after the fields. At narrow widths, actions wrap in source order and fields become one column. At 390 px, content must remain reachable without horizontal page scrolling. Only code, terminal output, diffs and genuine wide tables may scroll within a labeled region.

## Controls and forms

| Need | Public web-ui component | Contract to retain |
| --- | --- | --- |
| Text, search, URL, password, numeric input | `SettingsInput` | `type`, ID, ref, autocomplete, limits, validation and change handler |
| Multiline text, Markdown and command drafts | `SettingsTextArea` | Selection, IME, keyboard shortcuts, ref and draft ownership; `presentation="plain"` retains specialized composer/terminal surfaces |
| Select with existing native form/controller semantics | `SettingsSelect` / `SettingsOptionSelect` | Native value, options, form submission and events |
| Searchable or rich picker | `Select`; `createSelectPicker` for its supported DOM bridge | Accessible name, keyboard selection, caller-owned state and popup lifecycle |
| Boolean setting | `Switch` or `StateSwitch` | Controlled checked/disabled state; `StateSwitch` retains row propagation semantics |
| Labeled compact checkbox | `SettingsCheckbox` | Checked state, name/value, accessible label and form semantics |
| Choice group | `SettingsChoice` | Preserve radio semantics, arrow-key behavior and existing name/value selectors |
| Action | `Button` | `htmlType`, disabled/loading state, accessible name and existing handler |
| Related views | `Tabs` | Current IDs, focus behavior, `aria-controls` and selected state |
| Overlay / anchored picker | `Dialog` / `Popover` | Escape, focus return, layering and cleanup |
| Field | `Field`; `SchemaConfigForm` / `PluginSchemaFields` for declared schemas | Label, hint, error and authoritative caller-owned data |

Native elements **inside web-ui** are legitimate component implementation: the current settings wrappers intentionally preserve native form semantics. Consumers must use the exports; a CSS class on a raw input is not a component migration. Do not force native-select controllers to use an antd value/event contract as a styling-only change. External UI dependencies remain confined to web-ui.

Put a visible label above the control, followed by help text and any field error. Preserve `htmlFor`/ID, `aria-describedby`, `aria-invalid`, required/disabled state and stable test IDs. A placeholder does not replace a label. Keep schema limits, revision checks and credential references unchanged. Do not nest an independent label/interactive action inside `Field`'s label. Read-only text uses ordinary copy or `SettingsCode`, rather than a disabled editable control.

## Lists, states and status

Reuse `PluginList`, `ResourceListContent`, `SettingsList` and `SettingsRow`. Rows have a title, secondary metadata and an action group. Keep semantic tables with caption and scoped headers, and contain overflow within the table region. Technical details use `SettingsDetails`; avoid nested full cards for each property.

Use `SettingsState` with explicit `loading`, `empty`, `error` or `success` tone. Loading keeps context and uses `aria-busy`; empty explains what is absent and provides an existing useful action when available; error gives a localized failure and an existing retry action; success confirms the operation. Preserve a draft on failure. A paragraph with `role="alert"` alone does not receive the error visual style. Conversation cards use the equivalent `ConversationCardLayout` state. Keep complex existing resource empty-state guidance when wrapping it in the shared presentation.

Use `Badge` or `StateLights`, with visible localized text: `ok` for success, `warn` for caution, `bad` for failure, `off` / `unknown` for neutral or unknown state. Status color is supplementary. Read `--agnes-status-success-*`, `--agnes-status-warning-*`, `--agnes-status-danger-*`, `--agnes-status-info-text` and neutral text tokens; do not invent page-specific colors or map a failed read to success.

## Dialogs and icons

Use a localized title, optional description, scrollable body, field/operation feedback, then one footer action group. Put cancel before the primary action; destructive actions retain their explicit confirmation. Existing native `<dialog>` hosts may remain: shared content can render inside them while their controller keeps `showModal()`, Escape, focus return and public skin hooks. Do not nest a second modal inside such a host. The initial setup guide keeps its existing backdrop and progress layout.

Use the existing `.icon` SVG presentation and `createSettingsIcon` for settings navigation. Decorative icons are `aria-hidden`; icon-only buttons have localized accessible names. Do not replace icons with emoji or expose raw identifiers as operation labels.

## Scale and themes

The authority is `packages/web/public/styles/01-tokens.css`; `packages/web-ui/src/tokens.css` bridges semantic roles to static antd variables. Use these existing scales, rather than duplicating literal values:

| Purpose | Existing tokens |
| --- | --- |
| Spacing | `--s2`, `--s4`, `--s8`, `--s10`, `--s12`, `--s16`, `--s20`, `--s24`, `--s32`, `--s48` |
| Type | `--font-sans`, `--font-mono`, `--font-size-xs` (12), `--font-size-sm` (13), `--font-size-body` (14), `--font-size-md` (16), `--font-size-lg` (18), `--font-size-xl` (20), `--font-size-2xl` (24 px at default scale) |
| Line height | `--line-xs`, `--line-sm`, `--line-md`, `--line-lg` |
| Controls | `--control-height`, `--control-height-form`, `--control-height-touch` |
| Surface geometry | `--radius-*`, `--shadow-*`, `--admin-content-width`, `--dialog-max-height` |

Prefer 8–12 px within a field/row, 16–24 px between sections, and 24–32 px for page insets, through the corresponding tokens. Reuse shared component spacing before adding CSS. Do not round specialized trace/diff geometry into this scale if that changes its behavior.

Consume semantic `--agnes-*` colors. `.dark` supplies theme overrides and `color-scheme`; do not add a second theme switch or runtime ConfigProvider palette. Use `--agnes-input-surface` for editable fields and preserve focused, hovered, disabled and validation states. Any newly needed semantic color must have both light and dark values and follow the existing public skin-token generation contract. Keep `data-agnes-region` hooks and their surface specificity. Honor reduced motion and retain keyboard focus indicators.

All host-provided labels, help, empty states and errors have en and zh-CN entries. Format dates/numbers with the active locale; plugin/model identifiers, user content and protocol values remain literal.

## Documented native exceptions and acceptance

Outside web-ui, retain only the hidden file input in `packages/web-units/src/composer.ts` for the browser upload chooser (`attachment-file-input`), with its existing accessibility and upload lifecycle. Within web-ui, the temporary textarea in `conversation/turn-actions.tsx` is a platform clipboard fallback, removed in `finally`; it is not an editable product field. Native controls encapsulated by the shared library remain implementation details, including accessible checkbox/radio semantics.

Static HTML/template shells must not retain duplicate editable controls after migration. Remove obsolete fallback form markup or move it into shared React content, preserving DOM IDs, selectors, public hooks and controller lifetimes. Hidden duplicates are not accepted exceptions.

Review each inventory surface in en and zh-CN, light and dark, at desktop and 390 px, including overflow, keyboard focus and each relevant state. Capture matching before/after evidence using the repository's existing screenshot harness with one browser page at a time. Screenshot capture is evidence, not a claim that behavior tests passed.
