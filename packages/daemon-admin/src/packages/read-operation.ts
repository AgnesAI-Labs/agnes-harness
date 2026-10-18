import { withPackageVerification } from '@agnes/package-manager'
import type { PackageAdminMethodName } from '@agnes/protocol'

/** One RPC's file observations; effect handlers retain their independent verification gates. */
export function packageReadOperation<T>(method: PackageAdminMethodName, call: () => Promise<T>): Promise<T> {
  return [
    '_agnes/v1/applications.get',
    '_agnes/v1/applications.preview',
    '_agnes/v1/packages.list',
    '_agnes/v1/clientModules.list',
    '_agnes/v1/clientModules.read',
    '_agnes/v1/skins.list',
    '_agnes/v1/skins.read',
  ].includes(method)
    ? withPackageVerification(call)
    : call()
}
