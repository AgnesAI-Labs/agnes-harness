import { settlesWithin } from '@agnes/core-effects/effects/wrap'
import { sessionIdentity } from '../loop/scope.js'
import type { SessionImpl } from '../step/session.js'

/** The longest a closing session waits for its maintenance calls when it names no bound of its own. */
const DEFAULT_DRAIN_MS = 30_000

/** A maintenance call of this process, from its admission until its settlement is written or refused. */
type Running = { readonly settled: Promise<void>; readonly cut: () => void }

type Registry = { calls: Map<string, Running>; closing: boolean }

/**
 * Maintenance calls running in this process, by session. Kept apart from the side calls of a turn:
 * a turn's end, its drain and its interruption neither wait for nor cut these.
 */
const registries = new WeakMap<object, Registry>()

const registryOf = (s: SessionImpl): Registry => {
  const owner = sessionIdentity(s)
  let registry = registries.get(owner)
  if (!registry) {
    registry = { calls: new Map(), closing: false }
    registries.set(owner, registry)
  }
  return registry
}

/** The effect ids of this session's maintenance calls running in this process. */
export function maintenanceInFlight(s: SessionImpl): ReadonlySet<string> {
  return new Set(registries.get(sessionIdentity(s))?.calls.keys() ?? [])
}

/** Whether the session has begun to close, after which no maintenance call is admitted. */
export function maintenanceClosing(s: SessionImpl): boolean {
  return registries.get(sessionIdentity(s))?.closing === true
}

/**
 * Registers a call before its first await, so a close that starts at any later point waits for it.
 * Returns undefined when the session is closing or the id is already running; `cut` is what a close
 * that runs out of time calls, and `release` reports the call settled.
 */
export function claimMaintenance(
  s: SessionImpl,
  effectId: string,
  cut: () => void,
): { release: () => void } | 'closing' | 'running' {
  const registry = registryOf(s)
  // A close sets the registry's flag only when its drain runs; the session knows from its first line.
  if (registry.closing || s.closingOrClosed) return 'closing'
  if (registry.calls.has(effectId)) return 'running'
  let release!: () => void
  const settled = new Promise<void>((resolve) => {
    release = resolve
  })
  registry.calls.set(effectId, { settled, cut })
  return {
    release() {
      if (registry.calls.get(effectId)?.settled !== settled) return
      registry.calls.delete(effectId)
      release()
    },
  }
}

/**
 * The close of a session: refuses new calls, waits up to `closeDrainMs` for the running ones to
 * finish on their own, then cuts what is left and waits for those settlements too. A cut call that
 * may have reached the provider settles as unknown; one that had not, as not sent.
 */
export async function drainMaintenance(s: SessionImpl): Promise<void> {
  const registry = registryOf(s)
  registry.closing = true
  if (registry.calls.size === 0) return
  const bound = s.d.closeDrainMs ?? DEFAULT_DRAIN_MS
  const all = () => Promise.allSettled([...registry.calls.values()].map((call) => call.settled))
  if (await settlesWithin(all(), bound)) return
  for (const call of registry.calls.values()) call.cut()
  if (!(await settlesWithin(all(), bound)))
    s.d.logger.warn('session closed with maintenance calls still in flight', {
      sessionKey: s.key,
      pending: registry.calls.size,
    })
}
