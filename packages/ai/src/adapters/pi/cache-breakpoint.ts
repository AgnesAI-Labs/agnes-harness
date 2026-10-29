import type { RequestBody } from '@agnes/protocol'

type Json = Record<string, unknown>
type Block = Json & { type?: unknown; text?: unknown }
type Message = Json & { role?: unknown; content?: unknown }

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block: Block) => (typeof block?.text === 'string' ? block.text : '')).join('')
}

/** Anthropic block types that may carry `cache_control` in a conversation message. */
const ANTHROPIC_MARKABLE = new Set(['text', 'image', 'tool_result', 'tool_use', 'document'])

type Marks = {
  /** Removes the marks from one message, returning the first one found. */
  take(message: Message): unknown
  /** Puts the mark on one message; false when the message has no block that can carry it. */
  put(message: Message, mark: unknown): boolean
}

const anthropic: Marks = {
  take(message) {
    let found: unknown
    for (const block of Array.isArray(message.content) ? (message.content as Block[]) : []) {
      if (!isObject(block) || block.cache_control === undefined) continue
      found ??= block.cache_control
      delete block.cache_control
    }
    return found
  },
  put(message, mark) {
    if (typeof message.content === 'string') {
      if (!message.content) return false
      message.content = [{ type: 'text', text: message.content, cache_control: mark }]
      return true
    }
    const last = Array.isArray(message.content) ? (message.content as Block[]).at(-1) : undefined
    if (!isObject(last) || !ANTHROPIC_MARKABLE.has(String(last.type))) return false
    last.cache_control = mark
    return true
  },
}

/** OpenAI-compatible chat with Anthropic-style marks (an OpenRouter Claude model): text parts only. */
const completions: Marks = {
  take: anthropic.take,
  put(message, mark) {
    if (!['user', 'assistant', 'tool'].includes(String(message.role))) return false
    if (typeof message.content === 'string') return anthropic.put(message, mark)
    const parts = Array.isArray(message.content) ? (message.content as Block[]) : []
    const text = parts.findLast((part) => isObject(part) && part.type === 'text')
    if (!text) return false
    text.cache_control = mark
    return true
  },
}

/** Bedrock Converse: a `cachePoint` block at the end of a user message. */
const bedrock: Marks = {
  take(message) {
    if (!Array.isArray(message.content)) return undefined
    const isMark = (block: unknown) => isObject(block) && block.cachePoint !== undefined
    const mark = (message.content as unknown[]).find(isMark)
    if (mark !== undefined) message.content = (message.content as unknown[]).filter((block) => !isMark(block))
    return mark
  },
  put(message, mark) {
    if (message.role !== 'user' || !Array.isArray(message.content)) return false
    message.content.push(mark)
    return true
  },
}

const MARKS: Readonly<Record<string, Marks>> = {
  'anthropic-messages': anthropic,
  'openai-completions': completions,
  'bedrock-converse-stream': bedrock,
}

/**
 * These wire libraries mark a prompt-cache breakpoint on the request's last message, and a cache
 * entry is only written at a breakpoint. When the last messages are for this request only (a
 * timed turn's measured time, a loop's uncommitted note), an entry written there is never matched
 * again, because the next request carries different ones; every request of such a turn would
 * rewrite the whole conversation's cache. So the mark moves to the last message of the history
 * before them, which the next request repeats unchanged. The provider payload is changed in place,
 * and only when its trailing messages are exactly the request-only ones the request names; anything
 * else is left as the library built it.
 */
export function keepCacheBreakpointOnHistory(api: string, payload: unknown, req: RequestBody): void {
  const marks = MARKS[api]
  const count = req.requestOnlyMessages ?? 0
  if (!marks || count < 1 || !isObject(payload) || !Array.isArray(payload.messages)) return
  const messages = payload.messages as Message[]
  const own = req.messages.slice(-count)
  const tail = messages.slice(-count)
  if (own.length !== count || tail.length !== count || messages.length <= count) return
  for (const [i, message] of tail.entries()) {
    const wire = own[i]
    if (!isObject(message) || message.role !== 'user' || wire?.role !== 'user') return
    if (textOf(message.content) !== textOf(wire.content)) return
  }
  let mark: unknown
  for (const message of tail) mark = marks.take(message) ?? mark
  if (mark === undefined) return
  for (let i = messages.length - count - 1; i >= 0; i--) {
    const message = messages[i]
    if (isObject(message) && marks.put(message, mark)) return
  }
}
