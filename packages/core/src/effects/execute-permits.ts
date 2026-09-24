import { CoreError, type Seq } from '../types.js'

/**
 * An in-process capability for one dispatch of one durably-started effect. It intentionally has no
 * serializable fields: a ledger row, copied object, or process restart cannot recreate authority.
 */
export type ExecutePermit = Readonly<Record<never, never>>

export type ExecuteAttempt = 1 | 2

export type ExecutePermitBinding = Readonly<{
  effectId: string
  startSeq: Seq
  owner: object
  attempt: ExecuteAttempt
}>

type AttemptProgress = 0 | ExecuteAttempt

type EffectPermitState = {
  readonly startSeq: Seq
  readonly owner: object
  issuedAttempt: ExecuteAttempt
  consumedAttempt: AttemptProgress
  livePermit: object | undefined
}

function refused(message: string): never {
  throw new CoreError('E_EXECUTE_PERMIT', message)
}

/** Session-local issuer for capabilities consumed at the tool-dispatch boundary. */
export class ExecutePermitRegistry {
  readonly #live = new WeakMap<object, ExecutePermitBinding>()
  readonly #byEffect = new Map<string, EffectPermitState>()
  #open = true

  issue(input: ExecutePermitBinding): ExecutePermit {
    if (!this.#open) refused('permit registry is closed')
    if (!input.effectId) refused('effect id is empty')
    if (!Number.isSafeInteger(input.startSeq) || input.startSeq < 1) refused('start sequence is invalid')
    if (input.attempt !== 1 && input.attempt !== 2) refused('execute attempt is invalid')

    const prior = this.#byEffect.get(input.effectId)
    if (prior) {
      if (prior.owner !== input.owner || prior.startSeq !== input.startSeq)
        refused('effect is bound to another owner or durable start sequence')
      if (prior.livePermit) refused('previous permit remains unconsumed')
      if (input.attempt !== prior.consumedAttempt + 1)
        refused('execute attempts must be issued once in strict order')
    } else if (input.attempt !== 1) {
      refused('first execute attempt must be attempt 1')
    }

    const permit = Object.freeze({}) as ExecutePermit
    this.#live.set(permit, { ...input })
    if (prior) {
      prior.issuedAttempt = input.attempt
      prior.livePermit = permit
    } else {
      this.#byEffect.set(input.effectId, {
        startSeq: input.startSeq,
        owner: input.owner,
        issuedAttempt: input.attempt,
        consumedAttempt: 0,
        livePermit: permit,
      })
    }
    return permit
  }

  /**
   * Rebuilds only the attempt counter after a process restart. The caller must first verify the
   * durable effect/call binding and transport phase; this method deliberately accepts no replay
   * policy and mints no authority. A later `issue` still has to advance by exactly one.
   */
  restoreConsumed(input: ExecutePermitBinding): void {
    if (!this.#open) refused('permit registry is closed')
    if (!input.effectId) refused('effect id is empty')
    if (!Number.isSafeInteger(input.startSeq) || input.startSeq < 1) refused('start sequence is invalid')
    if (input.attempt !== 1 && input.attempt !== 2) refused('execute attempt is invalid')
    if (this.#byEffect.has(input.effectId)) refused('effect permit state is already restored')
    this.#byEffect.set(input.effectId, {
      startSeq: input.startSeq,
      owner: input.owner,
      issuedAttempt: input.attempt,
      consumedAttempt: input.attempt,
      livePermit: undefined,
    })
  }

  consume(permit: ExecutePermit, expected: ExecutePermitBinding): void {
    const binding = this.#live.get(permit)
    if (
      !binding ||
      binding.owner !== expected.owner ||
      binding.effectId !== expected.effectId ||
      binding.startSeq !== expected.startSeq ||
      binding.attempt !== expected.attempt
    )
      refused('permit is unknown, stale, or bound to another dispatch')

    const state = this.#byEffect.get(binding.effectId)
    if (!state || state.livePermit !== permit || state.issuedAttempt !== binding.attempt)
      refused('permit registry state is inconsistent')

    this.#live.delete(permit)
    state.livePermit = undefined
    state.consumedAttempt = binding.attempt
  }

  close(): void {
    this.#open = false
    for (const state of this.#byEffect.values()) {
      if (state.livePermit) this.#live.delete(state.livePermit)
    }
    this.#byEffect.clear()
  }
}
