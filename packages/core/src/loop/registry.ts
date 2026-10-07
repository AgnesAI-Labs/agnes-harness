import type { LoopCatalogEntry, LoopFactory, LoopRegistryPort, LoopSelection } from '@agnes/extension-api'
import { DEFAULT_LOOP, defaultLoopFactory } from './default-driver.js'

export class LoopRegistry implements LoopRegistryPort {
  private readonly factories = new Map<string, { sourcePackage: string; factory: LoopFactory }>()
  constructor() {
    this.register('@agnes/core', defaultLoopFactory)
  }
  register(sourcePackage: string, factory: LoopFactory): () => void {
    const key = loopKey(factory)
    if (!factory.id || !factory.version || this.factories.has(key))
      throw new Error(`Loop ${key} is invalid or already registered`)
    const record = { sourcePackage, factory }
    this.factories.set(key, record)
    return () => {
      if (this.factories.get(key) === record) this.factories.delete(key)
    }
  }
  resolve(selection: LoopSelection = DEFAULT_LOOP): LoopFactory {
    const record = this.factories.get(loopKey(selection))
    if (!record)
      throw new Error(
        `Loop ${loopKey(selection)} is not installed; install the session's pinned loop before resuming`,
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
