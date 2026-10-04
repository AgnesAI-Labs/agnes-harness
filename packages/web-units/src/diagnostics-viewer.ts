import {
  type DiagnosticsLocale,
  diagnosticsLocale,
  diagnosticsText,
  diagnosticsViewerLabels,
} from './diagnostics-locale.js'
import type { DiagnosticsBundle } from './diagnostics-types.js'

/**
 * The bundle JSON embedded in the offline viewer's `<script type="application/json">`
 * block. Escaping `<` keeps a literal `</script>` in user data (a session title, a
 * tool result, ...) from ever closing that tag early; escaping U+2028/U+2029 keeps the
 * text a valid JS string literal in case some downstream tool re-embeds it as one.
 * Written as escape sequences here (not literal characters) to pass the control-chars guard.
 */
export function escapeBundleJson(bundle: DiagnosticsBundle): string {
  return JSON.stringify(bundle)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const TAB_IDS = ['overview', 'conversation', 'trace', 'logs', 'system', 'artifacts'] as const

const STYLE = `
:root { color-scheme: light dark; --agh-bg:#fff; --agh-fg:#1a1a1a; --agh-muted:#666; --agh-border:#ddd; --agh-accent:#2563eb; }
@media (prefers-color-scheme: dark) {
  :root { --agh-bg:#111318; --agh-fg:#e6e6e6; --agh-muted:#9aa0a6; --agh-border:#333; --agh-accent:#7aa2f7; }
}
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--agh-bg); color: var(--agh-fg); }
header { padding: 16px 20px; border-bottom: 1px solid var(--agh-border); }
header h1 { margin: 0 0 4px; font-size: 18px; }
header p { margin: 2px 0; color: var(--agh-muted); font-size: 13px; }
nav { display: flex; gap: 4px; padding: 8px 20px; border-bottom: 1px solid var(--agh-border); flex-wrap: wrap; }
nav button { border: 1px solid var(--agh-border); background: transparent; color: var(--agh-fg); padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
nav button[aria-selected="true"] { background: var(--agh-accent); color: #fff; border-color: var(--agh-accent); }
main { padding: 16px 20px; }
main section { max-width: 960px; }
pre { white-space: pre-wrap; word-break: break-word; background: rgba(127, 127, 127, 0.08); padding: 8px; border-radius: 6px; font-size: 12px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--agh-border); }
.agh-node, .agh-span { padding: 4px 0; border-bottom: 1px solid var(--agh-border); }
.agh-node-kind { font-weight: 600; margin-right: 6px; }
.agh-empty { color: var(--agh-muted); }
`

// Everything below runs standalone, later, inside the offline exported page - no
// bundler, no imports, no access to anything outside this string. Duplicating a tiny
// duration formatter here (rather than importing trace.ts's) is deliberate: this text
// ships as-is inside the ZIP, so it cannot reference this module's scope.
const RUNTIME_SCRIPT = `
(function () {
  'use strict';
  var dataEl = document.getElementById('agh-bundle');
  var bundle = JSON.parse(dataEl ? dataEl.textContent : 'null');

  function el(tag, text, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function fill(template, vars) {
    return String(template).replace(/\\{(\\w+)\\}/g, function (_match, name) {
      return vars[name] == null ? '{' + name + '}' : String(vars[name]);
    });
  }
  function notIncluded(target) {
    target.appendChild(el('p', L.notIncluded, 'agh-empty'));
  }
  function fmtDuration(ms) {
    if (ms === undefined || ms === null) return L.durationRunning;
    if (ms < 1000) return fill(L.durationMs, { n: ms });
    if (ms < 60000) return fill(L.durationSeconds, { n: (ms / 1000).toFixed(ms < 10000 ? 1 : 0) });
    return fill(L.durationMinutes, { minutes: Math.floor(ms / 60000), seconds: Math.round((ms % 60000) / 1000) });
  }

  var STATUS_LABEL = L.status;
  var REASON_LABEL = L.reason;
  var INCLUDE_LABEL = L.include;

  var tabButtons = Array.prototype.slice.call(document.querySelectorAll('#agh-tabs button'));
  var tabSections = Array.prototype.slice.call(document.querySelectorAll('main > section'));
  tabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var name = btn.getAttribute('data-tab');
      tabButtons.forEach(function (b) { b.setAttribute('aria-selected', b === btn ? 'true' : 'false'); });
      tabSections.forEach(function (section) { section.hidden = section.id !== 'tab-' + name; });
    });
  });

  function renderOverview() {
    var root = document.getElementById('tab-overview');
    var list = el('ul', undefined, 'agh-include');
    Object.keys(INCLUDE_LABEL).forEach(function (key) {
      var included = bundle.include && bundle.include[key];
      list.appendChild(el('li', INCLUDE_LABEL[key] + ': ' + (included ? L.included : L.excluded)));
    });
    root.appendChild(list);
    if (bundle.warnings && bundle.warnings.length > 0) {
      var warnings = el('ul', undefined, 'agh-warnings');
      bundle.warnings.forEach(function (warning) {
        var reason = REASON_LABEL[warning.reason] || warning.reason;
        var text = warning.detail
          ? fill(L.warningDetail, { source: warning.source, reason: reason, detail: warning.detail })
          : fill(L.warning, { source: warning.source, reason: reason });
        warnings.appendChild(el('li', text));
      });
      root.appendChild(warnings);
    }
    if (bundle.events) {
      var summary = fill(L.events, { count: bundle.events.count, seq: bundle.events.lastSeq });
      root.appendChild(el('p', summary));
    }
  }

  function nodeText(node) {
    if (node.kind === 'user') return (node.content || []).map(function (b) { return (b && b.text) || ''; }).join(' ');
    if (node.kind === 'assistant') return node.text || node.thinking || '';
    if (node.kind === 'tool') return node.summary ? fill(L.toolSummary, { name: node.name, summary: node.summary }) : node.name;
    if (node.kind === 'approval') return node.summary || '';
    if (node.kind === 'compaction') return node.summary || '';
    if (node.kind === 'cost') return node.model || node.purpose || '';
    if (node.kind === 'artifact') return node.name || '';
    if (node.kind === 'context') return node.text || '';
    return '';
  }

  function renderConversation() {
    var root = document.getElementById('tab-conversation');
    var nodes = bundle.trace && bundle.trace.nodes;
    if (!nodes || nodes.length === 0) { notIncluded(root); return; }
    nodes.forEach(function (node) {
      var item = el('div', undefined, 'agh-node');
      item.appendChild(el('span', node.kind, 'agh-node-kind'));
      item.appendChild(el('span', nodeText(node)));
      item.appendChild(el('pre', JSON.stringify(node, null, 2)));
      root.appendChild(item);
    });
  }

  function renderSpan(span, depth, container) {
    var row = el('div', undefined, 'agh-span');
    row.style.paddingLeft = (depth * 16) + 'px';
    var parts = [span.kind, span.name, STATUS_LABEL[span.status] || span.status, fmtDuration(span.durationMs)];
    if (span.model) parts.push(span.model);
    if (span.error && span.error.message) parts.push(fill(L.error, { message: span.error.message }));
    row.textContent = parts.join(' · ');
    container.appendChild(row);
    (span.children || []).forEach(function (child) { renderSpan(child, depth + 1, container); });
  }

  function renderTrace() {
    var root = document.getElementById('tab-trace');
    var turns = (bundle.trace && bundle.trace.turns) || [];
    var withTrace = turns.filter(function (t) { return t.trace; });
    if (withTrace.length === 0) { notIncluded(root); return; }
    withTrace.forEach(function (turn) {
      root.appendChild(el('h3', fill(L.turn, { turn: turn.turn })));
      renderSpan(turn.trace, 0, root);
    });
  }

  function renderLogs() {
    var root = document.getElementById('tab-logs');
    if (!bundle.logs) { notIncluded(root); return; }
    ['daemon', 'host', 'browser'].forEach(function (key) {
      var value = bundle.logs[key];
      if (!value) return;
      root.appendChild(el('h3', key));
      if (key === 'browser') {
        var lines = (value.entries || []).map(function (entry) {
          return '[' + entry.ts + '] ' + entry.level + ' ' + entry.text;
        });
        root.appendChild(el('pre', lines.join('\\n')));
      } else {
        root.appendChild(el('pre', value.text + (value.truncated ? '\\n' + L.truncated : '')));
      }
    });
  }

  function renderSystem() {
    var root = document.getElementById('tab-system');
    if (!bundle.system) { notIncluded(root); return; }
    root.appendChild(el('pre', JSON.stringify(bundle.system, null, 2)));
  }

  function renderArtifacts() {
    var root = document.getElementById('tab-artifacts');
    if (!bundle.artifacts || bundle.artifacts.length === 0) { notIncluded(root); return; }
    var table = document.createElement('table');
    var head = document.createElement('tr');
    ['sha256', 'mime', 'lane', 'seq', 'source'].forEach(function (label) { head.appendChild(el('th', label)); });
    table.appendChild(head);
    bundle.artifacts.forEach(function (artifact) {
      var row = document.createElement('tr');
      row.appendChild(el('td', String(artifact.sha256).slice(0, 12)));
      row.appendChild(el('td', artifact.mime));
      row.appendChild(el('td', artifact.lane));
      row.appendChild(el('td', String(artifact.seq)));
      row.appendChild(el('td', artifact.source));
      table.appendChild(row);
    });
    root.appendChild(table);
  }

  renderOverview();
  renderConversation();
  renderTrace();
  renderLogs();
  renderSystem();
  renderArtifacts();
})();
`

/** Renders the self-contained offline `index.html` that ships inside the diagnostics ZIP. */
export function renderDiagnosticsViewer(
  bundle: DiagnosticsBundle,
  locale: DiagnosticsLocale = diagnosticsLocale(),
): string {
  const headerTitle = escapeHtml(
    bundle.sessionTitle ??
      bundle.sessionId ??
      diagnosticsText('diagnostics.viewer.fallbackTitle', undefined, locale),
  )
  const tabKey = {
    overview: 'diagnostics.viewer.tab.overview',
    conversation: 'diagnostics.viewer.tab.conversation',
    trace: 'diagnostics.viewer.tab.trace',
    logs: 'diagnostics.viewer.tab.logs',
    system: 'diagnostics.viewer.tab.system',
    artifacts: 'diagnostics.viewer.tab.artifacts',
  } as const
  const nav = TAB_IDS.map(
    (id, index) =>
      `<button type="button" data-tab="${id}" aria-selected="${index === 0 ? 'true' : 'false'}">${escapeHtml(diagnosticsText(tabKey[id], undefined, locale))}</button>`,
  ).join('')
  const sections = TAB_IDS.map(
    (id, index) => `<section id="tab-${id}"${index === 0 ? '' : ' hidden'}></section>`,
  ).join('')
  const labels = JSON.stringify(diagnosticsViewerLabels(locale)).replace(/</g, '\\u003c')
  const title = diagnosticsText('diagnostics.viewer.title', undefined, locale)
  const meta = diagnosticsText(
    'diagnostics.viewer.meta',
    { version: bundle.version, createdAt: bundle.createdAt },
    locale,
  )
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>${escapeHtml(title)}</h1>
<p id="agh-session-title">${headerTitle}</p>
<p id="agh-meta">${escapeHtml(meta)}</p>
</header>
<nav id="agh-tabs">${nav}</nav>
<main>${sections}</main>
<script type="application/json" id="agh-bundle">${escapeBundleJson(bundle)}</script>
<script>var L = ${labels};\n${RUNTIME_SCRIPT}</script>
</body>
</html>
`
}
