import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { canonicalJsonDigest, type RuntimeWireTypes as Wire } from '@agnes/protocol/runtime'
import { type BuildIdentity, SCENARIOS } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'

export const PACKAGE_INSTALLER_PROPOSAL_COVERAGE = Object.freeze({
  implemented: ['requestChange', 'cancelProposal', 'proposalStatus'],
  unfinished: [
    'prepare',
    'activate',
    'disable',
    'repair',
    'applyResourceChange',
    'installation-publication',
    'publication-recovery',
  ],
  qualification: 'local-persistent-proposals',
})

export interface PackageInstallerProposalSubject {
  readonly providerId: string
  requestChange(input: unknown, context: CallContext): Promise<Outcome<Wire['ChangeProposal']>>
  cancelProposal(input: unknown, context: CallContext): Promise<Outcome<Wire['ChangeProposal']>>
  proposalStatus(input: unknown, context: CallContext): Promise<Outcome<Wire['ChangeProposal']>>
  dispose(): void
}

export interface PackageInstallerProposalBinding {
  readonly providerId: string
  readonly providerDigest: string
  readonly command: string
  readonly build: BuildIdentity
  context(): CallContext
  open(directory: string): { subject: PackageInstallerProposalSubject; close(): void }
  /** A fresh process reads the same durable journal, never an in-memory recreated fixture. */
  coldStatus(directory: string, proposalId: string): Promise<Outcome<Wire['ChangeProposal']>>
}

export function packageInstallerProposalFixture(): Wire['ChangeProposalRequest'] {
  return {
    requestId: 'fixture-request',
    reason: 'inspect a fixed resource proposal',
    targetScope: { kind: 'installation', installationId: 'fixture-installation' },
    change: {
      kind: 'skill',
      resourceId: 'fixture-skill',
      sourceRef: null,
      operation: 'install',
      config: null,
    },
  }
}

function requireCase(condition: unknown): asserts condition {
  if (!condition) throw new Error('package installer proposal contract assertion failed')
}

/** Six scenarios cover only proposals; no claim of successful installation or release recovery. */
export function registerPackageInstallerProposalContract(
  harness: ConformanceHarness,
  binding: PackageInstallerProposalBinding,
): void {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.package-installer',
      scenario,
      providerId: binding.providerId,
      qualification: 'required',
      async run() {
        const directory = mkdtempSync(join(tmpdir(), 'installer-contract-'))
        const session = binding.open(directory)
        const context = binding.context()
        const input = packageInstallerProposalFixture()
        try {
          const accepted = await session.subject.requestChange(input, context)
          requireCase(accepted.ok)
          const proposal = accepted.value
          requireCase(session.subject.providerId === `agh.${binding.providerId}/package-installer`)
          requireCase(proposal.status === 'planning' && proposal.requester === context.principalRef)
          requireCase(
            !('prepare' in session.subject) &&
              !('activate' in session.subject) &&
              !('applyResourceChange' in session.subject),
          )
          if (scenario === 'normal') {
            const repeat = await session.subject.requestChange(input, {
              ...context,
              invocationId: 'reconnected',
            })
            requireCase(repeat.ok && canonicalJsonDigest(repeat.value) === canonicalJsonDigest(proposal))
            const status = await session.subject.proposalStatus({ proposalId: proposal.proposalId }, context)
            requireCase(status.ok && canonicalJsonDigest(status.value) === canonicalJsonDigest(proposal))
          }
          if (scenario === 'deny') {
            const conflict = await session.subject.requestChange(
              { ...input, reason: 'different input' },
              context,
            )
            requireCase(!conflict.ok && conflict.error.detailCode === 'request_input_conflict')
            const stranger = await session.subject.proposalStatus(
              { proposalId: proposal.proposalId },
              { ...context, principalRef: 'stranger' },
            )
            requireCase(!stranger.ok && stranger.error.code === 'denied')
            const stale = await session.subject.cancelProposal(
              { proposalId: proposal.proposalId, expectedRevision: 0, reason: 'stale' },
              context,
            )
            requireCase(!stale.ok && stale.error.detailCode === 'proposal_revision_conflict')
          }
          if (scenario === 'cancel' || scenario === 'recover') {
            const cancelled = await session.subject.cancelProposal(
              {
                proposalId: proposal.proposalId,
                expectedRevision: proposal.revision,
                reason: 'no longer needed',
              },
              context,
            )
            requireCase(
              cancelled.ok && cancelled.value.status === 'cancelled' && cancelled.value.revision === 2,
            )
            if (scenario === 'cancel') {
              const signal = AbortSignal.abort()
              const stopped = await session.subject.requestChange(
                { ...input, requestId: 'aborted' },
                { ...context, signal },
              )
              requireCase(!stopped.ok && stopped.error.code === 'cancelled')
            } else {
              session.close()
              const recovered = await binding.coldStatus(directory, proposal.proposalId)
              requireCase(
                recovered.ok && canonicalJsonDigest(recovered.value) === canonicalJsonDigest(cancelled.value),
              )
            }
          }
          if (scenario === 'dispose') {
            session.subject.dispose()
            const stopped = await session.subject.proposalStatus({ proposalId: proposal.proposalId }, context)
            requireCase(!stopped.ok && stopped.error.detailCode === 'provider_disposed')
          }
          return {
            id: `agh.package-installer/${binding.providerId}/proposals/${scenario}`,
            providerDigest: binding.providerDigest,
            recipe: 'local-persistent-proposals',
            features: ['requestChange', 'cancelProposal', 'proposalStatus'],
            build: binding.build,
            consumer: 'restricted-proposal-consumer',
            command: binding.command,
            status: 'passed' as const,
            configDigest: canonicalJsonDigest(input),
            releaseSetDigest: 'unpublished/proposal-only',
            attachmentDigest: canonicalJsonDigest(PACKAGE_INSTALLER_PROPOSAL_COVERAGE),
            fixture: null,
            sharedEvidenceId: null,
            perImplementation: true,
          }
        } finally {
          session.close()
          rmSync(directory, { recursive: true, force: true })
        }
      },
    })
}

