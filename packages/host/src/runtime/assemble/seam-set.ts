import type { Context } from '@agnes/cordis'
import type { SeamImplementations } from '@agnes/core'
import { bindApprovalTicket } from '@agnes/host-common/profile-policy'
import { createMutableSeamImplementations } from '@agnes/plugin-runtime/host'
import { createApprovalGrantControlPlane } from '../approval/grants.js'
import type { AssemblyContext } from './context.js'
import type { ProcessServices } from './process-services.js'
import type { SeamContexts } from './seam-contexts.js'

/**
 * The seams the Kernel runs on, created before any tree exists. `sandbox` and `platform` are static;
 * the other seven are stable facades that follow whichever tree is published (`adopt`). Permanent
 * approval grants are not a seam: the Host's grant control plane hands Core its own port.
 */
export type SeamSet = Readonly<{
  seams: SeamImplementations
  approvalGrantControl: ReturnType<typeof createApprovalGrantControlPlane>
  /** Point the facades at a published root; call it for every published tree. */
  adopt(root: Context): void
}>

export function openSeamSet(
  ctx: AssemblyContext,
  proc: ProcessServices,
  seamContexts: SeamContexts,
): SeamSet {
  const { adapters } = proc
  const mutable = createMutableSeamImplementations<SeamImplementations>(
    {
      sandbox: seamContexts.staticSeams.sandbox,
      platform: seamContexts.staticSeams.platform,
    },
    ctx.gates.publicationDispatch,
  )
  const approvalGrantControl = createApprovalGrantControlPlane(
    adapters.storage.metadata.namespace('@agnes/host/approval-grants', 'grants'),
    (grantId) => {
      bindApprovalTicket(ctx.gates.hotPolicy, grantId)
    },
  )
  return Object.freeze({
    seams: mutable.seams,
    approvalGrantControl,
    adopt: mutable.adopt,
  })
}
