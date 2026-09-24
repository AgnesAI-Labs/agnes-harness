import { scanAll } from '../log/scan-pages.js'
import type { BudgetState, Inbox, RepairDecision } from '../reduce/shapes.js'
import { CoreError, type EventInput, type Seq } from '../types.js'
import { quoteBudget } from './calibrate.js'
import { claimFrom, inboxEvent } from './inbox.js'
import { discloseTools, estimateTokens, resolveModel } from './inference.js'
import { type CheckpointPhase, type OpStateObj, withPhase } from './op-state.js'
import { replacementEffects, runCoreReplacement, runSlot } from './reentry.js'
import type {
  BudgetReplacementOutput,
  InboxReplacementOutput,
  OpContext,
  SessionImpl,
  StepOutcome,
  StopGateReplacementOutput,
  TurnEndReason,
} from './session.js'
import { turnVerifyInput } from './verify-input.js'

// A provider is free to publish nothing for a route, same as resolveModel's own fallback; this is
// the only value used when a real ModelRecord could not be found, never a default layered on top of
// one that was.
const CONTEXT_WINDOW_DEFAULT = 128_000
const BUDGET_END_REASONS = new Set<TurnEndReason>(['budget', 'max_steps', 'blocked'])
const STOP_END_REASONS = new Set<TurnEndReason>(['completed', 'blocked'])

/**
 * What the model is currently being shown. Counts from the most recent non-interrupted
 * `cost/ledger` entry's reported token total, then adds the cheap surface-character estimate for
 * whatever was appended after that request — so a long session's preflight cost stays bounded by
 * what changed since the last real count, instead of re-estimating the whole surface every step.
 */
function tokensSince(s: SessionImpl, anchor: { seq: Seq; total: number } | null): number {
  let n = anchor?.total ?? 0
  for (const node of s.surface()) {
    if (anchor && node.seq <= anchor.seq) continue
    const d = node.event.data as { content?: Array<{ text?: string }> } | null
    for (const b of d?.content ?? []) n += estimateTokens(b.text ?? '')
  }
  return n
}

export function contextTokens(s: SessionImpl): number {
  return tokensSince(s, s.state.lastLedgerTokens)
}

/**
 * What the compaction trigger reads, distinct from `contextTokens`'s own anchor: prefers a real
 * `provider.count()` calibration over the reported-usage anchor when the calibration is the more
 * recent of the two, since a count is a measurement of the wire body itself rather than a sum of
 * whatever the provider's usage event reported. Falls back to `contextTokens`'s own anchor whenever
 * no calibration exists, the last one was only ever an estimate, or it predates the reported-usage
 * anchor and so is the staler of the two — an estimate-sourced `lastPreflight` is exactly the same
 * chars-per-token estimate this function would fall back to anyway, so preferring it over the real
 * usage anchor would not be "consulting a calibration," it would be re-estimating under a
 * different name.
 */
export function compactionTriggerTokens(s: SessionImpl): number {
  const budget = s.latest('budget.state') as BudgetState | undefined
  const calibrated = budget?.lastPreflight
  const ledger = s.state.lastLedgerTokens
  const useCalibrated =
    calibrated?.source === 'count' &&
    calibrated.seq !== undefined &&
    (!ledger || calibrated.seq >= ledger.seq)
  return tokensSince(s, useCalibrated ? { seq: calibrated.seq as Seq, total: calibrated.tokens } : ledger)
}

/** The most recent inference's cache-read/input token counts, when a ledger anchor exists. */
export function lastCacheHint(s: SessionImpl): { cacheRead: number; input: number } | undefined {
  const last = s.state.lastLedgerTokens
  return last ? { cacheRead: last.cacheRead, input: last.input } : undefined
}

/**
 * The real context window for the model a slot resolved to, read from the same `ModelRecord` the
 * provider publishes for that route. Falls back to the default only when the provider throws or
 * the id is not in its catalogue — never when a record exists but happens not to carry the field,
 * since the schema makes `contextWindow` required on every published record.
 */
