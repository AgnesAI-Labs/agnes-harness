import { CoreError } from '@agnes/core'
import type { DecisionBackend, PreparedModelCall } from '@agnes/jev-runtime'
import type { DecisionBackendStatus, JsonValue, RuntimeTurnOptions } from '@agnes/protocol'
import { jcs } from '@agnes/protocol'
import { createDecisionBackend, type DecisionConnection } from '@agnes/runtime-jev'
import { captureJevPriceQuote } from './jev-pricing.js'

export type JevBackend = DecisionConnection['backend']
export interface JevDecisionTarget {
  decision: DecisionConnection
  requestCredits?: { decision?: number; language?: number }
}
export interface JevDecisionPool extends JevDecisionTarget {
  defaultDecisionBackend?: JevBackend
  backends?: Partial<Record<JevBackend, JevDecisionTarget>>
  unavailableBackends?: Partial<Record<JevBackend, string>>
}
export function decisionCoordinates(target: JevDecisionTarget) {
  const { backend, endpoint, model } = target.decision
  return { backend, endpoint, model }
}
export function decisionBackendStatus(options: JevDecisionPool): DecisionBackendStatus[] {
  const targets = { [options.decision.backend]: options, ...options.backends }
  return (['jev', 'laya'] as const).map((backend) => ({
    backend,
    label: backend === 'laya' ? 'Laya' : 'Jev',
    available: !!targets[backend],
    ...(!targets[backend]
      ? { unavailableReason: options.unavailableBackends?.[backend] ?? '决策后端未配置或未启用。' }
      : {}),
  }))
}

/** A round selects coordinates; each prepared call retains its own concrete transport owner. */
export function createJevDecisionPool(options: JevDecisionPool, now: () => number) {
  const targets: Partial<Record<JevBackend, JevDecisionTarget>> = {}
  const adapters = new Map<JevBackend, DecisionBackend>()
  const owners = new WeakMap<PreparedModelCall, DecisionBackend>()
  for (const [backend, supplied] of Object.entries({
    [options.decision.backend]: options,
    ...options.backends,
  })) {
    if (supplied.decision.backend !== backend)
      throw new CoreError('E_ENVELOPE', 'Decision backend identity mismatch')
    const target: JevDecisionTarget = {
      decision: Object.freeze({ ...supplied.decision }),
      ...(supplied.requestCredits ? { requestCredits: structuredClone(supplied.requestCredits) } : {}),
    }
    targets[backend as JevBackend] = target
    adapters.set(
      backend as JevBackend,
      createDecisionBackend({
        ...target.decision,
        pricing:
          target.decision.pricing ?? (() => captureJevPriceQuote({ ...target.decision, admittedAt: now() })),
      }),
    )
  }
  const configuredDefault = options.defaultDecisionBackend ?? options.decision.backend
  /** Boot resolution only: an unavailable configured default falls to the assembled primary. */
  const defaultBackend = targets[configuredDefault] ? configuredDefault : options.decision.backend
  let active = targets[defaultBackend] ?? targets[options.decision.backend]!
  const resolve = (backend: JevBackend): JevDecisionTarget => {
    const target = targets[backend]
    if (!target) throw new CoreError('E_UNSUPPORTED', 'Selected decision backend is unavailable', { backend })
    return target
  }
  return {
    defaultBackend,
    choices: () => Object.values(targets).map(decisionCoordinates),
    selection(runtimeOptions?: RuntimeTurnOptions): JsonValue {
      return decisionCoordinates(resolve(runtimeOptions?.decisionBackend ?? defaultBackend))
    },
    select(selection?: JsonValue) {
      if (selection === undefined) {
        active = resolve(defaultBackend)
        return
      }
      if (
        selection === null ||
        typeof selection !== 'object' ||
        Array.isArray(selection) ||
        (selection.backend !== 'jev' && selection.backend !== 'laya')
      )
        throw new CoreError('E_ENVELOPE', 'Invalid persisted decision selection')
      const target = resolve(selection.backend)
      if (jcs(selection) !== jcs(decisionCoordinates(target)))
        throw new CoreError(
          'E_RELATION',
          'Persisted decision target no longer matches the available connection',
        )
      active = target
    },
    current: () => active,
    backend: {
      async prepare(input, signal) {
        const owner = adapters.get(active.decision.backend)!
        const call = await owner.prepare(input, signal)
        owners.set(call, owner)
        return call
      },
      async invoke(call, signal) {
        const owner = owners.get(call)
        if (!owner) throw new CoreError('E_RELATION', 'Decision request has no prepared owner')
        owners.delete(call)
        return owner.invoke(call, signal)
      },
    } satisfies DecisionBackend,
    credits(call: PreparedModelCall) {
      const target = call.purpose === 'decision' ? targets[call.backend as JevBackend] : active
      return call.purpose === 'decision' ? target?.requestCredits?.decision : target?.requestCredits?.language
    },
  }
}
