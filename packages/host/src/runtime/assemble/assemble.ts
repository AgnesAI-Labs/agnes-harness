import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type Kernel, platformFacts, type SessionImpl } from '@agnes/core'
import type { ExtensionManifest, ResourceEntry } from '@agnes/extension-api'
import { HostError } from '@agnes/host-common/errors'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { businessLimit } from '@agnes/host-common/profile-policy'
import {
  buildExtensionRow,
  composeExtensionRowTarget,
  type DynamicExtension,
  EXT_ROW_EXTENSION_IDS,
  EXT_ROW_MOUNT_REVISION,
  type ExtRowLoader,
  MIGRATED_EXTENSION_IDS,
} from '@agnes/host-extensions/assemble/ext-rows'
import { bindExtensionInvocations } from '@agnes/host-extensions/assemble/extension-ports'
import type { SeamInitContext } from '@agnes/host-extensions/assemble/packages'
import { type BuiltinRowHandle, createBuiltinRowHost } from '@agnes/host-extensions/ext-host/builtin-row-host'
import { createExtensionFactorySelector } from '@agnes/host-extensions/ext-host/extension-isolation-selector'
import { mergeExtensionStatus } from '@agnes/host-extensions/ext-host/extension-status-book'
import {
  createManagedExtHost,
  type ExtensionSpec,
  type ExtensionStatus,
} from '@agnes/host-extensions/ext-host/index'
import { readAuthorManifest, readBundledExtensionDirs } from '@agnes/host-extensions/ext-host/manifest'
import { preflightEmbeddedExtension, preflightExtension } from '@agnes/host-extensions/ext-host/preflight'
import { serviceContext } from '@agnes/host-extensions/ext-host/service-context'
import { serviceInvoker } from '@agnes/host-extensions/ext-host/service-invocation'
import { ServiceRegistry } from '@agnes/host-extensions/ext-host/services'
import type { SkillRuntimeInput } from '@agnes/host-extensions/resources/skills'
import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import { compactionEngineCatalog } from '@agnes/host-providers/assemble/compaction-engines'
import { readAdminLoopDefault } from '@agnes/host-providers/assemble/loop-selection'
import { modelAdapterCatalog } from '@agnes/host-providers/assemble/model-adapters'
import { skillRowRevision, withSkillRows } from '@agnes/host-providers/assemble/skill-row'
import {
  generationRegistries,
  prepareGenerationOwnerReplacement,
} from '@agnes/host-providers/runtime-generation-view'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import type { EntryRow } from '@agnes/plugin-runtime/host'
import { mountComputerUse } from '../computer-use/index.js'
import { compositionSkills, compositionTools } from '../profile/composition-visibility.js'
import type { Assembled } from './assembled.js'
import type { AssembleDeps } from './assembly-deps.js'
import { buildBootRows } from './boot-rows.js'
import { createCapabilities } from './capabilities.js'
import { childAgentCatalog } from './child-agents.js'
import { createAssemblyContext, failAssembly } from './context.js'
import { createEcosystemContexts } from './ecosystem-context.js'
import { startKernelHooks } from './kernel-hooks.js'
import { createKernel, type ExtensionLeases } from './kernel-stage.js'
import { buildOperations } from './operations.js'
import { bindSeams } from './package-seams.js'
import { loadPackages } from './packages.js'
import { resolvePresetCatalog } from './presets.js'
import { openProcessServices } from './process-services.js'
import { assembleProvider } from './provider-stage.js'
import { createRowHosts } from './row-hosts.js'
import { mountRuntimeTarget } from './runtime-target.js'
import { openSeamContexts } from './seam-contexts.js'
import { authorizeServiceProcess } from './service-process-policy.js'
import { createSkillState } from './skills.js'
import { createWorkspaceRuntimeFactory } from './workspace-runtime.js'

/**
 * A raw module import, distinct from `PackageLoader`: `createManagedExtHost` evaluates an
 * extension's own entry file and reads its `default` export itself, whereas `deps.loader`
 * (`PackageLoader.importPackage`) normally runs that entry through `readNamedExports`'
 * seams/operations/runtimes/presets validation. Static preflight defers required/isolated-only
 * nonbuiltin roots so their entry cannot run before isolation selection.
 *
 * The default, when `deps.extensionLoader` is not supplied, is plain native `import()` - the exact
 * native-import behavior used by the builtin-row extension loader. That default is load-bearing:
 * `@agnes/base`'s real
 * bundled extensions are plain `.ts`/`.js` files with no packaging step of their own, and every
 * existing test that loads them for real (`test/ext-host/base-tools.test.ts`,
 * `test/assemble/enabled-packages.test.ts`, the L1 replay corpus) already relies on a zero-config
 * loader that just works without jiti or a cache directory. A caller with source-form (unbuilt
 * TypeScript) extensions to load outside a transpiling test runner opts into a jiti-backed loader
 * via `deps.extensionLoader` instead - `createManagedExtHost` accepts either shape unchanged.
 */