export function contextWindowFor(s: SessionImpl, route: string, model: string): number {
  try {
    const rec = s.d.provider.models().find((m) => m.route === route && m.id === model)
    return rec?.contextWindow ?? CONTEXT_WINDOW_DEFAULT
  } catch {
    return CONTEXT_WINDOW_DEFAULT
  }
}

/**
 * The check before a request is minted. It answers with the turn-end reason rather than a bare
 * "stop", because running out of steps, running out of credit and waiting on a human are three
 * different endings and the ledger has to say which one happened.
 */
async function builtinBudgetPreflight(s: SessionImpl): Promise<'ok' | { reason: TurnEndReason }> {
  const op = s.op() as OpStateObj
  if (op.step + 1 > s.preset.budget.maxSteps) {
    await s.endTurn('max_steps')
    return { reason: 'max_steps' }
  }
  const { model } = resolveModel(s, 'primary')
  const tokensEstimate = contextTokens(s)
  const projected = await s.d.runtime.ledgerProjected({ tokensEstimate, model })
  const prev = s.latest('budget.state') as BudgetState | undefined
  const budget: BudgetState = {
    slot: 'primary',
    escalate: prev?.escalate ?? false,
    creditsUsed: s.state.creditsUsed,
    creditsCap: s.turnBudgetCap(),
    // Always an estimate here: the preflight runs before the request exists, so there is nothing
    // for provider.count() to count even when the preset asks for one. The recount after minting
    // rewrites this with source 'count' and the hash it was bound to.
    lastPreflight: { tokens: tokensEstimate, source: 'estimate' },
  }
  await s.d.log.append([s.ev('budget.state', budget, { register: 'budget.state' })])
  const cap = s.turnBudgetCap()
  if (cap !== null && projected.credits > cap) {
    if (s.preset.budget.onExceed === 'deny') {
      await s.endTurn('budget')
      return { reason: 'budget' }
    }
    return quoteBudget(s, `next request estimated ${projected.credits} credits > cap ${cap}`)
  }
  return 'ok'
}

export { reserveTreeBudget } from '../child/runtime-budget.js'

export async function budgetPreflight(s: SessionImpl): Promise<'ok' | { reason: TurnEndReason }> {
  if (!s.d.segments?.Budget) return builtinBudgetPreflight(s)
  const op = s.op() as OpStateObj
  let delegated = false
  const out = await runCoreReplacement(
    s,
    'Budget',
    s.operationContext(),
    {
      nextStep: op.step + 1,
      maxSteps: s.preset.budget.maxSteps,
      creditsUsed: s.state.creditsUsed,
      creditsCap: s.turnBudgetCap(),
    },
    async () => {
      delegated = true
      const result = await builtinBudgetPreflight(s)
      return { action: 'delegated', outcome: result } as BudgetReplacementOutput
    },
  )
  if (!out || (out.action !== 'allow' && out.action !== 'end' && out.action !== 'delegated'))
    throw new CoreError('E_ENVELOPE', 'Budget replacement returned an invalid decision')
  if (out.action === 'delegated') {
    if (!delegated) throw new CoreError('E_RELATION', 'Budget replacement forged a delegated result')
    return out.outcome
  }
  if (out.action === 'allow') return 'ok'
  if (!BUDGET_END_REASONS.has(out.reason))
    throw new CoreError('E_ENVELOPE', `Budget replacement returned invalid reason ${String(out.reason)}`)
  if (!delegated && s.op())
    await s.endTurn(out.reason, {
      ...(out.error ? { error: out.error } : {}),
      events: replacementEffects(s, 'Budget', out.effects),
    })
  return { reason: out.reason }
}

