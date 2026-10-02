import type {
  AuthorSchema,
  EmptyAuthorConfig,
  ProviderDescriptor,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import type { IntegrityVerifyResult } from '@agnes/protocol/runtime'
import {
  createReferenceIntegrityFactory,
  createReferenceIntegrityProvider,
  type ReferenceIntegrityMaintenance,
  type ReferenceIntegrityTransferPort,
} from './integrity.js'
import { referenceCanonicalize, referenceVerify } from './integrity-algorithms.js'

declare const descriptor: ProviderDescriptor
declare const configSchema: AuthorSchema<EmptyAuthorConfig>
declare const maintenance: ReferenceIntegrityMaintenance
export const selected: ProviderFactory<ServiceProvider> = createReferenceIntegrityFactory({
  descriptor,
  configSchema,
  maintenance,
  authorize: async () => ({ ok: true, value: undefined }),
})
export const compute = createReferenceIntegrityProvider({
  binding: {
    bindingId: 'binding',
    contract: 'agh.integrity',
    logicalName: 'primary',
    providerId: 'reference.integrity',
  },
  scope: { kind: 'runtime', installationId: 'installation', runtimeId: 'runtime' },
  authorize: async () => ({ ok: true, value: undefined }),
})
export const canonical = referenceCanonicalize({ value: 'unicode 😀' })
export const verified: IntegrityVerifyResult = referenceVerify({
  kind: 'ledger-page',
  algorithm: 'agnes-ledger-jcs-sha256-v1',
  initial: { lastSeq: 0, legacyThroughSeq: 0, headDigest: null },
  rows: [],
})
export const invalidMaintenance: ReferenceIntegrityMaintenance = {
  // @ts-expect-error An injected package verifier returns the formal result, not a grant string.
  verifyPackage: async () => ({ ok: true, value: 'trusted' }),
}
createReferenceIntegrityFactory({
  descriptor,
  // @ts-expect-error Configuration needs a generated codec, not a SchemaRef alone.
  configSchema: descriptor.configSchema,
  authorize: async () => ({ ok: true, value: undefined }),
})

declare const transfer: ReferenceIntegrityTransferPort
export const recoveryOwner: ReferenceIntegrityTransferPort = transfer
export const missingRecovery: ReferenceIntegrityTransferPort = {
  ...transfer,
  // @ts-expect-error Transfer cannot be installed without its real owner reconciliation capability.
  reconcile: undefined,
}
export const oldUncheckedTransfer: ReferenceIntegrityMaintenance = {
  ...maintenance,
  // @ts-expect-error A single unchecked MethodHandler cannot establish effect recovery ownership.
  authorityTransfer: async () => ({ ok: true, value: null }),
}
