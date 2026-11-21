import { types as utilTypes } from 'node:util'
import type {
  ArtifactAuthorityBinding,
  ArtifactAuthorityWriteResult,
} from '@agnes/daemon-rpc/local/artifact-read-authority'
import type { ArtifactReadScopeAuthority } from '@agnes/daemon-rpc/local/methods/artifacts'
import { type ArtifactRef, sessionArtifactRoots, validateEvent } from '@agnes/protocol'

export type TrustedArtifactOwnership = Readonly<{
  resolve(sessionId: string, signal: AbortSignal): Promise<unknown>
}>
export type TrustedArtifactInspector = Readonly<{
  inspect(identity: Readonly<{ sha256: string; mime: string }>, signal: AbortSignal): Promise<unknown>
}>
export type TrustedArtifactHistory = Readonly<{
  read(sessionId: string, laneId: string, signal: AbortSignal): Promise<readonly unknown[]>
}>
export type ArtifactAuthorityProjectionWriter = Readonly<{
  append(writer: unknown, binding: unknown): ArtifactAuthorityWriteResult
  revoke(writer: unknown, binding: unknown): ArtifactAuthorityWriteResult
}>

type LaneState = {
  ownerId: string
  bindings: Map<string, ArtifactAuthorityBinding>
}
type EpochState = {
  session: number
  lanes: Map<string, number>
  revokedSession: boolean
  revokedLanes: Set<string>
}

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
      !Number.isInteger(d.size?.value) ||
      (d.size?.value as number) < 0
    )
      return
    return Object.freeze({ sha256, mime, size: d.size?.value as number })
  } catch {
    return
  }
}

type ProjectionEpoch = Readonly<{ session: number; lane: number }>
type SharedColdLoad = {
  promise: Promise<void>
  controller: AbortController
  waiters: number
  settled: boolean
}

