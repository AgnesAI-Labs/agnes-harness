import { types as utilTypes } from 'node:util'
import { type ArtifactRef, type EventEnvelope, validateEvent } from '@agnes/protocol'
import type {
  ArtifactAuthorityBinding,
  ArtifactAuthorityWriteResult,
} from '../local/artifact-read-authority.js'
import type { ArtifactReadScopeAuthority } from '../local/methods/artifacts.js'

const MAX_ROOTS_PER_HEADER = 256
const ARTIFACT_URI = /^artifact:\/\/([0-9a-f]{64})$/u

export type TrustedArtifactOwnership = Readonly<{
  resolve(sessionId: string, signal: AbortSignal): Promise<unknown>
}>
export type TrustedArtifactInspector = Readonly<{
  inspect(identity: Readonly<{ sha256: string; mime: string }>, signal: AbortSignal): Promise<unknown>
}>
export type ArtifactAuthorityProjectionWriter = Readonly<{
  append(writer: unknown, binding: unknown): ArtifactAuthorityWriteResult
  revoke(writer: unknown, binding: unknown): ArtifactAuthorityWriteResult
}>

type LaneState = { ownerId: string; bindings: Map<string, ArtifactAuthorityBinding> }
type EpochState = { session: number; lanes: Map<string, number> }

function unavailable(): Error {
  return new Error('artifact authority projection unavailable')
}

function revocationUnavailable(): Error {
  return new Error('artifact authority revocation unavailable')
}

function exactMethods<T extends object>(value: unknown, names: readonly string[]): T {
  try {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      utilTypes.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      throw unavailable()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      Reflect.ownKeys(descriptors).length !== names.length ||
      names.some((name) => {
        const descriptor = descriptors[name]
        return (
          !descriptor?.enumerable ||
          !Object.hasOwn(descriptor, 'value') ||
          typeof descriptor.value !== 'function' ||
          utilTypes.isProxy(descriptor.value)
        )
      })
    )
      throw unavailable()
    const snapshot = Object.create(null) as Record<string, unknown>
    for (const name of names) {
      const method = descriptors[name]?.value as (...args: unknown[]) => unknown
      snapshot[name] = (...args: unknown[]) => Reflect.apply(method, value, args)
    }
    return Object.freeze(snapshot) as T
  } catch {
    throw unavailable()
  }
}

function owner(value: unknown): string | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      Reflect.ownKeys(descriptors).length !== 2 ||
      descriptors.active?.value !== true ||
      descriptors.principalId?.enumerable !== true ||
      !Object.hasOwn(descriptors.principalId ?? {}, 'value')
    )
      return
    const principalId = descriptors.principalId?.value
    return typeof principalId === 'string' && principalId.length > 0 && principalId.length <= 512
      ? principalId
      : undefined
  } catch {
    return
  }
}

function artifact(value: unknown, sha256: string, mime: string): ArtifactRef | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return
    const d = Object.getOwnPropertyDescriptors(value)
    if (
      Reflect.ownKeys(d).length !== 3 ||
      d.sha256?.value !== sha256 ||
      d.mime?.value !== mime ||
      !Number.isSafeInteger(d.size?.value) ||
      (d.size?.value as number) < 0
    )
      return
    return Object.freeze({ sha256, mime, size: d.size?.value as number })
  } catch {
    return
  }
}

