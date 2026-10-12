import type { SeamImplementations } from '@agnes/core'
import { bindApprovalTicket } from '@agnes/host-common/profile-policy'
import { createMutableSeamImplementations } from '@agnes/plugin-runtime/host'
import { lazyPackageTables } from '../adapters/index.js'
import { createApprovalGrantControlPlane, migrateApprovalGrants } from '../approval/grants.js'
import type { AssemblyContext } from './context.js'
import type { ProcessServices } from './process-services.js'
import type { RuntimeTargetHost } from './runtime-target.js'
import type { SeamContexts } from './seam-contexts.js'

/**
 * The ten seams the Kernel runs on: `sandbox` and `platform` are static, the other eight follow
 * the published tree (they change when a seam row is replaced), and `approval` passes through
 * the Host's grant control plane so a stored grant can answer before the package seam is asked.
 */
export function bindSeams(
  ctx: AssemblyContext,
  proc: ProcessServices,
  seamContexts: SeamContexts,
  runtimeTarget: RuntimeTargetHost,
) {
  const { adapters } = proc
  const mutable = createMutableSeamImplementations<SeamImplementations>(
    runtimeTarget.pluginTree.root,
    {
      sandbox: seamContexts.staticSeams.sandbox,
      platform: seamContexts.staticSeams.platform,
    },
    ctx.gates.publicationDispatch,
  )
  runtimeTarget.seamRoot.replace = mutable.replaceRoot
  const approvalGrantControl = createApprovalGrantControlPlane(
    (() => {
      const ns = adapters.storage.metadata.namespace('@agnes/host/approval-grants', 'grants')
      if (adapters.storage.sqlite)
        migrateApprovalGrants(lazyPackageTables(adapters.storage, '@agnes/host/approval-grants'), ns)
      return ns
    })(),
    (grantId) => {
      bindApprovalTicket(ctx.gates.hotPolicy, grantId)
    },
  )
  const seams: SeamImplementations = {
    ...mutable.seams,
    approval: approvalGrantControl.bind(mutable.seams.approval),
  }
  return { seams, approvalGrantControl }
}
