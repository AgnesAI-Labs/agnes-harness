import type { EventEnvelope } from '@agnes/protocol'
import { toTranscript } from '../transcript.js'

const fence = (language: string, body: string): string => `\`\`\`${language}\n${body}\n\`\`\``

/** Converts a redacted Agnes ledger to the portable ShareGPT conversation document. */
export function exportShareGpt(
  events: EventEnvelope[],
  opts: { tools?: 'role' | 'inline'; id?: string } = {},
): Uint8Array {
  const mode = opts.tools ?? 'role'
  const transcript = toTranscript(events)
  const conversations: Array<{ from: 'system' | 'human' | 'gpt' | 'tool'; value: string }> = []
  for (const item of transcript.items) {
    switch (item.kind) {
      case 'user':
        conversations.push({
          from: 'human',
          value: item.images ? `${item.text}\n[${item.images} image(s) omitted]` : item.text,
        })
        break
      case 'assistant':
        conversations.push({
          from: 'gpt',
          value: [item.text, ...item.calls.map((call) => fence('tool_call', JSON.stringify(call)))]
            .filter(Boolean)
            .join('\n'),
        })
        break
      case 'tool': {
        const text = item.isError ? `[error] ${item.text}` : item.text
        conversations.push(
          mode === 'role'
            ? { from: 'tool', value: text }
            : {
                from: 'human',
                value: fence(
                  'tool_result',
                  JSON.stringify({ toolUseId: item.toolUseId, isError: item.isError, text: item.text }),
                ),
              },
        )
        break
      }
      case 'summary':
        conversations.push({ from: 'system', value: item.text })
        break
    }
  }
  return new TextEncoder().encode(
    `${JSON.stringify({ id: opts.id ?? transcript.sessionKey, conversations }, null, 2)}\n`,
  )
}
