# AGH theme

English | [简体中文](ui-theme.zh-CN.md)

Agnes Web has one built-in theme, used by the workbench, settings and the standalone admin pages. It is calm and tool-like: a warm off-white ground, one graphite gray family, one indigo accent, borders instead of shadows. Light and dark are both complete.

[Documentation](../README.md) · [Skins](skins.md) · [UI author guide](ui-author-guide.md) · [Frontend](frontend.md)

## Where the values live

| Layer | File | Contents |
| --- | --- | --- |
| `tokens` | [`packages/web/public/styles/01-tokens.css`](../../packages/web/public/styles/01-tokens.css) | The palette (`--agnes-color-*`, private), semantic tokens for light (`:root`) and dark (`.dark`), and the scales. |
| `ui` | [`packages/web-ui/src/tokens.css`](../../packages/web-ui/src/tokens.css) | The bridge from semantic tokens to Ant Design and Ant Design X variables (`--ant-*`). |
| `ui` | [`packages/web-ui/src/components.css`](../../packages/web-ui/src/components.css) | Shared component contracts (`.agh-*`). |

Components and plugins read semantic tokens only. The palette is the single place where colour values are written; stylesheet tests reject raw colours and palette references anywhere else.

## Colour roles

| Role | Token | Light | Dark |
| --- | --- | --- | --- |
| Ground | `--agnes-bg-page`, `--agnes-bg-app-content` | `#FBFAF8` | `#15161A` |
| Sidebar and panels | `--agnes-bg-app-sidebar`, `--agnes-bg-subtle` | `#F3F3F1` | `#1B1C21` |
| Surface (cards, inputs, menus, dialogs) | `--agnes-bg-surface`, `--agnes-bg-popover`, `--agnes-input-surface` | `#FFFFFF` | `#1F2026` |
| User message bubble | `--agnes-bg-user-bubble` | `#EFEFEC` | `#26272D` |
| Text | `--agnes-text-primary` | `#1B1D22` | `#E6E7EA` |
| Secondary text | `--agnes-text-secondary` | `#4B4F58` | `#C3C6CC` |
| Muted text | `--agnes-text-tertiary` | `#666B76` | `#9A9EA8` |
| Line | `--agnes-line-primary` | `#E4E4E0` | `#2C2E35` |
| Accent | `--agnes-brand-primary` | `#4F5BD5` | `#8A93FF` |
| Accent, soft | `--agnes-brand-emphasis-soft` | `#EEF0FC` | `#252845` |
| Success, warning, danger marks | `--agnes-status-*-solid` | `#2F8F5B` `#B7791F` `#C2413B` | `#5CC28A` `#E0A84A` `#EF7B74` |

Rules that keep the theme coherent:

- The accent marks the primary action, the current selection and state. It is not decoration, and status colours stay separate from it.
- Hover, selected and card surfaces are translucent overlays of the text colour (`--agnes-bg-hover`, `--agnes-bg-selected`, `--agnes-bg-card`), so they work on the ground, on panels and on surfaces alike.
- Status has two strengths: `-text` for words (4.5:1 on the ground and on its own `-bg`) and `-solid` for dots and icons (3:1). In light mode the text shade is darker than the mark.
- Muted text keeps 4.5:1 on every surface it appears on, including hover and card overlays; control boundaries (`--agnes-input-border`) and the focus ring keep 3:1. The contrast tables in [`token-contrast.test.ts`](../../packages/web-ui/test/token-contrast.test.ts) and [`style-tokens.test.ts`](../../packages/web/test/style-tokens.test.ts) enforce this for both modes.

## Type, shape and motion

| Scale | Tokens | Values |
| --- | --- | --- |
| Family | `--font-sans`, `--font-mono` | System stack: SF, Segoe UI, Inter where installed, PingFang SC and its platform peers for CJK. No web font. |
| Size | `--font-size-xs` … `--font-size-2xl` | 12, 13, 14 (base), 16, 18, 20, 24 px |
| Reading | `--font-size-prose`, `--line-height-prose`, `--measure-prose` | 14px, 1.7, 72ch for conversation prose; code and tables use the full width. |
| Body line height | `--line-height-body` | 1.6, the floor for CJK body text. |
| Radius | `--radius-control`, `--radius-card`, `--radius-surface`, `--radius-pill` | 6px controls; 8px cards and menus; 12px dialogs and the composer card; pills for small chips only. |
| Control height | `--control-height`, `--control-height-sm`, `--control-height-form`, `--control-height-touch` | 36px buttons; 28px compact and icon buttons; text fields match the buttons at 36px and rise to the 44px touch target at phone widths. |
| Elevation | `--elevation-0`, `--elevation-1`, `--elevation-2`, `--shadow-hairline` | Flat; menus and popovers; dialogs and drawers; the composer's 1px lift. |
| Motion | `--motion-fast`, `--motion-base`, `--motion-ease`, `--motion-breathe` | 120ms, 200ms, ease-out, and the 2.4s cycle of a running dot. |

