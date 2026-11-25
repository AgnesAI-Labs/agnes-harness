import type { UINode, UISpan } from '@agnes/protocol'
import {
  Button,
  SettingsList,
  SettingsRow,
  SettingsState,
  systemInputText,
  Tabs,
  webUiLocaleCatalog,
} from '@agnes/web-ui'
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
  :root {
    color-scheme: light dark;
    --agnes-bg-primary: Canvas;
    --agnes-bg-surface: color-mix(in srgb, Canvas 96%, CanvasText 4%);
    --agnes-bg-subtle: color-mix(in srgb, Canvas 92%, CanvasText 8%);
    --agnes-text-primary: CanvasText;
    --agnes-text-secondary: GrayText;
    --agnes-line-primary: color-mix(in srgb, GrayText 35%, transparent);
    --agnes-accent-primary: Highlight;
    --agnes-accent-soft: color-mix(in srgb, Highlight 14%, transparent);
    --agnes-warn-bg: color-mix(in srgb, Mark 20%, Canvas);
    --agnes-warn-border: color-mix(in srgb, Mark 55%, Canvas);
    --agnes-warn-text: CanvasText;
    --agnes-ok: Highlight;
    --agnes-bad: LinkText;
  }
}
@layer base {
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; background: var(--agnes-bg-primary); color: var(--agnes-text-primary); font-size: 14px; line-height: 1.6; }
  .ant-tabs-body-holder { display: none; }
}
@layer app {
  header { padding: 20px 24px 16px; background: var(--agnes-bg-surface); border-bottom: 1px solid var(--agnes-line-primary); }
  header h1 { margin: 0 0 6px; font-size: 19px; font-weight: 600; letter-spacing: -0.01em; text-wrap: balance; overflow-wrap: anywhere; }
  header p { margin: 2px 0; color: var(--agnes-text-secondary); font-size: 13px; max-width: 80ch; overflow-wrap: anywhere; }
  #agh-session-title { color: var(--agnes-text-primary); font-weight: 500; font-size: 14px; }
  #agh-tabs { position: sticky; top: 0; z-index: 10; display: flex; gap: 6px; padding: 10px 24px; background: var(--agnes-bg-surface); border-bottom: 1px solid var(--agnes-line-primary); flex-wrap: wrap; }
  #agh-tabs button { border: 1px solid transparent; background: transparent; color: var(--agnes-text-secondary); padding: 6px 14px; border-radius: 999px; cursor: pointer; font-size: 13px; font-weight: 500; min-height: 32px; touch-action: manipulation; transition: background .15s, color .15s; }
  #agh-tabs button:hover { background: var(--agnes-bg-subtle); color: var(--agnes-text-primary); }
  #agh-tabs button[aria-selected="true"] { background: var(--agnes-accent-primary); color: HighlightText; border-color: var(--agnes-accent-primary); }
  #agh-tabs button:focus-visible { outline: 2px solid var(--agnes-accent-primary); outline-offset: 2px; }
  main { padding: 20px 24px 40px; }
  main section { max-width: 1040px; margin: 0 auto; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  @media (max-width: 600px) {
    header, main { padding: 16px max(16px, env(safe-area-inset-right)) 24px max(16px, env(safe-area-inset-left)); }
    #agh-tabs { padding-inline: max(16px, env(safe-area-inset-left)) max(16px, env(safe-area-inset-right)); }
    #agh-tabs button { min-height: 44px; }
  }
  pre { margin: 8px 0 0; white-space: pre-wrap; word-break: break-word; background: var(--agnes-bg-subtle); border: 1px solid var(--agnes-line-primary); padding: 12px 14px; border-radius: 8px; font-size: 12px; line-height: 1.5; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; max-height: 460px; overflow: auto; }
  .agh-include { list-style: none; padding: 0; margin: 0 0 16px; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
  .agh-include li { background: var(--agnes-bg-surface); border: 1px solid var(--agnes-line-primary); border-radius: 10px; padding: 12px 14px; font-size: 13px; font-weight: 500; }
  .agh-warnings { list-style: none; padding: 0; margin: 0 0 16px; display: flex; flex-direction: column; gap: 8px; }
  .agh-warnings li { background: var(--agnes-warn-bg); border: 1px solid var(--agnes-warn-border); color: var(--agnes-warn-text); border-radius: 10px; padding: 10px 14px; font-size: 13px; }
  .agh-events-meta { background: var(--agnes-bg-surface); border: 1px solid var(--agnes-line-primary); border-radius: 10px; padding: 12px 14px; margin: 0; color: var(--agnes-text-secondary); font-size: 13px; }
  .agh-node { background: var(--agnes-bg-surface); border: 1px solid var(--agnes-line-primary); border-radius: 10px; padding: 12px 16px; margin-bottom: 10px; }
  .agh-node[data-kind="user"] { border-left: 3px solid var(--agnes-accent-primary); }
  .agh-node[data-kind="assistant"] { border-left: 3px solid var(--agnes-ok); }
  .agh-node[data-kind="context"], .agh-node[data-kind="context-sections"], .agh-node[data-kind="cost"] { background: transparent; border-style: dashed; padding: 8px 14px; }
  .agh-node-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
  .agh-node-kind { display: inline-block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; padding: 2px 8px; border-radius: 999px; background: var(--agnes-bg-subtle); color: var(--agnes-text-secondary); }
  .agh-node[data-kind="user"] .agh-node-kind { background: var(--agnes-accent-soft); color: var(--agnes-accent-primary); }
  .agh-node[data-kind="assistant"] .agh-node-kind { background: color-mix(in srgb, var(--agnes-ok) 14%, transparent); color: var(--agnes-ok); }
  .agh-node-seq { font-size: 12px; color: var(--agnes-text-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .agh-node-body { white-space: pre-wrap; word-break: break-word; font-size: 13.5px; color: var(--agnes-text-primary); }
  .agh-raw { margin-top: 8px; }
  .agh-raw-toggle { border: 1px solid var(--agnes-line-primary); background: transparent; color: var(--agnes-text-secondary); padding: 2px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .agh-turn-card { background: var(--agnes-bg-surface); border: 1px solid var(--agnes-line-primary); border-radius: 10px; padding: 12px 16px; margin-bottom: 14px; }
  .agh-turn-card h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; }
  .agh-span { padding: 6px 8px; border-bottom: 1px solid var(--agnes-line-primary); font-size: 13px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .agh-span:last-child { border-bottom: 0; }
  .agh-span[data-status="failed"] { color: var(--agnes-bad); }
  .agh-log-card { background: var(--agnes-bg-surface); border: 1px solid var(--agnes-line-primary); border-radius: 10px; padding: 12px 16px; margin-bottom: 14px; }
  .agh-log-card h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
  .agh-artifact { display: flex; gap: 12px; flex-wrap: wrap; margin: 4px 0 0; }
  .agh-artifact div { display: flex; gap: 4px; font-size: 13px; }
  .agh-artifact dt { font-weight: 600; color: var(--agnes-text-secondary); }
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
  Array.prototype.slice.call(document.querySelectorAll('[data-agh-toggle]')).forEach(function (btn) {
    btn.addEventListener('click', function () {
      var panel = document.getElementById(btn.getAttribute('aria-controls') || '');
      if (!panel) return;
      var open = !panel.hidden;
      panel.hidden = open;
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
  });
})();
`

type Labels = ReturnType<typeof diagnosticsViewerLabels>
function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => String(vars[name] ?? match))
}
function technicalPreview(text: string) {
  return text
    .replace(/\[Batch State(?::[^\]]*)?\][^\r\n]*/gi, '')
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{6}([0-9a-f]{6})\b/gi, '…$1')
    .trim()
}
function nodeText(node: UINode, labels: Labels, locale: DiagnosticsLocale): string {
  switch (node.kind) {
    case 'user':
      if (node.system)
        return technicalPreview(
          systemInputText(node.system, (key, vars) =>
            fill(webUiLocaleCatalog[locale][key] ?? key, vars ?? {}),
          ) ?? '',
        )
      return node.content.map((block) => (block.type === 'text' ? block.text : '')).join(' ')
    case 'assistant':
      return node.text || node.thinking || ''
    case 'tool':
      return node.summary
        ? technicalPreview(fill(labels.toolSummary, { name: node.name, summary: node.summary }))
        : node.name
    case 'approval':
    case 'compaction':
      return technicalPreview(node.summary ?? '')
    case 'cost':
      return node.model || node.purpose || ''
    case 'artifact':
      return node.name || ''
    case 'context':
      return technicalPreview(node.text ?? '')
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
      <div className="agh-span" data-status={span.status} style={{ paddingLeft: depth * 18 + 8 }}>
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
            <p className="agh-events-meta">
              {fill(labels.events, { count: bundle.events.count, seq: bundle.events.lastSeq })}
            </p>
          )}
        </section>
        <section id="tab-conversation" role="tabpanel" aria-labelledby="agh-tab-conversation" hidden>
          {bundle.trace?.nodes.length
            ? bundle.trace.nodes.map((node) => {
                const body = nodeText(node, labels, locale)
                return (
                  <div key={node.id} className="agh-node" data-kind={node.kind}>
                    <div className="agh-node-head">
                      <span className="agh-node-kind">{node.kind}</span>
                      {'seq' in node && typeof node.seq === 'number' && (
                        <span className="agh-node-seq">#{node.seq}</span>
                      )}
                    </div>
                    {body && <div className="agh-node-body">{body}</div>}
                    <div className="agh-raw">
                      <Button
                        htmlType="button"
                        className="agh-raw-toggle"
                        data-agh-toggle="raw"
                        aria-expanded={false}
                        aria-controls={`agh-raw-${node.id}`}
                      >
                        {labels.rawData}
                      </Button>
                      <pre id={`agh-raw-${node.id}`} hidden>
                        {JSON.stringify(node, null, 2)}
                      </pre>
                    </div>
                  </div>
                )
              })
            : empty}
        </section>
        <section id="tab-trace" role="tabpanel" aria-labelledby="agh-tab-trace" hidden>
          {turns.length
            ? turns.map((turn) => (
                <div key={turn.id} className="agh-turn-card">
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
                  <div key={key} className="agh-log-card">
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
