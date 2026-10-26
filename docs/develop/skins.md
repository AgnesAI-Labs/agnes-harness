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
    "plugins": [{ "apiRange": "^5.0.0", "id": "ext:my-agh-skin/main", "export": "main" }],
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

- `clientDescriptors.rowId` must match the plugin row ID. The descriptor's `skins` field registers skins. There is no separate extension manifest file; a plugin entry carries its own `capabilities` and `contributes`.
- `css` must be a **package-relative path**, starting with `./` and containing no `..`, drive letters, or backslashes.
- Skin IDs cannot be `light`, `dark`, `system`, or `none`, which are reserved for built-in themes. IDs must be **unique across installed skins**.

<a id="2-区域钩子稳定的选择器契约"></a>

## 2. Region hooks: the stable selector contract

**Use `data-agnes-region`.** Internal classes and IDs such as `.sidebar`, `#composer`, and `turn-*` are not a public contract and may change. Region hooks are versioned contracts: a rename must be reflected in contract checks.

| Hook | Element | Pages |
| --- | --- | --- |
| `app` | `body` | All three |
| `topbar` | Page `header` | All three |
| `dialog` | `dialog` | All three |
| `sidebar` | `aside.sidebar` | Workbench |
| `conversation` | Conversation wrapper | Workbench |
| `trace` | Execution trace `aside` | Workbench |
| `rightbar` | Right extension panel `aside` | Workbench |
| `workbench-right` | Right session dock `aside` | Workbench |
| `workbench-bottom` | Bottom session dock `aside` | Workbench |
| `transcript` | Conversation list container | Workbench |
| `empty-state` | Empty state | Workbench |
| `home-page` | Full page opened from a home sidebar entry `section` | Workbench |
| `approval` | Approval area | Workbench |
| `composer` | Input wrapper `form` | Workbench |
| `composer-input` | Input `textarea` | Workbench |
| `icon` | Interface icon `svg` | Workbench |
| `settings-pane` | Settings section | Workbench |

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

### 2.3 Cascade layers and skin precedence

The canonical order is declared in `@agnes/web-ui/layers.css`:

```css
@layer tokens, base, vendor, ui, app, skin;
```

Platform theme variables belong to `tokens`, native control defaults to `base`, Ant Design and Markdown vendor styles to `vendor`, shared components and the Ant Design theme bridge to `ui`, and application rules to `app`. The Web build emits the order once, before the rules, on all three entry pages. Shared component CSS exports import this same order for other Web UI consumers.

The host wraps a skin's authored stylesheet in `skin` when adopting it. Write ordinary CSS using the public region hooks; no layer declaration is required in the skin file. Normal skin declarations win over the earlier layers, including application ID selectors, so settings dialog surface overrides do not need `!important`. Token overrides retain their existing inline application and light/dark behavior. CSS importance still takes priority over normal declarations; hidden elements and reduced-motion safeguards retain their important rules.

```css
[data-agnes-region="composer"] {
  background-image: linear-gradient(160deg, #101820, #1d2b3a);
}
```

Region hooks remain the stable contract. The guard in `packages/web/test/skin-regions.test.ts` continues to check their surface declarations. Client-module styles are loaded through a native CSS `@import` in `app`; relative imports and asset URLs resolve from the original package stylesheet. Client modules own their component styling, while a skin owns appearance overrides across the host.

<a id="3-语义-token-清单"></a>

## 3. Semantic tokens

The following variable names can appear in `tokens`. The allowlist is generated from `packages/web/public/style.css`, whose ordered source fragments in `public/styles/` are the authoritative theme color source. Adding/removing tokens without updating generated output fails `gen:check`; documentation tests compare this list with the generated allowlist.