/** The gate a turn has to pass to be allowed to finish. */
async function builtinStopGate(s: SessionImpl): Promise<StepOutcome> {
  const op = s.op() as OpStateObj
  const hook = await s.hooks.turnStopping({ turn: op.meta.turn, step: op.step, proposedReason: 'completed' })
  if (hook.action === 'continue') {
    await s.transition(
      [s.ev('user/message', { content: [{ type: 'text', text: hook.note }], kind: 'runtime_context' })],
      withPhase(op, { kind: 'checkpoint', continuation: 'need_assistant', triggerSeq: op.meta.triggerSeq }),
    )
    return { phase: 'checkpoint' }
  }
  // Built once, reused for whichever of the two 'completed' exits below is taken: both are this
  // turn's own ending, not a fresh request, so the model/disclosure pair an after-core Operation
  // reads describes the turn that is about to close rather than one about to be sent.
  const { route, model } = resolveModel(s, 'primary')
  // `s.turn` is populated for the whole time a turn is open, and `stopGate` only ever runs mid-turn
  // (before whichever `endTurn` call below actually closes it), so the non-null assertion names a
  // real invariant rather than papering over a gap.
  const afterCoreCtx: OpContext = {
    session: s,
    preset: s.preset,
    state: op,
    snapshot: (s.turn as NonNullable<typeof s.turn>).snapshot,
    signal: s.ac.signal,
    disclosed: discloseTools(s),
    model: { slot: 'primary', route, model },
  }
  const verdict = await s.d.runtime.verify('turn', await turnVerifyInput(s, op.meta.triggerSeq), s.ac.signal)
  const signal = s.ev('verifier/signal', {
    scope: 'turn',
    tier: s.preset.verifier.defaultTier,
    verdict: verdict.verdict,
    reasons: verdict.reasons,
  })
  const verifiedAfterCoreCtx: OpContext = { ...afterCoreCtx, verifier: verdict }
  if (verdict.verdict === 'pass') {
    await runSlot(s, 'after-core', verifiedAfterCoreCtx)
    await s.endTurn('completed', { events: [signal] })
    return { phase: 'terminal', reason: 'completed' }
  }
  const history = (
    await scanAll((q) => s.d.log.scan(q), {
      fromSeq: op.meta.triggerSeq,
      toSeq: s.lastSeq,
      type: 'repair/decision',
      lane: s.lane,
    })
  ).map((e) => e.data as unknown as RepairDecision)
  const decision = await s.d.runtime.repairDecide(
    { turn: op.meta.turn, round: history.length + 1, history },
    verdict,
  )
  const rd = s.ev('repair/decision', {
    round: history.length + 1,
    decision,
    verdictSeq: s.lastSeq + 1,
  })
  if (decision === 'complete') {
    await runSlot(s, 'after-core', verifiedAfterCoreCtx)
    await s.endTurn('completed', { events: [signal, rd] })
    return { phase: 'terminal', reason: 'completed' }
  }
  if (decision === 'park') {
    const requestId = s.d.ids.requestId()
    const asked = {
      requestId,
      kind: 'unknown-outcome' as const,
      summary: `verifier failed: ${verdict.reasons.join('; ')}`,
      risk: 'unknown' as const,
      bindingHash: '',
      deadline: new Date(s.d.clock() + s.preset.approval.timeoutMs).toISOString(),
    }
    // Same hook as the tool-approval path in tools.ts: the payload describes "any request for human
    // approval", not "only a tool approval" — this park has no tool call behind it at all, so `tool`
    // names the approval's own kind and `argv` carries nothing. extension-api's ApprovalRequest risk
    // enum has no 'unknown' member (the value this call site's `asked.risk` actually carries); this
    // approval is unconditional regardless of risk heuristics, which 'always' already means.
    const overridden = s.hooks.approvalRequest
      ? (
          await s.hooks.approvalRequest({
            request: {
              tool: asked.kind,
              argv: null,
              risk: 'always',
              actor: s.d.actor,
              summary: asked.summary,
            },
          })
        ).request
      : undefined
    const finalAsked = overridden
      ? {
          ...asked,
          risk: overridden.risk ?? asked.risk,
          ...(overridden.summary !== undefined ? { summary: overridden.summary } : {}),
        }
      : asked
    const v = await s.askApproval(
      {
        ...finalAsked,
        sessionKey: s.key,
        stepId: `${op.meta.turn}/${op.step}`,
        actor: s.d.actor,
        taint: op.taint || s.laneTaint(),
        scope: s.key,
        ...(overridden?.context !== undefined ? { context: overridden.context } : {}),
      },
      s.ac.signal,
    )
    if (typeof v === 'object') {
      await s.endTurn('parked', {
        events: [signal, rd, s.ev('approval/asked', { ...finalAsked, pending: v })],
      })
      return { phase: 'terminal', reason: 'parked' }
    }
    const decided = s.ev('approval/decided', { requestId, verdict: v, via: 'sync' })
    if (!v.startsWith('allowed')) {
      await s.endTurn('blocked', { events: [signal, rd, s.ev('approval/asked', finalAsked), decided] })
      return { phase: 'terminal', reason: 'blocked' }
    }
    await s.transition(
      [signal, rd, s.ev('approval/asked', finalAsked), decided],
      withPhase(op, { kind: 'checkpoint', continuation: 'need_assistant', triggerSeq: op.meta.triggerSeq }),
    )
    return { phase: 'checkpoint' }
  }
  const prev = (s.latest('budget.state') as BudgetState | undefined) ?? {
    slot: 'primary',
    escalate: false,
    creditsUsed: 0,
    creditsCap: null,
  }
  const extra: EventInput[] =
    decision === 'escalate'
      ? [s.ev('budget.state', { ...prev, escalate: true }, { register: 'budget.state' })]
      : []
  await s.transition(
    [signal, rd, ...extra],
    withPhase(op, { kind: 'checkpoint', continuation: 'need_assistant', triggerSeq: op.meta.triggerSeq }),
  )
  return { phase: 'checkpoint' }
}

