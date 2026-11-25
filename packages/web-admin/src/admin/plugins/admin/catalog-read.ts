import type { PluginAdminApi } from '../api.js'
import type { AdminPageState } from '../types.js'
import { safeMessage } from './model.js'

export type CatalogPublish = (update: (state: AdminPageState) => AdminPageState) => void

/** Catalog and background discovery share one controller-owned publication fence. */
export class CatalogReads {
  #generation = 0
  #communityGeneration = 0
  #communityPending: { generation: number; read: Promise<void> } | undefined

  invalidate(): void {
    this.#generation++
  }

  async catalog(
    api: PluginAdminApi,
    query: string,
    cursor: string | undefined,
    current: () => boolean,
    publish: CatalogPublish,
  ) {
    const generation = ++this.#generation
    const communityGeneration = ++this.#communityGeneration
    const valid = () => generation === this.#generation && current()
    publish((state) => ({ ...state, loading: true, error: undefined }))
    try {
      const page = await api.catalog(query, cursor)
      if (valid())
        publish((state) => ({
          ...state,
          catalog: cursor ? [...state.catalog, ...page.items] : page.items,
          ...(communityGeneration === this.#communityGeneration
            ? {
                community: page.community,
                communityVersion: page.communityVersion,
                communityReadFailed: false,
              }
            : {}),
          nextCursor: page.nextCursor,
          loading: false,
          connection: 'connected',
        }))
    } catch (error) {
      if (valid())
        publish((state) => ({ ...state, loading: false, error: safeMessage(error), connection: 'offline' }))
    }
  }

  community(api: PluginAdminApi, current: () => boolean, publish: CatalogPublish): Promise<void> {
    if (this.#communityPending?.generation === this.#generation) return this.#communityPending.read
    const generation = this.#generation
    const communityGeneration = ++this.#communityGeneration
    const valid = () =>
      generation === this.#generation && communityGeneration === this.#communityGeneration && current()
    const pending = (async () => {
      try {
        const page = await api.catalog()
        if (valid())
          publish((state) => ({
            ...state,
            community: page.community,
            communityVersion: page.communityVersion,
            communityReadFailed: false,
          }))
      } catch {
        if (valid()) publish((state) => ({ ...state, communityReadFailed: true }))
      } finally {
        if (this.#communityPending?.generation === generation) this.#communityPending = undefined
      }
    })()
    this.#communityPending = { generation, read: pending }
    return pending
  }
}