export interface PackageInstallerApplyBinding {
  readonly providerId: string
  readonly providerDigest: string
  readonly command: string
  readonly build: BuildIdentity
  open(directory: string): Promise<{
    subject: PackageInstallerProposalSubject
    call: CallContext
    approved(): Promise<Wire['ChangeProposal']>
    controller: {
      apply(id: string, revision: number, context: CallContext): Promise<Outcome<Wire['ChangeProposal']>>
      dispose(): void
    }
    deny(): void
    loseResponse(): void
    close(): Promise<void>
  }>
  coldStatus(directory: string): Promise<Outcome<Wire['ChangeProposal']>>
}

/** Restricted persistent maintenance composition. Production approval and startup wiring are separate. */
export function registerPackageInstallerApplyContract(
  harness: ConformanceHarness,
  binding: PackageInstallerApplyBinding,
): void {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.package-installer',
      providerId: binding.providerId,
      scenario,
      qualification: 'required',
      async run() {
        const directory = mkdtempSync(join(tmpdir(), 'installer-apply-contract-'))
        const f = await binding.open(directory)
        try {
          const plan = await f.approved()
          requireCase(plan.interactionRef !== null && plan.status === 'awaiting-approval')
          requireCase(!('apply' in f.subject))
          if (scenario === 'normal' || scenario === 'recover') {
            if (scenario === 'recover') f.loseResponse()
            const applied = await f.controller.apply(plan.proposalId, plan.revision, f.call)
            if (scenario === 'normal')
              requireCase(
                applied.ok && applied.value.status === 'applied' && applied.value.resultRef !== null,
              )
            else {
              requireCase(!applied.ok)
              await f.close()
              const recovered = await binding.coldStatus(directory)
              requireCase(
                recovered.ok && recovered.value.status === 'applied' && recovered.value.resultRef !== null,
              )
            }
          }
          if (scenario === 'deny') {
            f.deny()
            const refused = await f.controller.apply(plan.proposalId, plan.revision, f.call)
            requireCase(!refused.ok && refused.error.code === 'denied')
          }
          if (scenario === 'cancel') {
            const cancelled = await f.subject.cancelProposal(
              { proposalId: plan.proposalId, expectedRevision: plan.revision, reason: 'stop' },
              f.call,
            )
            requireCase(cancelled.ok)
            const refused = await f.controller.apply(plan.proposalId, cancelled.value.revision, f.call)
            requireCase(!refused.ok && refused.error.code === 'cancelled')
          }
          if (scenario === 'dispose') {
            f.controller.dispose()
            const refused = await f.controller.apply(plan.proposalId, plan.revision, f.call)
            requireCase(!refused.ok && refused.error.detailCode === 'provider_disposed')
          }
          return {
            id: `agh.package-installer/${binding.providerId}/maintenance/${scenario}`,
            providerDigest: binding.providerDigest,
            recipe: 'restricted-persistent-maintenance-apply',
            features: ['deployment-approval-port', 'fixed-plan-apply', 'original-operation-probe'],
            build: binding.build,
            consumer: 'independent-maintenance-root',
            command: binding.command,
            status: 'passed' as const,
            configDigest: canonicalJsonDigest(plan),
            releaseSetDigest: plan.planDigest!,
            attachmentDigest: canonicalJsonDigest({
              qualification: 'provisional-injected-ports',
              productionWiring: false,
            }),
            fixture: null,
            sharedEvidenceId: null,
            perImplementation: true,
          }
        } finally {
          await f.close()
          rmSync(directory, { recursive: true, force: true })
        }
      },
    })
}
