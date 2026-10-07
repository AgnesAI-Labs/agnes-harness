import type { ExecutionDomain, ResolvedToolCallPolicy } from '@agnes/protocol'
import { artifactUri } from '../../effects/tool-result.js'
import { scanPages } from '../../log/scan-pages.js'
import type { ArtifactJob } from '../../reduce/shapes.js'
import {
  hasAuthenticToolPolicyHash,
  hasCompleteToolPolicyEnvelope,
  hasTrustedToolCallProvenance,
} from '../../registry/tool-policy.js'
import { deferredEffectId } from '../../step/deferred.js'
import { type OpStateObj, withPhase } from '../../step/op-state.js'
import type { SessionImpl, StepOutcome } from '../../step/session.js'
import { stepVerifyInput } from '../../step/verify-input.js'
import type { EventInput, Seq } from '../../types.js'

/** Polls external artifact jobs without closing their owning step until every result is known. */
export async function runDeferred(s: SessionImpl): Promise<StepOutcome> {
  const op = s.op() as OpStateObj
  if (op.phase.kind !== 'deferred') return { phase: 'checkpoint' }
  const events: EventInput[] = []
  const remaining: typeof op.phase.jobs = []
  for (const pending of op.phase.jobs) {
    const job = await s.d.runtime.artifactsPoll(pending.jobId)
    if (job.status === 'queued' || job.status === 'running') {
      remaining.push(pending)
      continue
    }
    const jobEffect = s.state.pendingEffects.get(deferredEffectId(pending.jobId, pending.toolUseId))
    if (jobEffect?.kind === 'job')
      events.push(
        s.ev('effect/settled', {
          effectId: jobEffect.effectId,
          outcome: job.status === 'done' && job.ref ? 'ok' : 'error',
        }),
      )
    events.push(s.ev('artifact/job', job, { register: 'artifact/job' }))
    const provenance = await deferredResultProvenance(s, pending)
    const source = {
      trust: provenance.trust,
      ...(provenance.callSeq === undefined ? {} : { sourceEventSeqs: [provenance.callSeq] }),
    }
    const data =
      job.status === 'done' && job.ref
        ? {
            toolUseId: pending.toolUseId,
            content: [
              {
                type: 'resource_link' as const,
                uri: artifactUri(job.ref),
                mimeType: job.ref.mime,
                name: 'artifact',
              },
            ],
            isError: false,
            enforcement: s.d.runtime.enforcement(),
            authz: { decisionId: 'n/a' },
          }
        : {
            toolUseId: pending.toolUseId,
            content: [
              {
                type: 'text' as const,
                text:
                  (job as ArtifactJob).error ??
                  (job.status === 'done' ? 'artifact job completed without a result' : job.status),
              },
            ],
            isError: true,
            code: 'JOB_FAILED',
            enforcement: s.d.runtime.enforcement(),
            authz: { decisionId: 'n/a' },
          }
    events.push(s.ev('tool/result', data, source))
  }
  if (remaining.length > 0) {
    if (events.length > 0) await s.transition(events, withPhase(op, { ...op.phase, jobs: remaining }))
    return { phase: 'deferred' }
  }
  const openStep = s.state.openStep.get(s.lane)
  if (openStep) {
    const verdict = await s.d.runtime.verify('step', await stepVerifyInput(s, openStep.startSeq), s.ac.signal)
    events.push(
      s.ev('verifier/signal', {
        scope: 'step',
        tier: s.preset.verifier.defaultTier,
        verdict: verdict.verdict,
        reasons: verdict.reasons,
      }),
      s.ev('step/end', { turn: openStep.turn, step: openStep.step }),
    )
  }
  await s.transition(events, withPhase(op, op.phase.resumeAfter as OpStateObj['phase']))
  return { phase: 'checkpoint' }
}

/**
 * Deferred completion happens after the original ToolDef may have changed or disappeared. Trust
 * therefore comes only from the exact durable tool/call row. Old or repaired ledgers remain
 * readable, but an absent field, broken hash, or missing row can never upgrade external output.
 */
export async function deferredResultProvenance(
  s: SessionImpl,
  pending: {
    jobId: string
    toolUseId: string
    callSeq?: Seq
  },
): Promise<{ trust: 'trusted' | 'untrusted'; callSeq?: Seq }> {
  // Independent loops may join after the original step; the durable marker still owns provenance.
  const fromSeq = Math.min(s.state.openStep.get(s.lane)?.startSeq ?? 1, pending.callSeq ?? Infinity)
  const toSeq = s.lastSeq
  let markerCallSeq: Seq | undefined
  const pages = scanPages((q) => s.d.log.scan(q), {
    fromSeq,
    toSeq,
    type: 'x/core/deferred-job',
    lane: s.lane,
  })
  for await (const markers of pages) {
    for (const marker of markers) {
      const data = marker.data as { jobId?: unknown; toolUseId?: unknown } | null
      if (data?.jobId !== pending.jobId || data.toolUseId !== pending.toolUseId) continue
      const sourceSeq = marker.sourceEventSeqs?.[0]
      if (
        markerCallSeq !== undefined ||
        marker.origin !== 'system' ||
        marker.trust !== 'trusted' ||
        marker.sourceEventSeqs?.length !== 1 ||
        sourceSeq === undefined ||
        sourceSeq < fromSeq ||
        sourceSeq > toSeq
      )
        return { trust: 'untrusted' }
      markerCallSeq = sourceSeq
    }
  }
  if (markerCallSeq === undefined || (pending.callSeq !== undefined && pending.callSeq !== markerCallSeq))
    return { trust: 'untrusted' }
  const callSeq = markerCallSeq
  const [call] = await s.d.log.scan({ fromSeq: callSeq, toSeq: callSeq, limit: 1 })
  if (!hasTrustedToolCallProvenance(call) || call?.lane !== s.lane) return { trust: 'untrusted', callSeq }
  const policy = call.data as {
    toolUseId?: unknown
    resolvedPolicy?: ResolvedToolCallPolicy
    policyHash?: string
    definitionFingerprint?: string
    executionDomain?: ExecutionDomain
  }
  if (
    policy.toolUseId !== pending.toolUseId ||
    !hasCompleteToolPolicyEnvelope(policy) ||
    !hasAuthenticToolPolicyHash(policy)
  )
    return { trust: 'untrusted', callSeq }
  return {
    trust: policy.resolvedPolicy.isOpenWorld ? 'untrusted' : 'trusted',
    callSeq,
  }
}
