import { canonicalJson } from '@agnes/core-common/request/hash'
import { CoreError } from '@agnes/core-common/types'
import type { DecisionReviewPort, DecisionSpec } from '@agnes/extension-api'
import { hookedAsk } from './approval-ask.js'
import { deliverDecision } from './decision-delivery.js'
import { domainDecisionEvents } from './domain-decision.js'
import type { SessionImpl } from './session.js'

/** An operation can review its own candidate without writing kernel events or issuing grants. */
export function operationDecisionPort(s: SessionImpl, owner: string): DecisionReviewPort {
  const source = s.decisions.bindSource({
    owner: `operation/${owner}`,
    sourcePackage: owner,
    packageVersion: s.d.agnesVersion ?? '0.0.0',
    operationId: owner,
    alive() {
      s.ac.signal.throwIfAborted()
    },
  })
  const port = s.decisions.port(source)
  return Object.freeze({
    ...port,
    async review(spec: DecisionSpec, options?: { readonly signal?: AbortSignal }) {
      const signal = AbortSignal.any([s.ac.signal, ...(options?.signal ? [options.signal] : [])])
      if (!spec.options.every((option) => ['allowed-once', 'allowed-session', 'rejected'].includes(option)))
        throw new CoreError('E_ENVELOPE', 'Operation reviews require one-shot approval choices')
      const existing = [...s.state.registers.decisionStates.values()].find(
        ({ value }) => value.request.owner === source.owner && value.request.spec.key === spec.key,
      )?.value
      const { asked, rewrite } = await hookedAsk(
        s,
        spec.purpose,
        null,
        { summary: spec.prompt, risk: 'always' as const },
        !existing,
      )
      const subject = spec.subject
      // A restored question is asked again exactly as it was recorded.
      const handle = await s.decisions.port({ ...source, permission: true }).request({
        ...spec,
        ...(existing
          ? { subject: existing.request.spec.subject }
          : rewrite && subject && typeof subject === 'object' && !Array.isArray(subject)
            ? { subject: { ...subject, rewrite } }
            : {}),
        prompt: existing?.request.spec.prompt ?? asked.summary,
      })
      const snapshot = await port.get(handle)
      if (snapshot.consumption) throw new CoreError('E_RELATION', 'DECISION_ALREADY_CONSUMED')
      if (snapshot.invalidation || (snapshot.result && snapshot.result.reason !== 'answered')) return snapshot
      let review: Awaited<ReturnType<typeof deliverDecision>>
      try {
        review = await deliverDecision(
          s,
          snapshot,
          {
            requestId: handle.id,
            kind: spec.purpose === 'refine' ? 'refine' : 'unknown-outcome',
            sessionKey: s.key,
            stepId: `${s.op()?.meta.turn ?? 0}/${s.op()?.step ?? 0}`,
            actor: s.d.actor,
            taint: (s.op()?.taint ?? false) || s.laneTaint(),
            scope: s.key,
            summary: snapshot.request.spec.prompt,
            risk: 'always',
            bindingHash: snapshot.request.subjectDigest,
            options: [...spec.options] as Array<'allowed-once' | 'allowed-session' | 'rejected'>,
            deadline:
              snapshot.request.expiresAt ?? new Date(s.d.clock() + s.preset.approval.timeoutMs).toISOString(),
            context: asked.context ?? canonicalJson(spec.subject),
          },
          signal,
          source.alive,
        )
      } catch (error) {
        if (!signal.aborted) throw error
        return s.decisions.withdraw(handle, source, 'stopped')
      }
      if (review.park)
        return s.decisions.withdraw(handle, source, (review.park.data as { waitEndedBy: string }).waitEndedBy)
      await s.locked(async () => {
        const events = domainDecisionEvents(s, review.snapshot, source)
        if (events.length) await s.d.log.append(events)
      })
      return port.get(handle)
    },
  })
}
