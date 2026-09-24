# Skin authoring guide

English | [简体中文](skins.zh-CN.md)

<a id="皮肤作者指南"></a>

A skin changes the appearance of the Agnes Web interface. It is **data only**: a stylesheet, optional image/font assets, and optional semantic token overrides. A skin **does not execute code**.

[Documentation](../README.md) · [Plugin development](plugins.md)

Repository tests check region hooks, semantic tokens, and example packages against the actual interface contracts.

<a id="1-快速开始"></a>

## 1. Quickstart

A **complete installable example** is available at [`examples/packages/skin-example/v1`](../../examples/packages/skin-example/v1). Its manifest and stylesheet demonstrate the format below and are tested against the real contract.

When creating a skin in a session, call `plugin_helper_guide` with `kind: "skin"` to obtain a complete template. The current workspace does not need to contain AGH source.

The current package format registers a plugin row through `package.json` and binds a data-only client descriptor:

```json
{
  "name": "my-agh-skin",
  "version": "0.1.0",
  "type": "module",
  "exports": "./index.mjs",
  "agnes": {
    "plugins": [{ "id": "ext:my-agh-skin/main", "export": "main" }],
    "clientDescriptors": [{ "rowId": "ext:my-agh-skin/main", "path": "./extensions/main/agnes.client.json" }]
  }
}
```

`index.mjs` exports an empty plugin row: `export const main = { apply() {} }`.

`extensions/main/agnes.client.json`:

```json
{
  "skins": [{ "id": "midnight", "name": "Midnight", "css": "./skins/midnight/skin.css" }]
}
```

`extensions/main/skins/midnight/skin.css`:

```css
/* Use data-agnes-region hooks so changes to internal classes do not break the skin. */
[data-agnes-region="app"] {
  background-image: linear-gradient(180deg, #10151c, #1c2430);
}
[data-agnes-region="sidebar"] {
  background-color: #151b23;
}
[data-agnes-region="composer"] {
  border-color: #2b3644;
}
```

Key rules:

- `clientDescriptors.rowId` must match the plugin row ID. The descriptor's `skins` field registers skins. The legacy `agnes.extension.json` format is not the entry point for new packages.
- `css` must be a **package-relative path**, starting with `./` and containing no `..`, drive letters, or backslashes.
- Skin IDs cannot be `light`, `dark`, `system`, or `none`, which are reserved for built-in themes. IDs must be **unique across installed skins**.

<a id="2-区域钩子稳定的选择器契约"></a>

## 2. Region hooks: the stable selector contract

**Use `data-agnes-region`.** Internal classes and IDs such as `.sidebar`, `#composer`, and `turn-*` are not a public contract and may change. Region hooks are versioned contracts: a rename must be reflected in contract checks.

| Hook | Element | Pages |
| --- | --- | --- |
| `app` | `body` | All three |
| `topbar` | Page `header` | All three |
| `dialog` | `dialog` (9 in workbench / 4 in plugin management / 3 in Skills and MCP) | All three |
| `sidebar` | `aside.sidebar` | Workbench |
| `conversation` | Conversation wrapper | Workbench |
| `trace` | Execution trace `aside` | Workbench |
| `rightbar` | Right extension panel `aside` | Workbench |
| `transcript` | Conversation list container | Workbench |
| `empty-state` | Empty state | Workbench |
| `approval` | Approval area | Workbench |
| `composer` | Input wrapper `form` | Workbench |
| `composer-input` | Input `textarea` | Workbench |
| `icon` | Interface icon `svg` (26 in workbench) | Workbench |
| `settings-pane` | Settings section (6 in workbench) | Workbench |

- Skins apply on **three pages**: workbench `/`, plugin management `/admin/plugins`, and Skills/MCP `/admin/resources`. Rules on `app`, `topbar`, and `dialog` therefore apply across these pages.
- **Message-level internals are not part of the contract.** Renderers generate `turn-*`, `node-*`, and similar structures dynamically; their current availability does not guarantee stability.

<a id="21-换掉图标用-mask-而不是贴图"></a>

### 2.1 Replace icons with masks

Every interface icon has the `icon` hook. Icons are **stroke-based SVGs** using `stroke: currentColor`. To replace one with an image, use the image as a mask so its color continues to follow the theme:

```css
[data-agnes-region="icon"] {
  /* Hide the original stroke, use the image as a mask, and fill with currentColor. */
  stroke: none;
  background-color: currentColor;
  mask: url("assets/glyph.png") center / contain no-repeat;
}
.dark [data-agnes-region="icon"] {
  background-color: var(--agnes-text-primary);
}
```

To change only line weight/color, use `stroke-width: 2.5; stroke: var(--agnes-brand-primary);`.

> Internal classes such as `.icon` are not the contract. Always target `[data-agnes-region="icon"]`.

<a id="22-换字体"></a>

### 2.2 Change fonts

Font files (`.woff2` / `.woff`) use the same `assets/` directory and size limits as images. Load them with `@font-face`:

```css
@font-face {
  font-family: "Skin Face";
  src: url("assets/face.woff2") format("woff2");
}
body,
button,
input,
textarea {
  font-family: "Skin Face", system-ui, sans-serif;
}
```

You can also use a system font stack without distributing assets, for example `font-family: "Chalkboard SE", "Comic Sans MS", cursive;`.

<a id="23-特异性为什么用钩子选择器就够不需要-important"></a>

### 2.3 Specificity and stylesheet order

Skin stylesheets are inserted through `adoptedStyleSheets`, after document stylesheets in cascade order. Order resolves a conflict only when specificity is equal. Base styles therefore place skin-facing surface properties on `data-agnes-region` selectors with specificity (0,1,0), rather than element IDs with specificity (1,0,0). With the same specificity, the later skin rule wins, so `!important` is unnecessary for those surfaces.

```css
/* Override the composer background using its region hook. */
[data-agnes-region="composer"] {
  background-image: linear-gradient(160deg, #101820, #1d2b3a);
}
```

The guard in `packages/web/test/skin-regions.test.ts` checks this invariant and fails if those surface properties move back to ID selectors.

**Exception: the workbench settings dialog.** Workbench dialogs share the `dialog` hook, but settings (`#config`) has a distinct surface declared through an ID selector. To override that surface:

- Prefer **tokens**, such as allowlisted `--agnes-bg-surface` and `--agnes-bg-page`.
- Use `!important` only when an arbitrary CSS surface rule, such as a background image, needs to override that ID rule.

Other dialogs, `settings-pane`, and the listed hook surfaces do not require `!important` for these overrides.

<a id="3-语义-token-清单"></a>

## 3. Semantic tokens

The following variable names can appear in `tokens`. The allowlist is generated from `packages/web/public/style.css`, which is the authoritative theme color source. Adding/removing tokens without updating generated output fails `gen:check`; documentation tests compare this list with the generated allowlist.

<!-- theme-tokens:begin -->
--agnes-brand-primary
--agnes-brand-focus-ring
--agnes-brand-emphasis-soft
--agnes-text-primary
--agnes-text-secondary
--agnes-text-tertiary
--agnes-text-disabled
--agnes-text-inverse
--agnes-text-emphasis
--agnes-icon-secondary
--agnes-bg-page
--agnes-bg-surface
--agnes-bg-popover
--agnes-bg-card
--agnes-bg-code
--agnes-bg-selected
--agnes-bg-hover
--agnes-bg-scrim
--agnes-surface-glass-soft
--agnes-surface-glass-hover
--agnes-input-surface
--agnes-input-content-strong
--agnes-input-placeholder
--agnes-input-border
--agnes-input-border-emphasis
--agnes-input-border-focus
--agnes-line-emphasis
--agnes-line-primary
--agnes-button-primary-bg
--agnes-button-primary-bg-hover
--agnes-button-primary-content
--agnes-button-outline-content
--agnes-status-success-text
--agnes-status-success-bg
--agnes-status-warning-text
--agnes-status-warning-bg
--agnes-status-danger-text
--agnes-status-danger-bg
--agnes-status-info-text
--shadow-elevation
--shadow-hairline
--shadow-dialog
--shadow-elevation-soft
--shadow-elevation-prominent
--agnes-bg-app-sidebar
--agnes-bg-app-content
--agnes-trace-track
--agnes-trace-row-current
--agnes-trace-row-hover
--agnes-trace-lane-input
--agnes-trace-lane-user
--agnes-trace-lane-context
--agnes-trace-lane-model
--agnes-trace-lane-tool
--agnes-trace-badge-user-text
--agnes-trace-badge-user-bg
--agnes-trace-badge-context-text
--agnes-trace-badge-context-bg
--agnes-trace-badge-assistant-text
--agnes-trace-badge-assistant-bg
--agnes-trace-badge-tool-text
--agnes-trace-badge-tool-bg
--agnes-trace-badge-approval-text
--agnes-trace-badge-approval-bg
--agnes-trace-badge-compaction-text
--agnes-trace-badge-compaction-bg
<!-- theme-tokens:end -->

