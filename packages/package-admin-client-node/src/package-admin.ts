import type {
  PackageCatalogDescriptor,
  PackageCatalogGetParams,
  PackageCatalogListParams,
  PackageCatalogPage,
  PackageDisableParams,
  PackageEnableParams,
  PackageInspectParams,
  PackageInstallParams,
  PackageListParams,
  PackageListResult,
  PackageOperation,
  PackageOperationCancelParams,
  PackageOperationGetParams,
  PackageOperationReceipt,
  PackagePinsInspectParams,
  PackagePinsInspectResult,
  PackagePinsReleaseParams,
  PackagePinsReleaseResult,
  PackageRemoveParams,
  PackageRollbackParams,
  PackageTrustParams,
  PackageTrustWorkspaceParams,
  PackageTrustWorkspaceResult,
  PackageUntrustParams,
  PackageUpdateParams,
  PluginTreeApplyParams,
  PluginTreeApplyResult,
  PluginTreeRollbackParams,
  PluginTreeRollbackResult,
  PluginTreeView,
} from '@agnes/protocol'
export type PackageAdminRpc = Readonly<{
  call<T>(method: string, params: unknown): Promise<T>
}>
type Disposer = () => void

export type PackageOperationSubscriptionOptions = {
  /** Polling preserves progress recovery across reconnects until PM5 supplies progress notifications. */
  intervalMs?: number
  signal?: AbortSignal
  onError?: (error: unknown) => void
}

export type PackageAdminClient = Readonly<{
  catalog: Readonly<{
    list(params: PackageCatalogListParams): Promise<PackageCatalogPage>
    get(params: PackageCatalogGetParams): Promise<PackageCatalogDescriptor>
  }>
  list(params: PackageListParams): Promise<PackageListResult>
  inspect(params: PackageInspectParams): Promise<PackageOperationReceipt>
  install(params: PackageInstallParams): Promise<PackageOperationReceipt>
  trust(params: PackageTrustParams): Promise<PackageOperationReceipt>
  untrust(params: PackageUntrustParams): Promise<PackageOperationReceipt>
  trustWorkspace(params: PackageTrustWorkspaceParams): Promise<PackageTrustWorkspaceResult>
  enable(params: PackageEnableParams): Promise<PackageOperationReceipt>
  disable(params: PackageDisableParams): Promise<PackageOperationReceipt>
  update(params: PackageUpdateParams): Promise<PackageOperationReceipt>
  rollback(params: PackageRollbackParams): Promise<PackageOperationReceipt>
  remove(params: PackageRemoveParams): Promise<PackageOperationReceipt>
  operation: Readonly<{
    get(params: PackageOperationGetParams): Promise<PackageOperation>
    cancel(params: PackageOperationCancelParams): Promise<PackageOperationReceipt>
    subscribe(
      params: PackageOperationGetParams,
      onProgress: (operation: PackageOperation) => void,
      options?: PackageOperationSubscriptionOptions,
    ): Promise<Disposer>
  }>
  pins: Readonly<{
    inspect(params: PackagePinsInspectParams): Promise<PackagePinsInspectResult>
    release(params: PackagePinsReleaseParams): Promise<PackagePinsReleaseResult>
  }>
  tree: Readonly<{
    get(params: PackageListParams): Promise<PluginTreeView>
    list(params: PackageListParams): Promise<PluginTreeView>
    apply(params: PluginTreeApplyParams): Promise<PluginTreeApplyResult>
    rollback(params: PluginTreeRollbackParams): Promise<PluginTreeRollbackResult>
  }>
}>

const TERMINAL_OPERATION_STATES = new Set<PackageOperation['state']>([
  'completed',
  'failed',
  'cancelled',
  'rolled-back',
])
const DEFAULT_POLL_INTERVAL_MS = 500

function validPollInterval(intervalMs: number): boolean {
  return Number.isSafeInteger(intervalMs) && intervalMs >= 50 && intervalMs <= 60_000
}

/**
 * The admin SDK is intentionally a Node-only handle. Every effect retains the protocol's explicit
 * clientId/commandId fields; the helper never mints or substitutes them because that would weaken
 * daemon-side idempotency binding.
 */
