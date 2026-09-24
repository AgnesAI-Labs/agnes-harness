import { types as utilTypes } from 'node:util'
import { consumeAuxiliaryVisionNotDispatchedAuthority } from '../orchestrator/auxiliary-vision-assembly.js'
import {
  consumeAuxiliaryVisionExecutorFallbackAuthority,
  consumeAuxiliaryVisionTerminalAuthority,
} from '../orchestrator/auxiliary-vision-executor.js'
import {
  isLedgerPreparedRequestMedia,
  type LedgerPreparedRequestMedia,
} from '../orchestrator/request-media-surface.js'
import { canonicalJson, sha256Hex } from './hash.js'

const MAX_DERIVED_TEXT_BYTES = 1_048_576

declare const brand: unique symbol
export type AuxiliaryVisionDerivedText = Readonly<{ readonly [brand]: true }>

type Projection = Readonly<{
  sessionKey: string
  media: LedgerPreparedRequestMedia
  text: string
  bindingHash: string
}>

const projections = new WeakMap<object, Projection>()

function exactInput(value: unknown): Readonly<Record<string, unknown>> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value))
      throw new TypeError()
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const fields = ['lane', 'media', 'sessionKey', 'terminalOutcome']
    if (
      Reflect.ownKeys(descriptors).length !== fields.length ||
      fields.some((field) => {
        const descriptor = descriptors[field]
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      }) ||
      Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !fields.includes(key))
    )
      throw new TypeError()
    const snapshot = Object.create(null) as Record<string, unknown>
    for (const field of fields) snapshot[field] = descriptors[field]?.value
    return Object.freeze(snapshot)
  } catch {
    throw new TypeError('auxiliary vision derived-text input is invalid')
  }
}

/**
 * Binds an auxiliary result to the exact media and session that produced it. The returned object
 * has no readable payload; only request derivation can consume its private WeakMap authority.
 */
export function prepareAuxiliaryVisionDerivedText(
  input: Readonly<{
    sessionKey: string
    lane: string
    media: LedgerPreparedRequestMedia
    terminalOutcome: unknown
  }>,
): AuxiliaryVisionDerivedText {
  const snapshot = exactInput(input)
  const media = snapshot.media
  const sessionKey = snapshot.sessionKey
  const lane = snapshot.lane
  if (!isLedgerPreparedRequestMedia(media) || media.header.route !== 'auxiliary-vision')
    throw new TypeError('auxiliary vision media authority is invalid')
  if (typeof sessionKey !== 'string' || media.sessionKey !== sessionKey || !sessionKey)
    throw new TypeError('auxiliary vision media belongs to a different session')
  if (typeof lane !== 'string' || !lane)
    throw new TypeError('auxiliary vision terminal belongs to a different lane')
  if (media.selected.length < 1) throw new TypeError('auxiliary vision media has no selected image')
  const terminal = consumeAuxiliaryVisionTerminalAuthority(snapshot.terminalOutcome)
  const executorFallback = consumeAuxiliaryVisionExecutorFallbackAuthority(snapshot.terminalOutcome)
  const notDispatched = consumeAuxiliaryVisionNotDispatchedAuthority(snapshot.terminalOutcome)
  const result = terminal ?? executorFallback ?? notDispatched
  if (!result) throw new TypeError('auxiliary vision outcome lacks a controlled settlement authority')
  const manifestHash = sha256Hex(canonicalJson(media.hashMaterial))
  if (result.sessionKey !== sessionKey || result.lane !== lane || result.mediaManifestHash !== manifestHash)
    throw new TypeError('auxiliary vision terminal authority does not match request media')
  const text = result.outcome.untrustedDerivedText
  if (Buffer.byteLength(text, 'utf8') > MAX_DERIVED_TEXT_BYTES)
    throw new TypeError('auxiliary vision derived text is invalid')
  const bindingHash = sha256Hex(
    canonicalJson({
      sessionKey,
      lane,
      media: media.hashMaterial,
      settlement: terminal
        ? {
            kind: 'terminal',
            effectId: terminal.effectId,
            terminalSeq: terminal.terminalSeq,
            terminalHash: terminal.terminalHash,
          }
        : executorFallback
          ? {
              kind: executorFallback.state,
              effectId: executorFallback.effectId,
              reason: executorFallback.reason,
            }
          : { kind: 'not_dispatched', reason: notDispatched?.reason },
      text,
    }),
  )
  const authority = Object.freeze(Object.create(null)) as AuxiliaryVisionDerivedText
  projections.set(authority, Object.freeze({ sessionKey, media, text, bindingHash }))
  return authority
}

export function consumeAuxiliaryVisionDerivedText(
  authority: AuxiliaryVisionDerivedText,
  media: LedgerPreparedRequestMedia,
  sessionKey: string,
): Readonly<{ text: string; bindingHash: string }> {
  const projection =
    authority && typeof authority === 'object' && !utilTypes.isProxy(authority)
      ? projections.get(authority)
      : undefined
  if (!projection || projection.media !== media || projection.sessionKey !== sessionKey)
    throw new TypeError('auxiliary vision derived text authority does not match request media')
  return Object.freeze({ text: projection.text, bindingHash: projection.bindingHash })
}