export async function stopGate(s: SessionImpl): Promise<StepOutcome> {
  if (!s.d.segments?.StopGate) return builtinStopGate(s)
  const op = s.op() as OpStateObj
  let delegated = false
  const out = await runCoreReplacement(
    s,
    'StopGate',
    s.operationContext(),
    { turn: op.meta.turn, step: op.step, proposedReason: 'completed' },
    async () => {
      delegated = true
      const outcome = await builtinStopGate(s)
      return { action: 'delegated', outcome } as StopGateReplacementOutput
    },
  )
  if (!out || (out.action !== 'continue' && out.action !== 'end' && out.action !== 'delegated'))
    throw new CoreError('E_ENVELOPE', 'StopGate replacement returned an invalid decision')
  if (out.action === 'delegated') {
    if (!delegated) throw new CoreError('E_RELATION', 'StopGate replacement forged a delegated result')
    return out.outcome
  }
  const effects = replacementEffects(s, 'StopGate', out.effects)
  if (out.action === 'end') {
    if (!STOP_END_REASONS.has(out.reason))
      throw new CoreError('E_ENVELOPE', `StopGate replacement returned invalid reason ${String(out.reason)}`)
    await s.endTurn(out.reason, { ...(out.error ? { error: out.error } : {}), events: effects })
    return { phase: 'terminal', reason: out.reason }
  }
  if (typeof out.note !== 'string' || out.note.length === 0)
    throw new CoreError('E_ENVELOPE', 'StopGate continue decision requires a note')
  await s.transition(
    [
      ...effects,
      s.ev('user/message', { content: [{ type: 'text', text: out.note }], kind: 'runtime_context' }),
    ],
    withPhase(op, { kind: 'checkpoint', continuation: 'need_assistant', triggerSeq: op.meta.triggerSeq }),
  )
  return { phase: 'checkpoint' }
}

/**
 * `resumeAfter` is stored as JSON, and `undefined` is not a JSON value: clearing the one-shot flag
 * means deleting the key, not assigning `undefined` to it, or the envelope refuses the row.
 */
const cleared = ({ skipInboxOnce: _once, ...rest }: CheckpointPhase): CheckpointPhase => rest

