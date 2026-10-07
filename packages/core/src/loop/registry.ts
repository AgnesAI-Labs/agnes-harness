import type { LoopCatalogEntry, LoopFactory, LoopRegistryPort, LoopSelection } from '@agnes/extension-api'
import { CoreError } from '../types.js'

// Persisted pre-plugin sessions bind this historical identity without loading extension runtime code.
export const LEGACY_LOOP: LoopSelection = Object.freeze({ id: 'agnes.default', version: '1.0.0' })

export class LoopRegistry implements LoopRegistryPort {
  private readonly factories = new Map<string, { sourcePackage: string; factory: LoopFactory }>()
  register(sourcePackage: string, factory: LoopFactory): () => Promise<void> {
    const key = loopKey(factory)
    if (!factory.id || !factory.version || this.factories.has(key))
      throw new Error(`Loop ${key} is invalid or already registered`)
    const record = { sourcePackage, factory }
    this.factories.set(key, record)
    return async () => {
      if (this.factories.get(key) === record) this.factories.delete(key)
    }
  }
  resolve(selection: LoopSelection = LEGACY_LOOP): LoopFactory {
    const record = this.factories.get(loopKey(selection))
    if (!record)
      throw new CoreError(
        'E_LOOP_MISSING',
        `Loop ${loopKey(selection)} is not installed; install that id and version before opening the session`,
        { loop: { id: selection.id, version: selection.version } },
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
        }),
      ),
    )
  }
}
export const loopKey = (selection: LoopSelection): string => `${selection.id}@${selection.version}`

export { type LoopPluginContext, registerLoopPlugin } from '@agnes/extension-api'
