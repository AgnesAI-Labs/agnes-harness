import type { Kernel } from '@agnes/core'
import { ProviderError } from '@agnes/extension-api'
import { HostError, type HostErrorCode } from '@agnes/host-common/errors'
import { withAssemblyIsolation } from '@agnes/host-common/profile/isolation'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { createHotPolicyFacade } from '@agnes/host-common/profile-policy'
import { PublicationDispatch } from '@agnes/host-common/publication-dispatch'
import { PublicationGate } from '@agnes/host-common/publication-gate'
import { HostQuietState } from '@agnes/host-common/quiet-state'
import type { HostPluginTreeBase } from '@agnes/host-extensions/assemble/seams-cordis'
import { createExtensionActivationBarrier } from '@agnes/host-extensions/ext-host/activation-barrier'
import { validateExtensionIsolation } from '@agnes/host-extensions/ext-host/extension-isolation-selector'
import type { WorkspaceInvocationResolver } from '@agnes/host-infrastructure/workspace-invocation-resolver'
import {
  applyProviderSelections,
  readProviderSelections,
} from '@agnes/host-providers/assemble/provider-selection'
import { RuntimeMutationGate } from '@agnes/host-providers/runtime-mutation-gate'
import { PackageError } from '@agnes/package-manager'
import { Rollback } from '../lifecycle/lifecycle.js'
import type { Assembled } from './assembled.js'
import type { AssembleDeps } from './assembly-deps.js'
import type { SessionCapabilitiesFn } from './capabilities.js'

/**
 * A value that exists only once a later stage has built it, read by closures an earlier stage
 * handed out. Reading it before then is an assembly bug, so it throws rather than yielding undefined.
 */
export class Late<T> {
  private value: T | undefined
  constructor(private readonly name: string) {}
  set(value: T): void {
    this.value = value
  }
  /** For the few readers that legitimately run before the value is built. */
  peek(): T | undefined {
    return this.value
  }
  get(): T {
    if (this.value === undefined) throw new Error(`assembly: ${this.name} was read before it was built`)
    return this.value
  }
}

/** What earlier stages must reach but only later stages can build. */
export type LiveBindings = Readonly<{
  kernel: Late<Kernel>
  pluginTree: Late<HostPluginTreeBase>
  extensionRows: Late<Assembled['extensionRows']>
  sessionCapabilities: Late<SessionCapabilitiesFn>
}>

/** Synchronous coordination objects with no I/O; one set per assembly. */
export type AssemblyGates = Readonly<{
  hotPolicy: ReturnType<typeof createHotPolicyFacade>
  quietState: HostQuietState
  publicationGate: PublicationGate
  runtimeMutationGate: RuntimeMutationGate
  publicationDispatch: PublicationDispatch
}>

/**
 * The state every assembly stage shares. Stages take it and return the typed result they own;
 * nothing else is shared through a closure. `profile` is the one mutable field: model-profile
 * updates and loop selection replace it, and closures read the current value.
 */
export type AssemblyContext = {
  profile: ResolvedProfile
  readonly deps: AssembleDeps
  readonly providerSelections: ReturnType<typeof readProviderSelections>
  readonly dataDir: string
  readonly workspaceRoot: string
  readonly env: NodeJS.ProcessEnv
  readonly clock: () => number
  readonly rollback: Rollback
  /** Aborted with `deps.signal`; handed to everything long-lived the assembly starts. */
  readonly abort: AbortController
  readonly activationBarrier: ReturnType<typeof createExtensionActivationBarrier>
  readonly workspaceInvocationFor: WorkspaceInvocationResolver
  readonly gates: AssemblyGates
  readonly live: LiveBindings
  /** The step the assembly is in; `fail` reports it. */
  step: string
  /** Ends a step and names the next: the crash point is after this step's work, before the next one's. */
  done(next: string): void
  say(kind: string, detail: Record<string, unknown>): void
  refuse(code: HostErrorCode, msg: string, detail: Record<string, unknown>): never
}

