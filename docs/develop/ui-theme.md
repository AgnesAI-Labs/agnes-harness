# AGH theme

English | [简体中文](ui-theme.zh-CN.md)

Agnes Web has one built-in theme, used by the workbench, settings and the standalone admin pages. It is calm and tool-like: pure white working content, a single gray navigation step, one graphite gray family, one indigo accent, borders instead of shadows. Light and dark are both complete.

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
| Content (conversation and the whole workbench panel) | `--agnes-bg-page`, `--agnes-bg-app-content` | `#FFFFFF` | `#1B1C21` |
| Navigation (sidebar and settings rail) | `--agnes-bg-app-sidebar` | `#F3F3F1` | `#15161A` |
| Subtle fill | `--agnes-bg-subtle` | `#F3F3F1` | `#1B1C21` |
| Surface (cards, inputs, menus, dialogs) | `--agnes-bg-surface`, `--agnes-bg-popover`, `--agnes-input-surface` | `#FFFFFF` | `#1F2026` |
| User message bubble | `--agnes-bg-user-bubble` | `#F3F3F1` | `#26272D` |
| Text | `--agnes-text-primary` | `#1B1D22` | `#E6E7EA` |
| Secondary text | `--agnes-text-secondary` | `#4B4F58` | `#C3C6CC` |
| Muted text | `--agnes-text-tertiary` | `#666B76` | `#9A9EA8` |
| Line | `--agnes-line-primary` | `#E4E4E0` | `#2C2E35` |
| Accent | `--agnes-brand-primary` | `#4F5BD5` | `#8A93FF` |
| Brand mark and wordmark | `--agnes-brand-mark` | `#3248AF` | `#6983FC` |
| Accent, soft | `--agnes-brand-emphasis-soft` | `#EEF0FC` | `#252845` |
| Success, warning, danger marks | `--agnes-status-*-solid` | `#2F8F5B` `#B7791F` `#C2413B` | `#5CC28A` `#E0A84A` `#EF7B74` |

Rules that keep the theme coherent:

- Light mode has exactly two neutral base surfaces: pure white `#ffffff` for working content and gray `#f3f3f1` for navigation and auxiliary fills. There is no intermediate off-white base; light empty states do not add a brand glow. The sidebar and settings rail are gray; conversation, documents, trace, galleries, automations, settings bodies and admin pages are white.
- The top bar and the entire right workbench (application tabs, filters, body and footer) are white: they operate on and inspect the current task, so they continue the conversation surface. Secondary navigation inside a panel, code blocks, icon tiles, neutral fields and the user bubble use the one gray fill.
- Cards, grouped settings, tool/evidence cards, the composer, dialogs, drawers and popovers use white surface tokens. Cards have a subtle primary border; the composer and floating layers also have soft shadows. The same structure applies to showcase applications: aerospace/pharma retain brand and status colours while using the shared neutral surfaces. Dark mode keeps its existing surface values.
- Hover and selection are temporary graphite overlays (`--agnes-bg-hover`, `--agnes-bg-selected`), not extra base surfaces. A selected navigation/session row uses white with a quiet border or raised edge. Primary actions, focus, menu selection and status keep their explicit accent/status tokens.
- Auxiliary fills use `--agnes-bg-subtle`, `--agnes-bg-fill`, `--agnes-bg-card` and `--agnes-bg-code`; actual card containers use `--agnes-bg-surface` or `--agnes-bg-group`. Filled neutral inputs use gray and return to white on focus; plain inputs read the white input surface. Flat workbench filters stay white. `--agnes-line-primary` frames containers; `--agnes-line-hairline` divides rows without adding another filled layer. Menus retain their 94% white material over a blurred backdrop, so sampled overlay pixels may differ from the two opaque base colours.
- Status has two strengths: `-text` for words (4.5:1 on the ground and on its own `-bg`) and `-solid` for dots and icons (3:1). In light mode the text shade is darker than the mark.
- Muted text keeps 4.5:1 on every surface it appears on, including hover and card overlays; control boundaries (`--agnes-input-border`) and the focus ring keep 3:1. A text field is a soft neutral fill (`--agnes-bg-fill`) inside that thin boundary line; the keyboard focus ring is a 1px solid line at the element's edge (`--focus-line`, the part that carries 3:1) inside a soft 3px halo (`--focus-outline`), both following the element's radius. The contrast tables in [`token-contrast.test.ts`](../../packages/web-ui/test/token-contrast.test.ts) and [`style-tokens.test.ts`](../../packages/web/test/style-tokens.test.ts) enforce this for both modes.

