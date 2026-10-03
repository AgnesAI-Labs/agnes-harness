import { canonicalJson } from '../request/hash.js'

// The one-line header an approver sees for a tool call. It names the call and the fields that decide
// what it touches, and it never cuts text silently: every shortened value says how much of it is
// shown. The arguments themselves travel with the request, so this line is a locator, not a copy.

/** Fields that say what a call acts on, in the order they lead the line. */
const IDENTITY = ['path', 'file_path', 'command', 'url', 'pattern', 'query'] as const
const COMMAND_MAX = 160
const IDENTITY_MAX = 240
const FIELD_MAX = 80
/** Total characters the remaining fields may add before the rest are only counted. */
const REST_MAX = 200
const FALLBACK_MAX = 200
/** Fields whose value is replaced by its size: the body is neither a locator nor header material. */
const BODY: Record<string, readonly string[]> = { write: ['content'], edit: ['edits'] }

/** Cuts at a code-point boundary and says how much was kept. */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…[showing ${end} of ${text.length} chars]`
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function sizeOf(tool: string, args: Record<string, unknown>): string {
  if (tool === 'write' && typeof args.content === 'string') return ` (${args.content.length} chars)`
  if (tool === 'edit' && Array.isArray(args.edits))
    return ` (${args.edits.length} edit${args.edits.length === 1 ? '' : 's'})`
  return ''
}

export function summarizeCall(name: string, args: unknown): string {
  if (!isObject(args)) return `${name} ${shorten(canonicalJson(args), FALLBACK_MAX)}`
  const body = BODY[name] ?? []
  const parts: string[] = []
  let first = true
  for (const key of IDENTITY) {
    const value = args[key]
    if (typeof value !== 'string') continue
    // Whitespace is folded so a multi-line script reads as one line; the count is of the folded text.
    const text = shorten(value.replace(/\s+/g, ' ').trim(), key === 'command' ? COMMAND_MAX : IDENTITY_MAX)
    parts.push(first ? text : `${key}=${JSON.stringify(text)}`)
    first = false
  }
  let used = 0
  let hidden = 0
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || body.includes(key)) continue
    if ((IDENTITY as readonly string[]).includes(key) && typeof value === 'string') continue
    const piece = `${key}=${shorten(canonicalJson(value), FIELD_MAX)}`
    if (used + piece.length > REST_MAX) hidden += 1
    else {
      parts.push(piece)
      used += piece.length + 1
    }
  }
  if (hidden > 0) parts.push(`…[${hidden} more field${hidden === 1 ? '' : 's'} not shown]`)
  return `${name} ${parts.join(' ')}${sizeOf(name, args)}`.trimEnd()
}
