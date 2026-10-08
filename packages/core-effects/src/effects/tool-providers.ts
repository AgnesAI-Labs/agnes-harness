import type {
  ToolPolicy,
  ToolPolicyRegistryPort,
  ToolRuntimeProvider,
  ToolRuntimeRegistryPort,
} from '@agnes/extension-api'
import { defaultToolPolicy, ProviderError } from '@agnes/extension-api'
import { defaultToolRuntimeProvider } from './tool-runtime.js'

export { defaultToolPolicy } from '@agnes/extension-api'

/** Small registries shared by Cordis services and directly embedded Kernels. */
class Providers<T extends { id: string; version: string }> {
  constructor(private readonly kind: 'tool-runtime' | 'tool-policy') {}
  private readonly entries = new Map<string, { provider: T; sourcePackage: string }>()
  register(sourcePackage: string, provider: T): () => Promise<void> {
    if (!provider.id?.trim() || !provider.version?.trim())
      throw new ProviderError('E_PROVIDER_INVALID', `Provider ${provider.id} is invalid`, {
        kind: this.kind,
        provider: provider.id,
        operation: 'register',
      })
    if (this.entries.has(provider.id))
      throw new ProviderError('E_PROVIDER_DUPLICATE', `Provider ${provider.id} is already registered`, {
        kind: this.kind,
        provider: provider.id,
        operation: 'register',
      })
    const entry = { provider, sourcePackage }
    this.entries.set(provider.id, entry)
    return async () => {
      if (this.entries.get(provider.id) === entry) this.entries.delete(provider.id)
    }
  }
  resolve(id: string): T {
    const entry = this.entries.get(id)
    if (!entry)
      throw new ProviderError('E_PROVIDER_UNKNOWN', `Tool provider ${id} is not installed`, {
        kind: this.kind,
        provider: id,
        operation: 'resolve',
      })
    return entry.provider
  }
  catalog() {
    return Object.freeze(
      [...this.entries.values()].map(({ provider, sourcePackage }) =>
        Object.freeze({
          id: provider.id,
          version: provider.version,
          sourcePackage,
        }),
      ),
    )
  }
}
export class ToolRuntimeRegistry extends Providers<ToolRuntimeProvider> implements ToolRuntimeRegistryPort {
  constructor(withDefault = true) {
    super('tool-runtime')
    if (withDefault) this.register('@agnes/core', defaultToolRuntimeProvider)
  }
}
export class ToolPolicyRegistry extends Providers<ToolPolicy> implements ToolPolicyRegistryPort {
  constructor(withDefault = true) {
    super('tool-policy')
    if (withDefault) this.register('@agnes/base', defaultToolPolicy)
  }
}
