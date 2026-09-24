import type { EventEnvelope } from '@agnes/protocol'
import { toTranscript } from '../transcript.js'

type ClaudeRow = Record<string, unknown>

/** Converts a redacted Agnes ledger to Claude Code's transcript JSONL shape. */
export function exportClaudeCode(
  events: EventEnvelope[],
  opts: { cwd?: string; version?: string } = {},
): Uint8Array {
  const transcript = toTranscript(events)
  const timestamps = new Map(events.map((event) => [event.seq, event.ts]))
  const ids = new Map(events.map((event) => [event.seq, event.id]))
  const cwd = opts.cwd ?? transcript.cwd
  const version = opts.version ?? 'agnes-export'
  const rows: ClaudeRow[] = []
  let parentUuid: string | null = null
  let leafUuid: string | null = null
  const base = (seq: number) => ({
    uuid: ids.get(seq) ?? `seq-${seq}`,
    parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd,
    sessionId: transcript.sessionKey,
    version,
    timestamp: timestamps.get(seq) ?? new Date(0).toISOString(),
  })
  const push = (row: ClaudeRow): void => {
    rows.push(row)
    parentUuid = String(row.uuid)
    leafUuid = parentUuid
  }

  for (const item of transcript.items) {
    switch (item.kind) {
      case 'user':
        push({ type: 'user', ...base(item.seq), message: { role: 'user', content: item.text } })
        break
      case 'assistant': {
        const content: ClaudeRow[] = []
        if (item.thinking) content.push({ type: 'thinking', thinking: item.thinking })
        if (item.text) content.push({ type: 'text', text: item.text })
        for (const call of item.calls)
          content.push({ type: 'tool_use', id: call.toolUseId, name: call.name, input: call.args ?? {} })
        push({
          type: 'assistant',
          ...base(item.seq),
          message: {
            role: 'assistant',
            model: 'agnes',
            stop_reason: item.calls.length ? 'tool_use' : 'end_turn',
            content,
          },
        })
        break
      }
      case 'tool':
        push({
          type: 'user',
          ...base(item.seq),
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: item.toolUseId,
                content: item.text,
                is_error: item.isError,
              },
            ],
          },
          ...(item.structured !== undefined ? { toolUseResult: item.structured } : {}),
        })
        break
      case 'summary':
        rows.push({ type: 'summary', summary: item.text, leafUuid })
        break
    }
  }
  const text = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : ''
  return new TextEncoder().encode(text)
}