const nativeExtensionImport = {
  import: async (file: string): Promise<Record<string, unknown>> =>
    (await import(pathToFileURL(file).href)) as Record<string, unknown>,
}

/** The steps assemble() can be told to crash after, in order. The testkit's crash matrix walks it. */
const STEP_ORDER = ['packages', 'adapters', 'presets', 'seams', 'provider', 'operations', 'kernel'] as const
export type AssemblyStep = (typeof STEP_ORDER)[number]
export const ASSEMBLY_STEPS: readonly AssemblyStep[] = STEP_ORDER

export type {
  Assembled,
  HostComputerUseRuntimeStatus,
  HostComputerUseStatusSource,
  ManagedExtHost,
  OrdinaryReconciliationLifecycle,
} from './assembled.js'
export type { AssembleDeps, HostPaths } from './assembly-deps.js'

export async function assemble(profile: ResolvedProfile, deps: AssembleDeps): Promise<Assembled> {
  const ctx = createAssemblyContext(profile, deps)
  const {
    dataDir,
    workspaceRoot,
    rollback,
    clock,
    env,
    say,
    refuse,
    done,
    activationBarrier,
    workspaceInvocationFor,
    providerSelections,
  } = ctx
  const ac = ctx.abort
  const { hotPolicy, quietState, publicationGate, runtimeMutationGate, publicationDispatch } = ctx.gates
  try {
    mkdirSync(join(dataDir, 'tmp'), { recursive: true, mode: 0o700 })
    const pkgs = await loadPackages(ctx)
    const {
      dirs,
      modules,
      runtimePackages,
      runtimePackageIds,
      activeRuntimeSources,
      inventory,
      loadRuntimeModule,
    } = pkgs
    done('adapters')

    const proc = await openProcessServices(ctx, pkgs)
    const {
      adapters,
      sandboxProviderSlot,
      skillReadRoots,
      gitWorktrees,
      lockedPackageMutations,
      secrets,
      nativePlatform,
    } = proc
    done('presets')

    const presetCatalog = resolvePresetCatalog(ctx, pkgs)
    const { presets, defaultPreset, profileConsent } = presetCatalog
    done('seams')
    const seamContexts = await openSeamContexts(ctx, pkgs, proc, presetCatalog)
    const { seamProfile, baseContext, contextFor, retention, staticSeams } = seamContexts
    const workspaceRuntime = createWorkspaceRuntimeFactory(ctx, pkgs, proc, presetCatalog, seamContexts)
    const { openWorkspaceRuntime } = workspaceRuntime
    const discoveredResources = new WeakMap<SessionImpl, readonly ResourceEntry[]>()
    const skillState = createSkillState(ctx, proc)
    const { owners: skillOwners } = skillState
    const bootRows = buildBootRows(ctx, pkgs, presetCatalog, seamContexts)
    const {
      builtSeams,
      builtPresets,
      builtOrdinary,
      compositionOwners,
      staticBootRows,
      bootTreeRows,
      builtin,
    } = bootRows
    const rowHosts = createRowHosts(ctx, pkgs, workspaceRuntime)
    const { pluginCatalogue, extensionInfo, extensionOrder, extensionOwners, rowExtensions, rowServices } =
      rowHosts
    const runtimeTarget = await mountRuntimeTarget(ctx, {
      pkgs,
      proc,
      presets: presetCatalog,
      bootRows,
      hosts: rowHosts,
      skillState,
    })
    const {
      publisher: runtimeTargetPublisher,
      generationViews,
      rawSessionRuntime,
      sessionRuntimeView,
      extensionServices,
      intelligentUi,
      enqueueRuntimeTarget,
      applyRuntimeTarget,
      ordinaryReconciliation,
      pluginTree,
      bindRuntimeSession,
      unbindRuntimeSession,
    } = runtimeTarget
    const { seams, approvalGrantControl } = bindSeams(ctx, proc, seamContexts, runtimeTarget)
    ctx.live.seams.set(seams)
    const computerUse = mountComputerUse({
      profile: ctx.profile,
      dataDir,
      platform: adapters.platform,
      retention,
      artifacts: {
        put: (bytes, meta) => seams.artifacts.put(bytes, { mime: meta.mime, name: meta.name }),
      },
      rollback,
    })
    say('seams.assembled', { seams: ctx.profile.seams, fsDigest: adapters.fs.fence().digest })
    const ecosystem = createEcosystemContexts(ctx, proc, seamContexts, skillState, computerUse)
    const { buildEcosystemContext, ecosystemContext, privacyTrajectory } = ecosystem
    done('provider')

    const providerStage = await assembleProvider(ctx, proc, presetCatalog, pluginTree)
    const { models, view, applyModelProfile } = providerStage
    done('operations')

    const { operations, runtimes } = buildOperations(ctx, pkgs, proc, seamContexts)
    done('kernel')

    const extensionLeases: ExtensionLeases = {}
    const kernelStage = await createKernel(ctx, {
      proc,
      presets: presetCatalog,
      providerStage,
      operations,
      runtimeTarget,
      skillState,
      computerUse,
      discoveredResources,
      extensionLeases,
    })
    const { kernel, extensionSessions, compositionLease, systemPromptProvider, memory } = kernelStage
    const capabilities = createCapabilities(ctx, {
      pkgs,
      presets: presetCatalog,
      bootRows,
      providerStage,
      runtimeTarget,
      skillState,
      discoveredResources,
    })
    const { compositionForPreset, sessionCapabilities } = capabilities
    const { observability, observeSession } = await startKernelHooks(ctx, {
      kernel,
      kernelStage,
      capabilities,
      ecosystem,
      runtimeTarget,
    })
    done('extensions')

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
    const extensionHost = extensionServices.current
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
    const extensionPlatform = platformFacts(seams.platform)
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
          .catch(() => undefined)
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
      seamPackages: new Set([ctx.profile.seams.sandbox, ctx.profile.seams.platform]),
      // Resource extensions keep their existing independent reload path. Only the two static seam
      // owners above are immutable now; the eight ordinary Cordis seams can update in place.
      // mutable() (ext-host/managed-host.ts:214-221) refuses by PACKAGE, and the shipped local-dev
      // template puts @agnes/base in `seams.sandbox` (templates/local-dev.yaml:11), so without this
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
    // Builtin manifests remain descriptive input for verified Cordis rows. Packaged builds supply
    // the same manifests through embeddedExtensions when no package files exist beside the binary.
    const findBundledExtension = (
      id: string,
    ):
      | {
          spec: ExtensionSpec
          packageId: string
          packageDirectory: string
          extensionDirectory: string
          embedded?: ExtensionManifest
        }
      | undefined => {
      for (const pkg of ctx.profile.packages) {
        if (!pkg.enabled || pkg.trust !== 'builtin') continue
        const packageDirectory = dirs.get(pkg.id)
        if (!packageDirectory) continue
        // Source installations keep descriptive manifests beside builtin packages.
        let extensionDirs: string[]
        try {
          extensionDirs = readBundledExtensionDirs(packageDirectory, pkg.trust === 'builtin')
        } catch {
          extensionDirs = []
        }
        for (const extensionDirectory of extensionDirs) {
          let manifest: ReturnType<typeof readAuthorManifest>
          try {
            manifest = readAuthorManifest(extensionDirectory)
          } catch {
            continue
          }
          if (manifest.id !== id) continue
          return {
            spec: {
              id: manifest.id,
              package: pkg.id,
              packageVersion: pkg.version,
              dir: extensionDirectory,
              trust: pkg.trust,
              enabled: true,
              integrity: pkg.integrity,
              revision: pkg.integrity,
            },
            packageId: pkg.id,
            packageDirectory,
            extensionDirectory,
          }
        }
        // Packaged builds embed the reviewed builtin manifest.
        const embedded = modules.get(pkg.id)?.embeddedExtensions?.find((m) => m.id === id)
        if (embedded && pkg.trust === 'builtin')
          return {
            spec: {
              id: embedded.id,
              package: pkg.id,
              packageVersion: pkg.version,
              dir: packageDirectory,
              trust: 'builtin',
              enabled: true,
              integrity: pkg.integrity,
              revision: pkg.integrity,
            },
            packageId: pkg.id,
            packageDirectory,
            extensionDirectory: packageDirectory,
            embedded,
          }
      }
      return undefined
    }
    // Third-party plugin rows may have registered before the kernel existed; they get their
    // registrations now. A tool name a builtin extension declares belongs to that extension's row.
    // `'unreadable'` is a builtin whose manifest cannot be read: nothing is known about what it declares.
    const authorManifestOf = (extensionId: string) => {
      const found = findBundledExtension(extensionId)
      if (!found) return undefined
      if (found.embedded) return found.embedded
      try {
        return readAuthorManifest(found.extensionDirectory)
      } catch {
        return 'unreadable' as const
      }
    }
    const consumesSkills = (extensionId: string) => {
      const manifest = authorManifestOf(extensionId)
      return manifest !== 'unreadable' && !!manifest?.liveResources?.includes('skills')
    }
    // A replacement bundled extension can declare the same public resource contract under any id.
    const declaredExtensionIds = new Set(EXT_ROW_EXTENSION_IDS)
    for (const pkg of ctx.profile.packages) {
      if (!pkg.enabled || pkg.trust !== 'builtin') continue
      for (const manifest of modules.get(pkg.id)?.embeddedExtensions ?? [])
        if (manifest.liveResources?.length) declaredExtensionIds.add(manifest.id)
      const directory = dirs.get(pkg.id)
      if (!directory) continue
      try {
        for (const extensionDirectory of readBundledExtensionDirs(directory, true)) {
          const manifest = readAuthorManifest(extensionDirectory)
          if (manifest.liveResources?.length) declaredExtensionIds.add(manifest.id)
        }
      } catch {
        /* Admission below remains fail-closed for unreadable manifests. */
      }
    }
    const reservedToolName = (name: string) => name.toLowerCase().replace(/^_+|_+$/g, '')
    const reservedTools = new Map<string, string>()
    for (const extensionId of declaredExtensionIds) {
      const manifest = authorManifestOf(extensionId)
      // An unreadable manifest declares nothing to reserve: that extension fails to load on its own.
      if (manifest === 'unreadable') continue
      for (const name of manifest?.capabilities.tools?.names ?? [])
        reservedTools.set(reservedToolName(name), `ext:${extensionId}`)
    }
    rowExtensions.activate({
      ports: extPorts,
      platform: extensionPlatform,
      shutdown: (source, context) => dispatchExtensionShutdown(source, context),
      reservedTool: (name, rowId) => {
        const owner = reservedTools.get(reservedToolName(name))
        return owner !== undefined && owner !== rowId
      },
      governance: new Map(
        ['agnes/privacy', 'agnes/hooks-runner'].map((extensionId) => {
          const manifest = authorManifestOf(extensionId)
          return [
            `ext:${extensionId}`,
            manifest === 'unreadable' ? manifest : (manifest?.capabilities.hooks ?? []),
          ] as const
        }),
      ),
    })
    // ==== ext: rows ====
    // This is the earliest point where an ext: row can exist: `managed`, `selectExtensionFactory`
    // and `findBundledExtension` (just above) are all consts declared after the boot tree's own
    // applyRuntimeTarget, and the row's loader needs all three.
    const extRowOwners = new Map<string, symbol>()
    // Extensions that exist only at runtime (one per resource), keyed by extension id. Registered by
    // `prepare`, dropped again once an apply no longer carries their row.
    const dynamicExtensionIds = new Set<string>()
    // Copies one owner's current Kernel registrations into the published generation sessions are
    // bound to, which otherwise keeps the copy it took when it was created.
    const mirrorGenerationOwner = (id: string) => {
      const current = runtimeTargetPublisher.current().value.current
      if (!current) return
      const seed = { tools: kernel.tools, resources: kernel.resources }
      const generation = generationRegistries(generationViews, current.runtimeRegistryRevision, seed)
      const replacement = prepareGenerationOwnerReplacement(generation, id, seed)
      replacement.commit()
      replacement.finalize()
    }
    const extRowLoader: ExtRowLoader = Object.freeze({
      load: async (extensionId: string) => ({
        id: extensionId,
        loaded: false,
        error: { code: 'E_EXT_LOAD', message: 'legacy extension loader is retired' },
      }),
      revoke: (extensionId: string, reason: string) => managed.revoke(extensionId, reason),
    })
    // The extension is constructed inside the row's apply, so a factory that throws is a listing
    // and an empty row, not an assembly failure.
    const loadMigratedExtension = (
      extensionId: string,
      skillResources?: SkillRuntimeInput,
    ): Promise<BuiltinRowHandle> => {
      const found = findBundledExtension(extensionId)
      if (!found)
        return Promise.resolve({
          loaded: false,
          error: { code: 'E_EXT_LOAD', message: 'extension not found' },
          release: async () => {},
        })
      return builtinRows.load({
        rowId: `ext:${extensionId}`,
        spec: found.spec,
        ...(found.embedded ? { embedded: found.embedded } : {}),
        factory: (token) =>
          (consumesSkills(extensionId)
            ? makeFactorySelector((owner, id) =>
                buildEcosystemContext(
                  owner,
                  id,
                  skillResources ? { skillResources: skillState.liveInput } : {},
                  ['skills'],
                ),
              )
            : selectExtensionFactory)(
            found.packageId,
            found.spec.id,
            found.packageDirectory,
            found.embedded ? found.packageDirectory : found.extensionDirectory,
            token,
          ),
      })
    }
    const loadDynamicExtension = (
      extensionId: string,
      dynamic: DynamicExtension,
    ): Promise<BuiltinRowHandle> => {
      return builtinRows.load({
        rowId: `ext:${extensionId}`,
        spec: dynamic.spec,
        embedded: dynamic.manifest,
        factory: () =>
          dynamic.factory(
            buildEcosystemContext(
              dynamic.spec.package,
              extensionId,
              { skillResources: skillState.liveInput },
              dynamic.manifest.liveResources,
            ),
          ),
        registration: 'lifetime',
        onLateRegistration: () => mirrorGenerationOwner(extensionId),
      })
    }
    const preparedExtensionInputs = new Map<string, Parameters<Assembled['extensionRows']['prepare']>[0]>()
    const prepareExtensionRow = (
      input: Readonly<{
        extensionId: string
        entryRevision?: string
        liveResourceRevision?: string
        config?: unknown
        disabled?: boolean
        dynamic?: DynamicExtension
        skillResources?: SkillRuntimeInput | undefined
      }>,
    ) => {
      if (input.dynamic) dynamicExtensionIds.add(input.extensionId)
      const found = input.dynamic ? undefined : findBundledExtension(input.extensionId)
      const manifest = input.dynamic?.manifest ?? authorManifestOf(input.extensionId)
      const liveResources = manifest && manifest !== 'unreadable' ? manifest.liveResources : undefined
      preparedExtensionInputs.set(input.extensionId, input)
      const onDisposeError = (error: unknown) =>
        say('extension.revoke_failed', {
          id: input.extensionId,
          row: `ext:${input.extensionId}`,
          ...(typeof (error as { code?: unknown }).code === 'string'
            ? { code: (error as { code: string }).code }
            : {}),
          message: error instanceof Error ? error.message : String(error),
        })
      const built = buildExtensionRow({
        extensionId: input.extensionId,
        packageId: input.dynamic?.spec.package ?? found?.packageId ?? '@agnes/base',
        entryRevision:
          input.entryRevision ??
          input.dynamic?.spec.revision ??
          found?.spec.revision ??
          EXT_ROW_MOUNT_REVISION,
        ...(liveResources === undefined ? {} : { liveResources }),
        ...(input.liveResourceRevision === undefined
          ? {}
          : { liveResourceRevision: input.liveResourceRevision }),
        loader: extRowLoader,
        owners: extRowOwners,
        onDisposeError,
        ...(input.dynamic
          ? {
              facade: {
                load: () => loadDynamicExtension(input.extensionId, input.dynamic as DynamicExtension),
              },
            }
          : MIGRATED_EXTENSION_IDS.has(input.extensionId) || liveResources?.length
            ? {
                facade: {
                  load: () =>
                    loadMigratedExtension(
                      input.extensionId,
                      Object.hasOwn(input, 'skillResources') ? input.skillResources : deps.skillResources,
                    ),
                },
              }
            : {}),
        ...(input.config === undefined ? {} : { config: input.config }),
        ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
      })
      // Without a Host-private claim the publisher refuses the row outright:
      // E_RUNTIME_TARGET_STATIC_CLAIM (runtime-target-static-authority.ts), and Host never boots.
      builtin.claims = Object.freeze([
        ...builtin.claims.filter((claim) => claim.row.id !== built.row.id),
        built.claim,
      ])
      return built.row
    }
    // Composed inside the apply queue (see enqueueRuntimeTarget): a daemon target still in flight
    // when this is called is part of the live tree by the time these rows are merged onto it.
    const applyExtensionRows = (rows: readonly Readonly<EntryRow>[]) =>
      enqueueRuntimeTarget(
        () =>
          buildCompleteRuntimeTarget(
            composeExtensionRowTarget({
              live: runtimeTargetPublisher.current().value.current?.target,
              fallbackRows: bootTreeRows,
              rows,
              extraOwnedRowIds: new Set([...dynamicExtensionIds].map((id) => `ext:${id}`)),
            }),
          ).target,
      )
    // Only extensions this installation can actually admit get a row. A row whose apply throws
    // during assembly does not become RowState 'failed': assemble.ts's own step wrapper rewrites it
    // into E_SEAM_INIT and unwinds the rollback, i.e. Host does not exist. Admission is therefore
    // decided BEFORE the row is built, with the same preflight managed.load runs (identity,
    // manifest, api range, capability ceiling). A profile that narrows `policy.capabilityCeiling`
    // below what a builtin declares used to mean "that one extension fails to load, Host boots";
    // rowifying it must not turn that into "Host does not exist".
    const admitsExtensionRow = (found: NonNullable<ReturnType<typeof findBundledExtension>>) => {
      try {
        const ceiling = ctx.profile.policy.capabilityCeiling
        if (found.embedded)
          preflightEmbeddedExtension({
            id: found.spec.id,
            manifest: found.embedded,
            ceiling,
            apiVersion: extensionInfo.apiVersion,
          })
        else preflightExtension({ ...found.spec, ceiling, apiVersion: extensionInfo.apiVersion })
        return true
      } catch {
        return false
      }
    }
    const extRowIds: string[] = []
    for (const extensionId of declaredExtensionIds) {
      // The Computer Use gate is a supply condition, not a grant condition: when it is off there is
      // nothing to load, so no row is built.
      if (extensionId === 'agnes/computer-use' && !ctx.profile.computerUse.enabled) continue
      const found = findBundledExtension(extensionId)
      if (!found) continue
      if (admitsExtensionRow(found)) extRowIds.push(extensionId)
      else
        say('extension.failed', {
          id: extensionId,
          code: 'E_EXT_LOAD',
          message: 'builtin row admission failed',
        })
    }
    builtin.hostExtensionRows = Object.freeze([
      ...extRowIds.map((extensionId) => {
        const pinned = deps.generationBuiltinRows?.find((row) => row.id === `ext:${extensionId}`)
        return prepareExtensionRow({
          extensionId,
          ...(consumesSkills(extensionId)
            ? {
                liveResourceRevision: skillRowRevision(deps.skillResources),
                skillResources: deps.skillResources,
              }
            : {}),
          ...(pinned
            ? {
                entryRevision: pinned.entryRevision,
                ...(pinned.config === undefined ? {} : { config: pinned.config }),
                ...(pinned.disabled === undefined ? {} : { disabled: pinned.disabled }),
              }
            : {}),
        })
      }),
    ])
    if (builtin.hostExtensionRows.length) await applyExtensionRows(builtin.hostExtensionRows)
    const extensionRows = Object.freeze({
      current: () => builtin.hostExtensionRows,
      prepare: prepareExtensionRow,
      apply: async (rows: readonly Readonly<EntryRow>[]) => {
        // Set before applying: the merge must not put back a row this call is removing.
        const previous = builtin.hostExtensionRows
        builtin.hostExtensionRows = Object.freeze([...rows])
        try {
          const report = await applyExtensionRows(rows)
          // A dynamic extension whose row is gone is forgotten, so a later apply cannot bring it back.
          const wanted = new Set(rows.map((row) => row.id))
          for (const id of preparedExtensionInputs.keys())
            if (!wanted.has(`ext:${id}`)) preparedExtensionInputs.delete(id)
          for (const id of [...dynamicExtensionIds]) {
            if (wanted.has(`ext:${id}`)) continue
            dynamicExtensionIds.delete(id)
            builtin.claims = Object.freeze(builtin.claims.filter((claim) => claim.row.id !== `ext:${id}`))
          }
          return report
        } catch (error) {
          builtin.hostExtensionRows = previous
          const retained = new Set(previous.map((row) => row.id))
          for (const id of dynamicExtensionIds) if (!retained.has(`ext:${id}`)) dynamicExtensionIds.delete(id)
          throw error
        }
      },
    })
    ctx.live.extensionRows.set(extensionRows)
    let skillRefreshTail: Promise<void> = Promise.resolve()
    let skillRetry = 0
    const refreshSkillRow = (fresh: SkillRuntimeInput | undefined): Promise<void> => {
      const supplied = fresh
      fresh = compositionSkills(fresh, ctx.profile.composition ?? {}, skillOwners)
      const task = skillRefreshTail.then(async () => {
        const previousRows = extensionRows.current()
        const consumers = previousRows.filter((row) => row.liveResources?.includes('skills'))
        const revision = skillRowRevision(fresh)
        const statusFor = (row: EntryRow) =>
          builtinRows.statusEntries().find(({ status }) => status.id === row.id.slice('ext:'.length))?.status
        const changed = consumers.filter(
          (row) =>
            !row.disabled &&
            (!statusFor(row)?.loaded ||
              (row.liveResourceRevision !== revision &&
                !row.liveResourceRevision?.startsWith(`${revision}:retry`))),
        )
        const oldInput = skillState.active
        const oldAvailable = skillState.available
        const oldPrepared = new Map(preparedExtensionInputs)
        const oldClaims = builtin.claims
        try {
          const replacements = new Map(
            changed.map((row) => {
              const extensionId = row.id.slice('ext:'.length)
              return [
                row.id,
                prepareExtensionRow({
                  ...oldPrepared.get(extensionId),
                  extensionId,
                  entryRevision: row.entryRevision,
                  liveResourceRevision:
                    row.liveResourceRevision === revision ? `${revision}:retry${++skillRetry}` : revision,
                  ...(row.config === undefined ? {} : { config: row.config }),
                  disabled: row.disabled,
                  skillResources: fresh,
                }),
              ]
            }),
          )
          if (changed.length)
            await extensionRows.apply(withSkillRows(previousRows, [...replacements.values()]))
          for (const row of changed) {
            const status = statusFor(row)
            if (!status?.loaded)
              throw new HostError('E_EXT_LOAD', 'Live resource consumer failed to load', {
                detail: { id: row.id, ...(status?.error ? { error: status.error.code } : {}) },
              })
          }
          skillState.active = fresh
          skillState.preload = fresh
          skillState.available = supplied
        } catch (error) {
          try {
            builtin.claims = oldClaims
            preparedExtensionInputs.clear()
            for (const [id, input] of oldPrepared) preparedExtensionInputs.set(id, input)
            await extensionRows.apply(previousRows)
            skillState.active = oldInput
            skillState.preload = oldInput
            skillState.available = oldAvailable
          } catch (restoreError) {
            throw new AggregateError([error, restoreError], 'Live resource refresh recovery required')
          }
          throw error
        }
      })
      skillRefreshTail = task.then(
        () => undefined,
        () => undefined,
      )
      return task
    }
    // ==== end ext: rows ====
    const reloadEcosystemExtension = async (
      id: string,
      freshInit: Readonly<{ skillResources?: SkillRuntimeInput }>,
    ): Promise<ExtensionStatus> => {
      if (
        extensionRows.current().some((row) => row.id === `ext:${id}` && row.liveResources?.includes('skills'))
      ) {
        await refreshSkillRow(freshInit.skillResources)
        const status = builtinRows.statusEntries().find(({ status }) => status.id === id)?.status
        if (!status) throw new HostError('E_EXT_LOAD', 'Skills row has no status')
        return status
      }
      throw new HostError('E_EXT_LOAD', `${id} is not a reloadable bundled ecosystem extension`, {
        detail: { id },
      })
    }
    rollback.push('extensions', () => managed.disposeAll())
    // A row that replaced a builtin row's extension (or the builtin coming back) evicts the
    // incumbent without waiting for its wind-down (`ExtensionOwners.claim`); the eviction still runs
    // to completion in the background. Left unawaited, `Host.close()` could return with an isolated
    // child still alive, and repeated replacements during the session's life would accumulate
    // children no one ever reaps. This runs last (LIFO), after the tree and every extension have
    // been torn down, so it also catches whatever the teardown itself just evicted.
    rollback.push('extension-evictions', () => extensionOwners.settled())
    // Teardown runs last-in-first-out. The tree's ext: rows revoke their extensions when they are
    // torn down, so the tree has to go before the extension host does, or every revoke fails.
    // Closing twice is a no-op, so the earlier registration still covers a half-finished assembly.
    rollback.push('runtime-target-tree', () => runtimeTargetPublisher.close())

    const extensionStatus = () =>
      mergeExtensionStatus(
        [managed.statusEntries(), rowExtensions.statusEntries(), builtinRows.statusEntries()],
        rowExtensions.replacedBy,
      )
    // 10 ready
    say('host.ready', { hash: ctx.profile.hash, extensions: extensionStatus().length })
    const servicesInvocation = serviceInvoker({
      authorize: async (entry, params, actor, workspace, signal) => {
        if (
          entry.owner === 'agnes/jobs-web' &&
          entry.capability.name === 'jobs.control' &&
          params.input &&
          typeof params.input === 'object' &&
          !Array.isArray(params.input) &&
          ['open', 'send'].includes(String(params.input.operation))
        )
          await authorizeServiceProcess(
            kernel.get(params.sessionId),
            {
              actor,
              session: {
                key: params.sessionId,
                lane: 'main',
                workspaceRoot: workspace.root,
                turn: 0,
                step: 0,
              },
              requestId: params.commandId ?? 'inspection',
              signal,
            },
            workspace.root,
          )
      },
      registry: services,
      ...(deps.serviceAuthority ? { authority: deps.serviceAuthority } : {}),
      principals: seams.principals,
      audit: deps.audit,
      signal: ac.signal,
      context: serviceContext({
        authorizeProcess: (identity, cwd) =>
          authorizeServiceProcess(kernel.get(identity.session?.key ?? ''), identity, cwd),
        seams,
        networkAllow: Object.freeze([...adapters.fs.fence().networkAllow]),
        log: deps.log,
      }),
    })
    const sessionConfiguration = createConfigurationService({
      home: deps.homeDir ?? dirname(dirname(deps.profileDir)),
      profile: ctx.profile.name,
      profileDir: deps.profileDir,
    })
    return {
      memory,
      activationBarrier,
      approvalGrants: approvalGrantControl.management,
      callService: servicesInvocation.call,
      inspectService: servicesInvocation.inspect,
      prepareService: servicesInvocation.prepare,
      callPreparedService: servicesInvocation.callPrepared,
      inspectPreparedService: servicesInvocation.inspectPrepared,
      kernel,
      seams,
      get provider() {
        return providerStage.provider
      },
      get providerFingerprint() {
        return providerStage.providerFingerprint
      },
      get routes() {
        return providerStage.routes
      },
      get preconfiguredRoutes() {
        return providerStage.preconfiguredRoutes
      },
      observeSession,
      ...(observability ? { observability } : {}),
      ...(deps.referenceLimits ? { referenceLimits: deps.referenceLimits } : {}),
      providers: { catalog: () => pluginTree.root.providers.catalog() },
      modelAdapterCatalog: () => modelAdapterCatalog(pluginTree.root),
      sessionPresetDefault: async () => (await sessionConfiguration.sessionDefaults()).defaults.preset,
      sessionLoopDefault: () => readAdminLoopDefault(sessionConfiguration),
      sessionModelSlots: async () => (await sessionConfiguration.modelSlots()).slots,
      compactionEngineCatalog: () => compactionEngineCatalog(pluginTree.root),
      childAgentCatalog: () => childAgentCatalog(pluginTree.root),
      compositionForPreset,
      sessionCapabilities,
      applyModelProfile,
      presets,
      runtimes,
      adapters,
      lockedPackageMutations,
      computerUse: computerUse.status,
      get computerUseArtifactGc() {
        return computerUse.artifactGc()
      },
      pluginTree,
      intelligentUi,
      extHost: managed,
      extensionStatus,
      rollback,
      defaultPreset: { view, hash: defaultPreset.hash },
      openWorkspaceRuntime,
      reloadEcosystemExtension,
      extensionRows,
      refreshSkillRow,
      ordinaryReconciliation,
      ordinaryConvergence: () => {
        const report = runtimeTargetPublisher.current().value.current?.report
        if (!report) {
          throw new HostError('E_EXT_LOAD', 'runtime target publisher produced no report', {
            detail: { reason: 'runtime-target-unpublished' },
          })
        }
        return report
      },
      publicationDispatch,
      applyRuntimeTarget,
      runtimeTargetSnapshot: () => {
        const target = runtimeTargetPublisher.current().value.current?.target
        if (!target) throw new Error('E_GENERATION_TARGET_MISSING: no published target')
        return target
      },
      bindRuntimeSession,
      unbindRuntimeSession,
      ...(systemPromptProvider ? { systemPromptProvider } : {}),
      sessionPresetLimits: () => ({
        limits: ctx.profile.limits,
        park: businessLimit(hotPolicy, 'approval.park'),
      }),
    }
  } catch (e) {
    return failAssembly(ctx, e)
  }
}
