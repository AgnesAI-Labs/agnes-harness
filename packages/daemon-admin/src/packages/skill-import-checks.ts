import { randomUUID } from 'node:crypto'
import { rpcError, type SkillImportParams, type SkillImportResult } from '@agnes/protocol'
import type { PackageAdminAuthority } from './permissions.js'

type Check = {
  owner: string
  result: SkillImportResult
  controller: AbortController
  expires: number
}
const reasons = new Set([
  'SKILL_SIZE_LIMIT',
  'SKILL_PATH_INVALID',
  'SKILL_LINK_REFUSED',
  'SKILL_MANIFEST_INVALID',
  'SKILL_SOURCE_CHANGED',
  'SKILL_INSTALL_BUSY',
  'SKILL_DOCUMENT_PROFILE_UNSUPPORTED',
  'SKILL_FILE_REFUSED',
  'SKILL_FILE_CONFLICT',
  'SKILL_PATH_DENIED',
  'SKILL_TARGET_CONFLICT',
])
/** A bounded, cancellable check job; installation and authorization remain with their existing owners. */
export function createSkillImportChecks(
  prepare: (
    params: SkillImportParams,
    granted: PackageAdminAuthority,
    signal: AbortSignal,
    progress: (phase: string) => void,
  ) => Promise<SkillImportResult>,
  cancel: (params: SkillImportParams, granted: PackageAdminAuthority) => Promise<SkillImportResult>,
) {
  const jobs = new Map<string, Check>()
  const discard = (id: string, job: Check) => {
    job.controller.abort()
    jobs.delete(id)
  }
  return {
    cleanup() {
      for (const [id, job] of jobs) if (job.expires < Date.now()) discard(id, job)
    },
    close() {
      for (const [id, job] of jobs) discard(id, job)
    },
    async handle(params: SkillImportParams, granted: PackageAdminAuthority, owner: string) {
      if (params.action === 'check') {
        if (!params.source || params.proposalId || params.expectedDigest) throw rpcError('INVALID_PARAMS')
        if (jobs.size >= 16) throw rpcError('SEMANTIC_REJECTED', { reason: 'SKILL_INSTALL_BUSY' })
        const id = `skill-check-${randomUUID()}`
        const job: Check = {
          owner,
          controller: new AbortController(),
          expires: Date.now() + 600_000,
          result: { state: 'running', proposalId: id, phase: 'acquiring' },
        }
        jobs.set(id, job)
        void prepare({ ...params, action: 'prepare' }, granted, job.controller.signal, (phase) => {
          if (!job.controller.signal.aborted) job.result = { state: 'running', proposalId: id, phase }
        })
          .then(async (result) => {
            if (job.controller.signal.aborted) {
              if (result.state === 'prepared' && result.proposalId)
                await cancel({ ...params, action: 'cancel', proposalId: result.proposalId }, granted)
            } else job.result = result
          })
          .catch((error: unknown) => {
            if (job.controller.signal.aborted) return
            const code = (error as { code?: string }).code
            job.result = {
              state: 'failed',
              ...(job.result.phase ? { phase: job.result.phase } : {}),
              message:
                code && reasons.has(code)
                  ? code
                  : job.result.phase === 'acquiring'
                    ? 'SKILL_SOURCE_UNAVAILABLE'
                    : 'SKILL_CHECK_FAILED',
            }
          })
        return job.result
      }
      const id = params.proposalId
      if (!id?.startsWith('skill-check-')) return undefined
      const job = jobs.get(id)
      if (!job || job.owner !== owner)
        throw rpcError('SEMANTIC_REJECTED', { reason: 'SKILL_PROPOSAL_UNAVAILABLE' })
      if (params.action === 'status') return job.result
      if (params.action !== 'cancel') throw rpcError('INVALID_PARAMS')
      job.controller.abort()
      if (job.result.state === 'prepared' && job.result.proposalId)
        await cancel({ ...params, proposalId: job.result.proposalId }, granted)
      job.result = { state: 'cancelled', proposalId: id }
      return job.result
    },
  }
}
