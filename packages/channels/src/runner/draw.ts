import { createHash } from 'node:crypto'
import type { AcpPermissionKind, ChannelCapabilities, UINode } from '@agnes/protocol'
import type { Block, CardBlock, ChannelMessage } from '../adapter.js'

// UINode's approval options are Agnes' own vocabulary (it has a 'allow_permanent' entry for the
// durable-grant flow, core/src/project/ui.ts:1018-1023); the channel card only understands ACP's
// four native PermissionOptionKind values and has no "grant permanently" button to offer, so that
// entry is dropped rather than forwarded to a wire field that cannot represent it.
const ACP_OPTION_KINDS = new Set<AcpPermissionKind>([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
])
function toAcpOptions(options: readonly string[]): AcpPermissionKind[] {
  return options.filter((o): o is AcpPermissionKind => ACP_OPTION_KINDS.has(o as AcpPermissionKind))
}

const STATUS_LABEL: Record<string, string> = {
  planned: '排队',
  awaiting_approval: '等待审批',
  running: '运行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
}

type SlotPayload = {
  title?: string
  body?: string
  link?: string
  text?: string
  table?: { columns: string[]; rows: string[][] }
  chart?: unknown
  actions?: CardBlock['actions']
}

function asSlotPayload(value: unknown): SlotPayload {
  return typeof value === 'object' && value !== null ? (value as SlotPayload) : {}
}

function slotBlocks(slot: string, value: unknown, requestSeq?: number): Block[] {
  const payload = asSlotPayload(value)
  if (slot === 'tool.card.inline') {
    const blocks: Block[] = []
    if (payload.table !== undefined) {
      blocks.push({
        kind: 'table',
        ...(payload.title === undefined ? {} : { title: payload.title }),
        columns: payload.table.columns,
        rows: payload.table.rows,
      })
    }
    if (payload.chart !== undefined || (payload.actions?.length ?? 0) > 0) {
      blocks.push({
        kind: 'card',
        title: payload.title ?? '',
        body: payload.chart === undefined ? '' : '（图表见桌面端）',
        ...(payload.actions === undefined ? {} : { actions: payload.actions }),
        ...(requestSeq === undefined ? {} : { requestSeq }),
      })
    }
    return blocks
  }
  if (slot === 'notification') {
    return [
      {
        kind: 'card',
        title: payload.title ?? '',
        body: payload.body ?? '',
        ...(payload.link === undefined ? {} : { fields: [['链接', payload.link]] }),
      },
    ]
  }
  if (slot === 'status.line') {
    return [{ kind: 'text', markdown: payload.text ?? '' }]
  }
  return []
}

export function whatToDraw(
  node: UINode,
  context: { costLine: boolean; artifactsUrl?: string; caps: ChannelCapabilities },
): ChannelMessage | null {
  switch (node.kind) {
    case 'user':
    case 'compaction':
      return null
    case 'assistant':
      // A node still streaming is not an answer yet; an empty one that stopped is an attempt whose
      // text was lost with its process, and a retry follows it.
      return node.streaming || node.text === '' ? null : { blocks: [{ kind: 'text', markdown: node.text }] }
    case 'tool': {
      const blocks: Block[] = [
        { kind: 'text', markdown: `⚙ ${node.name} · ${STATUS_LABEL[node.status] ?? node.status}` },
      ]
      for (const fill of node.slots ?? []) {
        if (fill.slot === 'tool.card.inline') {
          blocks.push(...slotBlocks(fill.slot, fill.payload, fill.requestSeq))
        }
      }
      return { blocks }
    }
    case 'approval':
      if (node.state === 'decided') {
        const verdict = node.decision?.verdict === 'rejected' ? '拒绝' : '批准'
        const by = node.decision?.byLabel === undefined ? '' : ` by ${node.decision.byLabel}`
        return { blocks: [{ kind: 'text', markdown: `已${verdict}${by}` }] }
      }
      if (node.state === 'expired') {
        return { blocks: [{ kind: 'text', markdown: '审批已超时' }] }
      }
      return {
        blocks: [
          {
            kind: 'approval',
            title: '需要审批',
            summary: node.summary,
            risk: node.risk,
            options: toAcpOptions(node.options),
            ...(node.ticket === undefined ? {} : { ticket: node.ticket }),
            ...(node.requestSeq === undefined ? {} : { requestSeq: node.requestSeq }),
            ...(node.expiresAt === undefined ? {} : { expiresAt: node.expiresAt }),
          },
        ],
      }
    case 'cost':
      return context.costLine
        ? { blocks: [{ kind: 'text', markdown: `本轮费用 ${node.credits ?? 0} credits` }] }
        : null
    case 'artifact': {
      const base = context.artifactsUrl?.replace(/\/+$/, '')
      return {
        blocks: [
          {
            kind: 'file',
            name: node.name,
            mime: node.ref.mime,
            ...(base === undefined ? {} : { url: `${base}/${node.ref.sha256}` }),
          },
        ],
      }
    }
    case 'slot': {
      const blocks = slotBlocks(node.fill.slot, node.fill.payload, node.fill.requestSeq)
      return blocks.length === 0 ? null : { blocks }
    }
    case 'context-sections':
    case 'contribute-conflict':
    case 'context':
      // Advisory diagnostic rows for /context, and harness-internal notices (hook notes, per-request
      // fact snapshots) riding the user/message channel -- neither is a message meant for a chat
      // surface's human audience, so this gets the same treatment as 'user'/'compaction' above: no
      // channel message for this node.
      return null
  }
}

export function contentHash(message: ChannelMessage): string {
  const normalized = {
    ...message,
    blocks: message.blocks.map((block) =>
      block.kind === 'file' && block.bytes !== undefined ? { ...block, bytes: block.bytes.length } : block,
    ),
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}
