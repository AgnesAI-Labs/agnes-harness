import type { ArtifactRef } from '@agnes/extension-api'
import type {
  ComputerUseActionResult,
  ComputerUseCaptureResult,
  ComputerUseElement,
  ComputerUseImage,
  ComputerUseTarget,
} from './backend.js'

type Data = Record<string, unknown>
const object = (value: unknown, message = 'computer_use backend result must be an object'): Data => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(message)
  return value as Data
}
const number = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${field} must be finite`)
  return value
}
const positiveInt = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined
const text = (value: unknown): unknown => {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

type Envelope = { payload: unknown; text: string }
function envelope(value: unknown): Envelope {
  const outer = object(value)
  const wrapped = [
    'structuredContent',
    'structured_content',
    'content',
    'images',
    'data',
    'isError',
    'is_error',
  ].some((key) => key in outer)
  if (!wrapped) return { payload: outer, text: '' }
  const chunks: string[] = []
  if (outer.content !== undefined) {
    if (!Array.isArray(outer.content)) throw new TypeError('driver content must be an array')
    for (const entry of outer.content) {
      const part = object(entry)
      if (part.type === 'image')
        throw new TypeError('raw driver images require Host artifact normalization before Base parsing')
      if (part.type === 'text' && typeof part.text === 'string') chunks.push(part.text)
    }
  }
  if (outer.images !== undefined) {
    if (!Array.isArray(outer.images)) throw new TypeError('driver images must be an array')
    if (outer.images.length)
      throw new TypeError('raw driver images require Host artifact normalization before Base parsing')
  }
  const joined = chunks.filter(Boolean).join('\n')
  const fallback = text(outer.data ?? joined)
  const canonical = Object.hasOwn(outer, 'structuredContent')
    ? outer.structuredContent
    : outer.structured_content
  const base = typeof fallback === 'object' && fallback !== null && !Array.isArray(fallback) ? fallback : {}
  const payload =
    canonical !== undefined && canonical !== null
      ? Array.isArray(canonical)
        ? canonical
        : { ...object(base), ...object(canonical) }
      : typeof fallback === 'object' && fallback !== null
        ? fallback
        : base
  return { payload, text: typeof fallback === 'string' ? fallback : joined }
}

function artifactRef(value: unknown): ArtifactRef {
  const ref = object(value)
  if (
    Object.keys(ref).some((key) => !['sha256', 'size', 'mime'].includes(key)) ||
    typeof ref.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(ref.sha256) ||
    !Number.isSafeInteger(ref.size) ||
    (ref.size as number) < 0 ||
    typeof ref.mime !== 'string' ||
    ref.mime.length > 128
  )
    throw new TypeError('capture.image.ref is invalid')
  return { sha256: ref.sha256, size: ref.size as number, mime: ref.mime }
}

function target(value: unknown, fallback: Data = {}): ComputerUseTarget {
  const raw = value === undefined ? {} : object(value)
  const app = raw.app ?? fallback.app
  const pid = positiveInt(raw.pid ?? fallback.pid)
  const windowId = positiveInt(raw.windowId ?? raw.window_id ?? fallback.windowId ?? fallback.window_id)
  const snapshotId = raw.snapshotId ?? raw.snapshot_id ?? fallback.snapshotId ?? fallback.snapshot_id
  if (windowId !== undefined && pid === undefined)
    throw new TypeError('capture target window_id requires pid')
  return {
    ...(typeof app === 'string' && app ? { app } : {}),
    ...(pid ? { pid } : {}),
    ...(windowId ? { windowId } : {}),
    ...(typeof snapshotId === 'string' && snapshotId ? { snapshotId } : {}),
  }
}

function element(value: unknown): ComputerUseElement {
  const raw = object(value)
  const frame = typeof raw.frame === 'object' && raw.frame !== null ? object(raw.frame) : undefined
  const source = raw.bounds ?? (frame ? [frame.x, frame.y, frame.w, frame.h] : undefined)
  let bounds: [number, number, number, number] | null = null
  if (Array.isArray(source) && source.length === 4 && source.every(Number.isFinite)) {
    const tuple = source as [number, number, number, number]
    bounds = tuple.every((part) => part === 0) ? null : tuple
  }
  const index = number(raw.index ?? raw.element_index, 'element.index')
  if (!Number.isSafeInteger(index) || index < 0)
    throw new TypeError('element.index must be a non-negative integer')
  if (typeof raw.role !== 'string') throw new TypeError('element.role must be a string')
  const token = raw.elementToken ?? raw.element_token
  const pid = positiveInt(raw.pid)
  const windowId = positiveInt(raw.windowId ?? raw.window_id)
  return {
    index,
    role: raw.role,
    label: typeof raw.label === 'string' ? raw.label : '',
    bounds,
    ...(typeof raw.app === 'string' && raw.app ? { app: raw.app } : {}),
    ...(pid ? { pid } : {}),
    ...(windowId ? { windowId } : {}),
    ...(typeof token === 'string' && token ? { elementToken: token } : {}),
  }
}

const ELEMENT_LINE =
  /^\s*(?:-\s+)?\[(\d+)]\s+(\w+)(?:\s*=\s*"([^"]*)"|\s+"([^"]*)"|\s+\((?!\d+\))([^)]*)\))?(?:\s+(?:\(\d+\)\s+)?id=([^\s[\]]+))?/gm
function textElements(source: string): ComputerUseElement[] {
  return [...source.matchAll(ELEMENT_LINE)].flatMap((match) => {
    const index = Number(match[1])
    return Number.isSafeInteger(index) && index >= 0
      ? [
          {
            index,
            role: match[2] ?? '',
            label: match[3] ?? match[4] ?? match[5] ?? match[6] ?? '',
            bounds: null,
          },
        ]
      : []
  })
}

function image(value: unknown): ComputerUseImage {
  const raw = object(value)
  const mime = raw.mime ?? raw.mimeType ?? raw.mime_type
  if (mime !== 'image/png' && mime !== 'image/jpeg') throw new TypeError('capture.image.mime is invalid')
  if (typeof raw.digest !== 'string' || !/^[0-9a-f]{64}$/.test(raw.digest))
    throw new TypeError('capture.image.digest is invalid')
  const width = number(raw.width, 'capture.image.width')
  const height = number(raw.height, 'capture.image.height')
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new TypeError('capture.image dimensions must be positive integers')
  const ref = artifactRef(raw.ref)
  if (ref.mime !== mime) throw new TypeError('capture.image MIME does not match its artifact reference')
  if (ref.size < 1) throw new TypeError('capture.image artifact must not be empty')
  if (ref.sha256 !== raw.digest)
    throw new TypeError('capture.image digest does not match its artifact reference')
  return { ref, mime, width, height, digest: raw.digest }
}

export function parseCaptureResult(value: unknown): ComputerUseCaptureResult {
  const wrapped = envelope(value)
  const raw = object(wrapped.payload)
  if (raw.mode !== 'som' && raw.mode !== 'vision' && raw.mode !== 'ax')
    throw new TypeError('capture.mode is invalid')
  const width = number(raw.width, 'capture.width')
  const height = number(raw.height, 'capture.height')
  if (width < 0 || height < 0) throw new TypeError('capture dimensions must be non-negative')
  const source = raw.elements ?? textElements(wrapped.text)
  if (!Array.isArray(source)) throw new TypeError('capture.elements must be an array')
  const elements = source.map(element)
  const indexes = new Set<number>()
  for (const entry of elements) {
    if (indexes.has(entry.index)) throw new TypeError('capture element indices must be unique')
    indexes.add(entry.index)
  }
  const title = raw.windowTitle ?? raw.window_title
  const scale = raw.boundsScale ?? raw.bounds_scale ?? raw.scale
  if (scale !== undefined && (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0))
    throw new TypeError('capture.bounds_scale must be positive and finite')
  let safety: ComputerUseCaptureResult['safety']
  if (raw.safety !== undefined) {
    const flags = object(raw.safety)
    if (typeof flags.reliable !== 'boolean') throw new TypeError('capture.safety.reliable must be boolean')
    const aliases = [
      ['secureInput', 'secure_input'],
      ['payment', 'payment'],
      ['twoFactor', 'two_factor'],
      ['systemPermission', 'system_permission'],
    ] as const
    const normalized: Record<string, boolean> = { reliable: flags.reliable }
    for (const [field, alias] of aliases) {
      const canonical = flags[field]
      const compatible = flags[alias]
      if (canonical !== undefined && typeof canonical !== 'boolean')
        throw new TypeError(`capture.safety.${field} must be boolean`)
      if (compatible !== undefined && typeof compatible !== 'boolean')
        throw new TypeError(`capture.safety.${alias} must be boolean`)
      if (canonical !== undefined && compatible !== undefined && canonical !== compatible)
        throw new TypeError(`capture.safety.${field} aliases disagree`)
      const value = canonical ?? compatible
      if (typeof value === 'boolean') normalized[field] = value
    }
    safety = normalized as NonNullable<ComputerUseCaptureResult['safety']>
  }
  return {
    mode: raw.mode,
    width,
    height,
    ...(typeof raw.app === 'string' && raw.app ? { app: raw.app } : {}),
    ...(typeof title === 'string' && title ? { windowTitle: title } : {}),
    target: target(raw.target, raw),
    elements,
    ...(raw.image === undefined ? {} : { image: image(raw.image) }),
    ...(typeof raw.note === 'string' && raw.note ? { note: raw.note } : {}),
    ...(typeof scale === 'number' ? { boundsScale: scale } : {}),
    ...(safety ? { safety } : {}),
  }
}

export function parseActionResult(value: unknown, action: string): ComputerUseActionResult {
  const wrapped = envelope(value)
  const raw = object(wrapped.payload)
  const outer = object(value)
  const transportError = outer.isError ?? outer.is_error
  const ok = raw.ok ?? (transportError === true ? false : transportError === false ? true : undefined)
  if (typeof ok !== 'boolean') throw new TypeError('action.ok must be boolean')
  if (raw.action !== undefined && raw.action !== action)
    throw new TypeError('action result does not match the dispatched action')
  const effect = raw.effect
  if (effect !== undefined && !['confirmed', 'unverifiable', 'suspected_noop'].includes(effect as string))
    throw new TypeError('action.effect is invalid')
  if (ok === false && (effect === 'confirmed' || raw.verified === true))
    throw new TypeError('failed action cannot be confirmed or verified')
  let escalation: ComputerUseActionResult['escalation']
  if (raw.escalation !== undefined) {
    const entry = object(raw.escalation)
    if (entry.recommended !== undefined && entry.recommended !== 'px' && entry.recommended !== 'foreground')
      throw new TypeError('action.escalation.recommended is invalid')
    if (entry.reason !== undefined && typeof entry.reason !== 'string')
      throw new TypeError('action.escalation.reason must be a string')
    escalation = {
      ...(entry.recommended ? { recommended: entry.recommended } : {}),
      ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
    }
  }
  const code = raw.code ?? raw.reason_code
  const delivery = raw.deliveryMode ?? raw.delivery_mode
  return {
    ok,
    action,
    ...(typeof raw.message === 'string' && raw.message
      ? { message: raw.message }
      : wrapped.text
        ? { message: wrapped.text }
        : {}),
    ...(typeof code === 'string' && code ? { code } : {}),
    ...(effect ? { effect: effect as NonNullable<ComputerUseActionResult['effect']> } : {}),
    ...(typeof raw.verified === 'boolean' ? { verified: raw.verified } : {}),
    ...(escalation ? { escalation } : {}),
    ...(typeof raw.path === 'string' && raw.path ? { path: raw.path } : {}),
    ...(typeof raw.degraded === 'boolean' ? { degraded: raw.degraded } : {}),
    ...(delivery === 'background' || delivery === 'foreground' ? { deliveryMode: delivery } : {}),
    ...(raw.target === undefined ? {} : { target: target(raw.target) }),
  }
}

export function parseListingResult(value: unknown, key: 'apps' | 'windows'): readonly unknown[] {
  if (Array.isArray(value)) return value
  const payload = envelope(value).payload
  if (Array.isArray(payload)) return payload
  const items = object(payload)[key]
  if (!Array.isArray(items)) throw new TypeError(`${key} result must be an array`)
  return items
}