/** Everything here may throw before the first step; those errors are not startup failures to unwind. */
export function createAssemblyContext(profile: ResolvedProfile, deps: AssembleDeps): AssemblyContext {
  const workspaceInvocationFor: WorkspaceInvocationResolver =
    deps.workspaceInvocationFor ??
    (() => {
      throw Object.assign(new Error('E_WORKSPACE_REQUIRED: session has no workspace invocation'), {
        code: 'E_WORKSPACE_REQUIRED',
      })
    })
  deps.signal?.throwIfAborted()
  const providerSelections = readProviderSelections(profile)
  profile = applyProviderSelections(profile, providerSelections)
  profile = withAssemblyIsolation(profile, deps.extensionIsolation)
  validateExtensionIsolation(profile.extensionIsolation)
  const abort = new AbortController()
  const activationBarrier = deps.activationBarrier ?? createExtensionActivationBarrier()
  deps.signal?.addEventListener('abort', () => abort.abort(), { once: true })
  const hotPolicy = createHotPolicyFacade()
  const publicationGate = new PublicationGate()
  const context: AssemblyContext = {
    profile,
    deps,
    providerSelections,
    dataDir: deps.dataDir,
    workspaceRoot: deps.workspaceRoot,
    env: deps.env ?? process.env,
    clock: deps.clock ?? (() => Date.now()),
    rollback: new Rollback(),
    abort,
    activationBarrier,
    workspaceInvocationFor,
    gates: Object.freeze({
      hotPolicy,
      quietState: new HostQuietState(),
      publicationGate,
      runtimeMutationGate: new RuntimeMutationGate(),
      publicationDispatch: new PublicationDispatch(publicationGate, hotPolicy),
    }),
    live: Object.freeze({
      kernel: new Late<Kernel>('kernel'),
      pluginTree: new Late<HostPluginTreeBase>('plugin tree'),
      extensionRows: new Late<Assembled['extensionRows']>('extension rows'),
      sessionCapabilities: new Late<SessionCapabilitiesFn>('session capabilities'),
    }),
    step: 'packages',
    done: (next) => {
      if (deps.crashAt === context.step) throw new Error(`crash:${context.step}`)
      context.step = next
    },
    say: (kind, detail) => deps.audit.write({ kind, detail }),
    refuse: (code, msg, detail) => {
      throw new HostError(code, msg, { detail })
    },
  }
  return context
}

/** Unwinds what the failed assembly had built, audits the failure and throws its startup error. */
export async function failAssembly(ctx: AssemblyContext, error: unknown): Promise<never> {
  const failed = await ctx.rollback.unwind()
  const msg = error instanceof Error ? error.message : String(error)
  const err =
    error instanceof HostError
      ? error
      : error instanceof PackageError &&
          error.code === 'E_PACKAGE_INTEGRITY' &&
          error.detail.reason === 'clean-home-required'
        ? new PackageError(
            'E_LOCK_MISMATCH',
            'Retired package format; select a new, empty AGH_HOME (clean home).',
            { detail: { reason: 'clean-home-required' } },
          )
        : new HostError('E_SEAM_INIT', msg, {
            detail: {
              step: ctx.step,
              ...(error instanceof ProviderError
                ? { reason: error.code.slice(2).toLowerCase().replaceAll('_', '-') }
                : {}),
            },
          })
  ctx.say('startup.failed', { step: ctx.step, code: err.code, message: err.message, rollbackFailed: failed })
  throw err
}

/** Refuses a second package contributing a name an earlier one already gave (`E_PACKAGE_DUPLICATE`). */
export const duplicateContribution = (id: string, k: string, n: string): never => {
  throw new HostError('E_PACKAGE_DUPLICATE', `${id}: ${k} ${n} is a duplicate`, { detail: { k, source: n } })
}
