// The reference's dedicated renderer for its slide outline view, on every target. The view it renders:
//
//   viewSchema  reference.outline/view@1, render key `reference.outline`
//   data        { title: string, revision: number, slides: { heading: string, points: string[] }[] }
//
// `revision` is the domain state revision the outline was read at; Web commands send it as their
// expected revision. Text and IM output come from this data, never from the view's fallback text. A
// data field this renderer does not know, an action feature the client did not negotiate, or text past
// the client's display limit makes the result incomplete, so a generic consumer can send the user to
// the Web view. format and encode are pure: they send no request, read no credential and change no
// state.
//
// The browser entry reaches no package, so the shapes used here are mirrored; the Node compile check
// in test/client-entry.compile.tsx assigns these definitions to the generated renderer types.
import { PHASE_MARKS, ReferenceOutline, readOutline, type View } from './presentation-renderer.js'
import type { Descriptor } from './ui-registry.js'

export const OUTLINE_VIEW_TYPE = 'reference.outline/view@1'
export const OUTLINE_RENDER_KEY = 'reference.outline'

// A descriptor names the digest of its published package, which exists only once a package is built
// and published. The reference is never published, so its descriptors carry this all-zero digest that
// names no package; an installer that checks descriptors against a package must refuse it.
export const UNPUBLISHED_PACKAGE_DIGEST = '0'.repeat(64)

// ponytail: a fixed cap keeps a long outline from flooding a chat; take it from the channel once the
// channel reports one.
const MAX_MESSAGES = 10

type TextPart = { kind: 'text'; text: string } | { kind: 'action'; actionKey: string; label: string }

interface Formatted {
  viewId: string
  revision: number
  parts: TextPart[]
  complete: boolean
  unsupportedRequiredFeatures: string[]
}

interface FormatContext {
  locale: string
  capabilities: { features: string[]; display: { maxTextBytes: number } }
}

interface Channel {
  kind: string
  maxTextBytes: number
  supportsButtons: boolean
}

interface Encoded {
  messages: { text: string; actionKeys: string[]; partIndex: number; partCount: number }[]
  complete: boolean
  requiresWebForm: boolean
}

/** UTF-8 length of one code point; a lone surrogate is encoded as U+FFFD, three bytes. */
function bytesOf(char: string): number {
  const code = char.codePointAt(0) ?? 0
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
}

const utf8Length = (text: string) => [...text].reduce((total, char) => total + bytesOf(char), 0)

/** `text` cut between code points into chunks of at most `max` UTF-8 bytes; undefined if one cannot fit. */
function split(text: string, max: number): string[] | undefined {
  const chunks: string[] = []
  let chunk = ''
  let size = 0
  for (const char of text) {
    const bytes = bytesOf(char)
    if (!(bytes <= max)) return undefined
    if (size + bytes > max) {
      chunks.push(chunk)
      chunk = ''
      size = 0
    }
    chunk += char
    size += bytes
  }
  if (chunk !== '') chunks.push(chunk)
  return chunks
}

export function formatOutline(view: View, context: FormatContext): { ok: true; value: Formatted } {
  const formatted: Formatted = {
    viewId: view.viewId,
    revision: view.revision,
    parts: [],
    complete: true,
    unsupportedRequiredFeatures: [],
  }
  const read = readOutline(view.data)
  if (read === undefined) return { ok: true, value: { ...formatted, complete: false } }
  formatted.complete = read.known
  const { title, slides } = read.outline
  const texts = [
    `${title}${PHASE_MARKS[view.phase]}`,
    ...slides.map((slide, index) =>
      [`${index + 1}. ${slide.heading}`, ...slide.points.map((point) => `- ${point}`)].join('\n'),
    ),
  ]
  let room = context.capabilities.display.maxTextBytes
  for (const text of texts) {
    room -= utf8Length(text)
    if (room < 0) {
      formatted.complete = false
      break
    }
    formatted.parts.push({ kind: 'text', text })
  }
  const negotiated = new Set(context.capabilities.features)
  const missing = new Set<string>()
  for (const action of view.actions) {
    if (action.availability !== 'enabled') continue
    const lacking = action.requiredFeatures.filter((feature) => !negotiated.has(feature))
    for (const feature of lacking) missing.add(feature)
    if (lacking.length === 0)
      formatted.parts.push({ kind: 'action', actionKey: action.actionKey, label: action.label })
  }
  if (missing.size > 0) {
    formatted.complete = false
    formatted.unsupportedRequiredFeatures = [...missing]
  }
  return { ok: true, value: formatted }
}

export function encodeOutline(formatted: Formatted, channel: Channel): { ok: true; value: Encoded } {
  const texts = formatted.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : []))
  const actions = formatted.parts.flatMap((part) => (part.kind === 'action' ? [part] : []))
  // Without buttons the labels are listed so the user sees what the host offers. Action keys, and any
  // approval value, never go into text, where a typed reply could forge them.
  if (!channel.supportsButtons && actions.length > 0)
    texts.push(`Actions: ${actions.map((action) => action.label).join(', ')}`)
  const chunks = split(texts.join('\n\n'), channel.maxTextBytes)
  if (chunks === undefined)
    return { ok: true, value: { messages: [], complete: false, requiresWebForm: true } }
  if (chunks.length === 0 && actions.length > 0) chunks.push('')
  const kept = chunks.slice(0, MAX_MESSAGES)
  const complete = formatted.complete && kept.length === chunks.length
  // The action keys ride on the last part, under the whole text, and name the original view actions.
  const messages = kept.map((text, partIndex) => ({
    text,
    actionKeys: partIndex === kept.length - 1 ? actions.map((action) => action.actionKey) : [],
    partIndex,
    partCount: kept.length,
  }))
  return { ok: true, value: { messages, complete, requiresWebForm: !complete } }
}

const descriptor = (id: string, targets: Descriptor['targets']): Descriptor => ({
  id,
  packageDigest: UNPUBLISHED_PACKAGE_DIGEST,
  renderKey: OUTLINE_RENDER_KEY,
  targets,
  viewSchemaRanges: [{ typeId: OUTLINE_VIEW_TYPE, minRevision: 1, maxRevision: 1 }],
  requiredFeatures: [],
  optionalFeatures: [],
  scope: 'view',
  entry: './src/client/index.ts',
})

// ponytail: plain definition objects; wrap them with defineRenderer once the extension API has it.
export const referenceOutlineWeb = {
  descriptor: descriptor('reference.outline.web', ['web']),
  component: ReferenceOutline,
}

export const referenceOutlineText = {
  descriptor: descriptor('reference.outline.text', ['tui', 'sdk', 'im']),
  format: formatOutline,
  encode: encodeOutline,
}