function recordedArtifactScope(input: {
  ownership: TrustedArtifactOwnership
  history: TrustedArtifactHistory | undefined
  lanes: Map<string, Map<string, LaneState>>
  epoch(sessionId: string, laneId: string): ProjectionEpoch
  current(sessionId: string, laneId: string, observed: ProjectionEpoch): boolean
  coldAllowed(sessionId: string, laneId: string): boolean
  projectRoots(
    sessionId: string,
    laneId: string,
    roots: readonly Readonly<{ sha256: string; mime: string; size?: number }>[],
    signal: AbortSignal,
    observed: ProjectionEpoch,
    expectedOwner: string,
    cold?: boolean,
  ): Promise<void>
}): ArtifactReadScopeAuthority {
  const { ownership, history, lanes, epoch, current, coldAllowed, projectRoots } = input
  const coldLoads = new Map<string, SharedColdLoad>()
  const scopeResolve: ArtifactReadScopeAuthority['resolve'] = async (target, signal) => {
    if (signal.aborted) return undefined
    let state = lanes.get(target.sessionId)?.get(target.laneId)
    const observedEpoch = epoch(target.sessionId, target.laneId)
    try {
      let currentOwner = owner(await ownership.resolve(target.sessionId, signal))
      if (
        !currentOwner ||
        currentOwner !== target.principalId ||
        signal.aborted ||
        !current(target.sessionId, target.laneId, observedEpoch)
      )
        return undefined
      if (!state && history && coldAllowed(target.sessionId, target.laneId)) {
        const key = JSON.stringify([target.sessionId, target.laneId])
        let load = coldLoads.get(key)
        if (!load) {
          if (coldLoads.size >= 4096) return undefined
          const source = history
          const controller = new AbortController()
          const loadEpoch = observedEpoch
          const loadOwner = currentOwner
          const entry: SharedColdLoad = {
            promise: Promise.resolve(),
            controller,
            waiters: 0,
            settled: false,
          }
          entry.promise = (async () => {
            const events = await source.read(target.sessionId, target.laneId, controller.signal)
            if (!Array.isArray(events) || utilTypes.isProxy(events) || events.length > 4096)
              throw unavailable()
            const roots = new Map<string, Readonly<{ sha256: string; mime: string; size?: number }>>()
            for (const raw of events) {
              const checked = validateEvent(raw)
              if (!checked.ok || (checked.value.lane ?? 'main') !== target.laneId) throw unavailable()
              for (const ref of sessionArtifactRoots(
                checked.value as import('@agnes/protocol').EventEnvelope,
              ) ?? []) {
                const identity = `${ref.sha256}:${ref.mime}`
                const previous = roots.get(identity)
                if (previous?.size !== undefined && ref.size !== undefined && previous.size !== ref.size)
                  throw unavailable()
                if (!previous || ref.size !== undefined) roots.set(identity, ref)
                if (roots.size > 4096) throw unavailable()
              }
            }
            if (
              controller.signal.aborted ||
              !coldAllowed(target.sessionId, target.laneId) ||
              !current(target.sessionId, target.laneId, loadEpoch)
            )
              throw unavailable()
            if (roots.size)
              await projectRoots(
                target.sessionId,
                target.laneId,
                [...roots.values()],
                controller.signal,
                loadEpoch,
                loadOwner,
                true,
              )
          })()
          coldLoads.set(key, entry)
          const finish = () => {
            entry.settled = true
            if (coldLoads.get(key) === entry) coldLoads.delete(key)
          }
          void entry.promise.then(finish, finish)
          load = entry
        }
        const activeLoad = load
        activeLoad.waiters += 1
        let left = false
        const leave = () => {
          if (left) return
          left = true
          activeLoad.waiters -= 1
          if (activeLoad.waiters <= 0 && !activeLoad.settled) {
            if (coldLoads.get(key) === activeLoad) coldLoads.delete(key)
            activeLoad.controller.abort()
          }
        }
        if (signal.aborted) {
          leave()
          return undefined
        }
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            leave()
            reject(unavailable())
          }
          signal.addEventListener('abort', onAbort, { once: true })
          activeLoad.promise.then(
            () => {
              signal.removeEventListener('abort', onAbort)
              leave()
              resolve()
            },
            (err) => {
              signal.removeEventListener('abort', onAbort)
              leave()
              reject(err)
            },
          )
        })
        state = lanes.get(target.sessionId)?.get(target.laneId)
        currentOwner = owner(await ownership.resolve(target.sessionId, signal))
        if (!coldAllowed(target.sessionId, target.laneId)) return undefined
      }
      if (
        !state ||
        !currentOwner ||
        currentOwner !== state.ownerId ||
        currentOwner !== target.principalId ||
        signal.aborted ||
        !current(target.sessionId, target.laneId, observedEpoch) ||
        lanes.get(target.sessionId)?.get(target.laneId) !== state
      )
        return undefined
      return Object.freeze({
        sessionId: target.sessionId,
        laneId: target.laneId,
      })
    } catch {
      return undefined
    }
  }
  return Object.freeze({ resolve: scopeResolve })
}

function projectionConfiguration(input: unknown) {
  let writer: ArtifactAuthorityProjectionWriter
  let inspector: TrustedArtifactInspector
  let ownership: TrustedArtifactOwnership
  let history: TrustedArtifactHistory | undefined
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
      Reflect.ownKeys(descriptors).length !== (Object.hasOwn(descriptors, 'history') ? 4 : 3) ||
      !['writer', 'inspector', 'ownership'].every(
        (name) => descriptors[name]?.enumerable && Object.hasOwn(descriptors[name] ?? {}, 'value'),
      )
    )
      throw unavailable()
    writer = exactMethods<ArtifactAuthorityProjectionWriter>(descriptors.writer?.value, ['append', 'revoke'])
    inspector = exactMethods<TrustedArtifactInspector>(descriptors.inspector?.value, ['inspect'])
    ownership = exactMethods<TrustedArtifactOwnership>(descriptors.ownership?.value, ['resolve'])
    if (Object.hasOwn(descriptors, 'history')) {
      if (!descriptors.history?.enumerable || !Object.hasOwn(descriptors.history, 'value'))
        throw unavailable()
      history = exactMethods<TrustedArtifactHistory>(descriptors.history.value, ['read'])
    }
  } catch {
    throw unavailable()
  }
  return Object.freeze({ writer, inspector, ownership, history })
}

