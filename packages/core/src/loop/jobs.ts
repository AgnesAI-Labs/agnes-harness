import type { LoopContext, LoopJobStatus, ToolResult } from '@agnes/extension-api'
import { toLedgerContent } from '../effects/tool-result.js'
import { withTimeout } from '../effects/wrap.js'
import { deferredResultProvenance } from '../execution/turn/deferred.js'
import { scanAll } from '../log/scan-pages.js'
import { deferredEffectId } from '../step/deferred.js'
import type { SessionImpl } from '../step/session.js'
import { CoreError } from '../types.js'
import type { LoopInvocations } from './invocations.js'

const RECEIPT = 'x/core/loop-job-result'

/** Joins one tool-owned job, independent of the default deferred phase and scheduler. */
export function loopJobs(s: SessionImpl, invocations: LoopInvocations): LoopContext['jobs'] {
  const active = new Set<string>()
  async function binding(id: string) {
    const toolUseId = await invocations.toolUseId(id)
    const markers = await scanAll((q) => s.d.log.scan(q), {
      type: 'x/core/deferred-job',
      lane: s.lane,
      fromSeq: (s.d.log.parent?.boundarySeq ?? 0) + 1,
      toSeq: s.lastSeq,
    })
    const marker = markers.find((event) => (event.data as { toolUseId: string }).toolUseId === toolUseId)
    const data = marker?.data as { jobId: string; toolUseId: string } | undefined
    if (!marker || !data || marker.origin !== 'system' || marker.trust !== 'trusted')
      throw new CoreError('E_RELATION', 'Invocation has no owned deferred job')
    return { ...data, ...(marker.sourceEventSeqs?.[0] ? { callSeq: marker.sourceEventSeqs[0] } : {}) }
  }
  async function receipt(id: string) {
    return (
      await scanAll((q) => s.d.log.scan(q), {
        type: RECEIPT,
        lane: s.lane,
        fromSeq: (s.d.log.parent?.boundarySeq ?? 0) + 1,
        toSeq: s.lastSeq,
      })
    )
      .reverse()
      .find((row) => (row.data as { invocationId: string }).invocationId === id)
  }
  async function status(id: string): Promise<LoopJobStatus> {
    const pending = await binding(id)
    const saved = await receipt(id)
    if (saved) return structuredClone(saved.data) as unknown as LoopJobStatus
    const job = await s.d.runtime.artifactsPoll(pending.jobId)
    return { jobId: pending.jobId, status: job.status }
  }
  return {
    status,
    async join(id, signal) {
      const done = s.beginLoopOperation()
      if (active.has(id)) {
        done()
        throw new CoreError('E_LANE_BUSY', 'Job join is active')
      }
      active.add(id)
      try {
        signal = AbortSignal.any([signal, s.ac.signal])
        for (;;) {
          signal.throwIfAborted()
          const pending = await binding(id)
          const saved = await receipt(id)
          if (saved) return structuredClone((saved.data as unknown as LoopJobStatus).result!)
          const job = await withTimeout(
            s.d.runtime.artifactsPoll(pending.jobId),
            5000,
            'loop job poll',
            signal,
            s.d.timers,
          )
          signal.throwIfAborted()
          if (job.status === 'queued' || job.status === 'running') {
            await new Promise<void>((resolve) => {
              const timers = s.d.timers ?? {
                setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
                clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
              }
              let timer: unknown
              const finish = () => {
                timers.clearTimeout(timer)
                signal.removeEventListener('abort', finish)
                resolve()
              }
              signal.addEventListener('abort', finish, { once: true })
              timer = timers.setTimeout(finish, s.preset.deferred.pollMs)
              if (signal.aborted) finish()
            })
            continue
          }
          const ok = job.status === 'done' && job.ref !== undefined
          const result: ToolResult = ok
            ? { content: [{ type: 'ref', ref: job.ref! }], isError: false }
            : {
                content: [
                  {
                    type: 'text',
                    text:
                      job.error ??
                      (job.status === 'done' ? 'artifact job completed without a result' : job.status),
                  },
                ],
                isError: true,
              }
          const provenance = await deferredResultProvenance(s, pending)
          await s.locked(async () => {
            signal.throwIfAborted()
            const saved = await receipt(id)
            if (saved) return
            const effectId = deferredEffectId(pending.jobId, pending.toolUseId)
            await s.d.log.append([
              s.ev('artifact/job', job, { register: 'artifact/job' }),
              s.ev(
                'tool/result',
                {
                  toolUseId: pending.toolUseId,
                  content: toLedgerContent(result.content),
                  isError: !ok,
                  ...(!ok ? { code: 'JOB_FAILED' } : {}),
                  enforcement: s.d.runtime.enforcement(),
                  authz: { decisionId: 'n/a' },
                },
                {
                  trust: provenance.trust,
                  ...(provenance.callSeq === undefined ? {} : { sourceEventSeqs: [provenance.callSeq] }),
                },
              ),
              ...(s.state.pendingEffects.has(effectId)
                ? [s.ev('effect/settled', { effectId, outcome: ok ? 'ok' : 'error' })]
                : []),
              s.ev(
                RECEIPT,
                { invocationId: id, jobId: job.jobId, status: job.status, result },
                { ignorable: true },
              ),
            ])
          })
          return result
        }
      } finally {
        active.delete(id)
        done()
      }
    },
  }
}
