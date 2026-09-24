import type { ContentBlock, UINode, UITimeline } from '@agnes/protocol'
import { formatUsdMicros } from '../tui/format-usage.js'

export type HtmlExportMeta = {
  sessionId: string
  exportedAt: string
  redacted: boolean
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character)
}

const CSS = `:root{color-scheme:light dark}body{font:14px/1.5 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1c211e;background:#fff}.meta,.minor{color:#69707a;font-size:12px}.meta{border-bottom:1px solid #d6dbd5;margin-bottom:1rem;padding-bottom:.5rem}.node{margin:.7rem 0}.user{background:#f3f5f4;border-radius:6px;padding:.6rem}.assistant{padding:.6rem}.tool{border:1px solid #d6dbd5;border-radius:6px;padding:.4rem .6rem;color:#4d555f}.approval{border-left:3px solid #0e6b54;padding:.4rem .6rem}.content{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.label{font-weight:600}.attachment{display:block}.compaction{text-align:center}@media(prefers-color-scheme:dark){body{color:#e7ece8;background:#151816}.user{background:#242925}.tool{border-color:#454c47;color:#c5ccc7}.meta,.minor{color:#abb3ad}}`

function contentBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return escapeHtml(block.text)
    case 'image':
      return `<span class="attachment">[image: ${escapeHtml(block.mimeType)}]</span>`
    case 'resource_link': {
      const label = block.name ? `${block.name}: ` : ''
      return `<span class="attachment">[resource: ${escapeHtml(label + block.uri)}]</span>`
    }
  }
}

function renderNode(node: UINode): string {
  switch (node.kind) {
    case 'user':
      return `<section class="node user"><div class="label">User${node.actorLabel ? ` · ${escapeHtml(node.actorLabel)}` : ''}</div><div class="content">${node.content.map(contentBlock).join('\n')}</div></section>`
    case 'assistant':
      return `<section class="node assistant"><div class="label">Assistant</div><div class="content">${escapeHtml(node.text)}</div></section>`
    case 'tool': {
      const previews = [node.argsPreview, node.resultPreview].filter(
        (preview): preview is string => preview !== undefined && preview !== '',
      )
      const body = [node.summary, ...previews].map(escapeHtml).join('\n')
      return `<details class="node tool"><summary>${escapeHtml(node.name)} · ${escapeHtml(node.status)}</summary><div class="content">${body}</div></details>`
    }
    case 'approval': {
      const outcome = node.decision?.verdict ?? node.state
      return `<section class="node approval"><span class="label">Approval · ${escapeHtml(outcome)}</span><div class="content">${escapeHtml(node.summary)}</div></section>`
    }
    case 'cost': {
      // `credits` and `billing` are independently optional on the wire, so a missing `credits` is
      // not an unknown cost. Same precedence the TUI renders this node with (usage-details.ts:5-8):
      // a real amount when the gateway billed one, the credit estimate only as the fallback.
      const amount = node.billing
        ? `${formatUsdMicros(node.billing.usdMicros)} (${escapeHtml(node.billing.source)})`
        : `credits ${node.credits ?? 'unknown'} (${escapeHtml(node.source)})`
      return `<section class="node minor">${amount}${node.purpose ? ` · ${escapeHtml(node.purpose)}` : ''}</section>`
    }
    case 'artifact':
      return `<section class="node minor">Artifact · ${escapeHtml(node.name)} · ${node.ref.size} B · ${escapeHtml(node.ref.mime)}</section>`
    case 'compaction':
      return `<section class="node minor compaction">— compacted ${node.range[0]}–${node.range[1]}${node.summary ? ` · ${escapeHtml(node.summary)}` : ''} —</section>`
    case 'context':
      // A per-request environment snapshot or a harness note. It is content the model is sent, not
      // a message for the human reading the transcript, and an archive is no exception -- an
      // exported transcript is the same transcript. No section, and the caller drops the empty
      // string rather than leaving a gap where one used to be.
      return ''
    case 'slot':
      return `<section class="node minor">Extension slot · ${escapeHtml(node.fill.slot)} · ${escapeHtml(node.fill.extId)}</section>`
    case 'context-sections': {
      const total = node.sections.reduce((sum, s) => sum + s.tokens, 0)
      return `<section class="node minor">Context breakdown · ${node.sections.length} sections · ${total} tokens (estimated)</section>`
    }
    case 'contribute-conflict':
      return `<section class="node minor">Contribute conflict · ${escapeHtml(node.key)}: ${escapeHtml(node.ops.join(', '))}</section>`
  }
}

/** Render a projection as one inert, self-contained document suitable for offline export. */
export function renderHtml(timeline: UITimeline, meta: HtmlExportMeta): string {
  const status = meta.redacted ? 'redacted' : 'raw'
  const nodes = timeline.nodes
    .map(renderNode)
    .filter((section) => section !== '')
    .join('\n')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(meta.sessionId)}</title><style>${CSS}</style></head><body><header class="meta">${escapeHtml(meta.sessionId)} · ${escapeHtml(meta.exportedAt)} · ${status} · ${timeline.nodes.length} items</header><main>${nodes}</main></body></html>`
}
