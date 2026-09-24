import { CoreError, type Seq } from '../types.js'
import { newOpState } from './op-state.js'
import type { SessionImpl } from './session.js'

/** A verifier pause asks permission to continue, not whether a side effect happened. */
export async function continueVerifier(
  s: SessionImpl,
  requestId: string,
  askedSeq: Seq,
  allowed: boolean,
): Promise<'opened' | 'blocked'> {
  const start = (
    await s.d.log.scan({
      fromSeq: 1,
      toSeq: askedSeq,
      lane: s.lane,
      type: 'turn/start',
      order: 'desc',
      limit: 1,
    })
  )[0]
  if (!start) throw new CoreError('E_RELATION', 'verifier pause turn missing')
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
  const rd = repair?.data as { decision: string; verdictSeq: Seq } | undefined
  if (!repair || rd?.decision !== 'park' || rd.verdictSeq <= start.seq || rd.verdictSeq >= repair.seq)
    throw new CoreError('E_RELATION', 'verifier pause decision missing')
  const signal = (await s.d.log.scan({ fromSeq: rd.verdictSeq, toSeq: rd.verdictSeq, lane: s.lane }))[0]
  const verdict = signal?.data as { scope: string; verdict: string } | undefined
  if (
    signal?.type !== 'verifier/signal' ||
    verdict?.scope !== 'turn' ||
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
  if (!allowed) {
    // Start, consumption, terminal row and tombstone must commit together: no crash can turn
    // a refusal into a ready checkpoint that sends a request on reopen.
    await s.endTurn('blocked', { events: [event] })
    return 'blocked'
  }
  await s.transition([event], (cur, seq) => {
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
  })
  return 'opened'
}