export function createPackageAdminClient(client: PackageAdminRpc): PackageAdminClient {
  const get = (params: PackageOperationGetParams): Promise<PackageOperation> =>
    client.call('_agnes/v1/packages.operation.get', params)

  return Object.freeze({
    catalog: Object.freeze({
      list: (params: PackageCatalogListParams): Promise<PackageCatalogPage> =>
        client.call('_agnes/v1/packages.catalog.list', params),
      get: (params: PackageCatalogGetParams): Promise<PackageCatalogDescriptor> =>
        client.call('_agnes/v1/packages.catalog.get', params),
    }),
    list: (params: PackageListParams): Promise<PackageListResult> =>
      client.call('_agnes/v1/packages.list', params),
    inspect: (params: PackageInspectParams): Promise<PackageOperationReceipt> =>
      client.call('_agnes/v1/packages.inspect', params),
    install: (params: PackageInstallParams): Promise<PackageOperationReceipt> =>
      client.call('_agnes/v1/packages.install', params),
    trust: (params: PackageTrustParams): Promise<PackageOperationReceipt> =>
      client.call('_agnes/v1/packages.trust', params),
    untrust: (params: PackageUntrustParams): Promise<PackageOperationReceipt> =>
      client.call('_agnes/v1/packages.untrust', params),
    trustWorkspace: (params: PackageTrustWorkspaceParams): Promise<PackageTrustWorkspaceResult> =>
      client.call('_agnes/v1/packages.trustWorkspace', params),
    enable: (params: PackageEnableParams): Promise<PackageOperationReceipt> =>
      client.call('_agnes/v1/packages.enable', params),
    disable: (params: PackageDisableParams): Promise<PackageOperationReceipt> =>
      client.call('_agnes/v1/packages.disable', params),
    update: (params: PackageUpdateParams): Promise<PackageOperationReceipt> =>
      client.call('_agnes/v1/packages.update', params),
    rollback: (params: PackageRollbackParams): Promise<PackageOperationReceipt> =>
      client.call('_agnes/v1/packages.rollback', params),
    remove: (params: PackageRemoveParams): Promise<PackageOperationReceipt> =>
      client.call('_agnes/v1/packages.remove', params),
    operation: Object.freeze({
      get,
      cancel: (params: PackageOperationCancelParams): Promise<PackageOperationReceipt> =>
        client.call('_agnes/v1/packages.operation.cancel', params),
      subscribe: async (
        params: PackageOperationGetParams,
        onProgress: (operation: PackageOperation) => void,
        options: PackageOperationSubscriptionOptions = {},
      ): Promise<Disposer> => {
        const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
        if (!validPollInterval(intervalMs)) throw new TypeError('invalid package operation poll interval')
        if (options.signal?.aborted) return () => undefined

        let disposed = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const dispose = (): void => {
          if (disposed) return
          disposed = true
          if (timer) clearTimeout(timer)
          timer = undefined
          options.signal?.removeEventListener('abort', dispose)
        }
        const poll = async (): Promise<void> => {
          if (disposed) return
          try {
            const operation = await get(params)
            if (disposed) return
            onProgress(operation)
            if (TERMINAL_OPERATION_STATES.has(operation.state)) {
              dispose()
              return
            }
          } catch (error) {
            if (disposed) return
            options.onError?.(error)
          }
          if (!disposed) timer = setTimeout(() => void poll(), intervalMs)
        }

        options.signal?.addEventListener('abort', dispose, { once: true })
        await poll()
        return dispose
      },
    }),
    pins: Object.freeze({
      inspect: (params: PackagePinsInspectParams): Promise<PackagePinsInspectResult> =>
        client.call('_agnes/v1/packages.pins.inspect', params),
      release: (params: PackagePinsReleaseParams): Promise<PackagePinsReleaseResult> =>
        client.call('_agnes/v1/packages.pins.release', params),
    }),
    tree: Object.freeze({
      get: (params: PackageListParams): Promise<PluginTreeView> =>
        client.call('_agnes/v1/plugins.tree.get', params),
      list: (params: PackageListParams): Promise<PluginTreeView> =>
        client.call('_agnes/v1/plugins.tree.list', params),
      apply: (params: PluginTreeApplyParams): Promise<PluginTreeApplyResult> =>
        client.call('_agnes/v1/plugins.tree.apply', params),
      rollback: (params: PluginTreeRollbackParams): Promise<PluginTreeRollbackResult> =>
        client.call('_agnes/v1/plugins.tree.rollback', params),
    }),
  })
}
