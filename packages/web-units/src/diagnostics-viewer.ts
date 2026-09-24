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

const TABS: ReadonlyArray<readonly [string, string]> = [
  ['overview', '概览'],
  ['conversation', '对话'],
  ['trace', '轨迹'],
  ['logs', '日志'],
  ['system', '系统'],
  ['artifacts', '产物'],
]

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
  function notIncluded(target) {
    target.appendChild(el('p', '未包含', 'agh-empty'));
  }
  function fmtDuration(ms) {
    if (ms === undefined || ms === null) return '进行中';
    if (ms < 1000) return ms + ' 毫秒';
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' 秒';
    return Math.floor(ms / 60000) + ' 分 ' + Math.round((ms % 60000) / 1000) + ' 秒';
  }

  var STATUS_LABEL = { running: '进行中', waiting: '等待中', completed: '已完成', failed: '失败', cancelled: '已取消' };
  var REASON_LABEL = { unavailable: '不可用', truncated: '已截断', limit: '超出上限', timeout: '超时', failed: '失败' };
  var INCLUDE_LABEL = { conversation: '对话与轨迹', logs: '日志', system: '系统信息' };

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
      list.appendChild(el('li', INCLUDE_LABEL[key] + '：' + (included ? '已包含' : '未包含')));
    });
    root.appendChild(list);
    if (bundle.warnings && bundle.warnings.length > 0) {
      var warnings = el('ul', undefined, 'agh-warnings');
      bundle.warnings.forEach(function (warning) {
        var reason = REASON_LABEL[warning.reason] || warning.reason;
        var text = warning.source + '：' + reason + (warning.detail ? '（' + warning.detail + '）' : '');
        warnings.appendChild(el('li', text));
      });
      root.appendChild(warnings);
    }
    if (bundle.events) {
      var summary = '完整事件账本见 events.jsonl（' + bundle.events.count + ' 条，截至 seq ' + bundle.events.lastSeq + '）';
      root.appendChild(el('p', summary));
    }
  }

  function nodeText(node) {
    if (node.kind === 'user') return (node.content || []).map(function (b) { return (b && b.text) || ''; }).join(' ');
    if (node.kind === 'assistant') return node.text || node.thinking || '';
    if (node.kind === 'tool') return node.name + (node.summary ? '：' + node.summary : '');
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
    if (span.error && span.error.message) parts.push('错误：' + span.error.message);
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
      root.appendChild(el('h3', '第 ' + turn.turn + ' 轮'));
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
        root.appendChild(el('pre', value.text + (value.truncated ? '\\n…（已截断）' : '')));
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
export function renderDiagnosticsViewer(bundle: DiagnosticsBundle): string {
  const headerTitle = escapeHtml(bundle.sessionTitle ?? bundle.sessionId ?? '应用范围')
  const nav = TABS.map(
    ([id, label], index) =>
      `<button type="button" data-tab="${id}" aria-selected="${index === 0 ? 'true' : 'false'}">${escapeHtml(label)}</button>`,
  ).join('')
  const sections = TABS.map(
    ([id], index) => `<section id="tab-${id}"${index === 0 ? '' : ' hidden'}></section>`,
  ).join('')
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>agh 诊断包</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>agh 诊断包</h1>
<p id="agh-session-title">${headerTitle}</p>
<p id="agh-meta">版本 ${escapeHtml(bundle.version)} · 导出于 ${escapeHtml(bundle.createdAt)}</p>
</header>
<nav id="agh-tabs">${nav}</nav>
<main>${sections}</main>
<script type="application/json" id="agh-bundle">${escapeBundleJson(bundle)}</script>
<script>${RUNTIME_SCRIPT}</script>
</body>
</html>
`
}
