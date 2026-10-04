import { CoreError, canonicalJson, estimateTokens, type SessionImpl, sha256Hex } from '@agnes/core'
import type { DecisionBackend, LanguageBackend, PreparedModelCall } from '@agnes/jev-runtime'
import { validateAgainst } from '@agnes/protocol'
import { CountResult, RequestBody } from '@agnes/protocol/gen/model'
import { drainJevCostOutbox } from './jev-cost.js'
import { admitJevTreeRequest, assertJevTreeBudgetAvailable, drainJevTreeBudget } from './jev-tree-budget.js'

export interface JevModelPolicyOptions {
  readonly session: SessionImpl
  readonly decision: DecisionBackend
  readonly language: LanguageBackend
  /** Private Host classification for a refusal after the durable model request was written. */
  readonly onBudgetRefusal?: (error: CoreError) => void
  /** Trusted request-bound price upper limit; never recorded as actual provider usage. */
  readonly projectCost?: (
    call: PreparedModelCall,
    tokens: number,
  ) => Promise<{ credits: number; creditSource: 'gateway' | 'estimated' } | undefined>
  /** Decision transports use their own wire protocol. A provider's language counter is not a substitute. */
  readonly countDecision?: (
    call: PreparedModelCall,
    signal: AbortSignal,
  ) => Promise<{ tokens: number; boundHash: string }>
}

type PreparedAdmission = {
  backend: DecisionBackend | LanguageBackend
  fingerprint: string
  tokens: number | undefined
  source: 'count' | 'estimate' | 'unknown'
  boundHash: string
}

/**
 * Apply the shared ledger and preset spending gates to the actual prepared request. Admission is
 * session-local, immutable and consumed once. This adapter never retries remote inference or
 * invents a charge for missing provider usage; durable settlement belongs to the runtime ledger.
 */