Settings and admin pages share one heading scale, whichever heading element a page uses: page title 16px, section 14px, row 13px, all semibold, with 13px body text. Dialog titles are 16px semibold. An empty state is a 24px mark, a 14px line that names the state and a 13px line that says what to do next.

Borders carry structure. A bordered card has no shadow; elevation belongs to layers that float above the page. Numbers that are compared (times, counts, costs, usage) use `font-variant-numeric: tabular-nums`. Motion is for occasional surfaces such as dialogs and drawers; menus, tabs and keyboard-triggered actions do not animate, and every animation stops under `prefers-reduced-motion`.

The browser's own surfaces follow the theme: `color-scheme` is set with the mode, the `theme-color` meta tag is written from the resolved ground colour, text selection uses a tint of the accent, the caret uses the accent, and long scroll regions show a thin thumb (`--agnes-scrollbar-thumb`).

## How Ant Design is themed

Ant Design runs in `zeroRuntime` mode: its prebuilt stylesheet is loaded in the `vendor` layer and reads `--ant-*` variables. The bridge in `tokens.css` assigns each of those variables a semantic token, in the `ui` layer:

```css
:root,
:root .agnes-theme {
  --ant-color-primary: var(--agnes-brand-primary);
  --ant-color-bg-container: var(--agnes-bg-surface);
  --ant-border-radius: var(--radius-control);
}
```

There is no second colour source. `ConfigProvider` only supplies what CSS cannot: the CSP nonce, the locale, the popup container and the overlay z-index layers. Do not pass colours through `ConfigProvider`'s `theme.token`; a skin or a mode switch would not reach them. A test checks that every global colour variable the Ant Design stylesheet reads is bridged.

## How Ant Design X is themed

Ant Design X is available from `@agnes/web-ui/x` (`Bubble`, `Sender`, `Conversations`, `ThoughtChain`, `Think`, `Actions`, `Welcome`, `Prompts`, `Attachments`, `FileCard`, `Sources`, `Suggestion`). The library has no prebuilt stylesheet, so every use sits under `XProvider` from the same module:

```tsx
import { Bubble, XProvider } from '@agnes/web-ui/x'

<XProvider>
  <Bubble content={text} />
</XProvider>
```

`XProvider` lets that subtree generate its styles at runtime. The styles carry the document's CSP nonce, are placed in the `vendor` layer, and declare their variables under the same `agnes-theme` key the bridge targets. X therefore takes its colours, radii, fonts and shadows from the same semantic tokens as Ant Design, in both modes. The bridge also maps the colour variables X computes for its own components (for example `--ant-sender-*` and `--ant-thought-chain-*`); a test renders the components and fails when a new one is left on a library default.

Only `packages/web-ui` imports `antd` or `@ant-design/x`. Applications and client modules use `@agnes/web-ui` and `@agnes/web-ui/x`. The components are presentational: they render what your store holds, and the x-sdk chat runtime is not included.

## Shared small touches

These display primitives are exported from `@agnes/web-ui`:

| Primitive | Use |
| --- | --- |
| `Kbd`, `shortcutLabel` | A quiet keyboard hint beside an action. `shortcutLabel(['mod', 'N'])` gives `⌘N` on Apple keyboards and `Ctrl+N` elsewhere. |
| `StatusDot` | A 6px state mark with `tone` and `running`; a running dot breathes, and stays still under reduced motion. Pass `label` when no adjacent text names the state. |
| `CompletionCheck` | The light check a finished turn or step leaves behind, with an optional duration. |
| `CopyButton` | A copy action whose icon becomes a check after a successful copy, then returns. Failures are reported to the caller through `onCopied(false)`. |

## How a skin overrides the theme

A skin changes the same semantic tokens, so its colours reach Agnes components, Ant Design and Ant Design X together:

```json
{
  "tokens": {
    "--agnes-brand-primary": { "light": "#0f766e", "dark": "#5eead4" },
    "--agnes-bg-user-bubble": { "light": "#e6f2ef", "dark": "#1d3531" }
  }
}
```

Token overrides are applied inline and outrank the built-in values in both modes. For anything tokens cannot express, the skin's stylesheet is adopted in the `skin` layer, after `tokens, base, vendor, ui, app`, so ordinary declarations on `data-agnes-region` hooks win without `!important`. Do not target `.ant-*` classes or redefine `--ant-*` variables; override the semantic token the bridge reads. The token list, limits and region hooks are in the [skin authoring guide](skins.md).