function createEpochTracker() {
  const epochs = new Map<string, EpochState>()
  const ensure = (sessionId: string): EpochState => {
    let state = epochs.get(sessionId)
    if (!state) {
      state = {
        session: 0,
        lanes: new Map<string, number>(),
        revokedSession: false,
        revokedLanes: new Set<string>(),
      }
      epochs.set(sessionId, state)
    }
    return state
  }
  return {
    epoch(sessionId: string, laneId: string): ProjectionEpoch {
      const state = epochs.get(sessionId)
      return Object.freeze({
        session: state?.session ?? 0,
        lane: state?.lanes.get(laneId) ?? 0,
      })
    },
    current(sessionId: string, laneId: string, observed: ProjectionEpoch): boolean {
      const state = epochs.get(sessionId)
      return (state?.session ?? 0) === observed.session && (state?.lanes.get(laneId) ?? 0) === observed.lane
    },
    coldAllowed(sessionId: string, laneId: string): boolean {
      const state = epochs.get(sessionId)
      return !state?.revokedSession && !state?.revokedLanes.has(laneId)
    },
    bumpLane(sessionId: string, laneId: string, revokeCold: boolean): void {
      const state = ensure(sessionId)
      state.lanes.set(laneId, (state.lanes.get(laneId) ?? 0) + 1)
      if (revokeCold) state.revokedLanes.add(laneId)
    },
    bumpSession(sessionId: string, revokeCold: boolean): void {
      const state = ensure(sessionId)
      state.session += 1
      state.lanes.clear()
      if (revokeCold) {
        state.revokedSession = true
        state.revokedLanes.clear()
      }
    },
  }
}

