import type { AssistantMessage, ContentBlock } from '@agnes/protocol'
import type { EnvelopeBuilder } from '../envelope.js'
import { type JsonlRow, sanitizeToolName, type Tolerance, textBlocks } from '../tolerance.js'
import { pathToLatestLeaf } from './tree.js'

type PiEntry = {
  type: string
  id?: string
  parentId?: string | null
  timestamp?: string
  cwd?: string
  message?: Record<string, unknown>
  summary?: string
  provider?: string
  modelId?: string
  thinkingLevel?: string
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const isEntry = (value: unknown): value is PiEntry => record(value) && typeof value.type === 'string'
const norm = (value: unknown): string =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[-_]/g, '')

export function readPiHeader(rows: JsonlRow[]): { sourceId: string; cwd: string } | null {
  const header = rows
    .map(({ value }) => value)
    .find(
      (value): value is PiEntry =>
        isEntry(value) && value.type === 'session' && typeof value.id === 'string' && value.id.length > 0,
    )
  return header ? { sourceId: header.id as string, cwd: header.cwd ?? '/' } : null
}

function userBlocks(content: unknown, report: Tolerance): ContentBlock[] {
  if (typeof content === 'string') return textBlocks(content)
  if (!Array.isArray(content)) return textBlocks('')
  const out: ContentBlock[] = []
  for (const block of content) {
    if (!record(block)) {
      report.unsupported('content:unknown')
      continue
    }
    if (block.type === 'text') out.push(...textBlocks(String(block.text ?? '')))
    else if (block.type === 'image' && typeof block.data === 'string')
      out.push({
        type: 'image',
        data: block.data,
        mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png',
      })
    else report.unsupported(`content:${String(block.type ?? 'unknown')}`)
  }
  return out.length > 0 ? out : textBlocks('')
}

function assistantParts(
  content: unknown,
  report: Tolerance,
): {
  messages: AssistantMessage['content']
  calls: Array<{ id: string; name: string; args: unknown }>
} {
  const values = Array.isArray(content)
    ? content
    : typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : []
  const messages: AssistantMessage['content'] = []
  const calls: Array<{ id: string; name: string; args: unknown }> = []
  for (const block of values) {
    if (!record(block)) {
      report.unsupported('content:unknown')
      continue
    }
    const kind = norm(block.type)
    if (kind === 'text') messages.push({ type: 'text', text: String(block.text ?? '') })
    else if (kind === 'thinking')
      messages.push({ type: 'thinking', text: String(block.thinking ?? block.text ?? '') })
    else if (kind === 'toolcall')
      calls.push({
        id: String(block.id ?? block.toolCallId ?? ''),
        name: String(block.name ?? ''),
        args: block.arguments ?? block.input ?? {},
      })
    else report.unsupported(`content:${String(block.type ?? 'unknown')}`)
  }
  return { messages, calls }
}

const stopReason = (source: unknown, hasCalls: boolean): AssistantMessage['stopReason'] => {
  if (hasCalls || norm(source) === 'tooluse') return 'tool_use'
  if (norm(source) === 'length' || norm(source) === 'maxtokens') return 'max_tokens'
  if (norm(source) === 'refusal') return 'refusal'
  if (norm(source) === 'error') return 'error'
  return 'end_turn'
}

export function importPi(rows: JsonlRow[], builder: EnvelopeBuilder, report: Tolerance): void {
  const nodes: Array<{ id: string; parentId: string | null; ts: number; node: PiEntry }> = []
  for (const { value } of rows) {
    if (!isEntry(value)) {
      report.unsupported('non-object')
      continue
    }
    if (value.type === 'session') continue
    if (!value.id) {
      report.unsupported(`${value.type}:missing-id`)
      continue
    }
    nodes.push({
      id: value.id,
      parentId: value.parentId ?? null,
      ts: Date.parse(value.timestamp ?? '') || 0,
      node: value,
    })
  }

  const unmapped: Record<string, number> = {}
  const unsupported = (kind: string): void => {
    report.unsupported(kind)
    unmapped[kind] = (unmapped[kind] ?? 0) + 1
  }
  for (const entry of pathToLatestLeaf(nodes, report).path) {
    if (entry.type === 'message') {
      const message = entry.message ?? {}
      const role = norm(message.role)
      if (role === 'user') builder.user(userBlocks(message.content, report), entry.timestamp)
      else if (role === 'assistant') {
        const converted = assistantParts(message.content, report)
        builder.assistant(
          converted.messages,
          stopReason(message.stopReason ?? message.stop_reason, converted.calls.length > 0),
          entry.timestamp,
        )
        for (const call of converted.calls)
          builder.toolCall(
            {
              toolUseId: call.id || `call-${builder.seq + 1}`,
              name: sanitizeToolName(call.name),
              args: call.args,
            },
            entry.timestamp,
          )
      } else if (role === 'toolresult' || role === 'tool') {
        const id = String(message.toolCallId ?? message.tool_call_id ?? '')
        const accepted = builder.toolResult(
          {
            toolUseId: id,
            content: userBlocks(message.content, report),
            isError: message.isError === true || message.is_error === true,
            ...(message.details !== undefined ? { structured: message.details } : {}),
          },
          entry.timestamp,
        )
        if (!accepted) report.repair(builder.seq + 1, `toolResult ${id || '<missing>'} without call`)
      } else unsupported(`message:${String(message.role ?? 'unknown')}`)
      continue
    }
    if (entry.type === 'compaction')
      builder.ext('compaction', { summary: String(entry.summary ?? ''), source: 'pi' }, entry.timestamp)
    else if (entry.type === 'branch_summary')
      builder.ext('branch-summary', { summary: String(entry.summary ?? '') }, entry.timestamp)
    else if (entry.type === 'model_change')
      builder.ext(
        'model-change',
        {
          ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
          ...(entry.modelId !== undefined ? { modelId: entry.modelId } : {}),
        },
        entry.timestamp,
      )
    else if (entry.type === 'thinking_level_change')
      builder.ext(
        'model-change',
        { ...(entry.thinkingLevel !== undefined ? { thinkingLevel: entry.thinkingLevel } : {}) },
        entry.timestamp,
      )
    else unsupported(entry.type)
  }
  if (Object.keys(unmapped).length > 0) builder.ext('unmapped', { source: 'pi', kinds: unmapped })
}
