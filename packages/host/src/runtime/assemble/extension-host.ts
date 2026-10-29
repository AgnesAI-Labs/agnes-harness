import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SeamImplementations } from '@agnes/core'
import { type Kernel, platformFacts } from '@agnes/core'
import { HostError } from '@agnes/host-common/errors'
import { EXT_ROW_EXTENSION_IDS } from '@agnes/host-extensions/assemble/ext-rows'
import { bindExtensionInvocations } from '@agnes/host-extensions/assemble/extension-ports'
import type { SeamInitContext } from '@agnes/host-extensions/assemble/packages'
import { createBuiltinRowHost } from '@agnes/host-extensions/ext-host/builtin-row-host'
import { createExtensionFactorySelector } from '@agnes/host-extensions/ext-host/extension-isolation-selector'
import { createManagedExtHost } from '@agnes/host-extensions/ext-host/index'
import { ServiceRegistry } from '@agnes/host-extensions/ext-host/services'
import { bestEffort } from '../../best-effort.js'
import { compositionTools } from '../profile/composition-visibility.js'
import type { AssemblyContext } from './context.js'
import type { createEcosystemContexts } from './ecosystem-context.js'
import type { createKernel, ExtensionLeases } from './kernel-stage.js'
import type { PackageSet } from './packages.js'
import type { ProcessServices } from './process-services.js'
import type { RowHosts } from './row-hosts.js'
import type { RuntimeTargetHost } from './runtime-target.js'
import { sandboxBackendPackages } from './workspace-runtime.js'

/**
 * A raw module import, distinct from `PackageLoader`: `createManagedExtHost` evaluates an
 * extension's own entry file and reads its `default` export itself, whereas `deps.loader`
 * (`PackageLoader.importPackage`) normally runs that entry through `readNamedExports`'
 * seams/operations/runtimes/presets validation. Static preflight defers required/isolated-only
 * nonbuiltin roots so their entry cannot run before isolation selection.
 *
 * The default, when `deps.extensionLoader` is not supplied, is plain native `import()` - the exact
 * native-import behavior used by the builtin-row extension loader. That default is load-bearing:
 * `@agnes/base`'s real bundled extensions are plain `.ts`/`.js` files with no packaging step of
 * their own, and every existing test that loads them for real already relies on a zero-config
 * loader that just works without jiti or a cache directory. A caller with source-form (unbuilt
 * TypeScript) extensions to load outside a transpiling test runner opts into a jiti-backed loader
 * via `deps.extensionLoader` instead - `createManagedExtHost` accepts either shape unchanged.
 */
const nativeExtensionImport = {
  import: async (file: string): Promise<Record<string, unknown>> =>
    (await import(pathToFileURL(file).href)) as Record<string, unknown>,
}

