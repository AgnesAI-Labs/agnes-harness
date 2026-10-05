import { minimumContextBudget, validateAgainst } from '@agnes/protocol'
import { PlanItems as PlanItemsSchema } from '@agnes/protocol/gen/session-v1'
import { decidedFields, isPending } from '../effects/approval-answer.js'
import { scanAll } from '../log/scan-pages.js'
import type { BudgetState, Inbox, PlanItems, RepairDecision } from '../reduce/shapes.js'
import { canonicalJson } from '../request/hash.js'
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

/** Whether less than half the reserve is left below the window, so waiting for a later attempt is not safe. */
export function nearlyFull(s: SessionImpl, contextWindow: number, reserveTokens: number): boolean {
  return contextWindow - compactionTriggerTokens(s) < reserveTokens / 2
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

function modelCapacityFor(s: SessionImpl, route: string, model: string): number {
  try {
    return (
      s.d.provider.models().find((m) => m.route === route && m.id === model)?.contextWindow ??
      CONTEXT_WINDOW_DEFAULT
    )
  } catch {
    return CONTEXT_WINDOW_DEFAULT
  }
}

/** The slot's saved window, or the capacity advertised by its provider. */
export function contextWindowFor(s: SessionImpl, route: string, model: string, slot = 'primary'): number {
  const selected = resolveModel(s, slot)
  const window =
    selected.route === route && selected.model === model ? s.preset.model.contextWindow?.[slot] : undefined
  return window ?? modelCapacityFor(s, route, model)
}

/** What the fixed instructions and tool schemas cost every request, estimated the way budgets judge it. */
export function fixedPrefixTokens(prefix: { system: string; tools: readonly unknown[] }): number {
  return estimateTokens(canonicalJson(prefix))
}

/**
 * Fit the preset policy to a window without changing the saved preset. The recent tail kept by a
 * compaction sits in the next request beside the fixed prefix and the summary, so it may take only
 * half of what is left below the trigger line after that prefix; otherwise the first request after
 * a compaction already lands on the line and compacts again. With a large window the configured
 * keep stays the smaller bound, so only small windows change.
 */
export function compactionSettingsFor(s: SessionImpl, contextWindow: number, fixedTokens = 0) {
  const configured = s.preset.compaction
  if (!Number.isFinite(configured.reserveTokens) || configured.reserveTokens < 0)
    throw new CoreError('E_ENVELOPE', 'compaction reserveTokens must be nonnegative')
  const target = resolveModel(s, 'primary')
  // Fit to the selected budget itself, not its ratio to a potentially huge model capacity.
  const reserveTokens =
    contextWindow >= modelCapacityFor(s, target.route, target.model) &&
    configured.reserveTokens < contextWindow
      ? configured.reserveTokens
      : Math.min(configured.reserveTokens, Math.floor(contextWindow / 4))
  const keepRecentTokens = Math.min(
    configured.keepRecentTokens,
    Math.max(0, Math.floor((contextWindow - reserveTokens - Math.max(0, fixedTokens)) / 2)),
  )
  if (reserveTokens === configured.reserveTokens && keepRecentTokens === configured.keepRecentTokens)
    return configured
  return {
    reserveTokens,
    keepRecentTokens,
  }
}

/** A reduced conversation budget cannot compact away fixed instructions and tool schemas. */
export function contextBudgetError(
  s: SessionImpl,
  slot: string,
  prefix: { system: string; tools: readonly unknown[] },
) {
  const window = s.preset.model.contextWindow?.[slot]
  if (window === undefined) return undefined
  const target = resolveModel(s, slot)
  const capacity = modelCapacityFor(s, target.route, target.model)
  if (window >= capacity) return undefined
  const fixedTokens = fixedPrefixTokens(prefix)
  const { reserveTokens } = compactionSettingsFor(s, window)
  if (window >= minimumContextBudget(capacity) && fixedTokens + reserveTokens < window) return undefined
  return {
    code: 'BUDGET_EXCEEDED',
    message: `Session context budget (${window} tokens) cannot fit fixed instructions/tools (${fixedTokens} estimated tokens) and reserved space. Increase the context budget or reset it to automatic.`,
  }
}

/**
 * The check before a request is minted. It answers with the turn-end reason rather than a bare
 * "stop", because running out of steps, running out of credit and waiting on a human are three
 * different endings and the ledger has to say which one happened.
 */
async function builtinBudgetPreflight(s: SessionImpl): Promise<'ok' | { reason: TurnEndReason }> {
  const op = s.op() as OpStateObj
  if (s.preset.budget.maxSteps !== null && op.step + 1 > s.preset.budget.maxSteps) {
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

function currentPlan(s: SessionImpl): PlanItems | undefined {
  const value = s.latest('plan.items')
  if (value == null) return undefined
  const parsed = validateAgainst<PlanItems>(PlanItemsSchema, value)
  if (!parsed.ok) throw new CoreError('E_ENVELOPE', 'completion plan is invalid')
  return structuredClone(parsed.value)
}

function planAllowsCompletion(s: SessionImpl): boolean {
  if (!s.preset.completionGate.enabled) return true
  const plan = currentPlan(s)
  return (
    !plan ||
    plan.items.length < s.preset.completionGate.minItems ||
    plan.items.every((item) => item.status === 'done')
  )
}

class CompletionPlanChanged extends Error {}

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
  // Built once, reused for every 'completed' exit below: each is this turn's own ending,
  // not a fresh request, so the model/disclosure pair an after-core Operation
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
  async function complete(events: EventInput[] | ((seq: Seq) => EventInput[])): Promise<StepOutcome> {
    const blocked = async (): Promise<StepOutcome> => {
      await s.endTurn('blocked', {
        error: { code: 'COMPLETION_GATE', message: 'The current plan still has unfinished items' },
        events,
      })
      return { phase: 'terminal', reason: 'blocked' }
    }
    if (!planAllowsCompletion(s)) return blocked()
    await runSlot(s, 'after-core', verifiedAfterCoreCtx)
    try {
      await s.endTurn('completed', {
        events: (seq) => {
          // Recheck after asynchronous slots and inside the existing transition lock.
          if (!planAllowsCompletion(s)) throw new CompletionPlanChanged()
          return typeof events === 'function' ? events(seq) : events
        },
      })
      return { phase: 'terminal', reason: 'completed' }
    } catch (error) {
      if (!(error instanceof CompletionPlanChanged)) throw error
      return blocked()
    }
  }
  if (verdict.verdict === 'pass' && planAllowsCompletion(s)) return complete([signal])
  const history = (
    await scanAll((q) => s.d.log.scan(q), {
      fromSeq: op.meta.triggerSeq,
      toSeq: s.lastSeq,
      type: 'repair/decision',
      lane: s.lane,
    })
  ).map((e) => e.data as unknown as RepairDecision)
  const round = history.length + 1
  const plan = currentPlan(s)
  let decision =
    round >= s.preset.repair.maxRounds
      ? ('park' as const)
      : await s.d.runtime.repairDecide(
          { turn: op.meta.turn, round, history, ...(plan ? { plan } : {}) },
          verdict,
        )
  // A strategy cannot accept a failed verifier or waive the completion plan on its own.
  if (decision === 'complete') decision = verdict.verdict === 'pass' ? 'repair' : 'park'
  const repairEvents = (verdictSeq: Seq): EventInput[] => [
    signal,
    s.ev('repair/decision', { round: history.length + 1, decision, verdictSeq }),
  ]
  if (decision === 'park') {
    const requestId = s.d.ids.requestId()
    const asked = {
      requestId,
      kind: 'unknown-outcome' as const,
      summary:
        verdict.verdict !== 'pass'
          ? `verifier failed: ${verdict.reasons.join('; ')}`
          : !planAllowsCompletion(s)
            ? 'completion blocked: the current plan has unfinished items'
            : 'completion requires review after repair',
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
    const answer = await s.askApprovalAnswer(
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
    if (isPending(answer)) {
      await s.endTurn('parked', {
        events: (seq) => [...repairEvents(seq), s.ev('approval/asked', { ...finalAsked, pending: answer })],
      })
      return { phase: 'terminal', reason: 'parked' }
    }
    const decided = s.ev('approval/decided', { requestId, ...decidedFields(answer), via: 'sync' })
    if (!answer.verdict.startsWith('allowed')) {
      await s.endTurn('blocked', {
        events: (seq) => [...repairEvents(seq), s.ev('approval/asked', finalAsked), decided],
      })
      return { phase: 'terminal', reason: 'blocked' }
    }
    // The model has already proposed completion. Approval accepts this verdict's evidence,
    // not another inference over the same history (which would ask the identical question again).
    // Close this turn atomically with the decision; future turns still run their own verifier.
    return complete((seq) => {
      // A steer received while approval/after-core awaited must not be stranded when this
      // turn closes. Preserve it as a new turn, with fresh verification and its original trust.
      const inbox = s.latest('inbox') as Inbox | undefined
      const pending = inbox?.items.some((item) => item.target === 'next-step')
        ? [
            inboxEvent(s.lane, s.d.actor, {
              items: inbox.items.map((item) =>
                item.target === 'next-step' ? { ...item, target: 'next-turn' as const } : item,
              ),
            }),
          ]
        : []
      return [...repairEvents(seq), s.ev('approval/asked', finalAsked), decided, ...pending]
    })
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
    (seq) => [...repairEvents(seq), ...extra],
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
    const contextWindow = contextWindowFor(s, route, model)
    const { reserveTokens } = compactionSettingsFor(s, contextWindow)
    const cache = lastCacheHint(s)
    // A route that failed outright is spared attempts, but never once the window is nearly full.
    const held =
      s.compaction.suspended?.(op.meta.turn) === true && !nearlyFull(s, contextWindow, reserveTokens)
    if (
      !held &&
      s.compaction.shouldCompact({
        contextTokens: compactionTriggerTokens(s),
        contextWindow,
        reserveTokens,
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
