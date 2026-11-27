import { applicationWorkText, type EventEnvelope } from '@agnes/protocol'

/** A short label from the first visible user input, without opening a conversation. */
export function sidebarPromptTitle(events: readonly EventEnvelope[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'user/message' || sidebarMessageTime(event) === undefined) continue
    const { content } = event.data as { content: { type: string; text?: string }[] }
    const text = content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    const display = applicationWorkText(text).text
    return display.trim() ? Array.from(display).slice(0, 56).join('') : undefined
  }
  return undefined
}

/** Mirrors the visible-message cases in Core's UI projection, without depending on its private state. */
export function sidebarMessageTime(event: EventEnvelope): number | undefined {
  if ((event.lane ?? 'main') !== 'main' || event.surfaceOp) return undefined
  const data = event.data as {
    kind?: string
    state?: string
    content?: { type?: string; text?: string }[]
  } | null
  if (!data || !Array.isArray(data.content)) return undefined
  const user = event.type === 'user/message' && data.kind !== 'runtime_context'
  const assistant =
    event.type === 'assistant/message' || (event.type === 'assistant/output' && data.state === 'interrupted')
  if (!user && !assistant) return undefined
  if (
    !data.content.some((block) =>
      block.type === 'text'
        ? typeof block.text === 'string' && block.text.trim().length > 0
        : user && ['image', 'audio', 'resource', 'resource_link'].includes(block.type ?? ''),
    )
  )
    return undefined
  const value = Date.parse(event.ts)
  return Number.isFinite(value) ? value : undefined
}
