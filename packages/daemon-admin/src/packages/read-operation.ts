import { type PackageManager, withPackageVerification } from '@agnes/package-manager'
import {
  PACKAGE_DOCS_MAX_BYTES,
  type PackageAdminMethodName,
  type PackageDocsGetParams,
  type PackageDocsGetResult,
  rpcError,
  validatePackageAdminCall,
} from '@agnes/protocol'
import type { PackageProfileDirectory } from './project.js'

/** One RPC's file observations; effect handlers retain their independent verification gates. */
export function packageReadOperation<T>(method: PackageAdminMethodName, call: () => Promise<T>): Promise<T> {
  return [
    '_agnes/v1/applications.get',
    '_agnes/v1/applications.preview',
    '_agnes/v1/packages.list',
    '_agnes/v1/clientModules.list',
    '_agnes/v1/clientModules.uiEntries',
    '_agnes/v1/clientModules.read',
    '_agnes/v1/clientModules.frontendPublication',
    '_agnes/v1/skins.list',
    '_agnes/v1/skins.read',
  ].includes(method)
    ? withPackageVerification(call)
    : call()
}

export async function readPackageDocs(
  options: { manager: Pick<PackageManager, 'documentation'>; profileDirectory: PackageProfileDirectory },
  { profile, ...request }: PackageDocsGetParams,
  signal?: AbortSignal,
): Promise<PackageDocsGetResult> {
  const directory = await options.profileDirectory(profile)
  const result = await options.manager.documentation(directory, request, signal)
  if (
    !validatePackageAdminCall('_agnes/v1/packages.docs.get', 'result', result).ok ||
    (result.found && Buffer.byteLength(result.markdown) > PACKAGE_DOCS_MAX_BYTES)
  )
    throw rpcError('SEMANTIC_REJECTED', { reason: 'E_PACKAGE_STATE' })
  return result
}
