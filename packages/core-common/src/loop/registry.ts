import type { LoopCatalogEntry, LoopFactory, LoopRegistryPort, LoopSelection } from '@agnes/extension-api'
import { ProviderError } from '@agnes/extension-api'

// Persisted pre-plugin sessions bind this historical identity without loading extension runtime code.
export const LEGACY_LOOP: LoopSelection = Object.freeze({ id: 'agnes.default', version: '1.0.0' })

export class LoopRegistry implements LoopRegistryPort {
  private readonly factories = new Map<string, { sourcePackage: string; factory: LoopFactory }>()
  register(sourcePackage: string, factory: LoopFactory): () => Promise<void> {
    const key = loopKey(factory)
    if (!factory.id || !factory.version)
      throw new ProviderError('E_PROVIDER_INVALID', `Loop ${key} is invalid`, {
        kind: 'loop',
        provider: factory.id,
        operation: 'register',
      })
    if (this.factories.has(key))
      throw new ProviderError('E_PROVIDER_DUPLICATE', `Loop ${key} is already registered`, {
        kind: 'loop',
        provider: factory.id,
        operation: 'register',
      })
    const record = { sourcePackage, factory }
    this.factories.set(key, record)
    return async () => {
      if (this.factories.get(key) === record) this.factories.delete(key)
    }
  }
  resolve(selection: LoopSelection = LEGACY_LOOP): LoopFactory {
    const record = this.factories.get(loopKey(selection))
    if (!record)
      throw new ProviderError(
        'E_PROVIDER_UNKNOWN',
        `Loop ${loopKey(selection)} is not installed; install that id and version before opening the session`,
        { kind: 'loop', provider: selection.id, operation: 'resolve' },
      )
    return record.factory
  }
  catalog(): readonly LoopCatalogEntry[] {
    return Object.freeze(
      [...this.factories.values()].map(({ factory, sourcePackage }) =>
        Object.freeze({
          id: factory.id,
          version: factory.version,
          capabilities: Object.freeze([...factory.capabilities]),
          sourcePackage,
          ...(factory.controls ? { controls: Object.freeze({ ...factory.controls }) } : {}),
        }),
      ),
    )
  }
}
export const loopKey = (selection: LoopSelection): string => `${selection.id}@${selection.version}`

export { type LoopPluginContext, registerLoopPlugin } from '@agnes/extension-api'
