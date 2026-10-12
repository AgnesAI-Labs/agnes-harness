import { newOpState } from '@agnes/core-common/step/op-state'
import { CoreError, type Seq } from '@agnes/core-common/types'
import type { DecisionSnapshot } from '@agnes/extension-api'
import { domainDecisionEvents, domainDecisionSource } from './domain-decision.js'
import type { SessionImpl } from './session.js'

/** A verifier pause asks permission to continue, not whether a side effect happened. */
export async function continueVerifier(
  s: SessionImpl,
  snapshot: DecisionSnapshot,
): Promise<'opened' | 'blocked' | false> {
  const subject = snapshot.request.spec.subject as {
    turn: number
    step: number
    triggerSeq: Seq
    round: number
    verdict: string
  }
  const requestId = snapshot.handle.id
  const allowed =
    !snapshot.invalidation &&
    snapshot.result?.reason === 'answered' &&
    snapshot.result.response.option.startsWith('allowed')
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
  if (!step) throw new CoreError('E_RELATION', 'verifier pause step missing')
  const originalTurn = (start.data as { turn: number }).turn
  const originalStep = step.data as { turn: number; step: number }
  if (originalStep.turn !== originalTurn) throw new CoreError('E_RELATION', 'verifier pause step mismatch')
  const turn = s.lastTurnNumber() + 1
  const event = s.ev('turn/start', {
    turn,
    trigger: 'approval-resume',
    continues: { turn: originalTurn, step: originalStep.step, requestId },
  })
  const consumed = () =>
    domainDecisionEvents(s, snapshot, domainDecisionSource(s, 'gate', snapshot.request.operationId))
  if (!allowed) {
    // Start, consumption, terminal row and tombstone must commit together: no crash can turn
    // a refusal into a ready checkpoint that sends a request on reopen.
    await s.endTurn('blocked', { events: () => [event, ...consumed()] })
    return 'blocked'
  }
  await s.transition(
    () => [event, ...consumed()],
    (cur, seq) => {
      if (cur) throw new CoreError('E_LANE_BUSY', 'continuation lane occupied')
      return newOpState(
        {
          turn,
          lane: s.lane,
          acceptedAt: new Date(s.d.clock()).toISOString(),
          triggerSeq: seq,
          presetName: s.preset.name,
          profileHash: s.d.resolvedProfileHash,
          depthLimit: s.preset.depthLimit,
        },
        seq,
      )
    },
  )
  return 'opened'
}
