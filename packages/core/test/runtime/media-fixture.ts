import { deflateSync } from 'node:zlib'
import type { Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import type { RequestMediaLimits } from '../../src/orchestrator/request-media.js'
import { sha256Hex } from '../../src/request/hash.js'
import {
  MEDIA_BYTES_SCHEMA,
  MEDIA_DERIVED_TEXT_SCHEMA,
  MEDIA_IMAGE_TO_TEXT_SCHEMA,
  MEDIA_NATIVE_SCHEMA,
  type MediaManifest,
  type MediaParameters,
  manifestRef,
  mediaSourceDigest,
  pack,
  packParameters,
  retentionOf,
} from '../../src/runtime/media/identity.js'
import type { LegacyImage } from '../../src/runtime/media/legacy-bridge.js'
import {
  candidatesFrom,
  framedVisionText,
  mediaHash,
  preflight,
} from '../../src/runtime/media/legacy-bridge.js'
import type { MediaEvidence } from '../../src/runtime/media/verify.js'

const u32 = (value: number) => [value >>> 24, value >>> 16, value >>> 8, value].map((byte) => byte & 0xff)
const crcTable = new Uint32Array(256)
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crcTable[index] = value >>> 0
}
function chunk(type: string, data: readonly number[]): number[] {
  const typed = [...Buffer.from(type, 'ascii'), ...data]
  let crc = 0xffffffff
  for (const byte of typed) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return [...u32(data.length), ...typed, ...u32((crc ^ 0xffffffff) >>> 0)]
}
/** A valid 1-bit PNG; `marker` makes distinct bytes (and digests) of the same size. */
export function png(width = 8, height = 8, marker = 0): Uint8Array {
  const raw = new Uint8Array(height * (Math.ceil(width / 8) + 1))
  return Uint8Array.from([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk('IHDR', [...u32(width), ...u32(height), 1, 0, 0, 0, 0]),
    ...chunk('tEXt', [...Buffer.from(`marker\0${marker}`, 'ascii')]),
    ...chunk('IDAT', [...deflateSync(raw)]),
    ...chunk('IEND', []),
  ])
}

export const LIMITS: RequestMediaLimits = {
  maxManifestEntries: 8,
  maxSelectedImages: 8,
  maxSelectedBlocks: 16,
  maxBytesPerImage: 4096,
  maxDimensionPerImage: 1456,
  maxPixelsPerImage: 10_000_000,
  maxSelectedBytes: 16384,
  maxSelectedPixels: 10_000_000,
}

export function blobOf(bytes: Uint8Array, mediaType = 'image/png'): W.BlobRef {
  const digest = sha256Hex(bytes)
  return {
    authorityId: 'blob-authority',
    blobId: `blob-${digest.slice(0, 12)}`,
    digest,
    bytes: bytes.length,
    mediaType,
    pinId: `pin-${digest.slice(0, 12)}`,
  }
}
export const publicBlob = (bytes: Uint8Array, mediaType?: string): W.PublicRef => ({
  kind: 'blob',
  value: blobOf(bytes, mediaType),
})

export function legacyImage(node: number, block: number, marker: number): LegacyImage {
  const bytes = png(8, 8, marker)
  return { node, block, blob: blobOf(bytes), bytes, sourceTool: 'computer_use' }
}

export const featuresText: W.ModelFeatures = {
  input: ['text'],
  output: ['text'],
  tools: false,
  structuredOutput: false,
  streaming: true,
}
export const featuresImage: W.ModelFeatures = { ...featuresText, input: ['text', 'image'] }

export const mediaBinding: W.BindingRef = {
  bindingId: 'media-binding',
  providerId: 'agh.default/media',
  contract: 'agh.media',
  logicalName: 'default',
}
export const stateBinding: W.BindingRef = {
  bindingId: 'state-binding',
  providerId: 'agh.default/state',
  contract: 'agh.state',
  logicalName: 'default',
}
export const modelBinding: W.BindingRef = {
  bindingId: 'model-binding',
  providerId: 'agh.default/model',
  contract: 'agh.model',
  logicalName: 'default',
}

export const digestOf = (value: unknown) => canonicalJsonDigest(value as W.JsonValue)

export const must = <T>(outcome: Outcome<T>): T => {
  if (!outcome.ok) throw new Error(outcome.error.detailCode)
  return outcome.value
}

export const parametersOf = (nodes: number[], extra: Partial<MediaParameters> = {}): MediaParameters => ({
  kind: 'agh.media/parameters@1',
  slot: 'image',
  maxEdge: 1456,
  maxOutputTokens: 512,
  failurePolicy: 'fail',
  allowConversion: true,
  nodes,
  limits: LIMITS,
  ...extra,
})

export type FixtureImage = Readonly<{ marker: number; node: number }>

export function planOf(
  images: readonly FixtureImage[],
  kind: 'native' | 'convert',
  extra: Partial<MediaParameters> = {},
): W.MediaPlan {
  const sourceRefs = images.map((image) => publicBlob(png(8, 8, image.marker)))
  return {
    key: `media:${kind}`,
    sourceRefs,
    sourceDigest: must(mediaSourceDigest(sourceRefs)),
    transformSchema: kind === 'native' ? MEDIA_NATIVE_SCHEMA : MEDIA_IMAGE_TO_TEXT_SCHEMA,
    parameters: must(
      packParameters(
        parametersOf(
          images.map((image) => image.node),
          extra,
        ),
      ),
    ),
    targetFeatures: kind === 'native' ? featuresImage : featuresText,
    provider: mediaBinding,
  }
}