Every token must provide **both** `light` and `dark` values:

```json
{
  "tokens": {
    "--agnes-bg-page": { "light": "#fdfeff", "dark": "#161b21" }
  }
}
```

Values must be valid CSS color or shadow expressions, with no `;`, `{`, `}`, or `@`, and no `url(...)`. URLs are permitted in `skin.css`, but not in token values. Gradients such as `linear-gradient(180deg, #ffffff, #f0f0f0)` are allowed.

You may override only a subset; omitted values fall back to the current built-in theme. Prefer tokens for resilience across changes, then use `skin.css` for styling they cannot express.

<a id="4-深浅色"></a>

## 4. Light and dark modes

Agnes switches modes through `.dark` on the root element and follows `prefers-color-scheme`.

- **Tokens:** Provide both `light` and `dark`; Agnes selects the value for the current mode.
- **`skin.css`:** Write rules for both modes yourself:

```css
[data-agnes-region="app"] { background-image: linear-gradient(180deg, #f7f8fa, #eef1f5); }
.dark [data-agnes-region="app"] { background-image: linear-gradient(180deg, #10151c, #1c2430); }
```

Check readability in both modes. Styling only one can make the other difficult to use.

<a id="5-资产图片与字体"></a>

## 5. Assets: images and fonts

Place assets in an **`assets/` directory beside the stylesheet** and reference them relatively:

```text
skins/aurora/
  skin.css
  assets/
    aurora.webp
    body.woff2
```

```css
[data-agnes-region="app"] {
  background-image: url('assets/aurora.webp');
  background-size: cover;
  background-position: center;
}
@font-face {
  font-family: 'Skin Body';
  src: url('assets/body.woff2') format('woff2');
}
```

Rules:

- Allowed extensions: `.webp`, `.png`, `.jpg`, `.jpeg`, `.avif`, `.woff2`, `.woff`.
- Maximum 2 MB per asset, 8 MB total assets per skin, and 128 KB per stylesheet. Packages exceeding limits are rejected.
- **No remote resources or inline base64.** Page policy includes `default-src 'self'`; remote images/fonts and `data:` URIs are blocked. Include images in the package.
- Only files under `assets/` are served. Other files next to the stylesheet are unavailable through the asset route.
- **Relative paths resolve from the stylesheet**, as in ordinary CSS: `url('assets/x.png')` maps to `/skins/<SKIN_ID>/assets/x.png`. Do not hard-code the skin ID or a machine path. The host converts asset references to absolute served URLs when delivering stylesheet text because initial inline text otherwise resolves against the page. Author package-relative references; the host handles the served URL.

<a id="6-能力与限制"></a>

## 6. Capabilities and limits

| Change | Supported? |
| --- | --- |
| Colors, gradients, shadows | Yes |
| Background images for the page, sidebar, conversation, composer, or dialogs | Yes |
| Fonts | Yes; include font files under `assets/` |
| Border radii, spacing, motion, layout | Yes; ordinary CSS |
| JavaScript execution or interaction changes | No; skins are data only |
| Remote images/fonts | No; blocked by CSP |
| Inline base64 images | No; `data:` blocked by CSP |

<a id="7-调试"></a>

## 7. Debugging

- **Temporarily disable a skin:** Add `?skin=none` to the page URL to force the built-in appearance, or `?skin=<id>` to select a specific skin. These are one-time overrides without a cached preference change. Reopen the URL without the parameter to return to your saved selection. Use this if a skin makes settings inaccessible.
- **CSS changes do not appear:** Stylesheets are cached by manifest `revision`. Disable/re-enable the package or reselect the skin to load current content.
- **Inspect available skins:** Open Settings → General → Appearance → Skin. The list includes skins declared by **enabled and trusted** packages.
