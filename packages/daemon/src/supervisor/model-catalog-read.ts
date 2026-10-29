import type { RuntimePluginSnapshot } from '@agnes/package-manager'
import { type AdminModelAdapter, isAdminModelAdapter } from '@agnes/protocol'

// Retain the existing adapter lookup budget. This path never acquires or starts a worker.
export const ADAPTER_LOOKUP_WAIT_MS = 2_000
export type ModelCatalogWorker = {
  readonly alive: boolean
  command(
    method: 'session.catalog',
    params: Record<string, unknown>,
    options: { timeoutMs: number },
  ): Promise<unknown>
}

/** Live registry descriptions can change after publication. Read only that metadata, then bind
 * community owners to the exact currently verified active code rows. No composition or admission. */
export async function readRunningModelCatalog(
  worker: ModelCatalogWorker | undefined,
  readSources: readonly RuntimePluginSnapshot[] | (() => Promise<readonly RuntimePluginSnapshot[]>),
  builtin: readonly Pick<AdminModelAdapter, 'id' | 'version' | 'sourcePackage'>[],
): Promise<readonly AdminModelAdapter[] | undefined> {
  if (!worker?.alive) return undefined
  try {
    const reply = await worker.command(
      'session.catalog',
      { modelsOnly: true },
      { timeoutMs: ADAPTER_LOOKUP_WAIT_MS },
    )
    if (!reply || typeof reply !== 'object') return undefined
    const value = reply as Record<string, unknown>
    if (
      !Array.isArray(value.modelAdapters) ||
      !value.modelAdapters.every(isAdminModelAdapter) ||
      !Array.isArray(value.sources)
    )
      return undefined
    const rows = value.sources
    const intrinsic = (adapter: AdminModelAdapter) =>
      !rows.some(
        (row) =>
          row &&
          typeof row === 'object' &&
          typeof row.plugin === 'string' &&
          row.plugin.startsWith(`${adapter.sourcePackage}@`),
      ) &&
      builtin.some(
        (entry) =>
          entry.id === adapter.id &&
          entry.version === adapter.version &&
          entry.sourcePackage === adapter.sourcePackage,
      )
    const sources = value.modelAdapters.some((adapter) => !intrinsic(adapter))
      ? typeof readSources === 'function'
        ? await readSources()
        : readSources
      : []
    return value.modelAdapters.filter((adapter) => {
      if (intrinsic(adapter)) return true
      return sources.some(
        ({ snapshot, trusted, enabled }) =>
          trusted &&
          enabled !== false &&
          snapshot.packageId === adapter.sourcePackage &&
          rows.some(
            (row) =>
              row &&
              typeof row === 'object' &&
              typeof row.plugin === 'string' &&
              row.plugin.startsWith(`${snapshot.packageId}@${snapshot.snapshotId}/`) &&
              row.entryRevision === snapshot.snapshotId,
          ),
      )
    })
  } catch {
    return undefined
  }
}
