import type { ServerResponse } from 'node:http'
import {
  httpRpcError,
  PACKAGE_DOCS_FEATURE,
  PACKAGE_DOCS_MAX_BYTES,
  type PackageAdminContext,
  type PackageDocsGetParams,
  validatePackageAdminCall,
} from '@agnes/protocol'
import { responseCause } from './admin-failure.js'
import { configurationReadOnly } from './permissions.js'

export type AdminDocsBackend = {
  epoch(): Promise<string | undefined>
  isCurrent(epoch: string): boolean
  get(params: PackageDocsGetParams, epoch: string, signal: AbortSignal): Promise<unknown>
}

export async function readPackageAdminContext(
  configured: PackageAdminContext,
  options: {
    invoke(action: 'list', params: { profile: string }): Promise<unknown>
    backendFeatures?: () => Promise<readonly string[]>
    docs?: AdminDocsBackend
  },
  docsRequested: boolean,
): Promise<{ context: PackageAdminContext; inventory: unknown }> {
  let inventory: unknown
  let backendFeatures: readonly string[] = []
  const readOnly = await configurationReadOnly(async () => {
    inventory = await options.invoke('list', { profile: configured.profile })
    backendFeatures = (await options.backendFeatures?.()) ?? []
    return inventory
  })
  const epoch = docsRequested && !readOnly ? await options.docs?.epoch().catch(() => undefined) : undefined
  const docsConnectionEpoch = epoch && options.docs?.isCurrent(epoch) ? epoch : undefined
  return {
    inventory,
    context: {
      ...configured,
      ...(docsConnectionEpoch ? { docsConnectionEpoch } : {}),
      features: [
        ...new Set([
          ...(configured.features ?? []).filter(
            (feature) =>
              feature !== PACKAGE_DOCS_FEATURE && !feature.startsWith('packages.community-discovery.'),
          ),
          ...backendFeatures.filter((feature) => feature !== PACKAGE_DOCS_FEATURE),
          ...(docsConnectionEpoch ? [PACKAGE_DOCS_FEATURE] : []),
        ]),
      ],
      permissions: readOnly
        ? configured.permissions.filter(
            (permission) => permission === 'packages.read' || permission === 'credentials.read',
          )
        : configured.permissions,
      readOnly,
    },
  }
}

type DocsResponse = { status: 200; body: unknown } | { status: 404 | 502 }

async function readAdminDocs(
  docs: AdminDocsBackend,
  params: PackageDocsGetParams,
  epoch: string,
  response: ServerResponse,
): Promise<DocsResponse | undefined> {
  if (response.destroyed) return undefined
  const controller = new AbortController()
  const disconnect = () => controller.abort()
  response.once('close', disconnect)
  try {
    const result = await docs.get(params, epoch, controller.signal)
    if (controller.signal.aborted) return undefined
    if (result === undefined || !docs.isCurrent(epoch)) return { status: 404 }
    if (
      typeof result !== 'object' ||
      result === null ||
      !validatePackageAdminCall('_agnes/v1/packages.docs.get', 'result', result).ok ||
      ('markdown' in result &&
        typeof result.markdown === 'string' &&
        Buffer.byteLength(result.markdown) > PACKAGE_DOCS_MAX_BYTES)
    )
      return { status: 502 }
    return { status: 200, body: { ...result, docsConnectionEpoch: epoch } }
  } catch (cause) {
    if (controller.signal.aborted) return undefined
    const rpc = typeof cause === 'object' && cause !== null && 'rpc' in cause ? cause.rpc : undefined
    if (
      !docs.isCurrent(epoch) ||
      (typeof rpc === 'object' && rpc !== null && 'code' in rpc && rpc.code === -32601)
    )
      return { status: 404 }
    throw cause
  } finally {
    response.removeListener('close', disconnect)
  }
}

export async function serveAdminDocs(
  docs: AdminDocsBackend | undefined,
  body: Record<string, unknown>,
  epoch: string | undefined,
  response: ServerResponse,
  reply: (response: ServerResponse, status: number, body: unknown) => void,
): Promise<void> {
  if (!docs || !epoch || !docs.isCurrent(epoch)) {
    reply(response, 404, { error: httpRpcError(404, 'E_ADMIN_ROUTE') })
    return
  }
  // The fixed route validates the RPC params before passing them to this bridge.
  const result = await readAdminDocs(docs, body as PackageDocsGetParams, epoch, response)
  if (!result || response.destroyed) return
  if (result.status === 404 || !docs.isCurrent(epoch))
    reply(response, 404, { error: httpRpcError(404, 'E_ADMIN_ROUTE') })
  else if (result.status === 502)
    reply(response, 502, { error: httpRpcError(502, 'E_ADMIN_RESPONSE', responseCause('result/docs/get')) })
  else if (result.status === 200) reply(response, 200, result.body)
}
