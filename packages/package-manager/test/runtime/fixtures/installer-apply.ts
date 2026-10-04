import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type { RuntimeWireTypes as W } from '@agnes/protocol/runtime'
import type {
  DeploymentApprovalAdapterPorts,
  DeploymentApprovalTerminal,
} from '../../../src/runtime/deployment-approval.js'
import type { createPackageMaintenanceController } from '../../../src/runtime/providers/package-installer.js'
import type { openInstallerFixture } from './installer.js'

export interface InstallerApplyFixture extends Omit<ReturnType<typeof openInstallerFixture>, 'close'> {
  buildObservation?: import('./installer-apply-build.js').BuildObservation
  controller: ReturnType<typeof createPackageMaintenanceController>
  query: ReturnType<typeof openInstallerFixture>
  call: CallContext
  request: W['ChangeProposalRequest']
  control: { authorized: boolean; failCandidate: boolean; losePublishResponse: boolean }
  input: { plan: W['ReleasePlan']; fixture: { now: string; previousRelease: W['ReleaseSet'] | null } }
  assembly: { snapshot(): { records: W['MaintenanceEnvelopeJsonValue'][] }; control: { now: string } }
  approvals: {
    control: {
      helperRunEligible: boolean
      admissionAvailable: boolean
      stateActionAvailable: boolean
      stateAuthorizationAvailable: boolean
      hostApprovalAvailable: boolean
      sourceChanged: boolean
      scopeChanged: boolean
    }
    ports: DeploymentApprovalAdapterPorts
    read(): DeploymentApprovalTerminal
    decode(ref: W['DataRef']): W['JsonValue']
  }
  patchApproval(patch: Partial<DeploymentApprovalTerminal>): void
  approved(): Promise<W['ChangeProposal']>
  close(): Promise<void>
}
const module = (await import(
  new URL('../../../../../tools/acceptance/runtime/fixtures/package-installer-apply.ts', import.meta.url).href
)) as {
  openInstallerApplyFixture(
    kind: 'default' | 'reference',
    directory: string,
    operation?: 'install' | 'disable' | 'repair' | 'resource',
    hook?: (phase: string) => Promise<void>,
    build?: { sourceKind?: 'local' | 'npm' | 'git'; fault?: 'secret' | 'failure' },
  ): Promise<InstallerApplyFixture>
  coldInstallerApplyStatus(kind: 'default' | 'reference', directory: string): Outcome<W['ChangeProposal']>
}
export const openInstallerApplyFixture = module.openInstallerApplyFixture
export const coldInstallerApplyStatus = module.coldInstallerApplyStatus