function mediaRoots(event: EventEnvelope): readonly Readonly<{ sha256: string; mime: string }>[] | undefined {
  if (event.type === 'request/header') {
    if (event.origin !== 'system' || event.trust !== 'trusted') return undefined
    const data = event.data as { media?: { manifest?: unknown } }
    if (!data.media) return undefined
    const manifest = data.media.manifest
    if (!Array.isArray(manifest) || manifest.length > MAX_ROOTS_PER_HEADER) throw unavailable()
    return manifest.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable()
      const entry = value as Record<string, unknown>
      if (
        typeof entry.sha256 !== 'string' ||
        typeof entry.mime !== 'string' ||
        entry.artifactUri !== `artifact://${entry.sha256}`
      )
        throw unavailable()
      return Object.freeze({ sha256: entry.sha256, mime: entry.mime })
    })
  }
  if (event.type !== 'tool/result') return undefined
  const data = event.data as { content?: unknown; isError?: unknown }
  if (event.origin !== 'tool:computer_use' || event.trust !== 'untrusted' || data.isError !== false)
    return undefined
  if (!Array.isArray(data.content)) return undefined
  const roots = new Map<string, Readonly<{ sha256: string; mime: string }>>()
  for (const value of data.content) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const block = value as Record<string, unknown>
    if (block.type !== 'resource_link') continue
    const match = typeof block.uri === 'string' ? ARTIFACT_URI.exec(block.uri) : null
    if (!match || (block.mimeType !== 'image/png' && block.mimeType !== 'image/jpeg')) continue
    const sha256 = match[1] as string
    roots.set(`${sha256}:${block.mimeType}`, Object.freeze({ sha256, mime: block.mimeType }))
    if (roots.size > MAX_ROOTS_PER_HEADER) throw unavailable()
  }
  return [...roots.values()]
}