<!-- theme-tokens:begin -->
--agnes-brand-primary
--agnes-brand-mark
--agnes-brand-focus-ring
--agnes-brand-emphasis-soft
--agnes-focus-ring-soft
--agnes-scrollbar-thumb
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
--agnes-bg-fill
--agnes-bg-fill-hover
--agnes-bg-group
--agnes-bg-scrim
--agnes-bg-lightbox
--agnes-surface-glass-soft
--agnes-surface-glass-hover
--agnes-bg-user-bubble
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
--agnes-status-info-bg
--agnes-bg-subtle
--agnes-status-success-border
--agnes-status-warning-border
--agnes-status-danger-border
--agnes-status-info-border
--agnes-status-success-solid
--agnes-status-warning-solid
--agnes-status-danger-solid
--agnes-status-info-solid
--shadow-elevation
--focus-outline
--focus-line
--focus-line-inset
--shadow-raised
--shadow-hairline
--shadow-dialog
--shadow-elevation-soft
--shadow-elevation-prominent
--elevation-0
--elevation-1
--elevation-2
--agnes-line-hairline
--agnes-bg-popover-material
--agnes-menu-active-bg
--agnes-menu-active-text
--agnes-switch-track
--agnes-switch-knob
--agnes-segment-track
--agnes-bg-control
--shadow-control
--shadow-control-primary
--shadow-knob
--shadow-popover
--agnes-bg-app-sidebar
--agnes-bg-app-content
--agnes-trace-track
--agnes-trace-row-current
--agnes-trace-row-hover
--agnes-trace-mark-bg
--agnes-trace-mark-text
--agnes-trace-row-hit
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
--agnes-file-type-text
--agnes-file-type-html
--agnes-file-type-css
--agnes-file-type-js
--agnes-file-type-ts
--agnes-file-type-json
--agnes-file-type-md
--agnes-file-type-svg
--agnes-file-type-image
--agnes-file-type-code
--agnes-file-type-other
--agnes-document-page-bg
--agnes-terminal-bg
--agnes-terminal-bar
--agnes-terminal-line
--agnes-terminal-text
--agnes-terminal-muted
<!-- theme-tokens:end -->

Status surfaces and elevation levels added to the theme contract:

| Token | Purpose |
| --- | --- |
| `--agnes-status-info-bg` | Background for informational notices. |
| `--agnes-bg-subtle` | Muted background for secondary surfaces. |
| `--agnes-status-success-border` | Border for success states. |
| `--agnes-status-warning-border` | Border for warning states. |
| `--agnes-status-danger-border` | Border for error or danger states. |
| `--agnes-status-info-border` | Border for informational states. |
| `--elevation-0` | Flat surfaces without a shadow. |
| `--elevation-1` | Shadow for small floating surfaces. |
| `--elevation-2` | Shadow for dialogs and raised surfaces. |
| `--agnes-bg-user-bubble` | Bubble surface of the user's own message; neutral, never the accent. |
| `--agnes-status-success-solid` | Non-text success marks such as dots and icons (at least 3:1). |
| `--agnes-status-warning-solid` | Non-text warning marks. |
| `--agnes-status-danger-solid` | Non-text error or danger marks. |
| `--agnes-status-info-solid` | Non-text informational marks. |
| `--agnes-line-hairline` | Dividers and control outlines; a tint of the text colour, drawn one device pixel wide on dense screens. |
| `--agnes-bg-popover-material` | Surface of menus and option lists: the popover colour at 94% over a backdrop blur. Keep it at least 94% opaque so text contrast holds. |
| `--agnes-menu-active-bg`, `--agnes-menu-active-text` | Fill and content colour of the pointed or keyboard-current row of a menu or picker; the pair must keep 4.5:1. |
| `--agnes-switch-track`, `--agnes-switch-knob` | Track and knob of a switch that is off; the on state uses `--agnes-brand-primary` and `--agnes-button-primary-content`. |
| `--agnes-segment-track` | Track of a segmented control. |
| `--agnes-bg-control` | Raised control surface: secondary buttons, popup buttons and the picked segment. |
| `--shadow-control`, `--shadow-control-primary` | Hairline ring and 1px lift of a raised control; lit top edge of a primary button. |
| `--shadow-knob` | Shadow of a switch knob. |
| `--shadow-popover` | Shadow of menus and option lists. |

Scales are not part of the `tokens` allowlist, but a skin stylesheet may set them on `:root` like any other CSS: the type scale (`--font-size-title`, `--font-size-caption`), radii (`--radius-sm` … `--radius-xl`), control sizes (`--control-height`, `--switch-width`, `--switch-height`), the icon line weight (`--icon-stroke`, `--icon-stroke-strong`), the hairline width (`--hairline`), continuous corners (`--corner-shape`, `--corner-scale`) and motion (`--motion-short`, `--motion-medium`, `--motion-long`, `--motion-spring`). Shared controls read these values, so one declaration reaches every button, switch, menu and dialog. Motion you add must stay inside `@media (prefers-reduced-motion: no-preference)`.

The built-in theme's values, its type and radius scales, and how these tokens reach Ant Design and Ant Design X are described in the [theme guide](ui-theme.md).

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

## Shared controls and readability

Follow the [UI author guide](ui-author-guide.md) token rules. Shared `.agh-btn*` controls, states, forms, skeletons and drawers consume semantic tokens. Do not target private antd classes or remove focus rings and 44px narrow hit targets. Body/icon/status text needs 4.5:1 contrast; control boundaries and focus need 3:1 in both themes. Start with the [token contrast table](../../packages/web-ui/test/token-contrast.test.ts); validate a custom skin’s actual overridden colors separately. Respect reduced motion.
