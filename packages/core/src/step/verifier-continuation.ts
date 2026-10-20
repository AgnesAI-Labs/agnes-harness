import { CoreError, type Seq } from '@agnes/core-common/types'
import type { DecisionSnapshot, LoopStepOutcome } from '@agnes/extension-api'
import type { SessionImpl } from './session.js'

type GateSubject = {
  turn: number
  step: number
  triggerSeq: Seq
  round: number
  verdict: string
  /** Historical marker: the loop had already asked to complete when verification parked. */
  completes?: boolean
}

/** Only Core may retire its own historical verifier question, including across a version upgrade. */
export async function retireVerifierDecision(s: SessionImpl, snapshot: DecisionSnapshot): Promise<void> {
  const request = snapshot.request
  if (request.owner !== 'core/gate' || request.sourcePackage !== '@agnes/core' || request.lane !== s.lane)
    throw new CoreError('E_RELATION', 'not a legacy verifier decision of this lane')
  const source = s.decisions.bindSource({
    permission: true,
    owner: 'core/gate',
    operationId: request.operationId,
    sourcePackage: '@agnes/core',
    packageVersion: request.packageVersion,
    alive() {
      s.ac.signal.throwIfAborted()
    },
  })
  await s.decisions.withdraw(snapshot.handle, source, 'verifier-system-error')
}

/** The stop-gate decisions of this lane that no continuation has read yet. */
export function* parkedGates(s: SessionImpl, completes: boolean) {
  for (const { value } of s.state.registers.decisionStates.values()) {
    if (
      value.request.owner !== 'core/gate' ||
      value.request.sourcePackage !== '@agnes/core' ||
      value.request.lane !== s.lane ||
      value.consumption ||
      s.state.resumedRequests.has(value.handle.id) ||
      ((value.request.spec.subject as GateSubject).completes === true) !== completes
    )
      continue
    yield value
  }
}

/**
 * A completion that parked at the stop gate is Core's to finish: the loop has no step left to take.
 * Retire its obsolete question automatically and block the unverified completion. The driver is
 * not asked to repeat its business work.
 */
export async function settleParkedCompletion(s: SessionImpl): Promise<LoopStepOutcome | undefined> {
  for (const value of parkedGates(s, true)) {
    const parked: LoopStepOutcome = { outcome: 'parked', phase: 'terminal', reason: 'parked' }
    if (value.request.requestedBy.id !== s.d.actor.id || value.request.requestedBy.org !== s.d.actor.org)
      return parked
    const snapshot = await s.decisions.get(value.handle)
    const reason = await continueVerifier(s, snapshot)
    if (reason === 'blocked') return { outcome: 'turn-ended', phase: 'terminal', reason }
  }
  return undefined
}

/** Retire legacy verification questions without treating any answer as authorization. */
export async function continueVerifier(
  s: SessionImpl,
  snapshot: DecisionSnapshot,
): Promise<'blocked' | false> {
  const subject = snapshot.request.spec.subject as GateSubject
  const requestId = snapshot.handle.id
  const start = (
    await s.d.log.scan({
      fromSeq: subject.triggerSeq,
      toSeq: s.lastSeq,
      lane: s.lane,
      type: 'turn/start',
      order: 'asc',
      limit: 1,
    })
  )[0]
  if (start?.type !== 'turn/start' || (start.data as { turn: number }).turn !== subject.turn)
    throw new CoreError('E_RELATION', 'verifier pause turn missing')
  const [end] = await s.d.log.scan({
    fromSeq: start.seq,
    toSeq: s.lastSeq,
    lane: s.lane,
    type: 'turn/end',
    order: 'asc',
    limit: 1,
  })
  if (!end || (end.data as { reason?: string }).reason !== 'parked') return false
  const askedSeq = end.seq
  const repair = (
    await s.d.log.scan({
      fromSeq: start.seq,
      toSeq: askedSeq,
      lane: s.lane,
      type: 'repair/decision',
      order: 'desc',
      limit: 1,
    })
  )[0]
  const rd = repair?.data as { decision: string; verdictSeq: Seq; round: number } | undefined
  if (
    !repair ||
    rd?.decision !== 'park' ||
    rd.round !== subject.round ||
    rd.verdictSeq <= start.seq ||
    rd.verdictSeq >= repair.seq
  )
    throw new CoreError('E_RELATION', 'verifier pause decision missing')
  const signal = (await s.d.log.scan({ fromSeq: rd.verdictSeq, toSeq: rd.verdictSeq, lane: s.lane }))[0]
  const verdict = signal?.data as { scope: string; verdict: string } | undefined
  if (
    signal?.type !== 'verifier/signal' ||
    verdict?.scope !== 'turn' ||
    verdict.verdict !== subject.verdict ||
    (verdict.verdict !== 'fail' && verdict.verdict !== 'needs_revision')
  )
    throw new CoreError('E_RELATION', 'verifier pause signal missing')
  const step = (
    await s.d.log.scan({
      fromSeq: start.seq,
      toSeq: askedSeq,
      lane: s.lane,
      type: 'step/start',
      order: 'desc',
      limit: 1,
    })
  )[0]
  const originalTurn = (start.data as { turn: number }).turn
  // A loop that only decides and checkpoints parks at the gate without ever opening a step.
  const originalStep = (step?.data as { turn: number; step: number } | undefined) ?? {
    turn: originalTurn,
    step: 0,
  }
  if (originalStep.turn !== originalTurn) throw new CoreError('E_RELATION', 'verifier pause step mismatch')
  const turn = s.lastTurnNumber() + 1
  const event = s.ev('turn/start', {
    turn,
    trigger: 'approval-resume',
    continues: { turn: originalTurn, step: originalStep.step, requestId },
  })
  // Old releases asked humans to approve verification failures. Retire that question as a
  // system withdrawal, even if somebody answered it; permission cannot establish valid output.
  await retireVerifierDecision(s, snapshot)
  await s.endTurn('blocked', {
    events: () => [
      event,
      s.ev(
        'x/core/verifier-recovery',
        { handling: 'blocked', legacyDecisionId: requestId, verdict: subject.verdict },
        { ignorable: true },
      ),
      s.ev(
        'x/core/decision-checkpoint',
        { handle: snapshot.handle, operationId: snapshot.request.operationId },
        { ignorable: true },
      ),
    ],
  })
  return 'blocked'
}
