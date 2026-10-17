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
  const extension =
    params.rowId === 'web:builtin:agnes/jobs' && params.service === 'jobs.read'
      ? 'agnes/jobs-web'
      : params.rowId === 'web:builtin:agnes/reply-suggestions' && params.service === 'replies.read'
        ? 'agnes/follow-up-hint'
        : undefined
  if (!extension) return undefined
  if (!call) return Promise.reject(rpcError('CAPABILITY_DENIED'))
  return call({ ...params, packageId: '@agnes/base', extension }).then((result) => {
    if (!validatePackageAdminCall('_agnes/v1/clientModules.callService', 'result', result).ok)
      throw rpcError('INTERNAL_ERROR')
    return result
  })
}
