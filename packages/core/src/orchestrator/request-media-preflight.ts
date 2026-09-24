import { types as utilTypes } from 'node:util'
import { type RequestMediaHeader, validateRequestMedia } from '@agnes/protocol'
import { scanPages } from '../log/scan-pages.js'
import { canonicalJson, sha256Hex } from '../request/hash.js'
import type { SessionImpl } from '../step/session.js'
import { CoreError, type Event } from '../types.js'
import type { LedgerPreparedRequestMedia } from './request-media-surface.js'

const EVENT = 'x/core/auxiliary-vision-preflight'
const HASH = /^[0-9a-f]{64}$/u
const EFFECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u

export type AuxiliaryVisionPreflight = Readonly<{
  header: RequestMediaHeader
  mediaHash: string
  effectId: string
}>

type Binding = Readonly<{
  sessionKey: string
  lane: string
  turn: number
  step: number
  attempt: number
  triggerSeq: number
}>

function invalid(message: string): never {
  throw new CoreError('E_ENVELOPE', message)
}

function safeJson(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  budget.nodes += 1
  if (budget.nodes > 2_048 || depth > 8) invalid('auxiliary media preflight exceeds its bounds')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalid('invalid preflight number')
  if (typeof value !== 'object' || utilTypes.isProxy(value)) invalid('invalid preflight value')
  const prototype = Object.getPrototypeOf(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) invalid('invalid preflight array')
    const length = descriptors.length?.value
    if (!Number.isSafeInteger(length) || length < 0 || length > 1_024) invalid('invalid preflight array')
    if (Reflect.ownKeys(descriptors).length !== length + 1) invalid('invalid preflight array')
    return Object.freeze(
      Array.from({ length }, (_, index) => {
        const descriptor = descriptors[String(index)]
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
          invalid('invalid preflight array element')
        return safeJson(descriptor.value, depth + 1, budget)
      }),
    )
  }
  if (prototype !== Object.prototype && prototype !== null) invalid('invalid preflight object')
  const result = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') invalid('invalid preflight key')
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid('invalid preflight property')
    result[key] = safeJson(descriptor.value, depth + 1, budget)
  }
  return Object.freeze(result)
}

function record(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  const snapshot = safeJson(value)
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
    invalid('invalid preflight record')
  const keys = Object.keys(snapshot)
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key)))
    invalid('invalid preflight record fields')
  return snapshot as Readonly<Record<string, unknown>>
}

function parse(value: unknown, expected: Binding): AuxiliaryVisionPreflight {
  const data = record(value, [
    'version',
    'sessionKey',
    'lane',
    'turn',
    'step',
    'attempt',
    'triggerSeq',
    'effectId',
    'header',
    'headerHash',
    'mediaHash',
  ])
  if (
    data.version !== 1 ||
    data.sessionKey !== expected.sessionKey ||
    data.lane !== expected.lane ||
    data.turn !== expected.turn ||
    data.step !== expected.step ||
    data.attempt !== expected.attempt ||
    data.triggerSeq !== expected.triggerSeq ||
    typeof data.effectId !== 'string' ||
    !EFFECT_ID.test(data.effectId) ||
    typeof data.headerHash !== 'string' ||
    !HASH.test(data.headerHash) ||
    typeof data.mediaHash !== 'string' ||
    !HASH.test(data.mediaHash)
  )
    invalid('auxiliary media preflight binding is invalid')
  const checked = validateRequestMedia(data.header)
  if (!checked.ok || checked.value.media.route !== 'auxiliary-vision')
    invalid('auxiliary media preflight header is invalid')
  const header = safeJson(checked.value.media) as RequestMediaHeader
  if (sha256Hex(canonicalJson(header)) !== data.headerHash)
    invalid('auxiliary media preflight header hash differs')
  return Object.freeze({ header, mediaHash: data.mediaHash, effectId: data.effectId })
}

export function auxiliaryVisionEffectId(binding: Binding, mediaHash: string): string {
  return `aux:${binding.turn}:${binding.step}:${binding.triggerSeq}:${mediaHash.slice(0, 32)}`
}

export async function loadAuxiliaryVisionPreflight(
  session: SessionImpl,
  binding: Binding,
): Promise<AuxiliaryVisionPreflight | undefined> {
  const rows: Event[] = []
  const pages = scanPages((q) => session.d.log.scan(q), {
    fromSeq: binding.triggerSeq,
    toSeq: session.lastSeq,
    type: EVENT,
    lane: session.lane,
  })
  for await (const page of pages) {
    rows.push(...page)
    if (rows.length > 1_000) invalid('auxiliary media preflight scan exceeds its bound')
  }
  const matching = rows.filter((row) => {
    try {
      const data = record(row.data, [
        'version',
        'sessionKey',
        'lane',
        'turn',
        'step',
        'attempt',
        'triggerSeq',
        'effectId',
        'header',
        'headerHash',
        'mediaHash',
      ])
      return (
        data.turn === binding.turn && data.step === binding.step && data.triggerSeq === binding.triggerSeq
      )
    } catch {
      return invalid('malformed auxiliary media preflight exists in the active turn')
    }
  })
  if (matching.length > 1) invalid('auxiliary media preflight collision')
  const row = matching[0]
  return row ? parse(row.data, binding) : undefined
}

export async function persistAuxiliaryVisionPreflight(
  session: SessionImpl,
  binding: Binding,
  media: LedgerPreparedRequestMedia,
): Promise<AuxiliaryVisionPreflight> {
  const mediaHash = sha256Hex(canonicalJson(media.hashMaterial))
  const effectId = auxiliaryVisionEffectId(binding, mediaHash)
  const header = safeJson(media.header) as RequestMediaHeader
  const headerHash = sha256Hex(canonicalJson(header))
  await session.append([
    session.ev(
      EVENT,
      { version: 1, ...binding, effectId, header, headerHash, mediaHash },
      { ignorable: true },
    ),
  ])
  return Object.freeze({ header, mediaHash, effectId })
}

export function verifyAuxiliaryVisionPreflightMedia(
  preflight: AuxiliaryVisionPreflight,
  media: LedgerPreparedRequestMedia,
  binding: Binding,
): void {
  const mediaHash = sha256Hex(canonicalJson(media.hashMaterial))
  if (mediaHash !== preflight.mediaHash || preflight.effectId !== auxiliaryVisionEffectId(binding, mediaHash))
    invalid('restored auxiliary media differs from its durable preflight')
}
