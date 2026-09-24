import { defineExtension, type ExtensionAPI, type SessionRef } from '@agnes/extension-api'
import { allowsUpload, type ConsentLevel } from './consent.js'
import { egressReceipt } from './egress.js'
import { DEFAULT_RULES, type RedactRules, redact } from './redact.js'

type SessionEgressState = {
  active: boolean
  consent: ConsentLevel
  previous: string | null
  tail: Promise<void>
  commitFailure?: EgressCommitError
}

type TrajectoryLifecycle = {
  previous(session: SessionRef, signal: AbortSignal): Promise<string | null>
  upload(session: SessionRef, gate: EgressGate, signal: AbortSignal): Promise<void>
}

// Authority is the pair minted by the host: an ExtensionAPI instance cannot borrow a
// canonical SessionRef owned by another host/extension instance (and a copied ref cannot
// satisfy the inner WeakMap either).
const states = new WeakMap<ExtensionAPI, WeakMap<SessionRef, SessionEgressState>>()
const issuedGates = new WeakSet<object>()

/** Opaque runtime authority: plain objects matching EgressGate's shape are rejected. */
export const sessionEgressAuthority = Object.freeze({
  assert(gate: EgressGate): void {
    if (!issuedGates.has(gate)) throw new Error('trajectory egress gate was not minted by privacy')
  },
})

/** Records the receipt only after the caller has successfully sent the corresponding bytes. */
export async function recordEgress(
  agnes: ExtensionAPI,
  prev: string | null,
  bytes: Uint8Array,
  consent: ConsentLevel,
) {
  const receipt = egressReceipt(prev, bytes, consent)
  await agnes.events.append('egress', receipt)
  return receipt
}

export type EgressGate = {
  readonly active: boolean
  readonly consent: ConsentLevel
  /** Canonical identity whose consent and receipt chain this gate owns. */
  readonly session: SessionRef
  send(
    value: unknown,
    sender: (bytes: Uint8Array) => void | Promise<void>,
  ): Promise<{ bytes: Uint8Array; receipt: Awaited<ReturnType<typeof recordEgress>> }>
}

export class EgressCommitError extends Error {
  readonly sent = true
  readonly retrySafe = false
  readonly receipt: ReturnType<typeof egressReceipt>

  constructor(receipt: ReturnType<typeof egressReceipt>, cause: unknown) {
    super('egress was sent but its receipt could not be committed; automatic retry is unsafe', { cause })
    this.name = 'EgressCommitError'
    this.receipt = receipt
  }
}

/** One outbound gate: consent check, ANON redaction, successful send, then chained receipt. */
export function createSessionEgressGate(
  agnes: ExtensionAPI,
  session: SessionRef,
  rules: Partial<RedactRules> = {},
): EgressGate {
  const state = states.get(agnes)?.get(session)
  if (!state?.active) throw new Error('egress session is not active')
  const resolvedRules: RedactRules = {
    ...DEFAULT_RULES,
    ...rules,
    paths: rules.paths === undefined ? DEFAULT_RULES.paths : rules.paths,
    custom: rules.custom ?? DEFAULT_RULES.custom,
  }
  const gate: EgressGate = {
    get active() {
      return state.active
    },
    get session() {
      return session
    },
    get consent() {
      return state.active ? state.consent : 'DISABLED'
    },
    send(value, sender) {
      const run = async () => {
        if (!state.active) throw new Error('egress session is not active')
        if (state.commitFailure) throw state.commitFailure
        const consent = state.consent
        if (!allowsUpload(consent)) throw new Error(`consent ${consent} does not allow upload`)
        if (consent === 'ANON' && value instanceof Uint8Array)
          throw new Error('ANON egress requires redactable text or structured data')
        const outbound = consent === 'ANON' ? redact(value, resolvedRules) : value
        const text = typeof outbound === 'string' ? outbound : JSON.stringify(outbound)
        if (!(outbound instanceof Uint8Array) && text === undefined)
          throw new Error('egress value is not serializable')
        const bytes =
          outbound instanceof Uint8Array ? outbound.slice() : new TextEncoder().encode(text as string)
        const receipt = egressReceipt(state.previous, bytes, consent)
        await sender(bytes)
        try {
          await agnes.events.append('egress', receipt)
        } catch (error) {
          state.commitFailure = new EgressCommitError(receipt, error)
          throw state.commitFailure
        }
        state.previous = receipt.chain
        return { bytes, receipt }
      }
      const result = state.tail.then(run, run)
      state.tail = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
  }
  issuedGates.add(gate)
  return gate
}

export function createPrivacyExtension(
  options: { trajectory?: TrajectoryLifecycle; rules?: Partial<RedactRules> } = {},
) {
  return defineExtension((agnes) => {
    const apiStates = new WeakMap<SessionRef, SessionEgressState>()
    states.set(agnes, apiStates)
    const owned = new Set<SessionRef>()
    const deactivate = (session: SessionRef): void => {
      const state = apiStates.get(session)
      if (state) state.active = false
      apiStates.delete(session)
      owned.delete(session)
    }
    const stopStart = agnes.registerHook('session_start', async (payload, context) => {
      if (apiStates.get(context.session)?.active) return
      const consent = context.session.telemetryConsent ?? 'DISABLED'
      if (context.session.telemetryConsentPendingAudit)
        await agnes.events.append('consent', {
          from: 'DISABLED',
          to: consent,
          by: `profile:${payload.preset}`,
        })
      const previous = options.trajectory
        ? await options.trajectory.previous(context.session, context.signal)
        : null
      if (previous !== null && !/^[a-f0-9]{64}$/.test(previous))
        throw new Error('trajectory previous receipt is not a lowercase sha256 digest')
      apiStates.set(context.session, {
        active: true,
        consent,
        previous,
        tail: Promise.resolve(),
      })
      owned.add(context.session)
    })
    const stopShutdown = agnes.registerHook('shutdown', async (_payload, context) => {
      try {
        if (options.trajectory) {
          const gate = createSessionEgressGate(agnes, context.session, options.rules)
          await options.trajectory.upload(context.session, gate, context.signal)
        }
      } finally {
        deactivate(context.session)
      }
    })
    return () => {
      for (const session of owned) deactivate(session)
      states.delete(agnes)
      stopShutdown()
      stopStart()
    }
  })
}

export const privacyExtension = createPrivacyExtension()

export default privacyExtension

export {
  allowsContent,
  allowsUpload,
  CONSENT_LEVELS,
  type ConsentLevel,
  type ConsentTransition,
  canTransition,
  changeConsent,
  transitionConsent,
} from './consent.js'
export { type EgressReceipt, egressReceipt } from './egress.js'
export { DEFAULT_RULES, type RedactRules, redact, redactText } from './redact.js'