export const routeSnapshot = (): W.ModelRouteSnapshot => ({
  routeId: 'vision-route',
  routeRevision: 1,
  adapter: {
    bindingId: 'adapter',
    providerId: 'agh.default/model-adapter',
    contract: 'agh.model-adapter',
    logicalName: 'default',
  },
  model: 'vision-model',
  endpointRef: 'vision-endpoint',
  catalogRevision: 1,
  features: { ...featuresImage },
  priceVersion: 'vision-price-1',
  credentialAudience: 'vision-endpoint',
  credentialBinding: null,
})

export type Built = {
  plan: W.MediaPlan
  media: W.PreparedMedia
  evidence: MediaEvidence
  manifest: MediaManifest
}

const sourcesOf = (plan: W.MediaPlan) =>
  plan.sourceRefs.map((ref, index) => {
    if (ref.kind !== 'blob') throw new Error('fixture source')
    return {
      blobId: ref.value.blobId,
      digest: ref.value.digest,
      bytes: ref.value.bytes,
      mediaType: ref.value.mediaType,
      version: ref.value.pinId,
      manifestIndex: index,
      blockIndex: 0,
      sourceTool: 'computer_use',
    }
  })

function preparedFor(images: readonly FixtureImage[], mode: 'native' | 'convert') {
  const candidates = must(
    candidatesFrom(
      images.map((image) => legacyImage(image.node, 0, image.marker)),
      LIMITS,
    ),
  )
  return must(preflight(candidates, mode, LIMITS))
}
const authorized = { principalRef: 'principal', authorizationRef: 'authorization' }
const blobOfRef = (ref: W.PublicRef): W.BlobRef => {
  if (ref.kind !== 'blob') throw new Error('fixture source')
  return ref.value
}

export function nativeBuilt(): Built {
  const images = [
    { marker: 1, node: 1 },
    { marker: 2, node: 2 },
  ]
  const plan = planOf(images, 'native')
  const prepared = preparedFor(images, 'native')
  const manifest: MediaManifest = {
    kind: 'native',
    planDigest: digestOf(plan),
    header: prepared.header,
    mediaHash: mediaHash(prepared),
    sources: sourcesOf(plan),
    authorizedBy: authorized,
    conversion: null,
  }
  const media: W.PreparedMedia = {
    sourceRefs: plan.sourceRefs,
    contentRefs: [
      must(manifestRef(manifest)),
      ...prepared.header.selectionOrder.map(
        (index): W.DataRef => ({
          kind: 'blob',
          schema: MEDIA_BYTES_SCHEMA,
          blob: blobOfRef(plan.sourceRefs[index]!),
        }),
      ),
    ],
    transformChain: [],
    provenance: {
      sourceRefs: plan.sourceRefs.map((ref) => blobOfRef(ref).blobId),
      producer: mediaBinding,
      trustLabels: ['media:native'],
    },
    trust: 'external',
    usageRefs: [],
  }
  return { plan, media, evidence: { child: null }, manifest }
}

export const VISION_TEXT = 'A dialog with a Save button'

export function convertedBuilt(): Built {
  const images = [{ marker: 1, node: 1 }]
  const plan = planOf(images, 'convert')
  const prepared = preparedFor(images, 'convert')
  const usage: W.UsageFactRef[] = [
    { authorityId: 'usage-authority', usageId: 'vision-attempt:model', digest: digestOf({ usage: 1 }) },
  ]
  const output: W.ModelOutput = {
    outputRef: must(
      pack(
        { typeId: 'fixture/output@1', revision: 1, digest: digestOf({ t: 1 }) },
        { content: [{ type: 'text', text: VISION_TEXT }], structured: { thinking: '', toolCalls: [] } },
      ),
    ),
    finishReason: 'stop',
    usageFactRefs: usage,
    providerReceipt: null,
    actualModel: 'vision-model',
  }
  const derived = must(
    pack(MEDIA_DERIVED_TEXT_SCHEMA, {
      kind: 'agh.media/derived-text@1',
      text: framedVisionText(VISION_TEXT),
    }),
  )
  const manifest: MediaManifest = {
    kind: 'converted',
    planDigest: digestOf(plan),
    header: prepared.header,
    mediaHash: mediaHash(prepared),
    sources: sourcesOf(plan),
    authorizedBy: authorized,
    conversion: {
      modelBinding,
      route: retentionOf(routeSnapshot()),
      promptDigest: digestOf({ prompt: 1 }),
      parserVersion: '1',
      inferInputDigest: digestOf({ preparedRef: 'p' }),
      childActionId: 'vision-child',
      childReceiptId: 'vision-receipt',
      anchor: blobOfRef(plan.sourceRefs[0]!).blobId,
    },
  }
  const media: W.PreparedMedia = {
    sourceRefs: plan.sourceRefs,
    contentRefs: [must(manifestRef(manifest)), derived],
    transformChain: [
      {
        actionId: 'vision-child',
        transformSchema: plan.transformSchema,
        inputDigest: plan.sourceDigest,
        outputDigest: derived.kind === 'inline' ? derived.digest : '',
      },
    ],
    provenance: { sourceRefs: [], producer: mediaBinding, trustLabels: ['media:converted'] },
    trust: 'derived',
    usageRefs: usage,
  }
  return {
    plan,
    media,
    manifest,
    evidence: {
      child: {
        actionId: 'vision-child',
        receiptId: 'vision-receipt',
        bindingId: modelBinding.bindingId,
        inputDigest: manifest.conversion!.inferInputDigest,
        output,
        text: VISION_TEXT,
      },
    },
  }
}
