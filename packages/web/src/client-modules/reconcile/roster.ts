import type { ClientModuleRosterRow } from '@agnes/protocol'
import type { ReadyClientModule } from './contracts.js'

export function readyRosterModules(rows: readonly ClientModuleRosterRow[]): ReadyClientModule[] {
  return rows.flatMap((row) => {
    if (
      !row.enabled ||
      row.phase !== 'ready' ||
      row.packageId === undefined ||
      row.revision === undefined ||
      row.entryUrl === undefined ||
      row.styleUrls === undefined ||
      row.slots === undefined ||
      row.extIds === undefined
    )
      return []
    return [
      {
        ...(row.intelligentComponents ? { intelligentComponents: row.intelligentComponents } : {}),
        ...(row.exampleOf ? { exampleOf: row.exampleOf } : {}),
        ...(row.pageEntry ? { pageEntry: row.pageEntry } : {}),
        ...(row.clientId ? { clientId: row.clientId } : {}),
        ...(row.presentationRoleBindings ? { presentationRoleBindings: row.presentationRoleBindings } : {}),
        ...(row.presentationRoles ? { presentationRoles: row.presentationRoles } : {}),
        ...(row.binding ? { binding: row.binding } : {}),
        ...(row.homeEntries ? { homeEntries: row.homeEntries } : {}),
        ...(row.examplePages ? { examplePages: row.examplePages } : {}),
        rowId: row.rowId,
        packageId: row.packageId,
        revision: row.revision,
        entryUrl: row.entryUrl,
        styleUrls: row.styleUrls,
        slots: row.slots,
        ...(row.slotCatalogVersion === undefined ? {} : { slotCatalogVersion: row.slotCatalogVersion }),
        ...(row.contentDigest === undefined ? {} : { contentDigest: row.contentDigest }),
        extIds: row.extIds,
        services: row.services ?? [],
        backendOwner: row.moduleName,
        streams: row.streams ?? [],
        ...(row.publicConfig ? { publicConfig: row.publicConfig } : {}),
      },
    ]
  })
}
