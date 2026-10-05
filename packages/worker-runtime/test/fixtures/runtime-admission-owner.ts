import type { HostRuntimeAdmissionInstallation } from '@agnes/host'
import { jcs } from '@agnes/protocol'
import {
  type AdmissionProbe,
  canonicalJsonDigest,
  type DataRef,
  type RunAdmission,
} from '@agnes/protocol/runtime'

const digest = 'a'.repeat(64)
function inline(value: string): DataRef {
  return {
    kind: 'inline',
    schema: { typeId: 'fixture.entry/text@1', revision: 1, digest },
    value,
    digest: canonicalJsonDigest(value),
    bytes: Buffer.byteLength(jcs(value)),
  }
}
export const admissionRequest: RunAdmission = {
  ticketId: 'ticket-entry',
  fingerprint: digest,
  releaseSetId: 'release-entry',
  bindingId: 'run-binding-entry',
  packagePinReceipt: inline('original-pin'),
  runId: 'run-entry',
  sessionId: 'runtime-session-entry',
  lane: 'main',
  workspaceId: 'workspace-entry',
  input: inline('request'),
  admittedAt: '2026-10-04T00:00:00Z',
  deadline: '2099-10-04T00:00:00Z',
  conversation: null,
}

/** Routing/lifecycle fixture only. It is not evidence for native State, identity or ticket issuance. */
export function admissionOwnerFixture(
  options: {
    observe?: (event: Record<string, unknown>) => void
    readyFailure?: boolean
    onCreate?: (signal: AbortSignal) => Promise<void>
  } = {},
): { installation: HostRuntimeAdmissionInstallation; events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = []
  const observe = (event: Record<string, unknown>) => {
    events.push(event)
    options.observe?.(event)
  }
  let closed = false
  let sequence = 0
  type Context = Parameters<HostRuntimeAdmissionInstallation['state']['createRun']>[1]
  const contexts = new WeakMap<Context, number>()
  const outcomes = new Map<string, AdmissionProbe>()
  const capture = (method: string, request: unknown, context: Context) => {
    if (closed || !contexts.has(context)) throw Error('fixture requires the original connection Context')
    observe({ method, request, context: contexts.get(context) })
  }
  const state: HostRuntimeAdmissionInstallation['state'] = {
    async createRun(request, context) {
      if (this !== state) throw Error('State receiver lost')
      capture('state.createRun', request, context)
      await options.onCreate?.(context.signal)
      if (context.signal.aborted)
        return {
          ok: false,
          error: {
            code: 'cancelled',
            detailCode: 'call_cancelled',
            message: 'fixture cancelled',
            diagnosticId: 'fixture',
            retryAdvice: { kind: 'never' },
          },
        }
      const value = outcomes.get(request.ticketId) ?? {
        state: 'created' as const,
        runId: request.runId,
        commit: {
          commitId: 'commit-entry',
          transactionFingerprint: digest,
          sessionId: request.sessionId,
          firstSeq: 1,
          lastSeq: 1,
          headDigest: digest,
          runRevision: 1,
          actionIds: [],
        },
      }
      outcomes.set(request.ticketId, value)
      return { ok: true, value }
    },
    async probeAdmission(request, context) {
      if (this !== state) throw Error('State receiver lost')
      capture('state.probeAdmission', request, context)
      return { ok: true, value: outcomes.get(request) ?? { state: 'absent' } }
    },
  }
  const admission: HostRuntimeAdmissionInstallation['admission'] = {
    async confirm(request, context) {
      if (this !== admission) throw Error('Admission receiver lost')
      capture('admission.confirm', request, context)
      return { ok: true, value: outcomes.get(request) ?? { state: 'absent' } }
    },
    async probe(request, context) {
      if (this !== admission) throw Error('Admission receiver lost')
      capture('admission.probe', request, context)
      return { ok: true, value: outcomes.get(request) ?? { state: 'absent' } }
    },
    async cancel(ticketId, fingerprint, context) {
      if (this !== admission) throw Error('Admission receiver lost')
      capture('admission.cancel', { ticketId, fingerprint }, context)
      if (outcomes.has(ticketId) && fingerprint !== admissionRequest.fingerprint)
        return {
          ok: false,
          error: {
            code: 'conflict',
            detailCode: 'fingerprint_conflict',
            message: 'Original request fingerprint differs',
            diagnosticId: 'fixture',
            retryAdvice: { kind: 'never' },
          },
        }
      const value: AdmissionProbe = outcomes.get(ticketId) ?? {
        state: 'cancelled',
        tombstoneId: 'tombstone-entry',
      }
      outcomes.set(ticketId, value)
      return { ok: true, value }
    },
  }
  const installation: HostRuntimeAdmissionInstallation = {
    selected: {
      'agh.identity': {
        binding: {
          contract: 'agh.identity',
          logicalName: 'default',
          bindingId: 'identity-entry',
          providerId: 'fixture/identity',
        },
        packageDigest: digest,
      },
      'agh.state': {
        binding: {
          contract: 'agh.state',
          logicalName: 'default',
          bindingId: 'state-entry',
          providerId: 'fixture/state',
        },
        packageDigest: digest,
      },
      'agh.assembly': {
        binding: {
          contract: 'agh.assembly',
          logicalName: 'default',
          bindingId: 'assembly-entry',
          providerId: 'fixture/assembly',
        },
        packageDigest: digest,
      },
    },
    admission,
    state,
    async ready() {
      observe({ method: 'ready' })
      if (options.readyFailure) throw Error('fixture ready failed')
    },
    async connectLocalOwner(signal) {
      if (closed || signal.aborted) throw Error('fixture closed')
      const number = ++sequence
      return {
        issue(deadline, traceRef) {
          const context: Context = {
            principalRef: 'local-fixture',
            scope: { kind: 'runtime', installationId: 'installation-entry', runtimeId: 'runtime-entry' },
            bindingId: 'assembly-entry',
            invocationId: `invocation-${number}`,
            deadline,
            traceRef,
            authorizationRef: 'fixture-authorization',
            signal,
          }
          contexts.set(context, number)
          return context
        },
        close() {
          observe({ method: 'connection.close', context: number })
        },
      }
    },
    async close() {
      closed = true
      observe({ method: 'close' })
    },
  }
  return { installation, events }
}
