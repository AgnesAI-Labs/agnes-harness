import { type OpStateObj, type ToolCallState, withPhase } from '@agnes/core-common/step/op-state'
import type { EventInput, Seq } from '@agnes/core-common/types'
import { isNestedCall } from '@agnes/core-ledger'
import { scanAll, scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { EffectNode } from '@agnes/core-ledger/reduce/state'
import { readSideCallBinding } from '../../orchestrator/side-call-effect-port.js'
import {
  hasCompleteToolPolicyEnvelope,
  hasTrustedToolCallProvenance,
  type PersistedToolPolicyFields,
  toolPolicyBindingProblem,
} from '../../registry/tool-policy.js'
import { closeTurn } from '../../step/control.js'
import type { SessionImpl } from '../../step/session.js'
import { classifyToolRecovery, type ToolRecoveryDecision } from '../../step/tool-recovery.js'
import { interruptedRequestNote } from './inference-failure.js'
import { failureNotes, recoveryNotes } from './nested-note.js'
import { unknownOutcomeRows } from './unknown-outcome.js'

export type ResumeMode = 'continue' | 'close'
export type ResumeAction =
  | 'rerun'
  | 'rerun-idempotent'
  | 'unknown'
  | 'retry'
  | 'error'
  | 'aborted'
  | 'poll'
  | 'settle'
export type ResumeReport = {
  state: 'idle' | 'resumed'
  phase?: string
  actions: Array<{ effectId: string; action: ResumeAction }>
}

/**
 * A call closed on resume, keeping its dispatch audit fields when they are complete. A call left in
 * `dispatch_pending` has an attempt but no transport phase yet; a terminal call records both or
 * neither, so the half-written pair is dropped rather than completed with a guessed phase.
 */
function completedCall(call: ToolCallState): ToolCallState {
  const done = { ...call, status: 'completed' } as ToolCallState & { dispatchAttempt?: unknown }
  if (call.dispatchPhase === undefined) delete done.dispatchAttempt
  return done
}

/** Marks one call terminal while preserving any completed dispatch audit fields. */
function setCallCompleted(o: OpStateObj, toolUseId: string): OpStateObj {
  if (o.phase.kind !== 'tools') return o
  const calls = o.phase.batch.calls.map((call) => (call.toolUseId === toolUseId ? completedCall(call) : call))
  return withPhase(o, { ...o.phase, batch: { ...o.phase.batch, calls } })
}

/** Marks each of the named calls terminal, as `setCallCompleted` does for one. */
export function setCallsCompleted(o: OpStateObj, toolUseIds: ReadonlySet<string>): OpStateObj {
  if (o.phase.kind !== 'tools' || toolUseIds.size === 0) return o
  return withPhase(o, {
    ...o.phase,
    batch: {
      ...o.phase.batch,
      calls: o.phase.batch.calls.map((call) => (toolUseIds.has(call.toolUseId) ? completedCall(call) : call)),
    },
  })
}

function setCallRetryAttempt(o: OpStateObj, toolUseId: string): OpStateObj {
  if (o.phase.kind !== 'tools') return o
  const calls = o.phase.batch.calls.map((call) => {
    if (call.toolUseId !== toolUseId || call.effectId === undefined) return call
    const { dispatchPhase: _priorObservation, ...rest } = call
    return {
      ...rest,
      status: 'dispatch_pending' as const,
      effectId: call.effectId,
      dispatchAttempt: 2 as const,
    } as ToolCallState
  })
  return withPhase(o, { ...o.phase, batch: { ...o.phase.batch, calls } })
}

function nestedCallGraph(o: OpStateObj, rootEffectId: string): ToolCallState[] {
  if (o.phase.kind !== 'tools') return []
  const reachableEffects = new Set([rootEffectId])
  const found = new Map<string, ToolCallState>()
  let changed = true
  while (changed) {
    changed = false
    for (const call of o.phase.batch.calls) {
      if (
        call.parentEffectId === undefined ||
        !reachableEffects.has(call.parentEffectId) ||
        found.has(call.toolUseId)
      )
        continue
      found.set(call.toolUseId, call)
      changed = true
      // A nested effect may already have settled and therefore be absent from pendingEffects(). Its
      // durable id still owns deeper calls in op.state, so keep walking through it rather than
      // orphaning a grandchild persisted during approval propagation.
      if (call.effectId !== undefined) reachableEffects.add(call.effectId)
    }
  }
  return [...found.values()]
}

/**
 * What to do about a call whose outcome nobody saw. It is asked as an approval because it is a
 * judgement only a person can make - the side effect may or may not have happened - and the turn
 * stops there while it is open. A pending answer returns through approval-callback and `continueParked`: allowed
 * acknowledges that it happened, while rejected records that it did not. Neither verdict replays
 * the never-replay tool.
 *
 * The turn is closed through `closeTurn` rather than `endTurn`, because the step the killed process
 * opened is still open here and a `turn/end` beside an open step is refused.
 */
async function askUnknownOutcome(s: SessionImpl, toolUseId: string, name: string): Promise<void> {
  const reconciliation = await unknownOutcomeRows(s, toolUseId, name)
  if (reconciliation.park) {
    await closeTurn(s, 'parked', { events: reconciliation.rows })
    return
  }
  // Answered while recovery waited (or before the crash): the answer is consumed here and the
  // resumed turn carries on, exactly as it does when the same answer arrives during a live batch.
  await s.transition(reconciliation.rows, (cur) => cur)
}

/** A synthesized `tool/result` closing a call the resume path is answering for, not the tool itself. */
function syntheticResult(
  s: SessionImpl,
  toolUseId: string,
  code: string,
  text: string,
  sourceSeq: Seq,
): EventInput {
  return s.ev(
    'tool/result',
    {
      toolUseId,
      content: [{ type: 'text', text }],
      isError: true,
      code,
      enforcement: s.d.runtime.enforcement(),
      authz: { decisionId: 'n/a' },
    },
    { sourceEventSeqs: [sourceSeq] },
  )
}

/**
 * Settles a still-pending descendant and everything under it as `unknown`, pushing a
 * `TOOL_OUTCOME_UNKNOWN` closer for each tool-kind node along the way. Used when a parent tool's
 * children are still open at resume: nobody saw how they ended, so guessing an outcome for them
 * would put a result on the ledger nobody observed. Every child of a tool effect is itself a tool
 * effect in the current design (`invokeTool` mints no other kind), but the walk does not assume
 * that: a non-tool descendant is settled the same way, only without a result to close (there is no
 * `toolUseId` to address one to).
 */
function settleUnknownSubtree(s: SessionImpl, n: EffectNode, events: EventInput[]): void {
  for (const c of n.children) settleUnknownSubtree(s, c, events)
  events.push(s.ev('effect/settled', { effectId: n.effectId, outcome: 'unknown' }))
  if (n.kind === 'tool' && n.tool)
    events.push(
      syntheticResult(
        s,
        n.tool.toolUseId,
        'TOOL_OUTCOME_UNKNOWN',
        `the outcome of ${n.tool.name} is unknown: the process died after the call went out`,
        n.argsSeq ?? n.intentSeq,
      ),
    )
}

/**
 * The rows that settle a side call the process died inside. It may already have reached the
 * provider and is never replayed, so it settles as `unknown`, and its spend is unknown too: the cost
 * row carries the estimate frozen into the call's binding row and goes ahead of the settlement in
 * the same commit. Neither the billing seam nor the tree budget is reached from here. A binding row
 * that is missing, not Core's own, or whose hash does not match gives no estimate to trust, so only
 * the settlement is written and the gap is recorded. A storage failure reading the row is not that
 * case and propagates, leaving the effect pending for the next resume.
 */
async function interruptedSideCallRows(s: SessionImpl, node: EffectNode): Promise<EventInput[]> {
  const settled = s.ev('effect/settled', { effectId: node.effectId, outcome: 'unknown' })
  const known = await readSideCallBinding(s, node.intentSeq, node.effectId)
  if (!known) {
    await s.diag('invariant', { kind: 'resume-side-call-binding-unusable', effectId: node.effectId })
    return [settled]
  }
  const { binding, audit } = known
  const cost = s.ev('cost/ledger', {
    purpose: 'side-call',
    effectId: node.effectId,
    model: binding.model,
    tokens: { input: audit.inputTokens, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(audit.projectedCredits === null ? {} : { credits: audit.projectedCredits }),
    creditSource: 'estimated',
    interrupted: true,
    route: binding.route,
  })
  return [cost, settled]
}

/** The `{ effectId, kind, tool?, replay }` shape `CHILD_INTERRUPTED`'s content lists each child as. */
function effectSummary(n: EffectNode): Pick<EffectNode, 'effectId' | 'kind' | 'tool' | 'replay'> {
  return { effectId: n.effectId, kind: n.kind, ...(n.tool ? { tool: n.tool } : {}), replay: n.replay }
}

/** Every node under `n`, flattened - the whole abandoned subtree, not just its direct children. */
function flattenDescendants(n: EffectNode): EffectNode[] {
  return n.children.flatMap((c) => [c, ...flattenDescendants(c)])
}

function actionForDecision(decision: ToolRecoveryDecision, replay?: string): ResumeAction {
  if (decision === 'settle-only') return 'settle'
  if (decision === 'cancelled') return 'aborted'
  if (decision === 'retry-same-effect') return replay === 'idempotent' ? 'rerun-idempotent' : 'rerun'
  return 'unknown'
}

/** Recover interrupted spend from the last durable output count, never the discarded text. */
async function interruptedInferenceCost(
  s: SessionImpl,
  root: EffectNode,
): Promise<{ cost: EventInput; output: number }> {
  // The ledger holds counts, not the streamed text: the last output row for this effect is the
  // best record of what the dead request had produced.
  const outputs = await scanAll((q) => s.d.log.scan(q), {
    fromSeq: root.intentSeq,
    toSeq: s.lastSeq,
    type: 'assistant/output',
    lane: s.lane,
  })
  const last = outputs.findLast(
    (row) => (row.data as { effectId?: unknown } | null)?.effectId === root.effectId,
  )
  const output = (last?.data as { estimatedTokens?: number } | undefined)?.estimatedTokens ?? 0
  const cost = s.ev('cost/ledger', {
    purpose: 'inference',
    effectId: root.effectId,
    tokens: { input: 0, output, cacheRead: 0, cacheWrite: 0 },
    creditSource: 'estimated',
    // 'unknown', not 'primary': an effect that named no slot cannot be attributed, and naming
    // the primary slot writes a spend into that slot's account that nobody made there.
    model: root.slot ?? 'unknown',
    interrupted: true,
  })
  return { cost, output }
}

/**
 * Reconciles what the ledger says was in flight when the process died. It reads the program counter
 * and the effects that were announced and never settled; it never folds history back, because the
 * rows are the history and a resume that rewrote them would be deciding what happened rather than
 * reading it.
 *
 * Each root effect is answered by the replay policy its tool declared, and an inference by the
 * retry budget the counter carries; media and side calls are never replayed, and settle as unknown.
 * What the effects have in common is the step: `runInference`
 * opens one unconditionally, and the relation check refuses a second `step/start` while the first is
 * still held - so every exit that does not hand the step on to the tools phase closes it here, in
 * the same transaction as the settlement. Missing that close is what made a session killed
 * mid-inference unresumable: the next `step()` threw, and the turn was repaired away instead of
 * continued.
 */
export async function resumeSession(s: SessionImpl, o: { mode?: ResumeMode } = {}): Promise<ResumeReport> {
  if (o.mode === 'close') return closeInterrupted(s)
  const op = s.op()
  if (!op) return { state: 'idle', actions: [] }
  await s.rehydrateTurn(op)
  const actions: ResumeReport['actions'] = []
  // Read afresh at each use rather than once at the top, the way `closeTurn` reads it: a branch that
  // has already closed the step must not be followed by one that writes a second close for it.
  const stepEnd = (): EventInput[] => {
    const open = s.state.openStep.get(s.lane)
    return open ? [s.ev('step/end', { turn: open.turn, step: open.step })] : []
  }
  for (const root of s.pendingEffects()) {
    const cur = s.op()
    if (!cur) break
    if (root.kind === 'inference') {
      const { cost, output } = await interruptedInferenceCost(s, root)
      if (cur.control.status === 'cancel_requested') {
        await s.transition(
          [cost, s.ev('effect/settled', { effectId: root.effectId, outcome: 'aborted' }), ...stepEnd()],
          withPhase(cur, {
            kind: 'failure_drain',
            error: { code: 'ABORTED', message: 'cancelled before the process died' },
            provenance: { kind: 'inference', seq: root.intentSeq },
          }),
        )
        actions.push({ effectId: root.effectId, action: 'aborted' })
        continue
      }
      // A phase that is not an inference holding a pending inference effect is a broken counter.
      // Defaulting the attempt to 0 would silently hand back a full retry budget and let a wedged
      // route be retried for ever, so the gap is recorded and the budget is treated as spent.
      const attempt = cur.phase.kind === 'inference' ? cur.phase.gen.attempt : undefined
      if (attempt === undefined)
        await s.diag('invariant', {
          kind: 'resume-attempt-unknown',
          effectId: root.effectId,
          phase: cur.phase.kind,
        })
      if (attempt !== undefined && attempt + 1 < s.preset.model.retry.maxAttempts) {
        await s.transition(
          [
            cost,
            s.ev('effect/settled', { effectId: root.effectId, outcome: 'error' }),
            ...(output > 0 ? [interruptedRequestNote(s, 'INTERRUPTED')] : []),
            ...stepEnd(),
          ],
          withPhase(cur, { kind: 'inference', gen: { status: 'ready', attempt: attempt + 1 } }),
        )
        actions.push({ effectId: root.effectId, action: 'retry' })
        continue
      }
      await s.transition(
        [cost, s.ev('effect/settled', { effectId: root.effectId, outcome: 'error' }), ...stepEnd()],
        withPhase(cur, {
          kind: 'failure_drain',
          error: { code: 'INTERRUPTED', message: 'inference interrupted; retries exhausted' },
          provenance: { kind: 'inference', seq: root.intentSeq },
        }),
      )
      actions.push({ effectId: root.effectId, action: 'error' })
      continue
    }
    if (root.kind === 'media') {
      // Auxiliary media may already have crossed the provider boundary. Its durable contract is
      // never-replay, so recovery records the unknown outcome without inventing a zero-cost row or
      // routing it through the primary inference retry budget. Any observed spend remains owned by
      // the auxiliary terminal transaction and therefore keeps purpose=media.
      await s.transition([s.ev('effect/settled', { effectId: root.effectId, outcome: 'unknown' })], cur)
      actions.push({ effectId: root.effectId, action: 'unknown' })
      continue
    }
    if (root.kind === 'side-call') {
      // Like media, a side call is never replayed and never goes through the primary inference
      // retry budget, so the phase and its attempt counter stay as they were. The step is not this
      // effect's: it is left open for the phase that owns it.
      await s.transition(await interruptedSideCallRows(s, root), cur)
      actions.push({ effectId: root.effectId, action: 'unknown' })
      continue
    }
    if (root.kind === 'tool' && root.tool) {
      const nestedCalls = nestedCallGraph(cur, root.effectId)
      const undispatchedNested = nestedCalls.filter(
        (call) => call.status !== 'completed' && call.effectId === undefined,
      )
      const undispatchedNestedEvents = undispatchedNested.map((call) =>
        syntheticResult(
          s,
          call.toolUseId,
          'TOOL_NOT_STARTED',
          `${call.name} was persisted but had not crossed effect intent before the process died`,
          call.argsSeq,
        ),
      )
      const nestedCallIds = new Set(nestedCalls.map((call) => call.toolUseId))
      const callSeq = root.argsSeq ?? root.intentSeq
      const callRow = (await s.d.log.scan({ fromSeq: callSeq, toSeq: callSeq, lane: s.lane }))[0]
      // The `[nested result]` note a synthesized close of this call commits with. Read before the
      // result lands, while the effect is still pending and bounds the scan.
      const notesFor = (code: string) => recoveryNotes(s, root, callRow?.data, code)
      // A parent whose own children are still unsettled: the process died somewhere inside the
      // call it made, and there is no way to tell from here whether the parent's own work finished
      // around them. Every descendant is closed as `unknown` and the parent is handed the list, so
      // the model (or, per `preset.recovery.unknownChild`, a human) decides what to do about a call
      // that may or may not have completed - this branch runs before the replay check below, which
      // answers a different question (whether the parent itself, not its children, may be re-run).
      if (root.children.length > 0) {
        const events: EventInput[] = []
        for (const c of root.children) settleUnknownSubtree(s, c, events)
        const descendants = flattenDescendants(root).map(effectSummary)
        events.push(
          syntheticResult(
            s,
            root.tool.toolUseId,
            'CHILD_INTERRUPTED',
            JSON.stringify({ interrupted: true, effects: descendants }),
            root.argsSeq ?? root.intentSeq,
          ),
          // The interrupted children's own closers are not on the ledger yet, so only the nested
          // calls that had already settled are listed.
          ...(await notesFor('CHILD_INTERRUPTED')),
          s.ev('effect/settled', { effectId: root.effectId, outcome: 'unknown' }),
        )
        events.push(...undispatchedNestedEvents)
        const descendantIds = new Set(
          flattenDescendants(root).flatMap((node) =>
            node.kind === 'tool' && node.tool ? [node.tool.toolUseId] : [],
          ),
        )
        for (const id of nestedCallIds) descendantIds.add(id)
        await s.transition(
          events,
          setCallsCompleted(setCallCompleted(cur, root.tool.toolUseId), descendantIds),
        )
        await s.diag('child-interrupted', { effectId: root.effectId, children: descendants.length })
        actions.push({ effectId: root.effectId, action: 'unknown' })
        if (s.preset.recovery.unknownChild === 'human')
          await askUnknownOutcome(s, root.tool.toolUseId, root.tool.name)
        continue
      }
      const registered = s.turn?.snapshot.byName.get(root.tool.name)
      // Recovery consumes the envelope durably written for this exact call. Looking at today's
      // ToolDef would re-run a classifier after a crash and could turn an input mutation into a safe
      // capture (or the reverse). Legacy open calls, tampered policy hashes, replay disagreement,
      // and definition drift all have an unknown external outcome and therefore take the same
      // human-reconciliation path as an explicit never-replay call.
      const persisted =
        cur.phase.kind === 'tools'
          ? cur.phase.batch.calls.find((call) => call.toolUseId === root.tool?.toolUseId)
          : undefined
      const ledgerPolicy = hasTrustedToolCallProvenance(callRow)
        ? (callRow?.data as PersistedToolPolicyFields)
        : undefined
      let recoveryRefusal: string | undefined
      const bindingProblem = toolPolicyBindingProblem(persisted, ledgerPolicy ?? undefined)
      if (bindingProblem === 'missing') recoveryRefusal = 'persisted-policy-missing'
      else if (bindingProblem === 'ledger-state-mismatch') recoveryRefusal = 'ledger-state-policy-mismatch'
      else if (bindingProblem === 'hash-mismatch') recoveryRefusal = 'persisted-policy-hash-mismatch'
      else if (!hasCompleteToolPolicyEnvelope(persisted)) recoveryRefusal = 'persisted-policy-missing'
      else if (persisted.effectId !== root.effectId) recoveryRefusal = 'persisted-effect-binding-mismatch'
      else if (persisted.resolvedPolicy.replay !== root.replay)
        recoveryRefusal = 'persisted-effect-replay-mismatch'
      else if (!registered) recoveryRefusal = 'tool-definition-missing'
      else if (persisted.definitionFingerprint !== registered.definitionFingerprint)
        recoveryRefusal = 'tool-definition-drift'
      if (
        [...s.state.registers.decisionStates.values()].some(
          ({ value }) =>
            value.request.operationId === root.tool?.toolUseId &&
            value.request.owner === registered?.source.source,
        )
      )
        recoveryRefusal = 'decision-continuation-blocked'
      if (recoveryRefusal)
        await s.diag('tool-policy-refused-on-resume', {
          effectId: root.effectId,
          tool: root.tool.name,
          reason: recoveryRefusal,
        })
      let hasMatchingResult = false
      const results = scanPages((q) => s.d.log.scan(q), {
        fromSeq: root.argsSeq ?? root.intentSeq,
        toSeq: s.lastSeq,
        type: 'tool/result',
        lane: s.lane,
      })
      for await (const page of results) {
        hasMatchingResult = page.some(
          (row) => (row.data as { toolUseId?: unknown } | null)?.toolUseId === root.tool?.toolUseId,
        )
        if (hasMatchingResult) break
      }
      const decision = classifyToolRecovery({
        mode: cur.control.status === 'cancel_requested' ? 'cancel' : 'resume',
        call: persisted ?? {
          status: 'effect_pending',
          replay: root.replay,
          effectId: root.effectId,
        },
        policy: persisted?.resolvedPolicy,
        policyBinding: recoveryRefusal ? 'untrusted' : 'trusted',
        hasMatchingResult,
      })
      if (decision === 'settle-only') {
        await s.transition(
          [...undispatchedNestedEvents, s.ev('effect/settled', { effectId: root.effectId, outcome: 'ok' })],
          setCallsCompleted(setCallCompleted(cur, root.tool.toolUseId), nestedCallIds),
        )
        actions.push({ effectId: root.effectId, action: actionForDecision(decision) })
        continue
      }
      if (decision === 'cancelled') {
        await s.transition(
          [
            ...undispatchedNestedEvents,
            syntheticResult(
              s,
              root.tool.toolUseId,
              'CANCELLED',
              `${root.tool.name} was cancelled before dispatch`,
              root.argsSeq ?? root.intentSeq,
            ),
            s.ev('effect/settled', { effectId: root.effectId, outcome: 'aborted' }),
          ],
          setCallsCompleted(setCallCompleted(cur, root.tool.toolUseId), nestedCallIds),
        )
        actions.push({ effectId: root.effectId, action: actionForDecision(decision) })
        continue
      }
      if (decision === 'retry-same-effect') {
        // Keep the original effect open. Attempt two is a continuation of the same durable intent,
        // not a fresh effect that would reset the retry budget after another crash.
        await s.transition(
          undispatchedNestedEvents,
          setCallsCompleted(setCallRetryAttempt(cur, root.tool.toolUseId), nestedCallIds),
        )
        actions.push({ effectId: root.effectId, action: actionForDecision(decision, root.replay) })
        continue
      }
      const blocked = recoveryRefusal === 'decision-continuation-blocked'
      const code = blocked ? 'DECISION_CONTINUATION_BLOCKED' : 'TOOL_OUTCOME_UNKNOWN'
      const notes = await notesFor(code)
      await s.transition(
        [
          ...undispatchedNestedEvents,
          s.ev(
            'tool/result',
            {
              toolUseId: root.tool.toolUseId,
              content: [
                {
                  type: 'text',
                  text: `the outcome of ${root.tool.name} is unknown: the process died after the call went out`,
                },
              ],
              isError: true,
              code,
              enforcement: s.d.runtime.enforcement(),
              authz: { decisionId: 'n/a' },
            },
            { sourceEventSeqs: [root.argsSeq ?? root.intentSeq] },
          ),
          ...notes,
          s.ev('effect/settled', { effectId: root.effectId, outcome: 'unknown' }),
        ],
        setCallsCompleted(setCallCompleted(cur, root.tool.toolUseId), nestedCallIds),
      )
      actions.push({ effectId: root.effectId, action: 'unknown' })
      // Reentry refusal says nothing about effects that may already have occurred.
      await askUnknownOutcome(s, root.tool.toolUseId, root.tool.name)
      continue
    }
    if (root.kind === 'compaction') {
      await s.transition(
        [s.ev('effect/settled', { effectId: root.effectId, outcome: 'error' })],
        cur.phase.kind === 'compaction' ? withPhase(cur, cur.phase.resumeAfter as OpStateObj['phase']) : cur,
      )
      await s.diag('compaction-failed', { effectId: root.effectId, reason: 'interrupted' })
      actions.push({ effectId: root.effectId, action: 'error' })
      continue
    }
    // A kind with no replay rule - a submitted job is the one that exists - is left outstanding and
    // reported. Settling it would put an outcome on the ledger that nobody observed; polling it is
    // the deferred phase's work, not the resume's.
    actions.push({ effectId: root.effectId, action: 'poll' })
  }
  const phase = s.op()?.phase.kind
  return { state: 'resumed', ...(phase ? { phase } : {}), actions }
}

/**
 * The other resume mode: not a continuation, a closing. Every effect still open anywhere in the
 * turn - inference, tool, compaction, job, and each still-pending child under any of them - is
 * settled in place (an inference-kind node as `error`, since nobody is going to retry it; a
 * tool-kind node as `unknown`, with its own `TOOL_OUTCOME_UNKNOWN` closer, for the same reason a
 * plain resume writes one; a side-call node as `unknown`, after its estimated cost row). A call that
 * had not even reached that far - still `planned` or `awaiting_approval` in the batch, with no
 * `effect/intent` on the ledger at all - gets `TOOL_NOT_STARTED` instead: there is no effect to
 * settle, only a call to close. All of it lands
 * in the one transaction `endTurn` writes: the settlements, the synthesized results, the step's own
 * close if one was open, and `turn/end{ reason: 'interrupted' }` tombstoning `op.state`. Nothing
 * here is resumed and nothing is re-run; a session closed this way is done, not paused.
 */
export async function closeInterrupted(s: SessionImpl): Promise<ResumeReport> {
  const op = s.op()
  if (!op) return { state: 'idle', actions: [] }
  const events: EventInput[] = []
  const actions: ResumeReport['actions'] = []
  const priorResults = await scanAll((q) => s.d.log.scan(q), {
    fromSeq: op.meta.triggerSeq,
    toSeq: s.lastSeq,
    type: 'tool/result',
    lane: s.lane,
  })
  const closedCalls = new Set(
    priorResults.map((row) => (row.data as { toolUseId?: unknown } | null)?.toolUseId).filter(Boolean),
  )
  const callRows = await scanAll((q) => s.d.log.scan(q), {
    fromSeq: op.meta.triggerSeq,
    toSeq: s.lastSeq,
    type: 'tool/call',
    lane: s.lane,
  })
  const ledgerCalls = new Map(
    callRows.flatMap((row) => {
      const data = row.data as (PersistedToolPolicyFields & { toolUseId?: unknown }) | null
      return hasTrustedToolCallProvenance(row) && typeof data?.toolUseId === 'string'
        ? [[data.toolUseId, data] as const]
        : []
    }),
  )
  const stateCalls =
    op.phase.kind === 'tools'
      ? new Map(op.phase.batch.calls.map((call) => [call.toolUseId, call]))
      : new Map()
  // Calls closed as unknown with the effect each ran under, for their `[nested result]` notes.
  const unknownCalls: Array<{ toolUseId: string; name: string; effectId?: string }> = []
  const closeCall = (
    toolUseId: string,
    name: string,
    code: 'TOOL_NOT_STARTED' | 'TOOL_OUTCOME_UNKNOWN',
    sourceSeq: Seq,
    detail?: string,
    effectId?: string,
  ): void => {
    if (closedCalls.has(toolUseId)) return
    if (code === 'TOOL_OUTCOME_UNKNOWN')
      unknownCalls.push({ toolUseId, name, ...(effectId ? { effectId } : {}) })
    events.push(
      syntheticResult(
        s,
        toolUseId,
        code,
        detail ??
          (code === 'TOOL_NOT_STARTED'
            ? `${name} never started: the session was closed first`
            : `the outcome of ${name} is unknown: the session was closed before it settled`),
        sourceSeq,
      ),
    )
    closedCalls.add(toolUseId)
  }
  // Reading a side call's binding row is asynchronous and the settlement below is not, so the rows
  // of every side call still open anywhere in the tree are read first.
  const sideCallRows = new Map<string, EventInput[]>()
  const readSideCalls = async (n: EffectNode): Promise<void> => {
    for (const c of n.children) await readSideCalls(c)
    if (n.kind === 'side-call') sideCallRows.set(n.effectId, await interruptedSideCallRows(s, n))
  }
  for (const root of s.pendingEffects()) await readSideCalls(root)
  const settleAll = (n: EffectNode): void => {
    for (const c of n.children) settleAll(c)
    if (n.kind === 'side-call') {
      events.push(
        ...(sideCallRows.get(n.effectId) ?? [
          s.ev('effect/settled', { effectId: n.effectId, outcome: 'unknown' }),
        ]),
      )
      actions.push({ effectId: n.effectId, action: 'unknown' })
      return
    }
    if (n.kind === 'tool' && n.tool) {
      const call = stateCalls.get(n.tool.toolUseId)
      const ledger = ledgerCalls.get(n.tool.toolUseId)
      const registered = s.currentTools().resolve(n.tool.name)
      const stateEffectId = call && 'effectId' in call ? call.effectId : undefined
      const trusted =
        call !== undefined &&
        toolPolicyBindingProblem(call, ledger) === undefined &&
        hasCompleteToolPolicyEnvelope(call) &&
        stateEffectId === n.effectId &&
        call.resolvedPolicy.replay === n.replay &&
        registered !== undefined &&
        call.definitionFingerprint === registered.definitionFingerprint
      const decision = call
        ? classifyToolRecovery({
            mode: 'close',
            call,
            policy: call.resolvedPolicy,
            policyBinding: trusted ? 'trusted' : 'untrusted',
            hasMatchingResult: closedCalls.has(n.tool.toolUseId),
          })
        : 'unknown'
      const settled = decision === 'settle-only'
      events.push(s.ev('effect/settled', { effectId: n.effectId, outcome: settled ? 'ok' : 'unknown' }))
      if (!settled)
        closeCall(
          n.tool.toolUseId,
          n.tool.name,
          'TOOL_OUTCOME_UNKNOWN',
          n.argsSeq ?? n.intentSeq,
          undefined,
          n.effectId,
        )
      actions.push({ effectId: n.effectId, action: settled ? 'settle' : 'unknown' })
      return
    }
    const unknown = n.kind === 'job' || n.kind === 'media'
    events.push(s.ev('effect/settled', { effectId: n.effectId, outcome: unknown ? 'unknown' : 'error' }))
    actions.push({ effectId: n.effectId, action: unknown ? 'unknown' : 'error' })
  }
  for (const root of s.pendingEffects()) settleAll(root)
  if (op.phase.kind === 'tools')
    for (const c of op.phase.batch.calls) {
      const decision = classifyToolRecovery({
        mode: 'close',
        call: c,
        policy: c.resolvedPolicy,
        policyBinding: 'trusted',
        hasMatchingResult: closedCalls.has(c.toolUseId),
      })
      closeCall(
        c.toolUseId,
        c.name,
        decision === 'not-started' ? 'TOOL_NOT_STARTED' : 'TOOL_OUTCOME_UNKNOWN',
        c.argsSeq,
        undefined,
        'effectId' in c ? c.effectId : undefined,
      )
    }
  if (op.phase.kind === 'deferred')
    for (const job of op.phase.jobs) {
      const call = s.state.toolCalls.get(job.toolUseId)
      if (call)
        closeCall(
          job.toolUseId,
          call.name,
          'TOOL_OUTCOME_UNKNOWN',
          call.seq,
          `job ${job.jobId} was still pending when the session was closed`,
        )
    }
  // Nothing reads a result once the session closes. A nested call closed as unknown gets the
  // unknown note; an outer one, the nested calls that had already written under it. The closers in
  // `events` are not on the ledger yet, so the list holds only nested calls that settled before.
  const rows = new Map(
    callRows.map((row) => [(row.data as { toolUseId?: unknown } | null)?.toolUseId, row.data]),
  )
  for (const c of unknownCalls) {
    // The batch state also knows a call made in an earlier turn (an approval continuation's).
    const row = (rows.get(c.toolUseId) ?? stateCalls.get(c.toolUseId)) as
      | { depth?: number; parentEffectId?: string }
      | undefined
    const nested = isNestedCall(row)
    // An outer call closed without a known effect has nothing to list under it.
    const effectId = c.effectId ?? (nested ? '' : undefined)
    if (effectId === undefined) continue
    events.push(
      ...(await failureNotes(
        s,
        { name: c.name, effectId, nested, parentEffectId: row?.parentEffectId },
        'TOOL_OUTCOME_UNKNOWN',
      )),
    )
  }
  events.push(
    s.ev('x/core/resume-closed', { turn: op.meta.turn, effects: actions.length }, { ignorable: true }),
  )
  await closeTurn(s, 'interrupted', { events })
  return { state: 'resumed', phase: 'terminal', actions }
}
