import { childLifecycleRevoked } from '../child/lifecycle.js'
import { assertReview } from '../execution/turn/review-budget.js'
import { DecisionCommands } from './decisions.js'
import type { SessionDeps, SessionImpl } from './session.js'

/** Bind decision ownership to the session's live authorization and single writer. */
export function sessionDecisions(session: SessionImpl, deps: SessionDeps): DecisionCommands {
  return new DecisionCommands({
    get key() {
      return session.key
    },
    get lane() {
      return session.lane
    },
    get lastSeq() {
      return session.lastSeq
    },
    get closed() {
      return session.closingOrClosed || deps.log.isClosed
    },
    get cancelled() {
      return session.op()?.control.status === 'cancel_requested' || childLifecycleRevoked(session)
    },
    get actor() {
      return session.d.actor
    },
    get permissionContext() {
      return session.permissionContext
    },
    get delegatedToolApprovals() {
      return session.roleAuthority?.humanApprovals !== false
    },
    get refuseApprovals() {
      return session.d.roleDelegation !== undefined
    },
    get delegatedFullAccess() {
      return session.d.roleDelegation?.delegatedFullAccess === true
    },
    get ttlMs() {
      return session.preset.approval.pendingTtlMs
    },
    ...(deps.timers ? { timers: deps.timers } : {}),
    log: deps.log,
    beforeAttestation: () => deps.log.fullVerified(),
    admitReviewDecision: async (spec, source, wait) => {
      if (
        !wait &&
        spec.purpose === 'unknown-outcome' &&
        source.owner === 'core/unknown-outcome' &&
        source.sourcePackage === '@agnes/core'
      )
        return
      await assertReview(session, 'unsupported')
    },
    historyVerified: () => deps.log.historyVerified,
    readDecisions: () => session.state.registers.decisionStates,
    clock: () => deps.clock(),
    id: () => deps.ids.ulid(),
    transact: (work) => session.locked(work),
    event: (value) => session.ev('decision/state', value, { register: 'decision/state' }),
  })
}
