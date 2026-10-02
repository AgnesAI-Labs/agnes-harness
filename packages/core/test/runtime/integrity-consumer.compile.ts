import type {
  AuthorSchema,
  EmptyAuthorConfig,
  ProviderDescriptor,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { canonicalizeIntegrity } from '../../src/runtime/integrity/canonicalize.js'
import { verifyIntegrity } from '../../src/runtime/integrity/verify.js'
import {
  createIntegrityFactory,
  createIntegrityProvider,
  type IntegrityMaintenancePorts,
} from '../../src/runtime/providers/integrity.js'

declare const descriptor: ProviderDescriptor
declare const configSchema: AuthorSchema<EmptyAuthorConfig>
declare const maintenance: IntegrityMaintenancePorts
export const factory: ProviderFactory<ServiceProvider> = createIntegrityFactory({
  descriptor,
  configSchema,
  maintenance,
  authorize: async () => ({ ok: true, value: undefined }),
})
export const selected = createIntegrityProvider({
  binding: {
    bindingId: 'binding',
    contract: 'agh.integrity',
    logicalName: 'primary',
    providerId: 'default.integrity',
  },
  scope: { kind: 'runtime', installationId: 'installation', runtimeId: 'runtime' },
  authorize: async () => ({ ok: true, value: undefined }),
})
export const canonical = canonicalizeIntegrity({ value: '你好' })
export const checkpoint = verifyIntegrity({
  kind: 'ledger-page',
  algorithm: 'agnes-ledger-jcs-sha256-v1',
  initial: { lastSeq: 0, legacyThroughSeq: 0, headDigest: null },
  rows: [],
})
export const badPort: IntegrityMaintenancePorts = {
  // @ts-expect-error The package owner must return the official verification result.
  verifyPackage: async () => ({ ok: true, value: 'grant' }),
}
createIntegrityFactory({
  descriptor,
  // @ts-expect-error A schema reference is not a generated configuration codec.
  configSchema: descriptor.configSchema,
  authorize: async () => ({ ok: true, value: undefined }),
})