/** What the enabled packages' bundled extensions run on: the kernel ports, the two hosts and the factory selector. */
export function createExtensionHost(
  ctx: AssemblyContext,
  input: Readonly<{
    pkgs: PackageSet
    proc: ProcessServices
    kernel: Kernel
    kernelStage: Awaited<ReturnType<typeof createKernel>>
    rowHosts: RowHosts
    runtimeTarget: RuntimeTargetHost
    ecosystem: ReturnType<typeof createEcosystemContexts>
    extensionLeases: ExtensionLeases
    seams: SeamImplementations
  }>,
) {
  const { deps, say, activationBarrier } = ctx
  const { publicationDispatch } = ctx.gates
  const { pkgs, proc, kernel, kernelStage, rowHosts, runtimeTarget, ecosystem, extensionLeases } = input
  const { modules, inventory } = pkgs
  const { adapters } = proc
  const { extensionSessions } = kernelStage
  const { extensionOrder, extensionOwners, extensionInfo, rowServices, rowExtensions } = rowHosts
  const { ecosystemContext } = ecosystem
  // 9 extensions - what the enabled packages bundle. One that fails to load is one extension the
  // host comes up without, so this step cannot fail the assembly and is not on the crash matrix.
  // bindExtensionInvocations is the real adapter: it turns the
  // kernel's own hooks/slots/resources registries plus its registrations() aggregator into the
  // full KernelPorts an extension callback runs against. During session_start core intentionally
  // has not published the half-initialized session in kernel.sessions yet, so only this private
  // resolver can see it. ExtensionSessions removes its opening marker after session_start and
  // revokes the exact object capability during failure cleanup/shutdown; ordinary Kernel callers
  // retain the public-after-initialization rule.
  const services = new ServiceRegistry()
  const extensionHost = runtimeTarget.extensionServices.current
  if (!extensionHost) throw new HostError('E_EXT_LOAD', 'service binding is closed')
  const extPorts = bindExtensionInvocations(
    {
      services,
      serviceProviders: extensionHost.ports,
      tools: ctx.profile.composition
        ? compositionTools(kernel.tools, ctx.profile.composition, ctx.profile.compositionToolScope)
        : kernel.tools,
      hooks: kernel.hooks,
      slots: kernel.slots,
      resources: kernel.resources,
      projections: kernel.projections,
      registrations: (source) => kernel.registrations(source),
    },
    (ref) => kernel.get(ref.key),
    (session) =>
      extensionSessions.ref(session) ??
      Object.freeze({ key: session.key, lane: session.lane, workspaceRoot: session.workspaceRoot }),
    extensionSessions.resolve,
    kernel.projections,
    activationBarrier,
    publicationDispatch,
    extensionHost.sink,
  )
  rowServices.activate(extPorts)
  // One snapshot for factory contexts and the isolated bootstrap; hooks get theirs from the kernel.
  const extensionPlatform = platformFacts(input.seams.platform)
  // The handlers are captured before the first await, so a caller may release the source's
  // registrations right after this returns and the shutdown still reaches every open session.
  const dispatchExtensionShutdown = async (source: string, context: { reason: 'revoke' | 'reload' }) => {
    const snapshot = kernel.hooks.snapshot(source)
    for (const session of [...kernel.sessions.values()]) {
      const sessionRef = extensionSessions.ref(session)
      if (!sessionRef) continue
      await kernel.hooks
        .dispatch(
          'shutdown',
          () => ({ reason: context.reason }),
          {
            session: sessionRef,
            signal: new AbortController().signal,
            replayed: false,
            log: deps.log,
          },
          { snapshot },
        )
        .catch(bestEffort(deps.log, 'extension-shutdown'))
    }
  }
  const managed = createManagedExtHost({
    order: extensionOrder,
    ports: extPorts,
    // JUDGMENT CALL: an extension-level revoke/reload is not scoped to one particular session the
    // way Kernel.close()'s own 'shutdown' dispatch is (that one fires once per open session, at
    // teardown, unfiltered by source - a different lifecycle use of the same hook name). This one
    // is scoped to just `source`'s own registrations via kernel.hooks.snapshot(source), but every
    // extension-registered hook handler still runs wrapped by bindExtensionInvocations, which
    // resolves ctx.session through ExtensionSessions' exact-reference WeakMap. A fabricated or
    // stale session identity therefore fails before an extension callback can run. The extension's
    // own shutdown hook would never actually run. So this dispatches once per session that is
    // genuinely open right now (mirroring Kernel.close()'s own per-session loop) instead of
    // inventing one; with zero sessions open there is nothing to notify, which is honest rather
    // than synthetic. `revoke`/`reload` are not yet reachable from Host (a later task), so this
    // path is presently unexercised by any production caller - it exists to satisfy the required
    // Options.shutdown contract now, correctly, rather than deferring the decision.
    shutdown: dispatchExtensionShutdown,
    loader: deps.extensionLoader ?? nativeExtensionImport,
    ceiling: ctx.profile.policy.capabilityCeiling,
    seamPackages: new Set(sandboxBackendPackages(ctx.profile, modules)),
    // Resource extensions keep their existing independent reload path. Only the sandbox backend
    // packages above are immutable now; the ordinary Cordis seams can update in place.
    // mutable() (ext-host/managed-host.ts:214-221) refuses by PACKAGE, and @agnes/base supplies
    // the local sandbox probe, so without this
    // every @agnes/base extension is unrevokable and an ext: row can never unmount. Opening it per
    // ID keeps the protection for every sibling that is not on this list. The list is derived from
    // the constant, not from the rows actually built, so it also names ids that ended up on the
    // assembly-time fallback or were gated off and have no row - harmless: it only lifts an
    // immutability veto, it does not itself revoke or load anything.
    reloadableExtensions: EXT_ROW_EXTENSION_IDS,
    // API_VERSION, not a literal: the loaded plan sample hardcoded '0.1.0', which is stale - the
    // real extension-api version is '1.0.0', and a mismatch here would fail every real manifest's
    // apiRange check at preflight (E_API_RANGE) before any real deployment ever got the chance.
    info: extensionInfo,
    platform: extensionPlatform,
    log: deps.log,
    audit: say,
  })
  // Builtin extensions that an `ext:` row supplies (MIGRATED_EXTENSION_IDS) are loaded here rather
  // than by `managed`, so a plugin row replacing one and the builtin coming back hand over cleanly.
  const builtinRows = createBuiltinRowHost({
    ...(deps.pluginManage ? { pluginManage: deps.pluginManage } : {}),
    ...(deps.sessionGeneration ? { sessionGeneration: deps.sessionGeneration } : {}),
    owners: extensionOwners,
    order: extensionOrder,
    ports: extPorts,
    platform: extensionPlatform,
    shutdown: dispatchExtensionShutdown,
    loader: deps.extensionLoader ?? nativeExtensionImport,
    ceiling: ctx.profile.policy.capabilityCeiling,
    info: extensionInfo,
    log: deps.log,
    audit: say,
  })
  extensionLeases.current = (source) =>
    managed.leaseFor(source) ?? rowExtensions.leaseFor(source) ?? builtinRows.leaseFor(source)
  // Factored out so a reload can build its own selector against a
  // `contextFor` bound to fresh resources instead of boot-time `deps`, reusing every other option
  // unchanged rather than restating this literal a second time.
  const makeFactorySelector = (contextFor: (owner: string, extensionId: string) => SeamInitContext) =>
    createExtensionFactorySelector({
      ...(ctx.profile.extensionIsolation ? { options: ctx.profile.extensionIsolation } : {}),
      ...(deps.extensionIsolationServices ? { services: deps.extensionIsolationServices } : {}),
      runtimeDirectory: join(deps.hostRoot, 'dist', 'agnes-runtime'),
      target: `${adapters.platform.os}-${adapters.platform.snapshot().arch}`,
      modules,
      inventory,
      contextFor,
      grantsFor: (owner, id) => pkgs.grants.extension(owner, id, modules.get(owner)),
      managed: {
        setIsolation: (id, isolation) => {
          managed.setIsolation(id, isolation)
          builtinRows.setIsolation(id, isolation)
        },
        // `builtinRows.fail` runs first and is not blocked by `managed.fail`: for a migrated id the
        // latter is a no-op that still queues behind whatever is ahead of it in managed-host's own
        // serial tail (an unrelated resource reload's un-deadlined shutdown dispatch, say), and
        // that must not delay releasing a dead isolated child's hook registrations. `allSettled`
        // also means a rejection from either side cannot swallow the other's report or escape as
        // an unhandled rejection.
        fail: async (id, error, token) => {
          await Promise.allSettled([builtinRows.fail(id, error, token), managed.fail(id, error)])
        },
      },
      audit: say,
    })
  const selectExtensionFactory = makeFactorySelector(ecosystemContext)
  return {
    services,
    extPorts,
    extensionPlatform,
    dispatchExtensionShutdown,
    managed,
    builtinRows,
    makeFactorySelector,
    selectExtensionFactory,
  }
}

export type ExtensionHost = ReturnType<typeof createExtensionHost>
