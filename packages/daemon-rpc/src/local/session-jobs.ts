import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { ActivationInProgressError } from '@agnes/host'
import {
  type ExtensionCallParams,
  rpcError,
  type SessionJobsControlParams,
  type SessionJobsReadParams,
} from '@agnes/protocol'
import { type ExtensionMethodsContext, executeJournaledEffect } from './methods/extensions.js'

export type SessionJobServices = Pick<
  ExtensionMethodsContext,
  'activationBarrier' | 'journal' | 'commandQueue' | 'callService' | 'inspectService'
>
const extension = 'agnes/jobs-web'
export function registerSessionJobs(
  ep: LocalEndpoint,
  services: SessionJobServices | undefined,
  requireOwner: (method: string, sessionId: string, call: CallContext) => void,
): void {
  for (const operation of ['read', 'control'] as const)
    ep.register(`_agnes/v1/session.jobs.${operation}`, async (params, call) => {
      const p = params as SessionJobsReadParams | SessionJobsControlParams
      requireOwner(`session.jobs.${operation}`, p.sessionId, call)
      if (!services || !call.conn.credential) throw rpcError('CAPABILITY_DENIED')
      const credential = (name: string) =>
        Object.freeze({
          kind: 'surface-service',
          source: 'session-workbench',
          subjectCredential: call.conn.credential,
          grants: [{ extension, name, range: '*' }],
        })
      let invocation: ReturnType<SessionJobServices['activationBarrier']['admit']>
      try {
        invocation = services.activationBarrier.admit('service')
      } catch (error) {
        if (error instanceof ActivationInProgressError)
          throw rpcError('OVERLOADED', { reason: error.reason, operationId: error.operationId })
        throw error
      }
      return invocation.run(async () => {
        const name = `jobs.${operation}`
        const { sessionId, ...fields } = p
        const input: ExtensionCallParams = {
          sessionId,
          extension,
          service: name,
          input:
            operation === 'read'
              ? fields
              : Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'commandId')),
          ...('commandId' in p ? { commandId: p.commandId } : {}),
        }
        const proof = credential(name)
        // The fixed query carries no commandId: Host rejects an effect before dispatch. A second
        // inspection would repeat the same authority check and workspace admission on every poll.
        if (operation === 'read') return (await services.callService(input, proof, call.signal)).output
        const inspection = await services.inspectService(input, proof, call.signal)
        if (inspection.kind !== 'effect') throw rpcError('CAPABILITY_DENIED')
        const control = p as SessionJobsControlParams
        if (control.operation !== 'open') {
          const snapshot = (
            await services.callService(
              { sessionId, extension, service: 'jobs.read', input: {} },
              credential('jobs.read'),
              call.signal,
            )
          ).output
          const jobs = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && snapshot.jobs
          if (
            !Array.isArray(jobs) ||
            !jobs.some(
              (job) =>
                job &&
                typeof job === 'object' &&
                !Array.isArray(job) &&
                job.id === control.jobId &&
                job.owner === 'human' &&
                job.ownerSessionId === sessionId,
            )
          )
            throw rpcError('CAPABILITY_DENIED')
        }
        return executeJournaledEffect({
          ...services,
          params: { ...input, commandId: control.commandId },
          credential: proof,
          signal: call.signal,
          serviceId: `service:session-jobs:${sessionId}`,
          identity: {
            principalId: call.conn.principalId,
            clientId: call.conn.clientId,
            sessionId: `session-jobs:${sessionId}`,
            commandId: control.commandId,
          },
          bindingKind: 'session.jobs.control',
        })
      })
    })
}