async function claimCheckpointInbox(s: SessionImpl, inbox: Inbox | undefined) {
  if (!s.d.segments?.Inbox) return claimFrom(inbox, 'next-step')
  const builtin = claimFrom(inbox, 'next-step')
  const decision = await runCoreReplacement(
    s,
    'Inbox',
    s.operationContext(),
    { inbox, target: 'next-step' },
    async (): Promise<InboxReplacementOutput> =>
      builtin ? { action: 'claim', itemId: builtin.item.itemId } : { action: 'none' },
  )
  if (!decision || (decision.action !== 'none' && decision.action !== 'claim'))
    throw new CoreError('E_ENVELOPE', 'Inbox replacement returned an invalid decision')
  if (decision.action === 'none') return undefined
  if (typeof decision.itemId !== 'string' || decision.itemId.length === 0)
    throw new CoreError('E_ENVELOPE', 'Inbox replacement returned an invalid itemId')
  const index = inbox?.items.findIndex(
    (item) => item.itemId === decision.itemId && item.target === 'next-step',
  )
  if (index === undefined || index < 0)
    throw new CoreError('E_RELATION', `Inbox replacement selected unavailable item ${decision.itemId}`)
  const item = inbox?.items[index]
  if (!item)
    throw new CoreError('E_RELATION', `Inbox replacement selected unavailable item ${decision.itemId}`)
  return {
    item,
    rest: { items: [...(inbox?.items.slice(0, index) ?? []), ...(inbox?.items.slice(index + 1) ?? [])] },
  }
}

export async function checkpointRoutine(s: SessionImpl): Promise<StepOutcome> {
  const op = s.op() as OpStateObj
  const ph = op.phase as CheckpointPhase
  if (!ph.skipInboxOnce) {
    const claimed = await claimCheckpointInbox(s, s.latest('inbox') as Inbox | undefined)
    if (claimed) {
      const { item, rest } = claimed
      await s.transition(
        [
          inboxEvent(s.lane, s.d.actor, rest),
          s.ev(
            'user/message',
            { content: item.content, kind: item.kind ?? 'steer' },
            { origin: 'principal', trust: item.trust ?? 'trusted', actor: item.actor },
          ),
        ],
        withPhase(op, { ...ph, continuation: 'need_assistant', skipInboxOnce: true }),
      )
      return { phase: 'checkpoint' }
    }
  }
  const t = s.turn
  if (t && t.compactionRequested !== false && s.preset.compaction.enabled) {
    const custom = t.compactionRequested
    t.compactionRequested = false
    await s.transition(
      [],
      withPhase(op, {
        kind: 'compaction',
        reason: 'requested',
        resumeAfter: cleared(ph),
        ...(custom ? { plan: { customInstructions: custom } } : {}),
      }),
    )
    return { phase: 'compaction' }
  }
  if (s.preset.compaction.enabled && ph.thresholdCheckedSeq !== ph.triggerSeq) {
    const { route, model } = resolveModel(s, 'primary')
    const cache = lastCacheHint(s)
    if (
      s.compaction.shouldCompact({
        contextTokens: compactionTriggerTokens(s),
        contextWindow: contextWindowFor(s, route, model),
        reserveTokens: s.preset.compaction.reserveTokens,
        ...(cache ? { cache } : {}),
      })
    ) {
      await s.transition(
        [],
        withPhase(op, {
          kind: 'compaction',
          reason: 'threshold',
          resumeAfter: { ...cleared(ph), thresholdCheckedSeq: ph.triggerSeq },
        }),
      )
      return { phase: 'compaction' }
    }
  }
  if (ph.continuation === 'need_assistant') {
    const pre = await budgetPreflight(s)
    if (pre !== 'ok') return { phase: 'terminal', reason: pre.reason }
    // Write the phase, do not merely report it: step() dispatches on op().phase.kind, so a
    // checkpoint that only returned { phase: 'inference' } would be re-entered forever and the
    // inference segment would never run.
    const cur = s.op() as OpStateObj
    await s.transition([], withPhase(cur, { kind: 'inference', gen: { status: 'ready', attempt: 0 } }))
    return { phase: 'inference' }
  }
  return stopGate(s)
}