/** Projects validated tool-result image refs and persisted request-media roots into durable authority. */
export function createArtifactAuthorityProjection(
  input: Readonly<{
    writer: ArtifactAuthorityProjectionWriter
    inspector: TrustedArtifactInspector
    ownership: TrustedArtifactOwnership
  }>,
): Readonly<{
  observe(sessionId: string, event: unknown, signal: AbortSignal): Promise<void>
  revokeLane(sessionId: string, laneId: string): void
  resetSession(sessionId: string): void
  scope: ArtifactReadScopeAuthority
}> {
  let writer: ArtifactAuthorityProjectionWriter
  let inspector: TrustedArtifactInspector
  let ownership: TrustedArtifactOwnership
  try {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      utilTypes.isProxy(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    )
      throw unavailable()
    const descriptors = Object.getOwnPropertyDescriptors(input)
    if (
      Reflect.ownKeys(descriptors).length !== 3 ||
      !['writer', 'inspector', 'ownership'].every(
        (name) => descriptors[name]?.enumerable && Object.hasOwn(descriptors[name] ?? {}, 'value'),
      )
    )
      throw unavailable()
    writer = exactMethods<ArtifactAuthorityProjectionWriter>(descriptors.writer?.value, ['append', 'revoke'])
    inspector = exactMethods<TrustedArtifactInspector>(descriptors.inspector?.value, ['inspect'])
    ownership = exactMethods<TrustedArtifactOwnership>(descriptors.ownership?.value, ['resolve'])
  } catch {
    throw unavailable()
  }
  const lanes = new Map<string, Map<string, LaneState>>()
  const epochs = new Map<string, EpochState>()
  const epoch = (sessionId: string, laneId: string) => {
    const state = epochs.get(sessionId) ?? { session: 0, lanes: new Map<string, number>() }
    epochs.set(sessionId, state)
    return Object.freeze({ session: state.session, lane: state.lanes.get(laneId) ?? 0 })
  }
  const current = (sessionId: string, laneId: string, observed: { session: number; lane: number }) => {
    const state = epochs.get(sessionId)
    return !!state && state.session === observed.session && (state.lanes.get(laneId) ?? 0) === observed.lane
  }
  const bumpLane = (sessionId: string, laneId: string) => {
    const state = epochs.get(sessionId) ?? { session: 0, lanes: new Map<string, number>() }
    state.lanes.set(laneId, (state.lanes.get(laneId) ?? 0) + 1)
    epochs.set(sessionId, state)
  }
  const bumpSession = (sessionId: string) => {
    const state = epochs.get(sessionId) ?? { session: 0, lanes: new Map<string, number>() }
    state.session += 1
    state.lanes.clear()
    epochs.set(sessionId, state)
  }
  const observe = async (sessionId: string, raw: unknown, signal: AbortSignal) => {
    const appended: ArtifactAuthorityBinding[] = []
    try {
      const checked = validateEvent(raw)
      if (!checked.ok || signal.aborted) return
      const event = checked.value as EventEnvelope
      const roots = mediaRoots(event)
      if (!roots?.length) return
      const laneId = event.lane ?? 'main'
      const observedEpoch = epoch(sessionId, laneId)
      const ownerId = owner(await ownership.resolve(sessionId, signal))
      if (!ownerId || signal.aborted || !current(sessionId, laneId, observedEpoch)) throw unavailable()
      const existingState = lanes.get(sessionId)?.get(laneId)
      if (existingState && existingState.ownerId !== ownerId) throw unavailable()
      const bindings: ArtifactAuthorityBinding[] = []
      for (const entry of roots) {
        const ref = artifact(
          await inspector.inspect({ sha256: entry.sha256, mime: entry.mime }, signal),
          entry.sha256,
          entry.mime,
        )
        if (!ref || signal.aborted || !current(sessionId, laneId, observedEpoch)) throw unavailable()
        bindings.push(Object.freeze({ sessionId, laneId, ownerId, artifact: ref }))
      }
      const confirmedOwner = owner(await ownership.resolve(sessionId, signal))
      if (confirmedOwner !== ownerId || signal.aborted || !current(sessionId, laneId, observedEpoch))
        throw unavailable()
      for (const binding of bindings) {
        if (!current(sessionId, laneId, observedEpoch)) throw unavailable()
        const result = writer.append(
          { permission: 'append', sessionId, laneId: binding.laneId, principalId: ownerId },
          binding,
        )
        if (!result.ok) throw unavailable()
        if (result.code === 'appended') appended.push(binding)
      }
      if (!current(sessionId, laneId, observedEpoch)) throw unavailable()
      const session = lanes.get(sessionId) ?? new Map<string, LaneState>()
      const state = existingState ?? { ownerId, bindings: new Map() }
      for (const binding of bindings) state.bindings.set(binding.artifact.sha256, binding)
      session.set(laneId, state)
      lanes.set(sessionId, session)
    } catch {
      for (const binding of appended) {
        try {
          writer.revoke(
            {
              permission: 'revoke',
              sessionId: binding.sessionId,
              laneId: binding.laneId,
              principalId: binding.ownerId,
            },
            binding,
          )
        } catch {
          // Preserve the fixed outer failure; rollback errors never replace or disclose it.
        }
      }
      throw unavailable()
    }
  }
  const revokeLane = (sessionId: string, laneId: string) => {
    bumpLane(sessionId, laneId)
    const session = lanes.get(sessionId)
    const state = session?.get(laneId)
    session?.delete(laneId)
    if (session?.size === 0) lanes.delete(sessionId)
    if (!state) return
    let failed = false
    for (const binding of state.bindings.values()) {
      try {
        const result = writer.revoke(
          { permission: 'revoke', sessionId, laneId, principalId: state.ownerId },
          binding,
        )
        if (!result.ok) failed = true
      } catch {
        failed = true
      }
    }
    if (failed) throw revocationUnavailable()
  }
  const scopeResolve: ArtifactReadScopeAuthority['resolve'] = async (target, signal) => {
    const state = lanes.get(target.sessionId)?.get(target.laneId)
    if (!state || signal.aborted) return undefined
    const observedEpoch = epoch(target.sessionId, target.laneId)
    try {
      const currentOwner = owner(await ownership.resolve(target.sessionId, signal))
      if (
        !currentOwner ||
        currentOwner !== state.ownerId ||
        currentOwner !== target.principalId ||
        signal.aborted ||
        !current(target.sessionId, target.laneId, observedEpoch) ||
        lanes.get(target.sessionId)?.get(target.laneId) !== state
      )
        return undefined
      return Object.freeze({ sessionId: target.sessionId, laneId: target.laneId })
    } catch {
      return undefined
    }
  }
  return Object.freeze({
    observe,
    revokeLane,
    resetSession(sessionId: string) {
      bumpSession(sessionId)
      const session = lanes.get(sessionId)
      lanes.delete(sessionId)
      if (!session) return
      let failed = false
      for (const [laneId, state] of session) {
        for (const binding of state.bindings.values()) {
          try {
            const result = writer.revoke(
              { permission: 'revoke', sessionId, laneId, principalId: state.ownerId },
              binding,
            )
            if (!result.ok) failed = true
          } catch {
            failed = true
          }
        }
      }
      if (failed) throw revocationUnavailable()
    },
    scope: Object.freeze({ resolve: scopeResolve }),
  })
}
