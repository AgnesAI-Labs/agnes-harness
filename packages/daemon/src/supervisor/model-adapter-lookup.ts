import { builtinModelAdapterCatalog, builtinModelSelectionData } from '@agnes/distribution'
import { conversationModelAdapters, type ResolvedProfile } from '@agnes/host'
import {
  type RuntimePluginSnapshot,
  readPublishedModelAdapters,
  withPackageVerification,
} from '@agnes/package-manager'
import type { AdminLoop, AdminModelAdapter } from '@agnes/protocol'
import { type ModelCatalogWorker, readRunningModelCatalog } from './model-catalog-read.js'
import type { WorkerLink } from './worker-link.js'

/** What the shared worker's assembled Host reports about sessions, as the supervisor reads it. */
export type SharedSessionCatalog = {
  presets?: readonly { id: string; isDefault: boolean }[]
  permissions?: readonly { id: string; isDefault: boolean }[]
  loops: AdminLoop[]
  modelAdapters: AdminModelAdapter[]
}

/** The shared worker's session catalog. It starts the worker if none is running. */
export async function sharedSessionCatalog(pool: {
  acquireSharedWorker(): Promise<Pick<WorkerLink, 'command'>>
}): Promise<SharedSessionCatalog> {
  const link = await pool.acquireSharedWorker()
  return (await link.command(
    'session.catalog',
    { selectionOnly: true },
    { timeoutMs: 31_000 },
  )) as SharedSessionCatalog
}

/** Model pickers need route declarations and registration descriptions, not session composition.
 * A community description is published by real Host assembly and is usable only while its exact
 * source remains verified and trusted. Nothing returned here can admit a session or execute code. */
export function readModelSelectionCatalog(input: {
  profile(): ResolvedProfile
  profileDir: string
  sources(): Promise<readonly RuntimePluginSnapshot[]>
  worker?(): ModelCatalogWorker | undefined
}): () => Promise<AdminModelAdapter[]> {
  return () =>
    withPackageVerification(async () => {
      const profile = input.profile()
      let reading: Promise<readonly RuntimePluginSnapshot[]> | undefined
      const readSources = () => (reading ??= input.sources())
      const live = await readRunningModelCatalog(
        input.worker?.(),
        readSources,
        builtinModelAdapterCatalog(profile),
      )
      if (live) return [...live]
      const sources = await readSources()
      const published = readPublishedModelAdapters(input.profileDir, profile.hash, sources)
      const builtin = await builtinModelSelectionData(profile)
      const adapters = new Map(builtin.adapters.map((a) => [a.id, a]))
      for (const entry of published) adapters.set(entry.id, entry)
      const models = new Map(builtin.models.map((m) => [`${m.route}\0${m.id}`, m]))
      for (const adapter of published)
        for (const model of adapter.models) {
          if (model.route)
            models.set(`${model.route}\0${model.id}`, {
              id: model.id,
              route: model.route,
              api: adapter.wireApi,
            })
        }
      return conversationModelAdapters([...adapters.values()], [...models.values()], builtin.routes)
    })
}
