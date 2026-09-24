import { createHash } from 'node:crypto'
import type { ArtifactRef, ContentBlock, JsonValue } from '@agnes/protocol'
import { decodeSafeImages, type SafeImageLimits } from '@agnes/protocol-validation'
import type { DriverCallResult, FakeCaptureRequest, FakeComputerUseDriverConnection } from './types.js'

const FAKE_IMAGE_LIMITS = Object.freeze({
  maxBytesPerImage: 4 * 1024 * 1024,
  maxPixelsPerImage: 1456 * 1456,
  maxAggregateBytes: 4 * 1024 * 1024,
  maxAggregatePixels: 1456 * 1456,
}) satisfies SafeImageLimits

type JsonObject = Record<string, JsonValue | undefined>
export type FakeObserveToolName = 'capture' | 'list_apps' | 'list_windows'

export type FakeObserveArtifactSink = Readonly<{
  put(bytes: Uint8Array, meta: { mime: 'image/png' | 'image/jpeg'; name: string }): Promise<ArtifactRef>
}>

export type NormalizedFakeObserveResult = Readonly<{
  content: readonly ContentBlock[]
  structuredContent: JsonValue
  isError: false
}>

function object(value: unknown, field: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`fake Computer Use ${field} must be an object`)
  return value as JsonObject
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function positiveInt(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new TypeError(`fake Computer Use ${field} must be a positive integer`)
  return value as number
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError(`fake Computer Use ${field} must be finite`)
  return value
}

