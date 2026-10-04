// The default text presentation of a domain view no registered renderer presents, for the tui, sdk and
// im targets. It is the text sibling of the generic Web card and shows the same information in the same
// order: status, fallback text, resources, then actions. Both functions are pure and import nothing at
// runtime, so they run unchanged in browsers. View data becomes plain text
// parts, never markup, with control characters replaced and format characters (bidirectional controls
// among them) removed so a terminal or chat cannot run them as escapes or reorder the text. Actions are
// referenced only by their keys. An enabled action that needs a feature the client did not negotiate is
// shown but not offered, and the result is marked incomplete so the consumer can send the user to the
// Web client.
import type {
  DomainView,
  FormattedView,
  IMRendererEncodeChannel,
  IMRendererEncodeResult,
  RuntimeError,
  TextPart,
  TextRendererFormatContext,
} from '@agnes/protocol/runtime'

type Outcome<T> = { ok: true; value: T } | { ok: false; error: RuntimeError }

const PHASES: Record<string, string> = {
  provisional: 'In progress',
  finalized: 'Final',
  interrupted: 'Interrupted, may be incomplete',
}
const ACTION_KINDS: readonly unknown[] = ['command', 'interaction', 'download', 'open-form']
const UNAVAILABLE = 'Not available here.'
// The DomainView schema holds at most 32 resources and 32 actions.
const MAX_ITEMS = 32
// The IMRendererEncodeResult schema holds at most this many messages.
const MAX_MESSAGES = 10_000
// One code point takes up to four UTF-8 bytes, so a smaller limit cannot carry every character.
const MIN_TEXT_BYTES = 4

const refuse = (detailCode: string, message: string): { ok: false; error: RuntimeError } => ({
  ok: false,
  error: {
    code: 'invalid_input',
    detailCode,
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'sdk-text-format',
  },
})

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

/**
 * View text as plain text: format characters are removed, line breaks become `\n` and every other
 * control character but tab is replaced. The zero width joiner stays, so emoji sequences hold together.
 */
const plain = (text: string) =>
  text
    .replace(/(?!\u200D)\p{Cf}/gu, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(?![\n\t])\p{Cc}/gu, '�')

/** UTF-8 bytes of one code point. A lone surrogate is sent as U+FFFD, which also takes three. */
function width(char: string): number {
  const code = char.codePointAt(0) ?? 0
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
}

function utf8Length(text: string): number {
  let total = 0
  for (const char of text) total += width(char)
  return total
}

/** `text` cut on code point boundaries into pieces of at most `limit` UTF-8 bytes. */
function chunks(text: string, limit: number): string[] {
  const pieces: string[] = []
  let start = 0
  let end = 0
  let bytes = 0
  for (const char of text) {
    if (bytes + width(char) > limit) {
      pieces.push(text.slice(start, end))
      start = end
      bytes = 0
    }
    bytes += width(char)
    end += char.length
  }
  pieces.push(text.slice(start))
  return pieces
}

const validPart = (part: unknown): part is TextPart =>
  record(part) &&
  ((part.kind === 'text' && typeof part.text === 'string') ||
    (part.kind === 'action' && typeof part.actionKey === 'string' && typeof part.label === 'string'))

