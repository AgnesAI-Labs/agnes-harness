import type {
  AssistantMessage,
  ContentBlock,
  EventEnvelope,
  ToolCall,
  ToolResult,
  UserMessage,
} from '@agnes/protocol'

export type TranscriptItem =
  | { kind: 'user'; text: string; images: number; seq: number }
  | {
      kind: 'assistant'
      text: string
      thinking: string
      calls: Array<{ toolUseId: string; name: string; args: unknown }>
      seq: number
    }
  | { kind: 'tool'; toolUseId: string; text: string; isError: boolean; structured?: unknown; seq: number }
  | { kind: 'summary'; text: string; seq: number }

export type Transcript = { sessionKey: string; cwd: string; items: TranscriptItem[] }

const textOf = (blocks: ContentBlock[]): string =>
  blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')

/** Projects durable Agnes events into the small conversation shape shared by export formats. */
export function toTranscript(events: EventEnvelope[]): Transcript {
  let sessionKey = ''
  let cwd = '/'
  const items: TranscriptItem[] = []
  for (const event of events) {
    switch (event.type) {
      case 'session/start': {
        const data = event.data as { key: string; imported?: { cwd?: string } }
        sessionKey = data.key
        cwd = data.imported?.cwd ?? cwd
        break
      }
      case 'user/message': {
        const data = event.data as UserMessage
        // Hook notices and per-request fact snapshots ride this event type for ordering but were
        // never typed by the operator. Neither export format has a turn kind for a harness-internal
        // notice, and both treat every 'user' item as a real human turn, so this is left out of the
        // transcript entirely rather than fabricating one.
        if (data.kind === 'runtime_context') break
        items.push({
          kind: 'user',
          text: textOf(data.content),
          images: data.content.filter((block) => block.type === 'image').length,
          seq: event.seq,
        })
        break
      }
      case 'assistant/message': {
        const data = event.data as AssistantMessage
        const text = data.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
        const thinking = data.content
          .filter((block) => block.type === 'thinking')
          .map((block) => block.text)
          .join('')
        if (event.surfaceOp && event.surfaceOp !== 'append')
          items.push({ kind: 'summary', text, seq: event.seq })
        else items.push({ kind: 'assistant', text, thinking, calls: [], seq: event.seq })
        break
      }
      case 'tool/call': {
        const data = event.data as ToolCall
        const call = { toolUseId: data.toolUseId, name: data.name, args: data.args }
        const last = items.at(-1)
        if (last?.kind === 'assistant') last.calls.push(call)
        else items.push({ kind: 'assistant', text: '', thinking: '', calls: [call], seq: event.seq })
        break
      }
      case 'tool/result': {
        const data = event.data as ToolResult
        items.push({
          kind: 'tool',
          toolUseId: data.toolUseId,
          text: textOf(data.content),
          isError: data.isError,
          ...(data.structured !== undefined ? { structured: data.structured } : {}),
          seq: event.seq,
        })
        break
      }
      case 'x/agnes/import/compaction':
        items.push({
          kind: 'summary',
          text: String((event.data as { summary?: string }).summary ?? ''),
          seq: event.seq,
        })
        break
      default:
        break
    }
  }
  return { sessionKey, cwd, items }
}
