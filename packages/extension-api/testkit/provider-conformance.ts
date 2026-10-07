import { ProviderError, type ProviderErrorCode } from '../src/errors.js'
import type { KindMap, ProviderRegistrationPort } from '../src/provider-kind.js'

/** Start a real Host operation with controlled inputs; ready means it reached the provider. */
export interface ProviderConformanceOperation {
  ready: Promise<void>
  result: Promise<unknown>
}
export interface ProviderConformanceProbe {
  start(signal: AbortSignal): ProviderConformanceOperation
  /** Close session/workspace handles acquired by the probe. */
  close(): Promise<void>
  /** Native APIs may return an explicit cancelled outcome instead of rejecting. */
  isCancelledResult?(result: unknown): boolean
  /** Reopen persisted state with a fresh session/instance, then check its observable contents. */
  coldResume?(): Promise<void>
}
export interface ProviderConformanceOptions<K extends keyof KindMap> {
  /** Use Host.providers from an isolated real Host; never substitute a mock registry. */
  providers: ProviderRegistrationPort
  sourcePackage: string
  provider: KindMap[K]
  /** Acquire the selected provider through the real Host service/session path. */
  open(provider: KindMap[K]): Promise<ProviderConformanceProbe>
}

async function expectCode(operation: () => unknown, code: ProviderErrorCode): Promise<void> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof ProviderError && error.code === code) return
    throw error
  }
  throw new Error(`Provider conformance: expected ${code}`)
}
async function expectCancelled(operation: Promise<unknown>, probe: ProviderConformanceProbe): Promise<void> {
  let result: unknown
  try {
    result = await operation
  } catch (error) {
    if (
      (error instanceof Error && error.name === 'AbortError') ||
      (error instanceof ProviderError && error.code === 'E_PROVIDER_UNAVAILABLE')
    )
      return
    throw error
  }
  if (probe.isCancelledResult?.(result)) return
  throw new Error('Provider conformance: cancelled operation returned a non-cancelled result')
}

/** Black-box admission, cancellation, draining unload and cold-resume contract checks. */
export async function runProviderConformance<K extends keyof KindMap>(
  kind: K,
  options: ProviderConformanceOptions<K>,
): Promise<readonly string[]> {
  const { providers, provider, sourcePackage } = options
  const selection = { provider: provider.id, version: provider.version }
  await expectCode(() => providers.resolve(kind, selection), 'E_PROVIDER_UNKNOWN')
  await expectCode(
    () => providers.register(kind, sourcePackage, { ...provider, version: 'invalid' }),
    'E_PROVIDER_INVALID',
  )
  const unregister = providers.register(kind, sourcePackage, provider)
  let probe: ProviderConformanceProbe | undefined
  const cases = ['admission', 'catalog']
  try {
    await expectCode(() => providers.register(kind, sourcePackage, provider), 'E_PROVIDER_DUPLICATE')
    const catalog = providers.catalog()
    const entry = catalog.find((entry) => entry.kind === kind && entry.id === provider.id)
    if (
      !entry ||
      !Object.isFrozen(catalog) ||
      !Object.isFrozen(entry) ||
      !Object.isFrozen(entry.capabilities)
    )
      throw new Error('Provider conformance: catalog must expose immutable registration metadata')
    probe = await options.open(providers.resolve(kind, selection))
    const cancel = new AbortController()
    const operation = probe.start(cancel.signal)
    // Attach a rejection handler before cancellation, without suppressing the assertion below.
    void operation.result.catch(() => {})
    await operation.ready
    cancel.abort()
    await expectCancelled(operation.result, probe)
    cases.push('cancel')
    if (kind === 'loop' || kind === 'persistence') {
      if (!probe.coldResume) throw new Error(`Provider conformance: ${kind} requires a cold-resume probe`)
    }
    if (probe.coldResume) {
      await probe.coldResume()
      cases.push('cold-resume')
    }
    const active = probe.start(new AbortController().signal)
    let settled = false
    void active.result.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await active.ready
    const disposal = unregister()
    if (disposal !== unregister()) throw new Error('Provider conformance: unregister must be idempotent')
    await disposal
    if (!settled)
      throw new Error('Provider conformance: unregister returned before the admitted operation drained')
    await expectCancelled(active.result, probe)
    await expectCode(() => providers.resolve(kind, selection), 'E_PROVIDER_UNKNOWN')
    cases.push('unload')
    return Object.freeze(cases)
  } finally {
    try {
      await unregister()
    } finally {
      await probe?.close()
    }
  }
}

export const loopConformance = (options: ProviderConformanceOptions<'loop'>) =>
  runProviderConformance('loop', options)
export const modelAdapterConformance = (options: ProviderConformanceOptions<'model-adapter'>) =>
  runProviderConformance('model-adapter', options)
export const compactionConformance = (options: ProviderConformanceOptions<'compaction'>) =>
  runProviderConformance('compaction', options)
export const persistenceConformance = (options: ProviderConformanceOptions<'persistence'>) =>
  runProviderConformance('persistence', options)
export const sandboxConformance = (options: ProviderConformanceOptions<'sandbox'>) =>
  runProviderConformance('sandbox', options)
export const toolRuntimeConformance = (options: ProviderConformanceOptions<'tool-runtime'>) =>
  runProviderConformance('tool-runtime', options)
export const toolPolicyConformance = (options: ProviderConformanceOptions<'tool-policy'>) =>
  runProviderConformance('tool-policy', options)
export const childAgentConformance = (options: ProviderConformanceOptions<'child-agent'>) =>
  runProviderConformance('child-agent', options)