## Type, shape and motion

| Scale | Tokens | Values |
| --- | --- | --- |
| Family | `--font-sans`, `--font-mono` | System stack: SF, Segoe UI, Inter where installed, PingFang SC and its platform peers for CJK. No web font. |
| Size | `--font-size-xs` … `--font-size-2xl`, `--font-size-caption`, `--font-size-title` | 12, 13, 14 (base), 16, 18, 20, 24 px; 12.5px group labels and row descriptions; the 26px bold page title (`--font-weight-bold`, `--tracking-title`, never tightened for CJK). |
| Reading | `--font-size-prose`, `--line-height-prose`, `--measure-prose` | 14px, 1.7, 72ch for conversation prose; code and tables use the full width. |
| Body line height | `--line-height-body` | 1.6, the floor for CJK body text. |
| Radius | `--radius-chip`, `--radius-control`, `--radius-segmented`, `--radius-tile`, `--radius-card`, `--radius-surface`, `--radius-modal`, `--radius-popover`, `--radius-menu-item`, `--radius-composer`, `--radius-pill` | The scale is 8 / 10 / 14 / 20. 8px chips, buttons, inputs, popup buttons, menu rows and navigation items; 10px segmented tracks and icon tiles; 14px grouped cards, panels, menus and popovers; 20px dialogs; the 24px composer card; pills for badges and switches only. Where the engine supports `corner-shape: squircle`, the shared surfaces draw continuous corners and widen their radius by `--corner-scale` (1.3); elsewhere they keep the plain radius. |
| Control size | `--control-height`, `--control-height-sm`, `--control-height-xs`, `--control-height-form`, `--control-height-touch`, `--menu-item-height`, `--row-min-height`, `--switch-width`, `--switch-height`, `--switch-knob` | 28px buttons, popup buttons and icon buttons; 24px compact buttons and segments; 32px text fields, rising to the 44px touch target at phone widths; 26px menu rows; 46px minimum setting rows; a 38×22 switch with an 18px knob. |
| Rhythm | `--space-section`, `--space-page-top`, `--hairline` | 28px between sections, 36px above a page title; dividers and control outlines are one device pixel on dense screens (0.5px at 2x), 1px elsewhere. |
| Icons | `--icon-stroke`, `--icon-stroke-strong` | 1.5 for every 16px line icon; 1.75 inside a primary button and on the selected navigation item or tab. |
| Elevation | `--elevation-0`, `--elevation-1`, `--elevation-2`, `--shadow-hairline`, `--shadow-control`, `--shadow-control-primary`, `--shadow-knob`, `--shadow-popover` | Flat; popovers; dialogs and drawers; a 1px lift for quiet raised controls; the hairline ring of a raised control and the lit top edge of a primary button; the switch knob; menus and option lists. |
| Motion | `--motion-short`, `--motion-medium`, `--motion-long`, `--motion-exit`, `--motion-ease-out`, `--motion-spring`, `--press-scale`, `--press-dim`, `--motion-breathe` | 160ms presses; 260ms disclosures, tab changes and the switch knob; 320ms menus, dialogs and side panels; exits take 60% of the entrance; an ease-out curve and a spring with about 8% overshoot; a press shrinks to 0.97 and darkens slightly; the 2.4s cycle of a running dot. `--motion-fast`, `--motion-base` and `--motion-ease` remain for colour changes. |

