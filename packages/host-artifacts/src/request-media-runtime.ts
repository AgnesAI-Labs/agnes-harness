import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import type { KernelOptions } from '@agnes/core'
import { validateRequestMedia } from '@agnes/protocol'

type RequestMediaRuntime = NonNullable<KernelOptions['requestMedia']>
type ImageInputTokenFallback = NonNullable<KernelOptions['imageInputTokenFallback']>

export type ProductionRequestMediaConfiguration = Readonly<{
  /** Session/lane-scoped trusted reader. It must resolve ownership before returning bytes. */
  readArtifact: RequestMediaRuntime['readArtifact']
  /** Explicit product limits frozen from P0 evidence; Host deliberately supplies no defaults. */
  surfaceLimits: RequestMediaRuntime['surfaceLimits']
  /** Explicit product limits frozen from P0 evidence; Host deliberately supplies no defaults. */
  mediaLimits: RequestMediaRuntime['mediaLimits']
}>

const SURFACE_LIMITS = Object.freeze([
  'maxLedgerEvents',
  'maxSurfaceNodes',
  'maxContentBlocks',
  'maxManifestEntries',
  'maxCandidateBytes',
  'maxCandidatePixels',
] as const)

const MEDIA_LIMITS = Object.freeze([
  'maxManifestEntries',
  'maxSelectedImages',
  'maxSelectedBlocks',
  'maxBytesPerImage',
  'maxDimensionPerImage',
  'maxPixelsPerImage',
  'maxSelectedBytes',
  'maxSelectedPixels',
] as const)

function invalid(): TypeError {
  return new TypeError('production request-media configuration is invalid')
}

function dataDescriptors(value: unknown, keys: readonly string[]): PropertyDescriptorMap {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    keys.some(
      (key) => descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key] ?? {}, 'value'),
    )
  )
    throw invalid()
  return descriptors
}

function limits<K extends string>(value: unknown, keys: readonly K[]): Readonly<Record<K, number>> {
  const descriptors = dataDescriptors(value, keys)
  return Object.freeze(
    Object.fromEntries(
      keys.map((key) => {
        const limit = descriptors[key]?.value as unknown
        if (!Number.isSafeInteger(limit) || (limit as number) < 1) throw invalid()
        return [key, limit as number]
      }),
    ) as Record<K, number>,
  )
}

/**
 * Builds the production Core media port only from an explicit authority and explicit reviewed
 * limits. The exact-shape snapshots prevent accessors/proxies from changing policy after assembly,
 * and the surface intentionally cannot mint auxiliary-vision production admission.
 */
export function composeProductionRequestMedia(
  input: ProductionRequestMediaConfiguration,
): RequestMediaRuntime {
  try {
    const descriptors = dataDescriptors(input, ['readArtifact', 'surfaceLimits', 'mediaLimits'])
    const readArtifact = descriptors.readArtifact?.value as unknown
    if (typeof readArtifact !== 'function' || utilTypes.isProxy(readArtifact)) throw invalid()
    const surfaceLimits = limits(descriptors.surfaceLimits?.value, SURFACE_LIMITS)
    const mediaLimits = limits(descriptors.mediaLimits?.value, MEDIA_LIMITS)
    return Object.freeze({
      readArtifact: readArtifact as RequestMediaRuntime['readArtifact'],
      surfaceLimits,
      mediaLimits,
    })
  } catch {
    throw invalid()
  }
}

function decodedImage(data: string): Buffer | undefined {
  if (
    data.length === 0 ||
    data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  )
    return undefined
  const bytes = Buffer.from(data, 'base64')
  return bytes.toString('base64') === data ? bytes : undefined
}

/**
 * Supplies Core's fail-closed image-budget fallback from the trusted Host boundary. The complete
 * serialized wire is used as a deliberately coarse upper bound (one token per JSON code unit), so
 * text, tools and user-inline images are all included. Persisted tool images are accepted only
 * when their actual bytes and MIME types match the selected media manifest exactly.
 */
export function createProductionImageInputTokenFallback(): ImageInputTokenFallback {
  return async ({ wire, media, imageCount, signal }) => {
    if (signal.aborted) return null
    const images: Array<{ data: string; mimeType: string; persisted: boolean }> = []
    for (const message of wire.messages)
      for (const block of message.content)
        if (block.type === 'image')
          images.push({
            data: block.data,
            mimeType: block.mimeType,
            persisted: message.role === 'tool_result',
          })
    if (images.length !== imageCount || !Number.isSafeInteger(imageCount) || imageCount < 1) return null

    const persisted = new Map<string, number>()
    for (const image of images) {
      if (!image.persisted) continue
      const bytes = decodedImage(image.data)
      if (!bytes) return null
      const key = `${createHash('sha256').update(bytes).digest('hex')}\0${image.mimeType}`
      persisted.set(key, (persisted.get(key) ?? 0) + 1)
    }

    if (media) {
      const checked = validateRequestMedia(media)
      if (!checked.ok) return null
      if (checked.value.media.route !== 'native-image') {
        if (persisted.size > 0) return null
      } else {
        for (const entry of checked.value.selected) {
          const key = `${entry.sha256}\0${entry.mime}`
          const remaining = persisted.get(key) ?? 0
          if (remaining < 1) return null
          if (remaining === 1) persisted.delete(key)
          else persisted.set(key, remaining - 1)
        }
        if (persisted.size > 0) return null
      }
    } else if (persisted.size > 0) {
      return null
    }

    let serialized: string | undefined
    try {
      serialized = JSON.stringify(wire)
    } catch {
      return null
    }
    if (signal.aborted || typeof serialized !== 'string' || !Number.isSafeInteger(serialized.length))
      return null
    return { tokens: Math.max(1, serialized.length), imageCount }
  }
}
