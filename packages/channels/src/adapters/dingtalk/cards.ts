import { createHash } from 'node:crypto'
import type { AcpPermissionKind } from '@agnes/protocol'
import type { Block } from '../../adapter.js'

type Button = { text: string; value: string; color: 'blue' | 'red' }
const APPROVAL_LABEL: Record<AcpPermissionKind, Omit<Button, 'value'>> = {
  allow_once: { text: '同意', color: 'blue' },
  allow_always: { text: '本会话都同意', color: 'blue' },
  reject_once: { text: '拒绝', color: 'red' },
  reject_always: { text: '本会话都拒绝', color: 'red' },
}
export function cardBizIdFor(sessionKey: string, nodeId: string): string {
  return createHash('sha256').update(`${sessionKey}#${nodeId}`).digest('hex').slice(0, 32)
}
export function approvalValue(
  key: { ticket?: string; requestSeq?: number },
  kind: AcpPermissionKind,
): string {
  return `appr:${key.ticket ?? `#${key.requestSeq ?? 0}`}:${kind}`
}
export function slotValue(requestSeq: number, actionId: string): string {
  return `slot:${requestSeq}:${actionId}`
}
export function buildCard(
  blocks: Block[],
  ids: { cardBizId: string },
  maxBytes: number,
): { cardData: Record<string, unknown>; bytes: number } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('maxBytes must be a positive integer')
  }
  let title = ''
  const markdown: string[] = []
  const buttons: Button[] = []
  for (const block of blocks) {
    switch (block.kind) {
      case 'text':
        markdown.push(block.markdown)
        break
      case 'link':
        markdown.push(`[${escapeMarkdownLabel(block.title)}](${block.url})`)
        break
      case 'file':
        markdown.push(
          block.url === undefined
            ? `${block.name}（无可发送链接）`
            : `[${escapeMarkdownLabel(block.name)}](${block.url})`,
        )
        break
      case 'table':
        title ||= block.title ?? ''
        if (block.title !== undefined) markdown.push(`**${block.title}**`)
        markdown.push(markdownTable(block.columns, block.rows))
        break
      case 'card':
        title ||= block.title
        if (block.body.length > 0) markdown.push(block.body)
        for (const [key, value] of block.fields ?? []) markdown.push(`- ${key}: ${value}`)
        for (const action of block.actions ?? []) {
          buttons.push({
            text: action.label,
            value: slotValue(block.requestSeq ?? 0, action.id),
            color: action.style === 'danger' ? 'red' : 'blue',
          })
        }
        break
      case 'approval':
        title ||= block.title
        markdown.push(block.summary, `风险：${block.risk}`)
        if (block.expiresAt !== undefined) markdown.push(`截止：${block.expiresAt}`)
        for (const option of block.options) {
          buttons.push({
            ...APPROVAL_LABEL[option],
            value: approvalValue(
              {
                ...(block.ticket === undefined ? {} : { ticket: block.ticket }),
                ...(block.requestSeq === undefined ? {} : { requestSeq: block.requestSeq }),
              },
              option,
            ),
          })
        }
        break
    }
  }
  const make = (body: string): Record<string, unknown> => ({
    outTrackId: ids.cardBizId,
    cardParamMap: {
      title: title || ' ',
      markdown: body,
      buttons: JSON.stringify(buttons),
    },
  })
  const full = markdown.join('\n\n')
  let cardData = make(full)
  let bytes = byteLength(cardData)
  if (bytes <= maxBytes) return { cardData, bytes }
  const suffix = '（已截断）'
  const characters = [...full]
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (byteLength(make(`${characters.slice(0, middle).join('')}${suffix}`)) <= maxBytes) low = middle
    else high = middle - 1
  }
  cardData = make(`${characters.slice(0, low).join('')}${suffix}`)
  bytes = byteLength(cardData)
  if (bytes > maxBytes) {
    throw new RangeError('DingTalk card byte limit is too small for the card envelope')
  }
  return { cardData, bytes }
}
function markdownTable(columns: string[], rows: string[][]): string {
  const cells = (row: string[]): string => row.map(escapeTableCell).join(' | ')
  return [
    `| ${cells(columns)} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${cells(row)} |`),
  ].join('\n')
}
function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}
function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\[\]]/g, '\\$&')
}
function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}