function createRootProjector(input: {
  writer: ArtifactAuthorityProjectionWriter
  inspector: TrustedArtifactInspector
  ownership: TrustedArtifactOwnership
  lanes: Map<string, Map<string, LaneState>>
  epoch(sessionId: string, laneId: string): ProjectionEpoch
  current(sessionId: string, laneId: string, observed: ProjectionEpoch): boolean
}) {
  const { writer, inspector, ownership, lanes, epoch, current } = input
  return async (
    sessionId: string,
    laneId: string,
    roots: readonly Readonly<{ sha256: string; mime: string; size?: number }>[],
    signal: AbortSignal,
    observedEpoch = epoch(sessionId, laneId),
    expectedOwner?: string,
    cold = false,
  ) => {
    const appended: ArtifactAuthorityBinding[] = []
    try {
      const ownerId = owner(await ownership.resolve(sessionId, signal))
      if (
        !ownerId ||
        (expectedOwner !== undefined && ownerId !== expectedOwner) ||
        signal.aborted ||
        !current(sessionId, laneId, observedEpoch)
      )
        throw unavailable()
      const existingState = lanes.get(sessionId)?.get(laneId)
      if (existingState && existingState.ownerId !== ownerId) throw unavailable()
      const bindings: ArtifactAuthorityBinding[] = []
      for (const entry of roots) {
        // A Core registration attests storage, not this adapter's Web readability or byte limit.
        // Legacy roots have no size and still require the existing trusted inspector.
        const registered = existingState?.bindings.get(`${entry.sha256}:${entry.mime}`)?.artifact
        let inspected: unknown
        if (entry.size !== undefined) inspected = entry
        else if (registered !== undefined) inspected = registered
        else {
          try {
            inspected = await inspector.inspect({ sha256: entry.sha256, mime: entry.mime }, signal)
          } catch {
            if (!cold || signal.aborted || !current(sessionId, laneId, observedEpoch)) throw unavailable()
            continue
          }
        }
        const ref = artifact(inspected, entry.sha256, entry.mime)
        if (signal.aborted || !current(sessionId, laneId, observedEpoch)) throw unavailable()
        if (!ref) {
          if (cold && entry.size === undefined) continue
          throw unavailable()
        }
        bindings.push(Object.freeze({ sessionId, laneId, ownerId, artifact: ref }))
      }
      if (cold && bindings.length === 0) return
      const confirmedOwner = owner(await ownership.resolve(sessionId, signal))
      if (confirmedOwner !== ownerId || signal.aborted || !current(sessionId, laneId, observedEpoch))
        throw unavailable()
      for (const binding of bindings) {
        if (!current(sessionId, laneId, observedEpoch)) throw unavailable()
        const result = writer.append(
          {
            permission: 'append',
            sessionId,
            laneId: binding.laneId,
            principalId: ownerId,
          },
          binding,
        )
        if (!result.ok) throw unavailable()
        if (result.code === 'appended') appended.push(binding)
      }
      if (!current(sessionId, laneId, observedEpoch)) throw unavailable()
      const session = lanes.get(sessionId) ?? new Map<string, LaneState>()
      const state = session.get(laneId) ?? { ownerId, bindings: new Map() }
      if (state.ownerId !== ownerId) throw unavailable()
      for (const binding of bindings)
        state.bindings.set(`${binding.artifact.sha256}:${binding.artifact.mime}`, binding)
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
}

/** Projects trusted storage registrations and legacy media roots into durable read authority. */
export function createArtifactAuthorityProjection(
  input: Readonly<{
    writer: ArtifactAuthorityProjectionWriter
    inspector: TrustedArtifactInspector
    ownership: TrustedArtifactOwnership
    history?: TrustedArtifactHistory
  }>,
): Readonly<{
  observe(sessionId: string, event: unknown, signal: AbortSignal): Promise<void>
  revokeLane(sessionId: string, laneId: string): void
  resetSession(sessionId: string): void
  detachSession(sessionId: string): void
  scope: ArtifactReadScopeAuthority
}> {
  const { writer, inspector, ownership, history } = projectionConfiguration(input)
  const lanes = new Map<string, Map<string, LaneState>>()
  const { epoch, current, coldAllowed, bumpLane, bumpSession } = createEpochTracker()
  const projectRoots = createRootProjector({ writer, inspector, ownership, lanes, epoch, current })
  const observe = async (sessionId: string, raw: unknown, signal: AbortSignal) => {
    try {
      const checked = validateEvent(raw)
      if (!checked.ok || signal.aborted) return
      const event = checked.value as import('@agnes/protocol').EventEnvelope
      const roots = sessionArtifactRoots(event)
      if (roots?.length) await projectRoots(sessionId, event.lane ?? 'main', roots, signal)
    } catch {
      throw unavailable()
    }
  }
  const revokeLane = (sessionId: string, laneId: string) => {
    bumpLane(sessionId, laneId, true)
    const session = lanes.get(sessionId)
    const state = session?.get(laneId)
    session?.delete(laneId)
    if (session?.size === 0) lanes.delete(sessionId)
    if (!state) return
    let failed = false
    for (const binding of state.bindings.values()) {
      try {
        const result = writer.revoke(
          {
            permission: 'revoke',
            sessionId,
            laneId,
            principalId: state.ownerId,
          },
          binding,
        )
        if (!result.ok) failed = true
      } catch {
        failed = true
      }
    }
    if (failed) throw revocationUnavailable()
  }
  const clearSession = (sessionId: string, revokeCold: boolean) => {
    bumpSession(sessionId, revokeCold)
    const session = lanes.get(sessionId)
    lanes.delete(sessionId)
    if (!session) return
    let failed = false
    for (const [laneId, state] of session) {
      for (const binding of state.bindings.values()) {
        try {
          const result = writer.revoke(
            {
              permission: 'revoke',
              sessionId,
              laneId,
              principalId: state.ownerId,
            },
            binding,
          )
          if (!result.ok) failed = true
        } catch {
          failed = true
        }
      }
    }
    if (failed) throw revocationUnavailable()
  }
  const scope = recordedArtifactScope({
    ownership,
    history,
    lanes,
    epoch,
    current,
    coldAllowed,
    projectRoots,
  })
  return Object.freeze({
    observe,
    revokeLane,
    resetSession(sessionId: string) {
      clearSession(sessionId, true)
    },
    detachSession(sessionId: string) {
      clearSession(sessionId, false)
    },
    scope,
  })
}