Settings and admin pages share one template and one heading scale, whichever heading element a page uses: page title 18px, section 14px, row 13px, all semibold, with 13px body text. A page is a header (title, one line of description, page actions), optional tabs and a body that scrolls inside the dialog; header and body keep to one column (`--settings-column`, 760px) behind one gutter (`--settings-gutter`), so nothing reaches the dialog edge or its close button. A group of pages is named once above its tabs, and the pages under it show only their description and actions. Simple settings are divided rows inside one outlined group; an outlined card is for an object such as an account or a plugin. Dialog titles are 16px semibold. An empty state is a 24px mark, a 14px line that names the state and a 13px line that says what to do next.

Borders carry structure. A bordered card has no shadow; elevation belongs to layers that float above the page. Numbers that are compared (times, counts, costs, usage) use `font-variant-numeric: tabular-nums`. Motion is short and moves only `transform` and `opacity`: disclosures, tab changes, menus, dialogs and side panels settle on a slight spring, and exits are shorter and never bounce. A surface opened from the keyboard appears at once (motion is gated on the pointer input modality), a button press is a slight shrink and darken with no ripple or glow, and every animation stops under `prefers-reduced-motion`.

The browser's own surfaces follow the theme: `color-scheme` is set with the mode, the `theme-color` meta tag is written from the resolved ground colour, text selection uses a tint of the accent, the caret uses the accent, and long scroll regions show a thin thumb (`--agnes-scrollbar-thumb`).

## Refinement layer

[`packages/web-ui/src/refinement.css`](../../packages/web-ui/src/refinement.css) is one stylesheet that gives the shared controls native proportions on top of the theme. It changes no colour role: every declaration reads a token above, and the interface stays complete without it.

| Control | Shape |
| --- | --- |
| Page header (`PageHeader`, `.agh-page-title`, `.agh-page-description`) | 26px bold title, one 13px line of description, page actions on the right. |
| Group label (`SettingsSection` heading, `.agh-group-label`) | 12.5px semibold, secondary grey, above the upper left of its group. |
| Button | 28px high, 8px radius. Secondary is a raised neutral surface with a hairline ring; primary has a lit top edge; icon buttons are rounded squares. |
| Switch (`StateSwitch`, `LabeledSwitch`, `Switch`) | 38×22 track, 18px knob that settles on the spring. |
| Segmented control (`Segmented`) | A rounded-rectangle track with a raised block on the picked option; native radios, so arrow keys and form semantics hold. Use it for two to six short choices. |
| Popup button (`Select`, `SettingsSelect`, the settings picker) | A raised surface that ends in an accent block with up/down chevrons: it picks one of a set. A searchable or multiple `Select` stays a field. |
| Menu and option list | The only translucent surface: 94% opaque over a backdrop blur. The pointed or keyboard-current row takes the accent fill with its own content colour (light: 5.54:1, dark: 6.58:1). |

Mark the current item of your own navigation with `aria-current`, `role="tab"` plus `aria-selected="true"`, or `data-selected="true"`; its icon then takes the heavier line weight.

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

There is no second colour source. `ConfigProvider` only supplies what CSS cannot: the CSP nonce, the locale, the popup container, the overlay z-index layers, and it turns the click ripple off. Do not pass colours through `ConfigProvider`'s `theme.token`; a skin or a mode switch would not reach them. A test checks that every global colour variable the Ant Design stylesheet reads is bridged.

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
| `Disclosure` | The one collapsible section: a button that names the section and the region it shows. Pass the always-visible row as `summary`; use `open` with `onOpenChange` to control it, or `defaultOpen` to let the reader's choice stand. The root carries `data-open="true|false"` for styling, and `dismissible` closes a floating panel on Escape or a click outside. A controller that must reveal a field before focusing it calls `setDisclosureOpen(element, true)`. Write this instead of a `<details>` element. |
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
