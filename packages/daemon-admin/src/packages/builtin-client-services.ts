import { RELEASE_CLIENT_QUERIES } from '@agnes/package-manager'
import {
  type ClientModuleServiceCallParams,
  type ExtensionCallResult,
  rpcError,
  validatePackageAdminCall,
} from '@agnes/protocol'

/** Explicit built-in query bridges. Worker admission still checks the session plugin and grants. */
export function callBuiltinClientQuery(
  params: ClientModuleServiceCallParams,
  call:
    | ((
        input: ClientModuleServiceCallParams & { packageId: string; extension: string },
      ) => Promise<ExtensionCallResult>)
    | undefined,
): Promise<ExtensionCallResult> | undefined {
  const bridge = RELEASE_CLIENT_QUERIES.find(
    (entry) => entry.rowId === params.rowId && entry.service === params.service,
  )
  if (!bridge) return undefined
  if (!call) return Promise.reject(rpcError('CAPABILITY_DENIED'))
  return call({ ...params, packageId: bridge.packageId, extension: bridge.extension }).then((result) => {
    if (!validatePackageAdminCall('_agnes/v1/clientModules.callService', 'result', result).ok)
      throw rpcError('INTERNAL_ERROR')
    return result
  })
}