function textContent(result: DriverCallResult): ContentBlock[] {
  const texts = result.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
  // Base joins every non-empty text block before attempting its legacy JSON fallback. Inspect that
  // exact projection so an object split across blocks cannot acquire trusted capture fields.
  const joined = texts.filter(Boolean).join('\n')
  if (/^\s*[[{]/.test(joined)) {
    try {
      const parsed: unknown = JSON.parse(joined)
      if (typeof parsed === 'object' && parsed !== null)
        throw new TypeError('fake Computer Use typed results reject JSON text fallback')
    } catch (error) {
      if (error instanceof TypeError) throw error
    }
  }
  return texts.map((text) => ({ type: 'text' as const, text }))
}

function captureData(value: JsonValue | undefined): JsonObject {
  const raw = object(value, 'capture structuredContent')
  if (raw.image !== undefined) throw new TypeError('fake Computer Use driver cannot author artifact identity')
  if (raw.mode !== 'som' && raw.mode !== 'vision' && raw.mode !== 'ax')
    throw new TypeError('fake Computer Use capture mode is invalid')
  const width = finite(raw.width, 'capture width')
  const height = finite(raw.height, 'capture height')
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0)
    throw new TypeError('fake Computer Use capture dimensions must be non-negative integers')
  const target = object(raw.target, 'capture target')
  if (typeof target.app !== 'string' || target.app.length === 0)
    throw new TypeError('fake Computer Use capture target app is invalid')
  const pid = target.pid === undefined ? undefined : positiveInt(target.pid, 'capture target pid')
  const windowId =
    target.window_id === undefined ? undefined : positiveInt(target.window_id, 'capture target window_id')
  if (windowId !== undefined && pid === undefined)
    throw new TypeError('fake Computer Use capture window target requires pid')
  if (typeof target.snapshot_id !== 'string' || target.snapshot_id.length === 0)
    throw new TypeError('fake Computer Use capture snapshot_id is invalid')
  if (!Array.isArray(raw.elements)) throw new TypeError('fake Computer Use capture elements must be an array')
  const seen = new Set<number>()
  const elements = raw.elements.map((value, offset) => {
    const element = object(value, `capture element ${offset}`)
    const index = positiveInt(element.index, `capture element ${offset} index`)
    if (seen.has(index)) throw new TypeError('fake Computer Use capture element indices must be unique')
    seen.add(index)
    if (typeof element.role !== 'string' || typeof element.label !== 'string')
      throw new TypeError(`fake Computer Use capture element ${offset} text is invalid`)
    if (
      !Array.isArray(element.bounds) ||
      element.bounds.length !== 4 ||
      !element.bounds.every((part) => typeof part === 'number' && Number.isFinite(part))
    )
      throw new TypeError(`fake Computer Use capture element ${offset} bounds are invalid`)
    if (typeof element.element_token !== 'string' || element.element_token.length === 0)
      throw new TypeError(`fake Computer Use capture element ${offset} token is invalid`)
    return {
      index,
      role: element.role,
      label: element.label,
      bounds: [...element.bounds],
      element_token: element.element_token,
    }
  })
  return {
    mode: raw.mode,
    width,
    height,
    target: {
      app: target.app,
      ...(pid === undefined ? {} : { pid }),
      ...(windowId === undefined ? {} : { window_id: windowId }),
      snapshot_id: target.snapshot_id,
    },
    elements,
  }
}

function captureArgs(request: FakeCaptureRequest, generation: number): JsonValue {
  const common = { mode: request.mode, generation }
  switch (request.target.kind) {
    case 'frontmost':
      return { ...common, target: 'frontmost' }
    case 'app':
      if (!request.target.app.trim()) throw new TypeError('fake Computer Use app target is empty')
      return { ...common, app: request.target.app }
    case 'pid':
      return { ...common, pid: positiveInt(request.target.pid, 'capture request pid') }
    case 'window':
      return {
        ...common,
        pid: positiveInt(request.target.pid, 'capture request pid'),
        window_id: positiveInt(request.target.windowId, 'capture request window_id'),
      }
    case 'screen':
      return { ...common, app: 'screen' }
    case 'desktop':
      return { ...common, app: 'desktop' }
  }
}

function scopeResult(result: DriverCallResult, expected?: 'window' | 'screen'): 'window' | 'screen' {
  if (result.isError) throw new Error('fake Computer Use screen config step returned isError')
  const raw = object(result.structuredContent, 'screen config result')
  if (raw.scope !== 'window' && raw.scope !== 'screen')
    throw new TypeError('fake Computer Use screen config scope is invalid')
  if (expected !== undefined && raw.scope !== expected)
    throw new TypeError(`fake Computer Use screen config did not confirm ${expected}`)
  return raw.scope
}

/** Fake-only screen compound lifecycle; no production runtime or admission path calls this helper. */
export async function captureFakeObserveConnection(
  connection: FakeComputerUseDriverConnection,
  request: FakeCaptureRequest,
  options: Readonly<{ timeoutMs: number; signal: AbortSignal }>,
  invalidate: () => Promise<void>,
): Promise<DriverCallResult> {
  const args = captureArgs(request, connection.generation)
  if (request.target.kind !== 'screen') return connection.call('capture', args, options)

  const failures: unknown[] = []
  let baseline: 'window' | 'screen' | undefined
  let setAttempted = false
  let captured: DriverCallResult | undefined
  try {
    baseline = scopeResult(await connection.call('get_capture_scope', {}, options))
    setAttempted = true
    scopeResult(await connection.call('set_capture_scope', { scope: 'screen' }, options), 'screen')
    captured = await connection.call('capture', args, options)
    if (captured.isError) throw new Error('fake Computer Use screen capture returned isError')
  } catch (error) {
    failures.push(error)
  } finally {
    if (baseline !== undefined && setAttempted) {
      try {
        scopeResult(await connection.call('set_capture_scope', { scope: baseline }, options), baseline)
      } catch (error) {
        failures.push(error)
      }
    }
  }
  if (failures.length) {
    try {
      await invalidate()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length === 1) throw failures[0]
    throw new AggregateError(failures, 'fake Computer Use screen compound failed')
  }
  if (!captured) throw new Error('fake Computer Use screen compound produced no capture')
  return captured
}

function appsData(value: JsonValue | undefined): JsonObject {
  const raw = object(value, 'list_apps structuredContent')
  if (!Array.isArray(raw.apps)) throw new TypeError('fake Computer Use apps must be an array')
  return {
    apps: raw.apps.map((value, offset) => {
      const app = object(value, `app ${offset}`)
      if (typeof app.app !== 'string' || app.app.length === 0 || typeof app.frontmost !== 'boolean')
        throw new TypeError(`fake Computer Use app ${offset} is invalid`)
      return {
        app: app.app,
        pid: positiveInt(app.pid, `app ${offset} pid`),
        frontmost: app.frontmost,
      }
    }),
  }
}

function windowsData(value: JsonValue | undefined): JsonObject {
  const raw = object(value, 'list_windows structuredContent')
  if (!Array.isArray(raw.windows)) throw new TypeError('fake Computer Use windows must be an array')
  return {
    windows: raw.windows.map((value, offset) => {
      const window = object(value, `window ${offset}`)
      if (typeof window.app !== 'string' || window.app.length === 0 || typeof window.title !== 'string')
        throw new TypeError(`fake Computer Use window ${offset} is invalid`)
      if (
        !Array.isArray(window.bounds) ||
        window.bounds.length !== 4 ||
        !window.bounds.every((part) => typeof part === 'number' && Number.isFinite(part))
      )
        throw new TypeError(`fake Computer Use window ${offset} bounds are invalid`)
      return {
        app: window.app,
        pid: positiveInt(window.pid, `window ${offset} pid`),
        window_id: positiveInt(window.window_id, `window ${offset} window_id`),
        title: window.title,
        bounds: [...window.bounds],
      }
    }),
  }
}

function validateArtifact(ref: ArtifactRef, expected: { sha256: string; size: number; mime: string }): void {
  if (
    ref.sha256 !== expected.sha256 ||
    ref.size !== expected.size ||
    ref.mime !== expected.mime ||
    !/^[0-9a-f]{64}$/.test(ref.sha256)
  )
    throw new TypeError('fake Computer Use artifact sink returned a mismatched identity')
}

/** Test-only typed Host boundary. It is neither a production backend nor an admission path. */
export async function normalizeFakeObserveResult(
  name: FakeObserveToolName,
  result: DriverCallResult,
  artifacts: FakeObserveArtifactSink,
): Promise<NormalizedFakeObserveResult> {
  const snapshot = structuredClone(result)
  if (snapshot.isError)
    throw new TypeError('fake Computer Use observe error cannot produce trusted capture state')
  const content = textContent(snapshot)
  const images = snapshot.content.filter((block) => block.type === 'image')
  const structured =
    name === 'capture'
      ? captureData(snapshot.structuredContent)
      : name === 'list_apps'
        ? appsData(snapshot.structuredContent)
        : windowsData(snapshot.structuredContent)

  if (name !== 'capture' && images.length)
    throw new TypeError(`fake Computer Use ${name} cannot return an image`)
  if (name !== 'capture')
    return Object.freeze({
      content: Object.freeze(content),
      structuredContent: deepFreeze(structured as JsonValue),
      isError: false,
    })
  const wantsImage = structured.mode === 'som' || structured.mode === 'vision'
  if (images.length !== (wantsImage ? 1 : 0))
    throw new TypeError(`fake Computer Use ${String(structured.mode)} capture has an invalid image count`)

  const decoded = decodeSafeImages(images, FAKE_IMAGE_LIMITS)
  if (decoded.some((image) => image.width > 1456 || image.height > 1456))
    throw new TypeError('fake Computer Use image exceeds the 1456px dimension limit')
  const image = decoded[0]
  if (!image)
    return Object.freeze({
      content: Object.freeze(content),
      structuredContent: deepFreeze(structured as JsonValue),
      isError: false,
    })
  if (structured.width !== image.width || structured.height !== image.height)
    throw new TypeError('fake Computer Use screenshot dimensions disagree with validated image bytes')
  const digest = createHash('sha256').update(image.bytes).digest('hex')
  const nameHint = image.mime === 'image/png' ? 'computer-use-screenshot.png' : 'computer-use-screenshot.jpg'
  const ref = await artifacts.put(image.bytes, { mime: image.mime, name: nameHint })
  validateArtifact(ref, { sha256: digest, size: image.bytes.byteLength, mime: image.mime })
  const trustedImage = Object.freeze({
    ref: Object.freeze({ ...ref }),
    mime: image.mime,
    width: image.width,
    height: image.height,
    digest,
  })
  content.push({
    type: 'resource_link',
    uri: `artifact://${digest}`,
    name: nameHint,
    mimeType: image.mime,
  })
  return Object.freeze({
    content: Object.freeze(content),
    structuredContent: deepFreeze({ ...structured, image: trustedImage } as JsonValue),
    isError: false,
  })
}
