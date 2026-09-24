import { type Actor, inspectJsonData, isDateTime, validateAgainst } from '@agnes/protocol'
import { ApprovalDecided } from '@agnes/protocol/gen/session-v1'
import { type Static, Type } from '@sinclair/typebox'
import type { Verdict } from '../effects/seams.js'
import { CoreError, type Seq } from '../types.js'
import { permanentGrantId } from './approval-grants.js'
import type { SessionImpl } from './session.js'

// Callback and expiry share one queue. A rejected callback must not poison the next attempt.
const queues = new WeakMap<SessionImpl, Promise<void>>()
function serial<T>(s: SessionImpl, fn: () => Promise<T>): Promise<T> {
  const work = (queues.get(s) ?? Promise.resolve()).then(fn)
  const tail = work.then(
    () => undefined,
    () => undefined,
  )
  queues.set(s, tail)
  void tail.then(() => {
    if (queues.get(s) === tail) queues.delete(s)
  })
  return work
}
async function reject(s: SessionImpl, reason: string): Promise<never> {
  await s.diag('approval-callback-rejected', { reason })
  throw new CoreError('E_RELATION', reason)
}
/** A pending approval's deadline in epoch ms; NaN, which counts as already due, if it is not a date-time. */
export const approvalDeadlineMs = (value: string): number =>
  isDateTime(value) ? Date.parse(value) : Number.NaN
const Receipt = Type.Object(
  {
    requestId: Type.String({ minLength: 1, maxLength: 128 }),
    bindingHash: Type.String({ pattern: '^([0-9a-f]{64})?$' }),
    expiresAt: Type.String(),
  },
  { additionalProperties: false },
)

export function resumeApproval(
  s: SessionImpl,
  ticket: string,
  verdict: Verdict,
  decidedBy: Actor,
): Promise<{ seq: Seq }> {
  // Detach before entering the queue; callers cannot change the approving identity while waiting.
  const data = inspectJsonData({ requestId: 'callback', verdict, via: 'callback', decidedBy, ticket })
  const checked = data.ok ? validateAgainst<ApprovalDecided>(ApprovalDecided, data.value) : undefined
  if (!checked?.ok || !checked.value.decidedBy || !ticket.length) return reject(s, 'invalid callback')
  const input = checked.value
  const approver = checked.value.decidedBy
  return serial(s, async () => {
    const matches = [...s.state.pendingApprovals.values()].filter((a) => a.pending?.ticket === ticket)
    const asked = matches.length === 1 ? matches[0] : undefined
    if (!asked?.pending || asked.lane !== s.lane) return reject(s, 'ticket unavailable')
    const offered = asked.options ?? ['allowed-once', 'allowed-session', 'rejected']
    if (input.verdict === 'allowed-permanent' && asked.kind !== 'tool')
      return reject(s, 'permanent approval is only valid for tool requests')
    if (!(offered as readonly string[]).includes(input.verdict))
      return reject(s, 'approval verdict was not offered')
    const deadline = approvalDeadlineMs(asked.pending.expiresAt)
    if (!Number.isFinite(deadline) || s.d.clock() >= deadline) return reject(s, 'ticket expired')
    const row = (await s.d.log.scan({ fromSeq: asked.seq, toSeq: asked.seq, lane: s.lane }))[0]
    if (row?.type !== 'approval/asked') return reject(s, 'approval record missing')
    if (row.actor.id === approver.id) return reject(s, 'self-approval')
    // The backend spends the ticket; a writer that has been replaced must find out first.
    await s.d.log.claimLease()
    let found: Awaited<ReturnType<typeof s.d.runtime.approvalResume>>
    try {
      found = await s.d.runtime.approvalResume(ticket, input.verdict)
    } catch {
      return reject(s, 'approval backend unavailable')
    }
    const receiptData = inspectJsonData(found)
    const receipt = receiptData.ok
      ? validateAgainst<Static<typeof Receipt>>(Receipt, receiptData.value)
      : undefined
    if (!receipt?.ok) return reject(s, 'approval binding mismatch')
    found = receipt.value
    const current = s.state.pendingApprovals.get(asked.requestId)
    if (!current || current.seq !== asked.seq) return reject(s, 'approval already decided')
    if (!found || found.requestId !== asked.requestId || found.bindingHash !== asked.bindingHash)
      return reject(s, 'approval binding mismatch')
    const backendDeadline = approvalDeadlineMs(found.expiresAt)
    if (
      !Number.isFinite(backendDeadline) ||
      backendDeadline > deadline ||
      s.d.clock() >= Math.min(deadline, backendDeadline)
    )
      return reject(s, 'ticket expired')
    const result = await s.d.log.append([
      s.ev(
        'approval/decided',
        {
          requestId: asked.requestId,
          verdict: input.verdict,
          via: 'callback',
          decidedBy: approver,
          ticket,
          ...(asked.scope ? { scope: asked.scope } : {}),
          ...(input.verdict === 'allowed-permanent' && asked.toolUseId && asked.scope
            ? {
                grantId: permanentGrantId({
                  sessionKey: s.key,
                  toolUseId: asked.toolUseId,
                  scope: asked.scope,
                }),
              }
            : {}),
        },
        { actor: approver, origin: 'external:callback' },
      ),
    ])
    return { seq: result.firstSeq }
  })
}

export function expireApprovals(s: SessionImpl): Promise<number> {
  return serial(s, async () => {
    let count = 0
    for (const asked of [...s.state.pendingApprovals.values()]) {
      if (asked.lane !== s.lane || !asked.pending) continue
      const deadline = approvalDeadlineMs(asked.pending.expiresAt)
      if (Number.isFinite(deadline) && s.d.clock() < deadline) continue
      if (s.state.pendingApprovals.get(asked.requestId)?.seq !== asked.seq) continue
      await s.d.log.append([
        s.ev('approval/decided', {
          requestId: asked.requestId,
          verdict: s.preset.approval.onTimeout,
          via: 'timeout',
          ticket: asked.pending.ticket,
        }),
      ])
      count++
    }
    return count
  })
}