export function formatDomainView(
  view: DomainView,
  context: Readonly<TextRendererFormatContext>,
): Outcome<FormattedView> {
  const value: unknown = view
  if (
    !record(value) ||
    value.kind !== 'domain' ||
    typeof value.viewId !== 'string' ||
    typeof value.revision !== 'number' ||
    !Number.isFinite(value.revision)
  )
    return refuse('not_a_view', 'the input is not a domain view')
  // A context without a feature list negotiated nothing, so every required feature is missing.
  const features: unknown = context?.capabilities?.features
  const negotiated = new Set(strings(features) ? features : [])
  const unsupported = new Set<string>()
  let complete = true
  const parts: TextPart[] = []
  const text = (line: string) => parts.push({ kind: 'text', text: plain(line) })
  /** The readable entries of a view list; a missing or overlong list makes the result incomplete. */
  const entries = (list: unknown): unknown[] => {
    if (!Array.isArray(list) || list.length > MAX_ITEMS) complete = false
    return Array.isArray(list) ? list.slice(0, MAX_ITEMS) : []
  }

  const phase =
    typeof value.phase === 'string' && Object.hasOwn(PHASES, value.phase) ? PHASES[value.phase] : undefined
  if (phase === undefined) complete = false
  text(`Status: ${phase ?? 'Unknown'}`)

  if (typeof value.fallbackText !== 'string') complete = false
  else if (value.fallbackText !== '') text(value.fallbackText)

  const titles: string[] = []
  for (const resource of entries(value.resources)) {
    const title = record(resource) ? (resource.title ?? resource.artifactId) : undefined
    if (typeof title === 'string') titles.push(title)
    else complete = false
  }
  if (titles.length > 0) {
    text('Resources:')
    for (const title of titles) text(`- ${title}`)
  }

  const actions: TextPart[] = []
  for (const action of entries(value.actions)) {
    if (!record(action) || typeof action.label !== 'string') {
      complete = false
      continue
    }
    const readable =
      ACTION_KINDS.includes(action.kind) &&
      typeof action.actionKey === 'string' &&
      (action.availability === 'enabled' || action.availability === 'disabled') &&
      strings(action.requiredFeatures) &&
      (action.disabledReason === null || typeof action.disabledReason === 'string')
    if (!readable) complete = false
    // Only an enabled action requires anything of this client; a disabled one is shown, never offered.
    const missing =
      readable && action.availability === 'enabled'
        ? (action.requiredFeatures as string[]).filter((feature) => !negotiated.has(feature))
        : []
    for (const feature of missing) unsupported.add(feature)
    if (readable && action.availability === 'enabled' && missing.length === 0)
      actions.push({ kind: 'action', actionKey: action.actionKey as string, label: plain(action.label) })
    else {
      const reason =
        readable && action.availability === 'disabled' ? (action.disabledReason as string | null) : null
      actions.push({ kind: 'text', text: plain(`${action.label}: ${reason ?? UNAVAILABLE}`) })
    }
  }
  if (actions.length > 0) {
    text('Actions:')
    parts.push(...actions)
  }

  return {
    ok: true,
    value: {
      viewId: value.viewId,
      revision: value.revision,
      parts,
      complete: complete && unsupported.size === 0,
      unsupportedRequiredFeatures: [...unsupported],
    },
  }
}

type Draft = { lines: string[]; bytes: number; actionKeys: string[] }

/**
 * Splits a formatted view into channel messages of at most `maxTextBytes` UTF-8 bytes each. Parts are
 * joined by newlines and a part longer than the limit is cut on code point boundaries. With buttons an
 * action part adds its key to the message it falls in; without them its label is sent as text. Messages
 * are numbered from 0.
 */
export function encodeForChannel(
  formatted: FormattedView,
  channel: Readonly<IMRendererEncodeChannel>,
): Outcome<IMRendererEncodeResult> {
  const limit: unknown = channel?.maxTextBytes
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < MIN_TEXT_BYTES)
    return refuse('invalid_limit', `the channel text limit must be an integer of at least ${MIN_TEXT_BYTES}`)
  const parts: unknown = formatted?.parts
  if (!Array.isArray(parts) || !parts.every(validPart))
    return refuse('invalid_formatted_view', 'the formatted view is malformed')
  const buttons = channel.supportsButtons === true
  const drafts: Draft[] = []

  const add = (line: string) => {
    const last = drafts.at(-1)
    const size = utf8Length(line)
    if (last !== undefined && last.lines.length > 0 && last.bytes + 1 + size <= limit) {
      last.lines.push(line)
      last.bytes += 1 + size
      return
    }
    for (const piece of chunks(line, limit)) {
      let open = drafts.at(-1)
      // A message that so far holds only buttons takes the first piece of text.
      if (open === undefined || open.lines.length > 0) {
        open = { lines: [], bytes: 0, actionKeys: [] }
        drafts.push(open)
      }
      open.lines.push(piece)
      open.bytes = utf8Length(piece)
    }
  }

  for (const part of parts) {
    if (part.kind === 'text') add(part.text)
    else if (!buttons) add(part.label)
    else {
      let open = drafts.at(-1)
      if (open === undefined) {
        open = { lines: [], bytes: 0, actionKeys: [] }
        drafts.push(open)
      }
      open.actionKeys.push(part.actionKey)
    }
  }
  if (drafts.length > MAX_MESSAGES) return refuse('too_many_messages', 'the view needs too many messages')

  const complete = formatted.complete === true
  return {
    ok: true,
    value: {
      messages: drafts.map((draft, partIndex) => ({
        text: draft.lines.join('\n'),
        actionKeys: draft.actionKeys,
        partIndex,
        partCount: drafts.length,
      })),
      complete,
      requiresWebForm: !complete,
    },
  }
}