export function createJevModelPolicy(options: JevModelPolicyOptions): {
  decision: DecisionBackend
  language: LanguageBackend
} {
  const s = options.session
  const pending = new WeakMap<PreparedModelCall, PreparedAdmission>()
  function refuse(message: string): never {
    throw new CoreError('E_BUDGET', message)
  }
  const priceGuard = async (call: PreparedModelCall, tokens: number | undefined) => {
    if (!call.requestedModel) refuse('Prepared request has no billable model identity')
    const cap = s.turnBudgetCap()
    if (cap !== null && (!Number.isFinite(cap) || cap < 0)) refuse('Invalid per-request budget cap')
    // An explicitly uncapped request needs no invented price bound. Tree admission still checks
    // every persisted ancestor and refuses this unknown quote if any scope is finite.
    if (tokens === undefined) {
      if (cap !== null) refuse('Non-text model input has no supported counter for this capped request')
      return { cap, upperCredits: undefined }
    }
    const upper = await options.projectCost?.(call, tokens)
    const projected =
      upper ??
      (await s.d.runtime.ledgerProjected({
        tokensEstimate: tokens,
        model: call.requestedModel,
      }))
    if (!Number.isFinite(projected.credits) || projected.credits < 0)
      refuse('Model price projection is unavailable')
    // The default ledger returns estimated zero when it has no history. This is not proof that
    // a model is free. Uncapped sessions may proceed, but no fabricated zero cost is persisted.
    if (cap !== null && projected.credits === 0 && projected.creditSource !== 'gateway')
      refuse('Model price is unknown for this capped request')
    if (cap !== null && projected.credits > cap)
      refuse(
        s.preset.budget.onExceed === 'quote'
          ? 'Model request exceeds its cap; Jev budget quote approval is unavailable'
          : `Model request projected ${projected.credits} credits exceeds its cap ${cap}`,
      )
    return {
      cap,
      upperCredits:
        upper && (upper.credits > 0 || upper.creditSource === 'gateway') ? upper.credits : undefined,
    }
  }
  const admission = async (
    backend: DecisionBackend | LanguageBackend,
    call: PreparedModelCall,
    signal: AbortSignal,
  ): Promise<PreparedAdmission> => {
    signal.throwIfAborted()
    await drainJevCostOutbox(s)
    await drainJevTreeBudget(s)
    await assertJevTreeBudgetAvailable(s)
    const fingerprint = sha256Hex(canonicalJson(call))
    const input =
      call.input !== null && typeof call.input === 'object' && !Array.isArray(call.input)
        ? call.input
        : undefined
    let tokens: number | undefined
    let boundHash: string
    let source: PreparedAdmission['source'] = s.preset.budget.preflight === 'count' ? 'count' : 'estimate'
    if (call.codec === 'agnes-language-v1' || call.codec === 'agnes-language-v2') {
      const checked = validateAgainst<import('@agnes/protocol').RequestBody>(RequestBody, input?.request)
      if (!checked.ok) refuse('Language backend did not prepare a valid provider request')
      const request = checked.value
      let endpoint: unknown = request.route
      if (call.codec === 'agnes-language-v2') {
        const snapshot = input?.providerRequest
        if (
          !snapshot ||
          typeof snapshot !== 'object' ||
          Array.isArray(snapshot) ||
          snapshot.codec !== 'agnes-provider-request-v1' ||
          typeof snapshot.endpoint !== 'string'
        )
          refuse('Language backend did not prepare an effective provider snapshot')
        const effective = validateAgainst<import('@agnes/protocol').RequestBody>(
          RequestBody,
          snapshot.request,
        )
        if (
          !effective.ok ||
          canonicalJson({ ...effective.value, system: request.system }) !== canonicalJson(request)
        )
          refuse('Effective provider snapshot does not match its prepared request')
        endpoint = snapshot.endpoint
      }
      if (request.model !== call.requestedModel || endpoint !== call.endpoint || request.sessionKey !== s.key)
        refuse('Prepared model identity does not match its request')
      boundHash = request.derivedHash
      const media = request.messages.some((message) =>
        message.content.some((block) => block.type !== 'text' && block.type !== 'thinking'),
      )
      if (source === 'count' || media) {
        const counted = validateAgainst<import('@agnes/protocol').CountResult>(
          CountResult,
          s.d.provider.count ? await s.d.provider.count(request, { signal }) : { source: 'unsupported' },
        )
        if (!counted.ok) refuse('Provider count is unavailable or is not bound to the prepared request')
        if (counted.value.source === 'unsupported') {
          if (source === 'count') refuse('Provider cannot count the prepared request required by this preset')
          source = 'unknown'
        } else {
          if (counted.value.boundHash !== boundHash || counted.value.tokens <= 0)
            refuse('Provider count is unavailable or is not bound to the prepared request')
          tokens = counted.value.tokens
          source = 'count'
        }
      } else {
        tokens = estimateTokens(canonicalJson(request))
      }
    } else if (call.codec === 'systemone-json-v1' && call.purpose === 'decision') {
      boundHash = sha256Hex(canonicalJson(call.input))
      if (source === 'count') {
        if (!options.countDecision)
          refuse('Decision transport cannot count the request required by this preset')
        const counted = await options.countDecision(call, signal)
        if (!Number.isSafeInteger(counted.tokens) || counted.tokens <= 0 || counted.boundHash !== boundHash)
          refuse('Decision count is not bound to the prepared request')
        tokens = counted.tokens
      } else tokens = estimateTokens(canonicalJson(call.input))
    } else refuse('Unknown prepared model request codec')
    if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens <= 0))
      refuse('Prepared request has no usable token bound')
    const { cap } = await priceGuard(call, tokens)
    signal.throwIfAborted()
    await s.locked(async () => {
      await s.d.log.append([
        s.ev(
          'budget.state',
          {
            slot: 'primary',
            escalate: false,
            creditsUsed: s.state.creditsUsed,
            creditsCap: cap,
            ...(tokens === undefined || source === 'unknown'
              ? {}
              : { lastPreflight: { tokens, source, boundHash } }),
          },
          { register: 'budget.state' },
        ),
      ])
    })
    return { backend, fingerprint, tokens, source, boundHash }
  }
  const invoke = async (
    backend: DecisionBackend | LanguageBackend,
    call: PreparedModelCall,
    signal: AbortSignal,
  ) => {
    try {
      const admitted = pending.get(call)
      if (
        !admitted ||
        admitted.backend !== backend ||
        admitted.fingerprint !== sha256Hex(canonicalJson(call))
      )
        refuse('Model invocation was not admitted here or changed after admission')
      pending.delete(call)
      signal.throwIfAborted()
      await drainJevCostOutbox(s)
      await drainJevTreeBudget(s)
      // A human approval or a different session may have changed shared policy since preparation.
      const { upperCredits } = await priceGuard(call, admitted.tokens)
      signal.throwIfAborted()
      if (admitted.fingerprint !== sha256Hex(canonicalJson(call)))
        refuse('Prepared model request changed during its budget check')
      await admitJevTreeRequest(s, call, upperCredits, signal)
      if (admitted.fingerprint !== sha256Hex(canonicalJson(call)))
        refuse('Prepared model request changed during tree admission')
      s.d.log.storage.assertSessionAdmitted?.(s.key)
      return backend.invoke(call, signal)
    } catch (error) {
      if (error instanceof CoreError && error.code === 'E_BUDGET') options.onBudgetRefusal?.(error)
      throw error
    }
  }
  return {
    decision: {
      async prepare(input, signal) {
        await drainJevCostOutbox(s)
        const call = await options.decision.prepare(input, signal)
        pending.set(call, await admission(options.decision, call, signal))
        return call
      },
      invoke: (call, signal) => invoke(options.decision, call, signal),
    },
    language: {
      maxFormatRetries: options.language.maxFormatRetries,
      async prepare(input, signal) {
        await drainJevCostOutbox(s)
        const call = await options.language.prepare(input, signal)
        pending.set(call, await admission(options.language, call, signal))
        return call
      },
      invoke: (call, signal) => invoke(options.language, call, signal),
    },
  }
}
