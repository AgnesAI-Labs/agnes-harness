import type { ChannelCapabilities } from '@agnes/protocol'
import type { ApprovalBlock, Block, CardBlock, ChannelMessage, TableBlock } from './adapter.js'

export type DegradedCap = 'edit' | 'card' | 'attachment' | 'thread'
export type MarkdownFeature = 'bold' | 'code' | 'list' | 'link'

const ACTIVE_HTML_ELEMENT = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const HTML_COMMENT = /<!--[\s\S]*?-->/g
const HTML_TAG = /<\/?[A-Za-z][^>]*>/g
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g

/** Turns untrusted channel text into inert text without discarding ordinary tag contents. */
export function escapeText(value: string): string {
  return value
    .replace(ACTIVE_HTML_ELEMENT, '')
    .replace(HTML_COMMENT, '')
    .replace(HTML_TAG, '')
    .replace(ZERO_WIDTH, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Reduces markdown to the portable subset declared by an adapter. */
export function markdownSubset(value: string, allowed: ReadonlySet<MarkdownFeature>): string {
  let result = value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  if (!allowed.has('link')) {
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
  }
  if (!allowed.has('bold')) result = result.replace(/\*\*([^*]+)\*\*/g, '$1')
  if (!allowed.has('code')) result = result.replace(/`([^`]+)`/g, '$1')
  if (!allowed.has('list')) result = result.replace(/^\s*[-*]\s+/gm, '')
  return result
}

function approvalKey(block: ApprovalBlock): string | undefined {
  if (block.ticket) return block.ticket.slice(0, 6)
  if (block.requestSeq !== undefined) return `#${block.requestSeq}`
  return undefined
}

export function approvalAsText(block: ApprovalBlock): string {
  const lines = [`【${block.title}】`, block.summary, `风险：${block.risk}`]
  if (block.expiresAt) lines.push(`截止：${block.expiresAt}`)

  const key = approvalKey(block)
  if (key) lines.push(`回复「同意 ${key}」或「拒绝 ${key}」`)
  return lines.join('\n')
}

function cardAsText(block: CardBlock): string {
  const lines = [`【${block.title}】`, block.body]
  for (const [key, value] of block.fields ?? []) lines.push(`${key}: ${value}`)
  if (block.actions?.length) {
    block.actions.forEach((action, index) => {
      lines.push(`${index + 1}. ${action.label}`)
    })
    lines.push(`回复 ${block.actions.map((_, index) => index + 1).join(' / ')} 选择`)
  }
  return lines.join('\n')
}

function tableAsText(block: TableBlock): string {
  const lines = block.title ? [`【${block.title}】`] : []
  lines.push(block.columns.join(' | '))
  for (const row of block.rows) lines.push(row.join(' | '))
  return lines.join('\n')
}

export function degrade(
  message: ChannelMessage,
  capabilities: ChannelCapabilities,
  options: { updating?: boolean } = {},
): { msg: ChannelMessage; degraded: DegradedCap[] } {
  const degraded = new Set<DegradedCap>()
  const blocks = message.blocks.map((block): Block => {
    if (
      (block.kind === 'card' || block.kind === 'table' || block.kind === 'approval') &&
      !capabilities.card
    ) {
      degraded.add('card')
      const markdown =
        block.kind === 'card'
          ? cardAsText(block)
          : block.kind === 'table'
            ? tableAsText(block)
            : approvalAsText(block)
      return { kind: 'text', markdown }
    }

    if (block.kind === 'file' && !capabilities.attachment) {
      degraded.add('attachment')
      return block.url
        ? { kind: 'link', title: block.name, url: block.url }
        : { kind: 'text', markdown: `${block.name}（无法发送）` }
    }
    return block
  })

  if (options.updating && !capabilities.edit) {
    degraded.add('edit')
    const first = blocks[0]
    if (first?.kind === 'text') {
      blocks[0] = { kind: 'text', markdown: `（更新）${first.markdown}` }
    } else {
      blocks.unshift({ kind: 'text', markdown: '（更新）' })
    }
  }

  return { msg: { ...message, blocks }, degraded: [...degraded] }
}
