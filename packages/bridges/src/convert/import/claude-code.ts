import type { AssistantMessage, ContentBlock } from '@agnes/protocol'
import type { EnvelopeBuilder } from '../envelope.js'
import { type JsonlRow, sanitizeToolName, type Tolerance, textBlocks } from '../tolerance.js'
import { pathToLatestLeaf } from './tree.js'

type ClaudeRow = {
  type: string
  uuid?: string
  parentUuid?: string | null
  isSidechain?: boolean
  timestamp?: string
  cwd?: string
  sessionId?: string
  message?: { role?: string; content?: unknown; stop_reason?: string }
  toolUseResult?: unknown
  summary?: string
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const isClaudeRow = (value: unknown): value is ClaudeRow => record(value) && typeof value.type === 'string'

export function readClaudeCodeHeader(rows: JsonlRow[]): { sourceId: string; cwd: string } | null {
  const row = rows
    .map(({ value }) => value)
    .find(
      (value): value is ClaudeRow =>
        isClaudeRow(value) &&
        value.type === 'user' &&
        value.isSidechain !== true &&
        typeof value.sessionId === 'string' &&
        value.sessionId.length > 0,
    )
  return row ? { sourceId: row.sessionId as string, cwd: row.cwd ?? '/' } : null
}

type Parts = {
  user: ContentBlock[]
  assistant: AssistantMessage['content']
  toolUses: Array<{ id: string; name: string; input: unknown }>
  toolResults: Array<{ id: string; content: ContentBlock[]; isError: boolean }>
}

function parts(content: unknown, report: Tolerance): Parts {
  const out: Parts = { user: [], assistant: [], toolUses: [], toolResults: [] }
  if (typeof content === 'string') {
    out.user.push(...textBlocks(content))
    out.assistant.push({ type: 'text', text: content })
    return out
  }
  if (!Array.isArray(content)) return out
  for (const value of content) {
    if (!record(value) || typeof value.type !== 'string') {
      report.unsupported('content:unknown')
      continue
    }
    if (value.type === 'text') {
      const text = String(value.text ?? '')
      out.user.push(...textBlocks(text))
      out.assistant.push({ type: 'text', text })
    } else if (value.type === 'thinking') {
      out.assistant.push({ type: 'thinking', text: String(value.thinking ?? value.text ?? '') })
    } else if (value.type === 'image') {
      const source = record(value.source) ? value.source : undefined
      if (typeof source?.data === 'string')
        out.user.push({
          type: 'image',
          data: source.data,
          mimeType: typeof source.media_type === 'string' ? source.media_type : 'image/png',
        })
      else if (typeof source?.url === 'string') out.user.push({ type: 'resource_link', uri: source.url })
      else report.unsupported('content:image')
    } else if (value.type === 'tool_use') {
      out.toolUses.push({
        id: String(value.id ?? ''),
        name: String(value.name ?? ''),
        input: value.input ?? {},
      })
    } else if (value.type === 'tool_result') {
      const toolContent = value.content
      const blocks: ContentBlock[] = []
      if (typeof toolContent === 'string') blocks.push(...textBlocks(toolContent))
      else if (Array.isArray(toolContent)) {
        for (const block of toolContent) {
          if (record(block) && block.type === 'text') blocks.push(...textBlocks(String(block.text ?? '')))
          else if (record(block) && block.type === 'image' && record(block.source)) {
            const source = block.source
            if (typeof source.data === 'string')
              blocks.push({
                type: 'image',
                data: source.data,
                mimeType: typeof source.media_type === 'string' ? source.media_type : 'image/png',
              })
          }
        }
      }
      out.toolResults.push({
        id: String(value.tool_use_id ?? ''),
        content: blocks,
        isError: value.is_error === true,
      })
    } else report.unsupported(`content:${value.type}`)
  }
  return out
}

const stopReason = (source: string | undefined, hasTools: boolean): AssistantMessage['stopReason'] => {
  if (hasTools || source === 'tool_use') return 'tool_use'
  if (source === 'max_tokens') return 'max_tokens'
  if (source === 'refusal') return 'refusal'
  if (source === 'error') return 'error'
  return 'end_turn'
}

export function importClaudeCode(rows: JsonlRow[], builder: EnvelopeBuilder, report: Tolerance): void {
  const main: Array<{
    id: string
    parentId: string | null
    ts: number
    node: ClaudeRow
  }> = []
  const summaries: ClaudeRow[] = []
  const sideIds = new Set<string>()
  const sideRows: ClaudeRow[] = []
  const unmapped: Record<string, number> = {}
  const unsupported = (kind: string): void => {
    report.unsupported(kind)
    unmapped[kind] = (unmapped[kind] ?? 0) + 1
  }

  for (const { value } of rows) {
    if (!isClaudeRow(value)) {
      unsupported('non-object')
      continue
    }
    if (value.isSidechain === true) {
      sideRows.push(value)
      if (value.uuid) sideIds.add(value.uuid)
      continue
    }
    if (value.type === 'summary') {
      summaries.push(value)
      continue
    }
    if (value.type !== 'user' && value.type !== 'assistant') {
      unsupported(value.type)
      continue
    }
    if (!value.uuid) {
      unsupported('missing-uuid')
      continue
    }
    main.push({
      id: value.uuid,
      parentId: value.parentUuid ?? null,
      ts: Date.parse(value.timestamp ?? '') || 0,
      node: value,
    })
  }

  for (const row of sideRows) if (!row.parentUuid || !sideIds.has(row.parentUuid)) report.dropBranch()

  for (const row of pathToLatestLeaf(main, report).path) {
    const content = parts(row.message?.content, report)
    if (row.type === 'user') {
      for (const result of content.toolResults) {
        const accepted = builder.toolResult(
          {
            toolUseId: result.id,
            content: result.content,
            isError: result.isError,
            ...(row.toolUseResult !== undefined ? { structured: row.toolUseResult } : {}),
          },
          row.timestamp,
        )
        if (!accepted) report.repair(builder.seq + 1, `tool_result ${result.id || '<missing>'} without call`)
      }
      if (content.user.length > 0) builder.user(content.user, row.timestamp)
      continue
    }
    builder.assistant(
      content.assistant,
      stopReason(row.message?.stop_reason, content.toolUses.length > 0),
      row.timestamp,
    )
    for (const call of content.toolUses)
      builder.toolCall(
        {
          toolUseId: call.id || `call-${builder.seq + 1}`,
          name: sanitizeToolName(call.name),
          args: call.input,
        },
        row.timestamp,
      )
  }
  for (const summary of summaries)
    builder.ext(
      'compaction',
      { summary: String(summary.summary ?? ''), source: 'claude-code' },
      summary.timestamp,
    )
  if (Object.keys(unmapped).length > 0) builder.ext('unmapped', { source: 'claude-code', kinds: unmapped })
}
