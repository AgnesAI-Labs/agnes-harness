import type {
  AuthorityDirectoryCompareAndSwapRequest,
  AuthorityDirectoryCompareAndSwapResult,
  AuthorityDirectoryControl,
  CallContext,
  Outcome,
} from '@agnes/extension-api/runtime'

declare const control: AuthorityDirectoryControl
declare const request: AuthorityDirectoryCompareAndSwapRequest
declare const context: CallContext
export const result: Promise<Outcome<AuthorityDirectoryCompareAndSwapResult>> = control.compareAndSwap(
  request,
  context,
)
// @ts-expect-error The retired method spelling is not a Local alias.
control.CAS(request, context)
// @ts-expect-error Maintenance calls require the complete Local call context.
control.compareAndSwap(request)
const { expectedWriterEpoch: _epoch, ...missingEpoch } = request
// @ts-expect-error The current writer epoch is required in the canonical request.
control.compareAndSwap(missingEpoch, context)
// @ts-expect-error The publication response cannot replace the publication request.
control.compareAndSwap({ transactionId: 'cutover', cutoverId: 'cutover', routes: [] }, context)
