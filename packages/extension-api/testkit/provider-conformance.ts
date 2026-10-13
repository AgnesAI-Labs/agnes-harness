import type { ChildAgentProvider } from '../src/child-agent.js'
import type { CompactionEngine } from '../src/compaction-engine.js'
import { ProviderError, type ProviderErrorCode } from '../src/errors.js'
import {
  childAgentKind,
  compactionKind,
  loopKind,
  modelAdapterKind,
  persistenceKind,
  sandboxKind,
  toolPolicyKind,
  toolRuntimeKind,
} from '../src/kinds.js'
import type { LoopFactory } from '../src/loop.js'
import type { ModelAdapter } from '../src/model-adapter.js'
import type { PersistenceProvider } from '../src/persistence.js'
import type { ProviderIdentity, ProviderKind, ProviderRegistrationPort } from '../src/provider-kind.js'
import type { SandboxProvider } from '../src/sandbox-provider.js'
import type { ToolPolicy } from '../src/tool-policy.js'
import type { ToolRuntimeProvider } from '../src/tool-runtime.js'

/** Start a real Host operation with controlled inputs; ready means it reached the provider. */
export interface ProviderConformanceOperation {
  ready: Promise<void>
  result: Promise<unknown>
}
export interface ProviderConformanceProbe {
  start(signal: AbortSignal): ProviderConformanceOperation
  /** Close session/workspace handles acquired by the probe. */
  close(): Promise<void>
  /** Persistence has no signal-bearing operation; report that limitation explicitly. */
  cancellation?: 'unsupported'
  /** Release a controlled, non-cancellable call after unload has started. */
  unloadStarted?(): Promise<void>
  /** Native APIs may return an explicit cancelled outcome instead of rejecting. */
  isCancelledResult?(result: unknown): boolean
  /** Reopen persisted state with a fresh session/instance, then check its observable contents. */
  coldResume?(): Promise<void>
}
export interface ProviderConformanceOptions<T extends ProviderIdentity> {
  /** Use Host.providers from an isolated real Host; never substitute a mock registry. */
  providers: ProviderRegistrationPort
  provider: T
  /** Acquire the selected provider through the real Host service/session path. */
  open(provider: T): Promise<ProviderConformanceProbe>
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
export async function runProviderConformance<T extends ProviderIdentity>(
  kind: ProviderKind<T>,
  options: ProviderConformanceOptions<T>,
): Promise<readonly string[]> {
  const { providers, provider } = options
  const selection = { provider: provider.id, version: provider.version }
  await expectCode(() => providers.resolve(kind, selection), 'E_PROVIDER_UNKNOWN')
  await expectCode(() => providers.register(kind, { ...provider, version: 'invalid' }), 'E_PROVIDER_INVALID')
  const unregister = providers.register(kind, provider)
  let probe: ProviderConformanceProbe | undefined
  const cases = ['admission', 'catalog']
  try {
    await expectCode(() => providers.register(kind, provider), 'E_PROVIDER_DUPLICATE')
    const catalog = providers.catalog()
    const entry = catalog.find((entry) => entry.kind === kind.kind && entry.id === provider.id)
    if (
      !entry ||
      !Object.isFrozen(catalog) ||
      !Object.isFrozen(entry) ||
      !Object.isFrozen(entry.capabilities)
    )
      throw new Error('Provider conformance: catalog must expose immutable registration metadata')
    probe = await options.open(providers.resolve(kind, selection))
    if (probe.cancellation === 'unsupported') {
      if (kind.kind !== persistenceKind.kind)
        throw new Error(`Provider conformance: ${kind.kind} must support cancellation`)
      cases.push('cancel-unsupported')
    } else {
      const cancel = new AbortController()
      const operation = probe.start(cancel.signal)
      // Attach a rejection handler before cancellation, without suppressing the assertion below.
      void operation.result.catch(() => {})
      await operation.ready
      cancel.abort()
      await expectCancelled(operation.result, probe)
      cases.push('cancel')
    }
    if (kind.kind === loopKind.kind || kind.kind === persistenceKind.kind) {
      if (!probe.coldResume)
        throw new Error(`Provider conformance: ${kind.kind} requires a cold-resume probe`)
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
    await probe.unloadStarted?.()
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

export const loopConformance = (options: ProviderConformanceOptions<LoopFactory>) =>
  runProviderConformance(loopKind, options)
export const modelAdapterConformance = (options: ProviderConformanceOptions<ModelAdapter>) =>
  runProviderConformance(modelAdapterKind, options)
export const compactionConformance = (options: ProviderConformanceOptions<CompactionEngine>) =>
  runProviderConformance(compactionKind, options)
export const persistenceConformance = (options: ProviderConformanceOptions<PersistenceProvider>) =>
  runProviderConformance(persistenceKind, options)
export const sandboxConformance = (options: ProviderConformanceOptions<SandboxProvider>) =>
  runProviderConformance(sandboxKind, options)
export const toolRuntimeConformance = (options: ProviderConformanceOptions<ToolRuntimeProvider>) =>
  runProviderConformance(toolRuntimeKind, options)
export const toolPolicyConformance = (options: ProviderConformanceOptions<ToolPolicy>) =>
  runProviderConformance(toolPolicyKind, options)
export const childAgentConformance = (options: ProviderConformanceOptions<ChildAgentProvider>) =>
  runProviderConformance(childAgentKind, options)
