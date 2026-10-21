import { CoreError, type EventInput } from '@agnes/core-common/types'
import { isPending } from '@agnes/core-effects/effects/approval-answer'
import type { ApprovalRequest } from '@agnes/core-effects/effects/seams'
import type { DecisionSnapshot } from '@agnes/extension-api'
import { delegatedApprovalRequest } from '../child/approval.js'
import type { DecisionSource } from './decisions.js'
import type { SessionImpl } from './session.js'

/** Delivery can end without an answer; the persisted request remains the only pending authority. */
export async function deliverDecision(
  s: SessionImpl,
  snapshot: DecisionSnapshot,
  offered: ApprovalRequest,
  signal: AbortSignal,
  authorize: () => void = () => {
    const call = snapshot.request.spec.subject as { call?: { name?: string; definitionFingerprint?: string } }
    if (
      !call.call?.name ||
      s.currentTools().resolve(call.call.name)?.definitionFingerprint !== call.call.definitionFingerprint
    )
      throw new CoreError('E_RELATION', 'DECISION_SOURCE_CHANGED')
  },
): Promise<{ snapshot: DecisionSnapshot; park?: EventInput; pending?: boolean }> {
  if (!snapshot.result && !snapshot.invalidation) {
    const local = new AbortController()
    const deliverySignal = AbortSignal.any([signal, local.signal])
    offered = await delegatedApprovalRequest(s, snapshot, offered)
    const delivery = s
      .askApprovalAnswer(
        {
          ...offered,
          requestId: snapshot.handle.id,
          deadline: snapshot.request.expiresAt ?? offered.deadline,
          decision: { handle: snapshot.handle, revision: snapshot.revision },
        },
        deliverySignal,
      )
      .then((answer) => ({ kind: 'delivery' as const, answer }))
    const source: DecisionSource = {
      owner: snapshot.request.owner,
      operationId: snapshot.request.operationId,
      sourcePackage: snapshot.request.sourcePackage,
      packageVersion: snapshot.request.packageVersion,
      alive() {},
    }
    const waiting = s.decisions
      .port(source)
      .wait(snapshot.handle, { signal: deliverySignal })
      .then((result) => ({ kind: 'state' as const, result }))
    let winner: Awaited<typeof delivery> | Awaited<typeof waiting>
    try {
      winner = await Promise.race([delivery, waiting])
    } finally {
      local.abort('detached')
      await Promise.allSettled([delivery, waiting])
    }
    signal.throwIfAborted()
    if (winner.kind === 'state') return { snapshot: await s.decisions.get(snapshot.handle) }
    const answer = winner.answer
    if (
      !isPending(answer) &&
      answer.answeredBy &&
      answer.answeredBy.role !== 'agent' &&
      (!s.roleAuthority || answer.answeredBy.role !== 'system') &&
      ['allowed-once', 'allowed-session', 'allowed-permanent', 'rejected'].includes(answer.verdict)
    ) {
      try {
        await s.decisions.answer(
          {
            handle: snapshot.handle,
            revision: snapshot.revision,
            commandId: `delivery:${snapshot.handle.id}`,
            response: { option: answer.verdict, value: null },
          },
          {
            actor: answer.answeredBy,
            category: 'human',
            authorize() {
              signal.throwIfAborted()
              authorize()
            },
          },
        )
      } catch (error) {
        // Another authenticated client may have won the same writer race. Read its canonical result.
        const current = await s.decisions.get(snapshot.handle)
        if (!current.result && !current.invalidation) throw error
      }
    } else {
      const current = await s.decisions.get(snapshot.handle)
      if (!current.result && !current.invalidation) {
        if (s.roleAuthority)
          return {
            snapshot: await s.decisions.withdraw(
              current.handle,
              source,
              isPending(answer) ? 'detached' : (answer.reason ?? 'invalid-answer'),
            ),
          }
        const op = s.op()
        const [input] = op
          ? await s.d.log.scan({
              type: 'user/message',
              lane: s.lane,
              toSeq: op.meta.triggerSeq,
              order: 'desc',
              limit: 1,
            })
          : []
        if (input?.origin === 'system' && input.actor.attrs.unattendedApproval === 'refuse') {
          const refused = await s.decisions.withdraw(current.handle, source, 'unattended-refused')
          await s.d.log.append([
            s.ev('x/core/unattended-refused', { handle: current.handle }, { ignorable: true }),
          ])
          return { snapshot: refused }
        }
        return {
          snapshot: current,
          pending: isPending(answer),
          park: s.ev(
            'x/core/decision-delivery',
            {
              handle: current.handle,
              waitEndedBy: isPending(answer)
                ? 'detached'
                : (answer.reason ?? (answer.verdict === 'unavailable' ? 'no-approver' : 'invalid-answer')),
            },
            { ignorable: true },
          ),
        }
      }
    }
  }
  return { snapshot: await s.decisions.get(snapshot.handle) }
}
