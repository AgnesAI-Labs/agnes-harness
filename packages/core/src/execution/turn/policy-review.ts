import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type { ToolPolicyDecision, ToolPolicyInput } from '@agnes/extension-api'
import { type RequestBody, type TokenCounts, ToolReviewFact, validateAgainst } from '@agnes/protocol'
import { deriveRequest } from '../../request/derive.js'
import { toProviderRequest } from '../../request/to-provider.js'
import { applyBeforeRequestPatches } from '../../request/transforms.js'
import type { SessionImpl } from '../../step/session.js'
import { estimateTokens, resolveModel } from './inference.js'

const counters = new WeakMap<SessionImpl, number>()
/** Generic policy execution. Policy algorithms and review consistency belong to plugins. */
export async function decideToolPolicy(
  s: SessionImpl,
  input: ToolPolicyInput,
  signal: AbortSignal,
): Promise<ToolPolicyDecision> {
  const rows = await scanAll((q) => s.d.log.scan(q), {
    type: ['x/approval/review', 'x/approval/reservation'],
    toSeq: s.lastSeq,
  })
  const prior = rows.findLast(
    (row) =>
      row.type === 'x/approval/review' &&
      row.origin === 'system' &&
      row.trust === 'trusted' &&
      row.actor.id === s.d.actor.id &&
      row.actor.org === s.d.actor.org &&
      row.sourceEventSeqs?.includes(s.state.toolCalls.get(input.call.id)!.seq) &&
      (row.data as { toolUseId?: string }).toolUseId === input.call.id &&
      row.lane === s.lane,
  )
  const data = prior?.data as
    | { review?: unknown; effect?: unknown; reason?: unknown; policyHash?: unknown; name?: unknown }
    | undefined
  if (
    data &&
    validateAgainst(ToolReviewFact, data.review).ok &&
    data.policyHash === sha256Hex(canonicalJson(input.policy)) &&
    data.name === input.call.name &&
    (data.review as ToolReviewFact).argsHash === sha256Hex(canonicalJson(input.call.args)) &&
    data.effect ===
      ((data.review as ToolReviewFact).decision === 'escalate'
        ? 'ask'
        : (data.review as ToolReviewFact).decision) &&
    ['allow', 'ask', 'deny'].includes(String(data.effect))
  )
    return {
      effect: data.effect as ToolPolicyDecision['effect'],
      reason: String(data.reason),
      review: data.review as ToolReviewFact,
    }
  const settings = await s.d.toolPolicySettings?.(s.preset.approval.policy ?? 'default', signal)
  const history = rows.filter((row) => row.origin === 'system' && row.trust === 'trusted')
  const user = await scanAll((q) => s.d.log.scan(q), { type: 'user/message', lane: s.lane, toSeq: s.lastSeq })
  const instructions = user
    .filter((row) => row.origin === 'principal' && row.trust === 'trusted')
    .flatMap((row) => {
      const data = row.data as { content?: import('@agnes/protocol').ContentBlock[] }
      return (data.content ?? [])
        .filter((block) => block.type === 'text' && block.reference === undefined)
        .map((block) => (block as { text: string }).text)
    })
  const permission = await s
    .toolPolicy(settings?.policy)
    .decide(
      { ...input, ...(settings?.config !== undefined ? { config: settings.config } : {}), instructions },
      signal,
      {
        async reserve(limit) {
          const count =
            counters.get(s) ?? history.filter((row) => row.type === 'x/approval/reservation').length
          if (count >= limit) return false
          counters.set(s, count + 1)
          await s.d.log.append([
            s.ev('x/approval/reservation', { toolUseId: input.call.id }, { ignorable: true }),
          ])
          return true
        },
        async model(request, reviewSignal, onUsage) {
          const target = resolveModel(s, request.slot)
          // A fast slot must be explicitly configured; never quietly spend on the primary model.
          if (!s.preset.model.route[request.slot]) throw new Error('Reviewer model profile is not configured')
          const turn = s.turn
          if (!turn) throw new Error('No active turn')
          const derived = applyBeforeRequestPatches(
            deriveRequest({
              kind: 'summary',
              merged: { tools: [], sections: [], runtimeContext: {}, conflicts: [] },
              harnessEntries: [],
              surface: [],
              disclosed: [],
              model: { slot: request.slot, ...target },
              contract: s.d.contractForModel?.(target) ?? s.d.contract,
              nonce: turn.nonce,
              envelopeNonceFor: (seq) => s.envelopeNonceFor(seq),
              envelopeCache: s.envelopeCache,
              summaryPlan: {
                system: 'Return only the requested review JSON. Do not call tools.',
                instruction: request.prompt,
              },
            }),
            [{ ext: 'core:policy-model', patch: { maxTokens: 512 } }],
          )
          const wire: RequestBody = toProviderRequest(derived.request, {
            sessionKey: s.key,
            derivedHash: derived.header.derived_hash,
          })
          const projected = await s.d.runtime.ledgerProjected({
            tokensEstimate: estimateTokens(canonicalJson(wire)) + 512,
            model: target.model,
          })
          const cap = s.turnBudgetCap()
          if (
            !Number.isFinite(projected.credits) ||
            projected.credits < 0 ||
            (cap !== null && projected.credits > cap)
          )
            throw new Error('Review exceeds budget')
          const operation = s.op()!
          let text = '',
            completed = false
          let credits = projected.credits
          let creditSource = projected.creditSource
          let tokens: TokenCounts = {
            input: estimateTokens(request.prompt),
            output: 512,
            cacheRead: 0,
            cacheWrite: 0,
          }
          reviewSignal.throwIfAborted()
          onUsage?.({ model: target.model, cost: credits, costSource: creditSource })
          try {
            for await (const event of s.d.provider.infer(wire, {
              signal: reviewSignal,
              toolNames: [],
              retry: false,
            })) {
              reviewSignal.throwIfAborted()
              if (event.type === 'text_delta') text += event.delta
              if (text.length > 8192) throw new Error('Review too large')
              if (event.type === 'error' || event.type === 'toolcall_end' || event.type === 'deviation')
                throw new Error('Review failed')
              if (event.type === 'usage') {
                tokens = event.tokens
                if (event.credits !== undefined) {
                  if (!Number.isFinite(event.credits) || event.credits < 0)
                    throw new Error('Invalid review cost')
                  credits = event.credits
                  creditSource = event.creditSource
                }
                onUsage?.({ model: target.model, cost: credits, costSource: creditSource })
              }
              if (event.type === 'done') completed = event.reason === 'stop'
            }
            if (!completed) throw new Error('Review incomplete')
          } finally {
            // Failed/aborted requests still consume the reservation estimate unless usage replaces it.
            const spend = {
              effectId: `review-${sha256Hex(input.call.id)}`,
              purpose: 'approval-guardian' as const,
              tokens,
              credits,
              creditSource,
              model: target.model,
            }
            const recorded = await s.d.runtime.ledgerRecord({
              ...spend,
              sessionKey: s.key,
              lane: s.lane,
              turn: operation.meta.turn,
              step: operation.step,
            })
            await s.d.log.append([s.ev('cost/ledger', spend)])
            if (!recorded) throw new Error('Review cost unavailable')
          }
          return { text, model: target.model, cost: credits, costSource: creditSource }
        },
      },
    )
  if (permission.review) {
    if (
      !validateAgainst(ToolReviewFact, permission.review).ok ||
      permission.effect !== (permission.review.decision === 'escalate' ? 'ask' : permission.review.decision)
    )
      throw new Error('Invalid policy review fact')
    await s.transition(
      [
        s.ev(
          'x/approval/review',
          {
            toolUseId: input.call.id,
            name: input.call.name,
            policy: s.toolPolicy(settings?.policy).id,
            policyHash: sha256Hex(canonicalJson(input.policy)),
            effect: permission.effect,
            reason: permission.reason,
            review: permission.review,
          },
          { ignorable: true, sourceEventSeqs: [s.state.toolCalls.get(input.call.id)!.seq] },
        ),
      ],
      s.op()!,
    )
  }
  return permission
}
