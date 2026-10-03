import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { canonicalJsonDigest, type RuntimeWireTypes as W } from '@agnes/protocol/runtime'
import {
  type createInstallRepairPlan,
  createPackageInstallerProvider,
  createPackageMaintenanceController,
  type InstallJournal,
  openInstallJournal,
  type PackageInstallerOptions,
  type PackageMaintenancePorts,
} from '../../../src/runtime/providers/package-installer.js'

const reference = (await import(
  new URL('../../../../../examples/runtime-reference/src/providers/package-installer.js', import.meta.url)
    .href
)) as {
  createReferencePackageInstallerProvider: typeof createPackageInstallerProvider
  createReferencePackageMaintenanceController: typeof createPackageMaintenanceController
  openReferenceInstallJournal: typeof openInstallJournal
  createReferenceInstallRepairPlan: typeof createInstallRepairPlan
}
export const createReferenceFixtureController = reference.createReferencePackageMaintenanceController
export const createReferenceFixtureRepairPlan = reference.createReferenceInstallRepairPlan
export async function installerReleaseFixture(): Promise<W['ReleasePlan']> {
  const fixtures = (await import(
    new URL('../../../../extension-api/testkit/runtime/contracts/assembly-fixture.js', import.meta.url).href
  )) as {
    assemblyFixture(): { plan: W['ReleasePlan'] }
  }
  return fixtures.assemblyFixture().plan
}

export const installerProcessFixture = fileURLToPath(new URL('./installer-process.ts', import.meta.url))
export const installerContext = (): CallContext => ({
  principalRef: 'fixture-owner',
  authorizationRef: 'fixture-authorization',
  invocationId: 'fixture-invocation',
  bindingId: 'fixture-binding',
  traceRef: 'fixture-trace',
  deadline: '2030-01-01T00:00:00Z',
  scope: { kind: 'installation', installationId: 'fixture-installation' },
  signal: new AbortController().signal,
})
export function inlineInstallerRef(value: W['JsonValue']): W['DataRef'] {
  return {
    kind: 'inline',
    value,
    digest: canonicalJsonDigest(value),
    bytes: Buffer.byteLength(JSON.stringify(value)),
    schema: {
      typeId: 'fixture.install/record@1',
      revision: 1,
      digest: canonicalJsonDigest('fixture-schema'),
    },
  }
}
export function installerFixtureRequest(): W['ChangeProposalRequest'] {
  return {
    requestId: 'fixture-request',
    reason: 'install a verified resource',
    targetScope: installerContext().scope,
    change: {
      kind: 'skill',
      resourceId: 'fixture-skill',
      sourceRef: null,
      operation: 'install',
      config: null,
    },
  }
}
export function installerFixturePlan(
  input: W['ChangeProposalRequest'],
): Extract<NonNullable<W['ChangeProposal']['plan']>, { kind: 'resource' }> {
  if (input.change.kind === 'package') throw new Error('resource fixture only')
  const value = {
    ...input.change,
    targetScope: input.targetScope,
    expectedRevision: null,
    planId: 'fixture-plan',
    permissionDifference: [],
  }
  return { kind: 'resource', value: { ...value, digest: canonicalJsonDigest(value) } }
}
export function openInstallerFixture(
  providerId: string,
  directory: string,
  override: Partial<PackageInstallerOptions> = {},
) {
  const journal: InstallJournal =
    providerId === 'default'
      ? openInstallJournal(join(directory, 'journal.sqlite'))
      : reference.openReferenceInstallJournal(join(directory, 'journal.sqlite'))
  const options: PackageInstallerOptions = {
    journal,
    currentAuthorization: async (call) => ({ ok: true, value: call.principalRef }),
    readLocalOperation: null,
    ...override,
  }
  const subject =
    providerId === 'default'
      ? createPackageInstallerProvider(options)
      : reference.createReferencePackageInstallerProvider(options)
  const ports: PackageMaintenancePorts = {
    ...options,
    resolveReleaseRoute: null,
    generateVerifiedPlan: async (input) => ({ ok: true, value: installerFixturePlan(input) }),
    readDeploymentApproval: null,
    candidate: null,
    publish: null,
    now: () => '2026-10-03T00:00:00Z',
  }
  const controller =
    providerId === 'default'
      ? createPackageMaintenanceController(ports)
      : reference.createReferencePackageMaintenanceController(ports)
  return {
    journal,
    subject,
    ports,
    controller,
    close() {
      subject.dispose()
      journal.close()
    },
  }
}
export function coldInstallerStatus(
  providerId: string,
  directory: string,
  proposalId: string,
): Outcome<W['ChangeProposal']> {
  const output = execFileSync(process.execPath, ['--import', 'tsx', installerProcessFixture], {
    env: {
      ...process.env,
      INSTALLER_FIXTURE_PROVIDER: providerId,
      INSTALLER_FIXTURE_DIRECTORY: directory,
      INSTALLER_FIXTURE_PROPOSAL: proposalId,
      INSTALLER_FIXTURE_WRITE: '0',
    },
    encoding: 'utf8',
    timeout: 30000,
  })
  return JSON.parse(output) as Outcome<W['ChangeProposal']>
}

/** Synthetic original operation binding, not an installation success fixture. */
export function bindInstallerFixtureOperation(journal: InstallJournal, proposalId: string) {
  let record = journal.read(proposalId)
  record = journal.compareAndSwap(proposalId, record.proposal.revision, {
    ...record,
    proposal: {
      ...record.proposal,
      status: 'awaiting-approval',
      revision: record.proposal.revision + 1,
      plan: installerFixturePlan(record.input),
      planDigest: installerFixturePlan(record.input).value.digest,
    },
  })
  record = journal.compareAndSwap(proposalId, record.proposal.revision, {
    ...record,
    approvalRef: inlineInstallerRef({ approval: 'fixture-deployment-only' }),
    proposal: { ...record.proposal, status: 'approved', revision: record.proposal.revision + 1 },
  })
  return journal.compareAndSwap(proposalId, record.proposal.revision, {
    ...record,
    operation: {
      operationId: 'original-upgrade',
      reference: inlineInstallerRef({ upgradeId: 'original-upgrade' }),
    },
    proposal: { ...record.proposal, status: 'applying', revision: record.proposal.revision + 1 },
  })
}
