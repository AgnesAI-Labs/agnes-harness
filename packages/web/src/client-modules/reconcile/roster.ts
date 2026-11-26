import type { ClientModuleRosterRow } from '@agnes/protocol'
import type { ReadyClientModule } from './contracts.js'

const digest = /^[a-f0-9]{64}$/

export function validDocumentAdmission(
  admission: ClientModuleRosterRow['documentAdmission'],
  contentDigest: string | undefined,
) {
  if (
    !admission ||
    typeof admission.bindingDigest !== 'string' ||
    !digest.test(admission.bindingDigest) ||
    typeof contentDigest !== 'string' ||
    !/^sha256-[a-f0-9]{64}$/.test(contentDigest)
  )
    return false
  if (admission.kind === 'release') return !('presentationRevision' in admission)
  return (
    admission.kind === 'approved-presentation' &&
    typeof admission.presentationRevision === 'number' &&
    Number.isSafeInteger(admission.presentationRevision) &&
    admission.presentationRevision >= 0
  )
}

function isAssetOf(url: string, packageId: string, revision: string) {
  const path = url.replace(/^\/plugins\/generations\/[a-f0-9-]{36}\//, '/plugins/')
  return (
    path.startsWith(`/plugins/${packageId}/${encodeURIComponent(revision)}/`) &&
    !/[\\?#]/.test(path) &&
    new URL(path, 'http://localhost').pathname === path
  )
}

export function readyRosterModules(
  rows: readonly ClientModuleRosterRow[],
  profile: string,
): ReadyClientModule[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const { rowId } of rows) {
    if (seen.has(rowId)) duplicates.add(rowId)
    seen.add(rowId)
  }
  return rows.flatMap((row) => {
    const { packageId, revision } = row
    if (
      !row.enabled ||
      row.phase !== 'ready' ||
      !row.rowId.startsWith('web:') ||
      duplicates.has(row.rowId) ||
      !packageId ||
      !revision ||
      row.binding?.profileId !== profile ||
      row.binding.owner !== row.rowId ||
      row.binding.packageId !== packageId ||
      row.binding.integrity !== revision ||
      row.binding.availability === 'disabled' ||
      row.binding.availability === 'failed' ||
      !row.documentAdmission ||
      !row.contentDigest ||
      !validDocumentAdmission(row.documentAdmission, row.contentDigest) ||
      (row.documentAdmission.kind === 'approved-presentation' &&
        (row.binding.lifetime !== 'profile' || row.binding.availability !== 'active')) ||
      row.rendererDataUrl !== undefined ||
      row.intelligentComponents !== undefined ||
      row.entryUrl === undefined ||
      row.styleUrls === undefined ||
      row.slots === undefined ||
      row.extIds === undefined ||
      !isAssetOf(row.entryUrl, packageId, revision) ||
      row.styleUrls.some((url) => !isAssetOf(url, packageId, revision))
    )
      return []
    return [
      {
        documentAdmission: row.documentAdmission,
        ...(row.exampleOf ? { exampleOf: row.exampleOf } : {}),
        ...(row.pageEntry ? { pageEntry: row.pageEntry } : {}),
        ...(row.clientId ? { clientId: row.clientId } : {}),
        ...(row.presentationRoleBindings ? { presentationRoleBindings: row.presentationRoleBindings } : {}),
        ...(row.presentationRoles ? { presentationRoles: row.presentationRoles } : {}),
        binding: row.binding,
        ...(row.homeEntries ? { homeEntries: row.homeEntries } : {}),
        ...(row.examplePages ? { examplePages: row.examplePages } : {}),
        rowId: row.rowId,
        packageId,
        revision,
        entryUrl: row.entryUrl,
        styleUrls: row.styleUrls,
        slots: row.slots,
        ...(row.slotCatalogVersion === undefined ? {} : { slotCatalogVersion: row.slotCatalogVersion }),
        contentDigest: row.contentDigest,
        extIds: row.extIds,
        services: row.services ?? [],
        backendOwner: row.moduleName,
        streams: row.streams ?? [],
        ...(row.publicConfig ? { publicConfig: row.publicConfig } : {}),
      },
    ]
  })
}
