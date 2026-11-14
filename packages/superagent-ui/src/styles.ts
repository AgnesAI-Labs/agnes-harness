/** The panel stylesheet, injected once by the panel provider. */
export const STYLES = `/* The panel's own names for the Agnes theme tokens, so a component reads one vocabulary and the theme owns the values. */
:root {
  --dsw-alias-label-primary: var(--agnes-text-primary);
  --dsw-alias-label-secondary: var(--agnes-text-secondary);
  --dsw-alias-label-tertiary: var(--agnes-text-tertiary);
  --dsw-alias-label-caption: var(--agnes-text-tertiary);
  --dsw-alias-label-dimmed: var(--agnes-text-tertiary);
  --dsw-alias-label-primary-foreground: var(--agnes-text-inverse);
  --dsw-alias-border-l2: var(--agnes-line-hairline);
  --dsw-alias-border-l3: var(--agnes-line-primary);
  --dsw-alias-border-l4: var(--agnes-line-emphasis);
  --dsw-alias-brand-primary: var(--agnes-brand-primary);
  --dsw-alias-link: var(--agnes-brand-primary);
  --dsw-alias-state-error-primary: var(--agnes-status-danger-text);
  --dsw-alias-state-warn-primary: var(--agnes-status-warning-text);
  --dsw-alias-state-success-primary: var(--agnes-status-success-text);
  --dsw-alias-state-business-primary: var(--agnes-status-info-text);
  --dsw-alias-state-idle-primary: var(--agnes-text-tertiary);
  --dsw-alias-interactive-bg-hover: var(--agnes-bg-hover);
  --dsw-alias-interactive-bg-active: var(--agnes-bg-selected);
  --dsw-alias-bg-base: var(--agnes-bg-page);
  --dsw-alias-bg-module-platform: var(--agnes-bg-surface);
  --dsw-alias-bg-layer-1: var(--agnes-bg-surface);
  --dsw-alias-bg-layer-2: var(--agnes-bg-subtle);
  --dsw-alias-bg-layer-3: var(--agnes-bg-fill);
  --dsw-alias-bg-mask-1: var(--agnes-bg-scrim);
  --dsw-alias-tooltip-bg: var(--agnes-bg-popover);
  --dsw-alias-toast-bg: var(--agnes-bg-popover);
  --dsw-alias-button-primary-fill: var(--agnes-button-primary-bg);
  --dsw-alias-button-primary-hover: var(--agnes-button-primary-bg-hover);
  --dsw-alias-button-ghost-active-fill: var(--agnes-bg-selected);
  --dsw-alias-button-ghost-active-border: var(--agnes-line-emphasis);
  --dsw-static-neutral-bluish-00: var(--agnes-color-gray-0);
  --dsw-elevation-soft: 0 1px 4px color-mix(in srgb, var(--agnes-text-primary) 12%, transparent);
  --dsw-elevation-prominent: 0 8px 24px color-mix(in srgb, var(--agnes-text-primary) 18%, transparent);
  --dsw-shadow-lv3: 0 12px 32px color-mix(in srgb, var(--agnes-text-primary) 22%, transparent);
  --dsw-mask-blur: 6px;
}
/* Panel layout and local UI controls styled with DSH --dsw-alias-* design tokens; one rule per line. */
.dt-page { box-sizing: border-box; height: 100%; overflow: auto; scrollbar-gutter: stable; scroll-padding: 48px 0 72px; container-type: inline-size; padding: 28px clamp(24px, 4vw, 48px) 0; color: var(--dsw-alias-label-primary); }
/* Deployment page rendered inside a host page, which owns scrolling and padding. */
.dt-embedded { container-type: inline-size; color: var(--dsw-alias-label-primary); }
/* Disable sticky positioning inside a host page, where the host container owns scrolling and bottom padding. */
.dt-embedded .dt-savebar { position: static; }
.dt-page > .dt-column { max-width: 960px; margin: 0 auto; padding-bottom: 48px; display: flex; flex-direction: column; gap: 24px; }
.dt-head { position: relative; z-index: 3; display: flex; align-items: flex-start; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; }
.dt-search { position: relative; width: 240px; max-width: 100%; }
.dt-search-results { position: absolute; top: calc(100% + 6px); right: 0; width: min(560px, 90cqw); max-height: 60vh; overflow: auto; padding: 8px 16px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); z-index: 5; display: flex; flex-direction: column; gap: 8px; }
.dt-mark { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 25%, transparent); color: inherit; border-radius: 2px; }
[data-platform='darwin'] .dt-page .dt-head { padding-top: var(--dsh-frame-top-clearance, 0px); }
.dt-title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dt-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.dt-page .dt-tabs { overflow-x: auto; display: flex; gap: 20px; max-width: none; padding: 0; border-radius: 0; background: none; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }
.dt-segmented { width: 100%; max-width: 420px; box-sizing: border-box; display: inline-grid; gap: 2px; padding: 3px; border-radius: 9px; background: var(--dsw-alias-interactive-bg-hover); }
.dt-form.dt-block { padding: 16px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 16px; gap: 16px; }
.dt-block-title { display: flex; align-items: center; gap: 4px; margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
.dt-section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dt-section-title { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; font-size: 13px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dt-section-name { white-space: nowrap; }
.dt-count { font-size: 14px; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; font-weight: 400; }
.dt-hint { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.dt-error { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-state-error-primary); }
.dt-banner { margin: 0; padding: 8px 12px; border-radius: 10px; font-size: 13px; line-height: 20px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); overflow-wrap: anywhere; }
.dt-banner.dt-danger { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.dt-list { list-style: none; margin: 0 -8px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.dt-row { position: relative; min-width: 0; border-radius: 12px; padding: 10px 8px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: flex-start; }
.dt-row.dt-link:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dt-row-main { flex: 1 1 200px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dt-disclosure-body .dt-row-main { flex-basis: 0; }
.dt-row-title { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 14px; line-height: 20px; font-weight: 500; }
.dt-open { max-width: 100%; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; font-size: 14px; line-height: 20px; font-weight: 500; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dt-open::after { content: ''; position: absolute; inset: 0; border-radius: 12px; }
.dt-open:focus-visible { outline: none; }
.dt-open-wrap { white-space: normal; }
.dt-open:focus-visible::after { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dt-row-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); overflow-wrap: anywhere; }
.dt-row-quote { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dt-clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
/* Transparent block borders preserve vertical spacing when line clamping clips padding. */
.dt-banner:is(.dt-clamp, .dt-clamp-8) { padding-block: 0; border-block: 8px solid transparent; }
.dt-banner-label { font-weight: 500; }
.dt-banner .dt-md { display: inline; }
.dt-banner .dt-md > p:first-child { display: inline; }
.dt-row-buttons { position: relative; z-index: 1; gap: 8px; margin-top: 4px; }
.dt-row-actions { position: relative; z-index: 1; display: flex; align-items: center; gap: 4px; flex: none; margin-left: auto; font-size: 13px; line-height: 20px; }
.dt-dot { flex: none; margin-top: 5px; }
.dt-inline-link { position: relative; z-index: 1; color: var(--dsw-alias-link); text-decoration: none; }
.dt-inline-link:hover { text-decoration: underline; }
.dt-textlink { padding: 0; border: 0; background: none; font: inherit; color: var(--dsw-alias-link); cursor: pointer; text-align: left; }
.dt-textlink:hover { text-decoration: underline; }
.dt-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; line-height: 20px; }
.dt-kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; font-size: 13px; line-height: 20px; }
.dt-kv dt { color: var(--dsw-alias-label-tertiary); }
.dt-kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.dt-timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dt-event { padding: 12px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dt-event:last-child { border-bottom: 0; }
.dt-event.dt-highlight { background: var(--dsw-alias-interactive-bg-hover); border-radius: 8px; padding-inline: 8px; margin-inline: -8px; }
.dt-event-text { margin: 0; font-size: 13px; line-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dt-event-actor { font-weight: 500; color: var(--dsw-alias-label-secondary); }
.dt-event-quiet .dt-event-text { color: var(--dsw-alias-label-tertiary); }
.dt-flow { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.dt-clamp-8 { display: -webkit-box; -webkit-line-clamp: 8; -webkit-box-orient: vertical; overflow: hidden; }
.dt-more { align-self: flex-start; font-size: 12px; }
.dt-reveal { opacity: 0; }
.dt-event:hover .dt-reveal, .dt-reveal:focus-visible { opacity: 1; }
@media (hover: none) {
  .dt-reveal { opacity: 1; }
}
.dt-event-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dt-filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dt-filters .dt-search { margin-left: auto; }
.dt-form { display: flex; flex-direction: column; gap: 24px; }
.dt-fieldset { display: flex; flex-direction: column; gap: inherit; min-width: 0; margin: 0; padding: 0; border: 0; }
.dt-field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; line-height: 20px; min-width: 0; }
.dt-field small { color: var(--dsw-alias-label-caption); font-size: 12px; }
.dt-textarea { box-sizing: border-box; width: 100%; min-width: 0; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 10px; padding: 8px 12px; font: inherit; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1, transparent); resize: vertical; }
.dt-select { box-sizing: border-box; width: 100%; min-width: 0; height: 32px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 8px; padding: 0 28px 0 8px; text-overflow: ellipsis; font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1, transparent); }
.dt-textarea:focus-visible, .dt-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dt-mono { font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 12px; overflow-wrap: anywhere; }
.dt-detail { margin-top: 2px; color: var(--dsw-alias-label-secondary); }
.dt-savebar .dt-error { white-space: pre-line; }
.dt-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 36px; font-size: 13px; }
.dt-subhead-actions { display: inline-flex; align-items: center; gap: 4px; }
.dt-btn-busy .dt-btn-icon svg { animation: dt-spin 1s linear infinite; }
.dt-subhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.dt-rules, .dt-changes { list-style: none; margin: 0; padding: 0; }
.dt-field-head { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); }
.dt-info { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; border: 0; background: none; color: var(--dsw-alias-label-caption); cursor: help; }
.dt-info:hover, .dt-info:focus-visible { color: var(--dsw-alias-label-secondary); }
.dt-info:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 50%; }
.dt-tooltip { position: fixed; z-index: 1100; width: max-content; max-width: min(320px, calc(100vw - 24px)); padding: 3px 7px; border-radius: 8px; background: var(--dsw-alias-tooltip-bg); color: var(--dsw-static-neutral-bluish-00); font-size: 13px; line-height: 20px; overflow-wrap: break-word; pointer-events: none; animation: dt-tooltip-in 150ms ease-in-out; }
@keyframes dt-tooltip-in { from { opacity: 0; } }
.dt-rules { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dt-rule { display: flex; align-items: flex-start; gap: 12px; padding: 6px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.dt-rule > :first-child { flex: 1; min-width: 0; }
.dt-rule-preview { flex: 1; min-width: 0; margin-left: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-caption); }
.dt-rule-switch { margin-top: 2px; flex: none; }
.dt-rule-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-caption); }
.dt-rule-dot[data-enabled] { background: var(--dsw-alias-brand-primary); }
.dt-rule-body { display: flex; flex-direction: column; gap: 12px; padding: 8px 0 8px 28px; }
.dt-model { display: flex; flex-direction: column; gap: 6px; }
.dt-grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.dt-changes { display: flex; flex-direction: column; gap: 2px; font-size: 13px; line-height: 20px; }
.dt-changes li::before { content: '· '; color: var(--dsw-alias-label-caption); }
.dt-main { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
.dt-modal.dt-glossary-modal { width: min(680px, 100%); }
.dt-nav-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; min-height: 32px; padding: 6px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer; }
.dt-nav-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dt-nav-item[aria-current='true'] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); font-weight: 500; }
.dt-nav-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dt-changed-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-brand-primary); flex: none; }
.dt-add-skill { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dt-prompt-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.dt-editor { min-height: 360px; }
.dt-inline-select { width: auto; }
.dt-preview-part { display: flex; flex-direction: column; gap: 6px; padding: 2px 0 2px 12px; border-left: 2px solid var(--dsw-alias-border-l3); }
.dt-preview-head { font-size: 13px; line-height: 20px; display: flex; align-items: baseline; gap: 8px; }
div.dt-preview-head { color: var(--dsw-alias-label-secondary); }
.dt-card { display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 16px; min-width: 0; }
.dt-card-head { display: flex; align-items: center; gap: 12px; min-height: 28px; }
.dt-card-head .dt-row-main { flex: 1 1 0; min-width: 64px; }
.dt-card-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dt-row-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
.dt-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dt-rows-item { display: grid; grid-template-columns: repeat(var(--dt-columns), minmax(0, 1fr)) auto; gap: 8px; align-items: center; }
.dt-filter-gap { flex: 1; }
.dt-page-head { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.dt-page-head > .dt-btn { margin-left: -10px; }
.dt-page-title { display: flex; align-items: center; gap: 8px 16px; flex-wrap: wrap; width: 100%; }
.dt-page-title h2 { margin: 0; flex: 1 1 auto; min-width: 0; font-size: 20px; line-height: 28px; font-weight: 500; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dt-status-line { margin-top: -16px; }
.dt-plain-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 13px; line-height: 20px; }
.dt-details { display: flex; flex-direction: column; gap: 2px; border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 8px; }
.dt-danger-zone { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dt-danger-zone .dt-btn { color: var(--dsw-alias-state-error-primary); }
.dt-md { display: flex; flex-direction: column; gap: 6px; font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
.dt-md p, .dt-md ul, .dt-md ol { margin: 0; }
.dt-md ul, .dt-md ol { padding-left: 20px; display: flex; flex-direction: column; gap: 2px; }
.dt-md-heading { font-weight: 500; }
.dt-code { font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 12px; padding: 0 4px; border-radius: 4px; background: var(--dsw-alias-bg-module-platform); }
.dt-dot-wrap { display: inline-flex; flex: none; }
.dt-search-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dt-ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 280px; }
.dt-legend-title { margin: 16px 0 6px; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.dt-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; }
.dt-legend li { display: flex; align-items: center; gap: 6px; }
.dt-legend .dt-dot { margin-top: 0; }
.dt-savebar { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; padding: 12px 0; background: var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1)); border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dt-savebar .dt-hint { margin-right: auto; }
.dt-card > .dt-savebar, .dt-block > .dt-savebar { margin: 0 -16px -16px; padding: 12px 16px; border-radius: 0 0 16px 16px; }
.dt-glossary { width: 100%; border-collapse: collapse; font-size: 13px; line-height: 20px; }
.dt-glossary th, .dt-glossary td { text-align: left; padding: 6px 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); vertical-align: top; }
.dt-glossary th { color: var(--dsw-alias-label-tertiary); font-weight: 400; }
.dt-glossary th.dt-glossary-group { color: var(--dsw-alias-label-secondary); font-weight: 600; padding-top: 14px; }
.dt-glossary th:nth-child(-n+2), .dt-glossary td:nth-child(-n+2) { white-space: nowrap; }
.dt-values { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 16px 0 0; font-size: 13px; }
.dt-values dt { color: var(--dsw-alias-label-tertiary); }
.dt-values dd { margin: 0; }
.dt-pre { margin: 0; padding: 12px; border-radius: 10px; background: var(--dsw-alias-bg-module-platform); font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 12px; line-height: 18px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 480px; overflow: auto; }
.dt-pre ins { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent); text-decoration: none; }
.dt-pre del { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent); text-decoration: none; }
.dt-prompt { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 20px; align-items: start; }
.dt-prompt-nav { display: flex; flex-direction: column; gap: 2px; }
.dt-prompt-nav button { justify-content: flex-start; }
.dt-disclosure-body { padding: 8px 0 8px 28px; display: flex; flex-direction: column; gap: 8px; }
@container (max-width: 640px) {
  .dt-tab { padding: 0 8px; font-size: 13px; }
  .dt-segment { padding: 0 10px; }
  .dt-head { align-items: center; }
  .dt-search-results { right: auto; left: 0; width: 100%; }
  .dt-page-title h2 { font-size: 17px; line-height: 24px; }
  .dt-status-line { margin-top: -12px; }
  .dt-page .dt-tabs { display: flex; flex-wrap: nowrap; scrollbar-width: thin; }
  .dt-page .dt-tab { flex: none; }
  .dt-page .dt-tabs[data-more='end'] { mask-image: linear-gradient(to right, var(--agnes-text-primary) calc(100% - 40px), transparent); }
  .dt-page .dt-tabs[data-more='start'] { mask-image: linear-gradient(to right, transparent, var(--agnes-text-primary) 40px); }
  .dt-page .dt-tabs[data-more='both'] { mask-image: linear-gradient(to right, transparent, var(--agnes-text-primary) 40px, var(--agnes-text-primary) calc(100% - 40px), transparent); }
  .dt-kv { grid-template-columns: 1fr; gap: 2px; }
  .dt-grid3, .dt-prompt { grid-template-columns: 1fr; }
  .dt-search { width: 100%; }
  .dt-filters .dt-search { margin-left: 0; }
}
/* Local UI primitive styles (see controls.tsx). */
.dt-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; border: none; border-radius: 18px; cursor: pointer; font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); background: transparent; padding: 0 14px; white-space: nowrap; }
.dt-btn:disabled { cursor: not-allowed; opacity: 0.4; }
.dt-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dt-btn-md { height: 36px; }
.dt-btn-sm { height: 28px; font-size: 12px; line-height: 18px; padding: 0 10px; border-radius: 14px; }
.dt-btn-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dt-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dt-btn-ghost:hover:not(:disabled), .dt-btn-outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dt-btn-ghost:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.dt-btn-outline { border: 0.5px solid var(--dsw-alias-border-l3); }
.dt-btn-icon { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; }
.dt-tag { display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap; }
.dt-tag[data-tone='outline'] { border: 0.5px solid var(--dsw-alias-border-l4); color: var(--dsw-alias-label-tertiary); }
.dt-tag[data-tone='neutral'] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.dt-tag[data-tone='quiet'] { color: var(--dsw-alias-label-tertiary); }
.dt-tag[data-tone='success'] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); color: var(--dsw-alias-state-success-primary); }
.dt-tag[data-tone='info'] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); color: var(--dsw-alias-state-business-primary); }
.dt-tag[data-tone='warning'] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); color: var(--dsw-alias-state-warn-primary); }
.dt-tag[data-tone='danger'] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); color: var(--dsw-alias-state-error-primary); }
.dt-pill { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border: none; border-radius: 12px; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); cursor: pointer; }
.dt-pill:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dt-pill-active, .dt-pill-active:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-button-ghost-active-fill); box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border); }
.dt-tabs { display: grid; padding: 4px; border-radius: 12px; background: var(--dsw-alias-bg-module-platform); }
.dt-tab { box-sizing: border-box; height: 34px; padding: 0 12px; border: 0.5px solid transparent; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 14px; line-height: 20px; white-space: nowrap; cursor: pointer; transition: color 180ms ease, background 180ms ease; }
.dt-tab:hover { color: var(--dsw-alias-label-primary); }
.dt-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary); font-weight: 600; background: var(--dsw-alias-bg-layer-3); border-color: var(--dsw-alias-border-l3); }
.dt-tab:focus-visible { outline: none; text-decoration: underline; text-underline-offset: 4px; }
.dt-segment { height: 28px; padding: 0 16px; border: 0; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px; font-weight: 500; white-space: nowrap; cursor: pointer; transition: color 120ms ease, background 160ms ease; }
.dt-segment:hover:not(:disabled), .dt-segment[aria-selected='true'] { color: var(--dsw-alias-label-primary); }
.dt-segment[aria-selected='true'] { background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-soft); }
.dt-segment:disabled { cursor: default; opacity: 0.4; }
.dt-segment:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dt-input { box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; height: 32px; min-width: 0; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.dt-input:focus-within { border-color: var(--dsw-alias-brand-primary); }
.dt-input-icon { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; color: var(--dsw-alias-label-tertiary); }
.dt-input input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.dt-input input::placeholder { color: var(--dsw-alias-label-dimmed); }
.dt-input input::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }
.dt-field .dt-input, .dt-search .dt-input, .dt-add-skill .dt-input { display: flex; width: 100%; }
.dt-switch { box-sizing: border-box; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 10px; background: var(--dsw-alias-border-l3); cursor: pointer; }
.dt-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.dt-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dt-switch-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-label-primary-foreground); transition: transform 120ms ease; }
.dt-switch[aria-checked='true'] .dt-switch-thumb { transform: translateX(16px); }
.dt-state-dot { position: relative; display: inline-block; flex: none; width: 10px; height: 10px; color: var(--dsw-alias-state-idle-primary); }
.dt-state-dot::after { content: ''; position: absolute; inset: 20%; border-radius: 50%; background: currentColor; }
.dt-state-dot[data-state='done'] { color: var(--dsw-alias-state-success-primary); }
.dt-state-dot[data-state='warning'] { color: var(--dsw-alias-state-warn-primary); }
.dt-state-dot[data-state='error'] { color: var(--dsw-alias-state-error-primary); }
.dt-spinner { flex: none; color: var(--dsw-alias-label-tertiary); }
.dt-spinner g { transform-origin: center; animation: dt-spin 1.5s linear infinite; }
.dt-spinner circle { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.dt-spinner circle:first-child { opacity: 0.25; }
.dt-spinner circle:last-child { stroke-dasharray: 18 150; }
@keyframes dt-spin { to { transform: rotate(360deg); } }
.dt-disclosure-row { display: flex; align-items: center; gap: 4px; min-height: 28px; min-width: 0; border-radius: 8px; cursor: pointer; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.dt-disclosure-row:hover { color: var(--dsw-alias-label-primary); }
.dt-disclosure-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dt-disclosure-lead { position: relative; display: inline-flex; flex: none; width: 24px; height: 24px; align-items: center; justify-content: center; }
.dt-disclosure-icon { display: inline-flex; align-items: center; justify-content: center; }
.dt-disclosure-chevron { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; }
.dt-disclosure-row:hover .dt-disclosure-icon, .dt-disclosure[data-open] .dt-disclosure-icon { visibility: hidden; }
.dt-disclosure-row:hover .dt-disclosure-chevron, .dt-disclosure[data-open] .dt-disclosure-chevron { display: inline-flex; }
.dt-disclosure-title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dt-modal-root { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: max(24px, var(--dsh-frame-top-clearance, 24px)) 24px; }
.dt-modal-mask { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur); }
.dt-modal { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 20px; width: min(380px, 100%); max-height: 100%; padding: 0 0 24px; overflow: hidden; border-radius: 24px; background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); color: var(--dsw-alias-label-primary); outline: none; }
.dt-modal-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 22px 14px 0 24px; }
.dt-modal-header h2 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
.dt-modal-close { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: none; border-radius: 8px; background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary); }
.dt-modal-close:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dt-modal-description { margin: -8px 0 0; padding: 0 24px; font-size: 14px; line-height: 22px; }
.dt-modal-body { min-width: 0; min-height: 0; overflow: auto; padding: 0 24px; }
.dt-modal-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 24px; }
.dt-toast { position: fixed; top: 40px; left: 50%; z-index: 1100; pointer-events: none; width: max-content; max-width: min(640px, calc(100vw - 48px)); padding: 12px 16px; border-radius: 14px; background: var(--dsw-alias-toast-bg); color: var(--dsw-static-neutral-bluish-00); font-size: 14px; line-height: 22px; box-shadow: var(--dsw-shadow-lv3); transform: translateX(-50%); animation: dt-toast-in 160ms ease-out, dt-toast-fade 1000ms ease var(--dt-toast-hold, 3000ms) forwards; }
@keyframes dt-toast-in { from { opacity: 0; transform: translate(-50%, -6px); } to { opacity: 1; transform: translate(-50%, 0); } }
@keyframes dt-toast-fade { to { opacity: 0; visibility: hidden; } }
@media (prefers-reduced-motion: reduce) {
  .dt-tab, .dt-segment, .dt-switch-thumb, .dt-spinner g, .dt-btn-busy .dt-btn-icon svg, .dt-tooltip { transition: none; animation: none; }
  .dt-toast { animation: dt-toast-fade 1000ms ease var(--dt-toast-hold, 3000ms) forwards; }
}
.dt-page .dt-tab { height: 34px; padding: 0 2px; border: 0; border-radius: 0; color: var(--dsw-alias-label-tertiary); font-size: 14px; }
.dt-page .dt-tab[aria-selected='true'] { background: none; color: var(--dsw-alias-label-primary); font-weight: 500; box-shadow: inset 0 -1.5px 0 var(--dsw-alias-label-primary); }
.dt-status-head { display: flex; align-items: center; gap: 8px; }
.dt-status-title { margin: 0; flex: 1; display: flex; align-items: center; gap: 4px; font-size: 15px; line-height: 22px; font-weight: 600; }
.dt-status-text { margin-left: auto; flex: none; font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.dt-status-line .dt-status-text { margin-left: 0; }
.dt-status-text[data-state='warning'] { color: var(--dsw-alias-state-warn-primary); }
.dt-status-text[data-state='error'] { color: var(--dsw-alias-state-error-primary); }
.dt-row-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dt-lv { white-space: nowrap; }
.dt-lv-label { color: var(--dsw-alias-label-caption); }
.dt-lv-value { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dt-chip { display: inline-flex; flex-wrap: wrap; max-width: 100%; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 6px; overflow: hidden; font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dt-chip-source { padding: 0 6px; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-module-platform); }
.dt-chip-fact { padding: 0 6px; border-left: 0.5px solid var(--dsw-alias-border-l3); white-space: nowrap; }
.dt-chip-label { margin-right: 4px; color: var(--dsw-alias-label-caption); }
.dt-chip-link { position: relative; z-index: 1; text-decoration: none; cursor: pointer; transition: border-color 120ms ease; }
.dt-chip-link:hover { border-color: var(--dsw-alias-brand-primary); }
.dt-chip-link:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dt-chip-open { display: inline-flex; align-items: center; padding: 0 5px; border-left: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-brand-primary); }
.dt-chip-problem, .dt-chip-problem .dt-chip-label { color: var(--dsw-alias-state-error-primary); }
.dt-cards { gap: 8px; }
.dt-att .dt-inline-link { font-size: 13px; font-weight: 500; }
.dt-list > .dt-att { margin: 2px 8px; }
.dt-att { padding: 10px 12px 10px 16px; border: 0; border-radius: 0; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }
.dt-att::before { content: ''; position: absolute; left: 6px; top: 10px; bottom: 10px; width: 2px; border-radius: 1px; background: var(--dsw-alias-state-warn-primary); opacity: 0.7; }
.dt-att-error::before { background: var(--dsw-alias-state-error-primary); }
.dt-att-what { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-state-warn-primary); }
.dt-att-error .dt-att-what, .dt-att-error .dt-att-what .dt-open { color: var(--dsw-alias-state-error-primary); }
.dt-stats { display: flex; flex-wrap: wrap; gap: 6px 20px; }
.dt-stat { display: inline-flex; align-items: baseline; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-caption); }
.dt-stat-value { font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.dt-more-link { font-size: 12px; font-weight: 400; }
.dt-settings { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 24px; align-items: start; }
.dt-settings-nav { position: sticky; top: 0; display: flex; flex-direction: column; gap: 2px; }
.dt-settings-link { padding: 6px 10px; border: 0; border-radius: 8px; background: none; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 14px; text-align: left; cursor: pointer; }
.dt-settings-link:hover { color: var(--dsw-alias-label-primary); }
.dt-settings-link[aria-current='page'] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-weight: 500; }
.dt-settings-link[data-stage] + .dt-settings-link:not([data-stage]) { margin-top: 10px; }
.dt-settings-body { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.dt-settings-title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; }
.dt-subtabs { display: flex; gap: 16px; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }
.dt-subtab { padding: 0 0 6px; border: 0; background: none; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 13px; cursor: pointer; }
.dt-subtab[aria-selected='true'] { color: var(--dsw-alias-label-primary); font-weight: 500; box-shadow: inset 0 -1.5px 0 var(--dsw-alias-label-primary); }
.dt-part { display: flex; flex-direction: column; gap: 12px; }
.dt-rows-summary { text-align: left; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.dt-table { width: 100%; border-collapse: collapse; font-size: 12px; line-height: 18px; }
.dt-table th { text-align: left; font-weight: 400; color: var(--dsw-alias-label-caption); padding: 2px 8px 2px 0; }
.dt-table td { padding: 4px 8px 4px 0; border-top: 0.5px solid var(--dsw-alias-border-l3); vertical-align: top; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
@container (max-width: 640px) {
  .dt-settings { grid-template-columns: 1fr; gap: 12px; }
  .dt-settings-nav { position: static; flex-direction: row; flex-wrap: wrap; }
  .dt-settings-link[data-stage] + .dt-settings-link:not([data-stage]) { margin-top: 0; }
  .dt-page .dt-tabs { gap: 14px; }
}
.dt-list > .dt-ticket { display: grid; grid-template-columns: 112px minmax(0, 1fr); column-gap: 12px; align-items: start; margin: 0; padding: 12px 8px 12px 18px; border-radius: 0; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }
.dt-list > .dt-ticket[data-state]::before { content: ''; position: absolute; left: 6px; top: 12px; bottom: 12px; width: 2px; border-radius: 1px; background: var(--dsw-alias-state-warn-primary); opacity: 0.7; }
.dt-list > .dt-ticket[data-state='error']::before { background: var(--dsw-alias-state-error-primary); }
.dt-ticket-stage { align-self: stretch; padding-top: 1px; border-right: 0.5px solid var(--dsw-alias-border-l3); }
.dt-ticket-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dt-ticket-body .dt-row-title .dt-open { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dt-ticket-meta { flex-wrap: nowrap; overflow: hidden; white-space: nowrap; }
.dt-ticket-meta .dt-chip { flex: none; }
.dt-ticket-note { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-primary); }
.dt-ticket-note-error { color: var(--dsw-alias-state-error-primary); }
.dt-ticket-actions { position: relative; z-index: 1; display: flex; flex-wrap: wrap; gap: 8px; min-height: 30px; margin-top: 2px; }
/* Pass pointer events through action containers to the row link, keeping only child controls interactive. */
.dt-ticket-actions, .dt-row-buttons, .dt-row-actions { pointer-events: none; }
.dt-ticket-actions > *, .dt-row-buttons > *, .dt-row-actions > * { pointer-events: auto; }
.dt-line { min-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dt-row-meta.dt-line { flex-wrap: nowrap; }
.dt-line-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dt-error-text { color: var(--dsw-alias-state-error-primary); }
.dt-stage { display: inline-flex; align-items: flex-start; gap: 5px; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.dt-stage svg { flex: none; margin-top: 2px; }
.dt-stage[data-state='warning'] { color: var(--dsw-alias-state-warn-primary); }
.dt-stage[data-state='error'] { color: var(--dsw-alias-state-error-primary); }
.dt-stage[data-state='ongoing'] { color: var(--dsw-alias-state-business-primary); }
.dt-icon-link { display: inline-flex; align-items: center; gap: 4px; }
a.dt-btn, a.dt-btn:hover { text-decoration: none; }
.dt-section-icon { display: inline-flex; align-self: center; color: var(--dsw-alias-label-tertiary); }
.dt-trigger-link { display: flex; flex-direction: column; gap: 2px; width: 100%; margin: -4px 0 -4px -8px; padding: 4px 8px; border: 0; border-radius: 8px; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; }
.dt-trigger-link:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dt-trigger-link:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dt-trigger-text { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.dt-kv-stack { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dt-banner-actions { margin-top: 6px; }
@container (max-width: 640px) {
  .dt-list > .dt-ticket { grid-template-columns: 1fr; row-gap: 4px; }
  .dt-ticket-stage { border-right: 0; }
}
.dt-nav-group { margin: 10px 10px 2px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dt-nav-group:first-child { margin-top: 0; }
.dt-prompt-nav .dt-nav-item { flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; }
.dt-nav-item > span { display: inline-flex; align-items: center; gap: 6px; }
.dt-nav-item small { font-size: 12px; line-height: 18px; font-weight: 400; color: var(--dsw-alias-label-caption); }
.dt-preview-part[data-editable] { border-left-color: var(--dsw-alias-brand-primary); }
.dt-preview-head b { font-weight: 500; }
.dt-preview-head > span { font-size: 12px; color: var(--dsw-alias-label-caption); }
.dt-changed-tag { margin-left: 6px; padding: 0 5px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 4px; font-size: 11px; line-height: 16px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.dt-updated-tag { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.dt-default-updated { display: flex; flex-direction: column; gap: 6px; padding: 2px 0 2px 12px; border-left: 2px solid var(--dsw-alias-state-warn-primary); }
.dt-diff-fold { color: var(--dsw-alias-label-caption); font-style: italic; }
.dt-compare { margin-left: auto; }
.dt-admission th { white-space: nowrap; }
.dt-admission thead tr:first-child th:not(:first-child) { color: var(--dsw-alias-label-secondary); font-weight: 500; }
.dt-admission td { vertical-align: middle; }
.dt-admission-scope { color: var(--dsw-alias-label-primary); font-size: 13px; }
.dt-admission-scope small { display: block; font-size: 11px; color: var(--dsw-alias-label-caption); }
.dt-admission-na { color: var(--dsw-alias-label-caption); }
.dt-admission-cell { display: flex; align-items: center; gap: 4px; }
.dt-admission-cell .dt-select { flex: 1; min-width: 0; }
.dt-admission-slot { display: inline-flex; flex: none; width: 16px; }
.dt-info-warn { color: var(--dsw-alias-state-warn-primary); }
.dt-field-segmented { max-width: 240px; }
`
