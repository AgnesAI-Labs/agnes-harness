import type { AssistantMessage, ContentBlock } from '@agnes/protocol'
import type { EnvelopeBuilder } from '../envelope.js'
import { type JsonlRow, sanitizeToolName, type Tolerance, textBlocks } from '../tolerance.js'

type CodexLine = {
  id?: string
  instructions?: unknown
  timestamp?: string
  type?: string
  record_type?: string
  payload?: Record<string, unknown>
  [key: string]: unknown
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const isLine = (value: unknown): value is CodexLine => record(value)
const norm = (value: unknown): string =>
  String(value ?? '')
    .toLowerCase()
    .replace(/-/g, '_')

export function readCodexHeader(
  rows: JsonlRow[],
): { sourceId: string; cwd: string; forkedFrom?: string } | null {
  const line = rows
    .map(({ value }) => value)
    .find((value): value is CodexLine => isLine(value) && norm(value.type) === 'session_meta')
  const legacy = rows
    .map(({ value }) => value)
    .find(
      (value): value is CodexLine =>
        isLine(value) &&
        value.type === undefined &&
        typeof value.id === 'string' &&
        typeof value.timestamp === 'string',
    )
  const meta = line?.payload ?? legacy
  if (!meta) return null
  const sourceId = meta.session_id ?? meta.id
  if (typeof sourceId !== 'string' || sourceId.length === 0) return null
  const forked = meta.forked_from_id ?? meta.parent_thread_id
  return {
    sourceId,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : '/',
    ...(typeof forked === 'string' && forked.length > 0 ? { forkedFrom: forked } : {}),
  }
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .filter(record)
    .map((part) => part.text ?? part.content ?? part.summary_text ?? '')
    .filter((part): part is string => typeof part === 'string')
    .join('')
}

function outputBlocks(value: unknown): ContentBlock[] {
  if (typeof value === 'string') return textBlocks(value)
  if (Array.isArray(value)) {
    const text = textOf(value)
    if (text.length > 0) return textBlocks(text)
  }
  return textBlocks(value === undefined ? '' : JSON.stringify(value))
}

function callArgs(value: unknown, report: Tolerance, seq: number): unknown {
  if (typeof value !== 'string') return value ?? {}
  try {
    return JSON.parse(value) as unknown
  } catch {
    report.repair(seq, 'invalid function-call arguments kept as raw text')
    return { raw: value }
  }
}

const itemStopReason = (payload: Record<string, unknown>): AssistantMessage['stopReason'] => {
  const reason = norm(payload.stop_reason)
  if (reason === 'max_tokens' || reason === 'length') return 'max_tokens'
  if (reason === 'refusal') return 'refusal'
  if (reason === 'error') return 'error'
  return 'end_turn'
}

export function importCodex(rows: JsonlRow[], builder: EnvelopeBuilder, report: Tolerance): void {
  const header = readCodexHeader(rows)
  if (header?.forkedFrom) builder.ext('origin', { forkedFrom: header.forkedFrom })
  const pendingThinking: string[] = []
  let callStepOpen = false
  const unmapped: Record<string, number> = {}
  const unsupported = (kind: string): void => {
    report.unsupported(kind)
    unmapped[kind] = (unmapped[kind] ?? 0) + 1
  }
  const takeThinking = (): AssistantMessage['content'] => {
    const content = pendingThinking.splice(0).map((text) => ({ type: 'thinking' as const, text }))
    return content
  }

  for (const { value } of rows) {
    if (!isLine(value)) {
      unsupported('non-object')
      continue
    }
    const kind = norm(value.type)
    if (kind.length === 0 && typeof value.id === 'string' && typeof value.timestamp === 'string') continue
    if (kind.length === 0 && value.record_type !== undefined) {
      unsupported(norm(value.record_type) || 'record')
      continue
    }
    const directItem =
      kind === 'message' ||
      kind === 'agent_message' ||
      kind === 'reasoning' ||
      kind === 'function_call' ||
      kind === 'function_call_output' ||
      kind === 'local_shell_call' ||
      kind === 'tool_search_call' ||
      kind === 'custom_tool_call' ||
      kind === 'custom_tool_call_output'
    const payload = directItem ? value : (value.payload ?? {})
    if (kind === 'session_meta') continue
    if (kind === 'turn_context') {
      builder.ext('turn-context', payload, value.timestamp)
      continue
    }
    if (kind === 'token_usage_record') {
      builder.ext('usage', payload, value.timestamp)
      continue
    }
    if (kind === 'compacted') {
      builder.ext(
        'compaction',
        { summary: textOf(payload.message ?? payload.summary), source: 'codex' },
        value.timestamp,
      )
      continue
    }
    if (kind !== 'response_item' && !directItem) {
      unsupported(kind || 'unknown')
      continue
    }

    const item = directItem ? kind : norm(payload.type)
    if (item === 'reasoning') {
      pendingThinking.push(textOf(payload.summary ?? payload.content))
      continue
    }
    if (item === 'message' || item === 'agent_message') {
      const text = textOf(payload.content ?? payload.message)
      if (payload.role === 'user') builder.user(textBlocks(text), value.timestamp)
      else if (payload.role === 'assistant' || item === 'agent_message')
        builder.assistant(
          [...takeThinking(), { type: 'text', text }],
          itemStopReason(payload),
          value.timestamp,
        )
      else {
        unsupported(`response_item:message:${String(payload.role ?? 'unknown')}`)
        continue
      }
      callStepOpen = false
      continue
    }
    if (
      item === 'function_call' ||
      item === 'local_shell_call' ||
      item === 'tool_search_call' ||
      item === 'custom_tool_call'
    ) {
      if (!callStepOpen) {
        builder.assistant(takeThinking(), 'tool_use', value.timestamp)
        callStepOpen = true
      }
      const defaultName = item === 'local_shell_call' ? 'local_shell' : item
      const rawArgs =
        item === 'local_shell_call'
          ? (payload.action ?? {})
          : item === 'function_call'
            ? callArgs(payload.arguments, report, builder.seq + 1)
            : (payload.input ?? payload.arguments ?? {})
      builder.toolCall(
        {
          toolUseId: String(payload.call_id ?? payload.id ?? `call-${builder.seq + 1}`),
          name: sanitizeToolName(String(payload.name ?? defaultName)),
          args: rawArgs,
        },
        value.timestamp,
      )
      continue
    }
    if (item === 'function_call_output' || item === 'custom_tool_call_output') {
      const id = String(payload.call_id ?? payload.id ?? '')
      const output = payload.output ?? payload.content
      const accepted = builder.toolResult(
        {
          toolUseId: id,
          content: outputBlocks(output),
          isError: payload.is_error === true || norm(payload.status) === 'failed',
          ...(typeof output === 'object' && output !== null ? { structured: output } : {}),
        },
        value.timestamp,
      )
      if (!accepted) report.repair(builder.seq + 1, `function_call_output ${id || '<missing>'} without call`)
      continue
    }
    unsupported(`response_item:${item || 'unknown'}`)
  }

  if (pendingThinking.length > 0) builder.assistant(takeThinking(), 'end_turn')
  if (Object.keys(unmapped).length > 0) builder.ext('unmapped', { source: 'codex', kinds: unmapped })
}
