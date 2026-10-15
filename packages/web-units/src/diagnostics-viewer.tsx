import type { UINode, UISpan } from '@agnes/protocol'
import { Button, SettingsList, SettingsRow, SettingsState, Tabs } from '@agnes/web-ui'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  type DiagnosticsLocale,
  diagnosticsLocale,
  diagnosticsText,
  diagnosticsViewerLabels,
} from './diagnostics-locale.js'
import type { DiagnosticsBundle } from './diagnostics-types.js'

/** Keep script breakers inert even when a downstream consumer re-embeds the JSON. */
export function escapeBundleJson(bundle: DiagnosticsBundle): string {
  return JSON.stringify(bundle)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

const ARTIFACT_FIELDS = ['sha256', 'mime', 'lane', 'seq', 'source'] as const
const TAB_IDS = ['overview', 'conversation', 'trace', 'logs', 'system', 'artifacts'] as const
const STYLE = `
@layer tokens, base, ui, app;
@layer tokens {
  :root { color-scheme: light dark; --agnes-bg-primary: Canvas; --agnes-text-primary: CanvasText; --agnes-text-secondary: GrayText; --agnes-line-primary: GrayText; --agnes-accent-primary: Highlight; }
}
@layer base {
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--agnes-bg-primary); color: var(--agnes-text-primary); font-size: 14px; line-height: 1.6; }
}
@layer app {
  header { padding: 16px 20px; border-bottom: 1px solid var(--agnes-line-primary); }
  header h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; text-wrap: balance; overflow-wrap: anywhere; }
  header p { margin: 2px 0; color: var(--agnes-text-secondary); font-size: 13px; max-width: 75ch; overflow-wrap: anywhere; }
  #agh-tabs { display: flex; gap: 4px; padding: 8px 20px; border-bottom: 1px solid var(--agnes-line-primary); flex-wrap: wrap; }
   #agh-tabs button { border: 1px solid var(--agnes-line-primary); background: transparent; color: var(--agnes-text-primary); padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; min-height: 32px; touch-action: manipulation; }
   #agh-tabs button[aria-selected="true"] { background: var(--agnes-accent-primary); color: HighlightText; border-color: var(--agnes-accent-primary); }
  #agh-tabs button:focus-visible { outline: 2px solid var(--agnes-accent-primary); outline-offset: 2px; }
  main { padding: 16px 20px; }
  main section { max-width: 960px; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  @media (max-width: 600px) {
    header, main { padding: 16px max(16px, env(safe-area-inset-right)) 16px max(16px, env(safe-area-inset-left)); }
    #agh-tabs { padding-inline: max(16px, env(safe-area-inset-left)) max(16px, env(safe-area-inset-right)); }
    #agh-tabs button { min-height: 44px; }
  }
  pre { white-space: pre-wrap; word-break: break-word; background: color-mix(in srgb, var(--agnes-text-secondary) 8%, transparent); padding: 8px; border-radius: 6px; font-size: 12px; }
  .agh-node, .agh-span { padding: 4px 0; border-bottom: 1px solid var(--agnes-line-primary); }
  .agh-node-kind { font-weight: 600; margin-right: 6px; }
  .agh-artifact { display: flex; gap: 8px; flex-wrap: wrap; }
  .agh-artifact div { display: flex; gap: 4px; }
  .agh-artifact dt { font-weight: 600; }
  .agh-artifact dd { margin: 0; }
}
`

// All content is rendered by React before export. The offline page needs no vendor files,
// network or hydration; this script only changes existing tabs and their focus/visibility.
const RUNTIME_SCRIPT = `
(function () {
  'use strict';
  var tabs = Array.prototype.slice.call(document.querySelectorAll('#agh-tabs button'));
  var sections = Array.prototype.slice.call(document.querySelectorAll('main > section'));
  function select(tab, focus) {
    var name = tab.getAttribute('data-tab');
    tabs.forEach(function (item) {
      item.setAttribute('aria-selected', item === tab ? 'true' : 'false');
      item.tabIndex = item === tab ? 0 : -1;
    });
    sections.forEach(function (section) { section.hidden = section.id !== 'tab-' + name; });
    if (focus) tab.focus();
  }
  tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () { select(tab, false); });
    tab.addEventListener('keydown', function (event) {
      var next;
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else return;
      event.preventDefault();
      select(tabs[next], true);
    });
  });
})();
`

type Labels = ReturnType<typeof diagnosticsViewerLabels>
function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => String(vars[name] ?? match))
}
function nodeText(node: UINode, labels: Labels): string {
  switch (node.kind) {
    case 'user':
      return node.content.map((block) => (block.type === 'text' ? block.text : '')).join(' ')
    case 'assistant':
      return node.text || node.thinking || ''
    case 'tool':
      return node.summary ? fill(labels.toolSummary, { name: node.name, summary: node.summary }) : node.name
    case 'approval':
    case 'compaction':
      return node.summary || ''
    case 'cost':
      return node.model || node.purpose || ''
    case 'artifact':
      return node.name || ''
    case 'context':
      return node.text || ''
    default:
      return ''
  }
}
function formatDuration(ms: number | undefined, labels: Labels): string {
  if (ms === undefined) return labels.durationRunning
  if (ms < 1000) return fill(labels.durationMs, { n: ms })
  if (ms < 60000) return fill(labels.durationSeconds, { n: (ms / 1000).toFixed(ms < 10000 ? 1 : 0) })
  return fill(labels.durationMinutes, {
    minutes: Math.floor(ms / 60000),
    seconds: Math.round((ms % 60000) / 1000),
  })
}
function Span({ span, depth, labels }: { span: UISpan; depth: number; labels: Labels }) {
  const parts = [
    span.kind,
    span.name,
    labels.status[span.status] ?? span.status,
    formatDuration(span.durationMs, labels),
  ]
  if (span.model) parts.push(span.model)
  if (span.error?.message) parts.push(fill(labels.error, { message: span.error.message }))
  return (
    <>
      <div className="agh-span" style={{ paddingLeft: depth * 16 }}>
        {parts.join(' · ')}
      </div>
      {span.children.map((child) => (
        <Span key={child.id} span={child} depth={depth + 1} labels={labels} />
      ))}
    </>
  )
}
function Viewer({ bundle, locale }: { bundle: DiagnosticsBundle; locale: DiagnosticsLocale }) {
  const labels = diagnosticsViewerLabels(locale)
  const text = (key: Parameters<typeof diagnosticsText>[0], vars?: Record<string, string | number>) =>
    diagnosticsText(key, vars, locale)
  const empty = <SettingsState>{labels.notIncluded}</SettingsState>
  const turns = bundle.trace?.turns.filter((turn) => turn.trace) ?? []
  return (
    <>
      <header>
        <h1>{text('diagnostics.viewer.title')}</h1>
        <p id="agh-session-title">
          {bundle.sessionTitle ?? bundle.sessionId ?? text('diagnostics.viewer.fallbackTitle')}
        </p>
        <p id="agh-meta">
          {text('diagnostics.viewer.meta', { version: bundle.version, createdAt: bundle.createdAt })}
        </p>
      </header>
      <Tabs
        items={TAB_IDS.map((key) => ({ key, label: text(`diagnostics.viewer.tab.${key}`) }))}
        renderTabBar={() => (
          <div id="agh-tabs" role="tablist" aria-label={text('diagnostics.viewer.title')}>
            {TAB_IDS.map((id, index) => (
              <Button
                key={id}
                htmlType="button"
                id={`agh-tab-${id}`}
                role="tab"
                data-tab={id}
                aria-selected={index === 0}
                aria-controls={`tab-${id}`}
                tabIndex={index === 0 ? 0 : -1}
              >
                {text(`diagnostics.viewer.tab.${id}`)}
              </Button>
            ))}
          </div>
        )}
      />
      <main>
        <section id="tab-overview" role="tabpanel" aria-labelledby="agh-tab-overview">
          <ul className="agh-include">
            {(Object.keys(labels.include) as Array<keyof Labels['include']>).map((key) => (
              <li key={key}>
                {labels.include[key]}: {bundle.include[key] ? labels.included : labels.excluded}
              </li>
            ))}
          </ul>
          {bundle.warnings.length > 0 && (
            <ul className="agh-warnings">
              {bundle.warnings.map((warning, index) => {
                const vars = {
                  source: warning.source,
                  reason: labels.reason[warning.reason],
                  detail: warning.detail ?? '',
                }
                // Warnings are an immutable ordered record in the exported bundle.
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: warnings are immutable ordered records and may repeat.
                  <li key={index}>{fill(warning.detail ? labels.warningDetail : labels.warning, vars)}</li>
                )
              })}
            </ul>
          )}
          {bundle.events && (
            <p>{fill(labels.events, { count: bundle.events.count, seq: bundle.events.lastSeq })}</p>
          )}
        </section>
        <section id="tab-conversation" role="tabpanel" aria-labelledby="agh-tab-conversation" hidden>
          {bundle.trace?.nodes.length
            ? bundle.trace.nodes.map((node) => (
                <div key={node.id} className="agh-node">
                  <span className="agh-node-kind">{node.kind}</span>
                  <span>{nodeText(node, labels)}</span>
                  <pre>{JSON.stringify(node, null, 2)}</pre>
                </div>
              ))
            : empty}
        </section>
        <section id="tab-trace" role="tabpanel" aria-labelledby="agh-tab-trace" hidden>
          {turns.length
            ? turns.map((turn) => (
                <div key={turn.id}>
                  <h3>{fill(labels.turn, { turn: turn.turn })}</h3>
                  {turn.trace && <Span span={turn.trace} depth={0} labels={labels} />}
                </div>
              ))
            : empty}
        </section>
        <section id="tab-logs" role="tabpanel" aria-labelledby="agh-tab-logs" hidden>
          {bundle.logs
            ? (['requestAudit', 'host', 'runtime', 'browser'] as const).map((key) => {
                const value =
                  key === 'requestAudit'
                    ? (bundle.logs?.requestAudit ?? bundle.logs?.daemon)
                    : bundle.logs?.[key]
                if (!value) return null
                const content =
                  'entries' in value
                    ? value.entries.map((entry) => `[${entry.ts}] ${entry.level} ${entry.text}`).join('\n')
                    : value.text + (value.truncated ? `\n${labels.truncated}` : '')
                return (
                  <div key={key}>
                    <h3>
                      {key === 'requestAudit' || key === 'runtime'
                        ? text(`diagnostics.viewer.log.${key}`)
                        : key}
                    </h3>
                    <pre>{content}</pre>
                  </div>
                )
              })
            : empty}
        </section>
        <section id="tab-system" role="tabpanel" aria-labelledby="agh-tab-system" hidden>
          {bundle.system ? <pre>{JSON.stringify(bundle.system, null, 2)}</pre> : empty}
        </section>
        <section id="tab-artifacts" role="tabpanel" aria-labelledby="agh-tab-artifacts" hidden>
          {bundle.artifacts.length ? (
            <SettingsList>
              {bundle.artifacts.map((artifact) => (
                <SettingsRow
                  key={`${artifact.lane}:${artifact.seq}:${artifact.sha256}`}
                  title={`${ARTIFACT_FIELDS[0]}: ${artifact.sha256.slice(0, 12)}`}
                >
                  <dl className="agh-artifact">
                    {(['mime', 'lane', 'seq', 'source'] as const).map((key) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{artifact[key]}</dd>
                      </div>
                    ))}
                  </dl>
                </SettingsRow>
              ))}
            </SettingsList>
          ) : (
            empty
          )}
        </section>
      </main>
    </>
  )
}

/** Self-contained HTML in the diagnostics ZIP, rendered with shared components before export. */
export function renderDiagnosticsViewer(
  bundle: DiagnosticsBundle,
  locale: DiagnosticsLocale = diagnosticsLocale(),
): string {
  const markup = renderToStaticMarkup(<Viewer bundle={bundle} locale={locale} />)
  const title = renderToStaticMarkup(
    <title>{diagnosticsText('diagnostics.viewer.title', undefined, locale)}</title>,
  )
  return `<!doctype html>\n<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${title}<style>${STYLE}</style></head><body>${markup}<script type="application/json" id="agh-bundle">${escapeBundleJson(bundle)}</script><script>${RUNTIME_SCRIPT}</script></body></html>`
}
