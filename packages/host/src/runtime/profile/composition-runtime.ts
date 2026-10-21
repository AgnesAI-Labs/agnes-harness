import { dirname } from 'node:path'
import { CoreError } from '@agnes/core'
import { HostError } from '@agnes/host-common/errors'
import { resolvePreset } from '@agnes/host-common/presets/resolve'
import {
  loopPatch,
  type ResolvedComposition,
  resolveComposition,
} from '@agnes/host-common/profile/composition'
import { modelProfileDeployment } from '@agnes/host-common/profile/model-compatibility'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import { readAdminLoopDefault } from '@agnes/host-providers/assemble/loop-selection'
import {
  type CompositionBinding,
  CompositionSessionStore,
  createLiveCompositionWriter,
} from '@agnes/host-providers/profile/composition-state'
import {
  pluginSnapshotIdentity,
  RuntimePluginCatalogue,
} from '@agnes/host-providers/runtime-plugin-catalogue'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import { RuntimeGenerationSnapshotStore, withPackageVerification } from '@agnes/package-manager'
import type { PluginRow, RuntimeTarget } from '@agnes/plugin-runtime/host'
import { createRuntimeGenerationHost, type PluginGenerationStatus } from '../generation/host.js'
import { projectGenerationStatus } from '../generation/runtime-descriptor.js'
import { translateSessionFailure } from '../generation/seam-pins.js'
import { liveResourceRow, pluginWorkspaceLayers } from '../generation/target-code.js'
import { assertGenerationTrust } from '../generation/trust.js'
import { combinedSecurityStatus } from '../lifecycle/admin-security-status.js'
import type { Host, HostOptions } from '../lifecycle/host.js'
import {
  assertHostPublication,
  createHostFacade,
  type HostPublicationReport,
} from '../lifecycle/host-facade.js'
import { collectIdleContainers, createHostCallQueue, generationIdleMs } from '../lifecycle/host-idle.js'
import {
  createKernelFacade,
  createSessionMapFacade,
  type HostFacadeOverrides,
} from '../lifecycle/host-routing.js'
import { sessionHostRoutes } from '../lifecycle/session-host-routes.js'
import { sessionKey } from '../sessions/session.js'
import {
  activeAgentPackages,
  assertAgentRequest,
  createAgentResolver,
  sessionAdmission,
  verifyAgentPin,
} from './agent-plan.js'
import { compositionPresets } from './composition-presets.js'
import {
  type CompositionContainer as Container,
  profileForComposition,
  projectCompositionRows,
} from './composition-selection.js'
import { mergeCompositionStatuses } from './composition-status.js'
import { modelCatalogPublisher } from './model-catalog-publication.js'
import { lazyRoleChildren } from './role-children.js'
import { admitSessionBundlePresets } from './session-bundle-presets.js'
import { resolveSessionCapabilities } from './session-capabilities.js'
import { describeCapabilitySession } from './session-capability-view.js'

type Factory = (profile: ResolvedProfile, options: HostOptions) => Promise<Host>

/** Composition selects a container; W7 continues to own generations, leases and durable pins. */
export async function createCompositionHost(
  profile: ResolvedProfile,
  options: HostOptions,
  factory: Factory,
): Promise<Host> {
  const legacyPublication =
    !profile.composition && !profile.bundlePresets && !Object.keys(profile.bundleCatalog ?? {}).length
  const store = new CompositionSessionStore(options.profileDir)
  const configuration = createConfigurationService({
    home: options.homeDir ?? dirname(dirname(options.profileDir)),
    profile: profile.name,
    profileDir: options.profileDir,
  })
  const generations = new RuntimeGenerationSnapshotStore(options.profileDir)
  store.sweepOrphans((digest) => generations.pinFileState(digest))
  const containers = new Map<string, Container>()
  const builtinRows = new WeakMap<Host, readonly PluginRow[]>()
  const opening = new Map<string, Promise<Container>>()
  const openingFailures = new Map<string, string>()
  const idleSince = new Map<Container, number>()
  const idleMs = generationIdleMs(profile.limits)
  const sessionOwners = new Map<string, Container>()
  let trustedPackages = new Set(
    (options.runtimePluginSnapshots ?? options.runtimePluginCatalogue ?? [])
      .filter((source) => source.trusted)
      .map((source) => source.snapshot.packageId),
  )
  const refreshTrust = async () => {
    trustedPackages = new Set(
      (
        (await options.runtimePluginSources?.()) ??
        options.runtimePluginSnapshots ??
        options.runtimePluginCatalogue ??
        []
      )
        .filter((source) => source.trusted)
        .map((source) => source.snapshot.packageId),
    )
  }
  const prepared = new Map<string, Parameters<Host['extensionRows']['prepare']>[0]>()
  let currentSkills = options.skillResources
  let modelProfile = profile
  let lastPublication: HostPublicationReport | undefined
  const presets = await compositionPresets(profile, options)
  let closed = false
  let closing: Promise<void> | undefined
  const calls = createHostCallQueue(() => closed)
  let bootTarget: Host['runtimeTargetSnapshot']
  let latestTarget: RuntimeTarget | undefined
  let latestRows: Parameters<Host['extensionRows']['apply']>[0] | undefined
  const writer = await createLiveCompositionWriter(options.profileDir)
  const projectRows = <T extends RuntimeTarget['tree']['rows'][number]>(
    rows: readonly T[],
    tree: ResolvedComposition,
    host?: Host,
  ): T[] =>
    projectCompositionRows(
      rows,
      tree,
      host,
      host ? (builtinRows.get(host) ?? []) : [],
      [...containers.values()].flatMap((container) => builtinRows.get(container.host) ?? []),
    )
  const draining = (rows: readonly PluginRow[], tree: ResolvedComposition, host?: Host) => {
    const loop = tree.selection.loop
    const source =
      loop &&
      host?.kernel.loops.catalog().find((entry) => entry.id === loop.id && entry.version === loop.version)
        ?.sourcePackage
    // Only a removed package-provided selected loop makes this composition dormant.
    // Bundles containing solely live resources need no retained code container.
    return (
      !!source &&
      trustedPackages.has(source) &&
      (tree.toolScope?.activePackages ?? []).includes(source) &&
      !rows.some((row) => !row.disabled && pluginSnapshotIdentity(row.plugin)?.packageId === source)
    )
  }
  const project = (target: RuntimeTarget, tree: ResolvedComposition, host?: Host): RuntimeTarget => {
    const previous = host?.runtimeTargetSnapshot?.()
    // A disabled bundle has no new-session container. Retained sessions still need its exact
    // loop/provider code; publish only live resources until the bundle becomes eligible again.
    if (previous && draining(target.tree.rows, tree, host))
      return buildCompleteRuntimeTarget({
        rows: [
          ...previous.tree.rows.filter((row) => !liveResourceRow(row)),
          ...projectRows(
            [...target.tree.rows, ...Object.values(target.resource.rows).filter((row) => row !== null)],
            tree,
            host,
          ).filter(liveResourceRow),
        ],
        resources: target.resource.resources,
      }).target
    return buildCompleteRuntimeTarget({
      rows: projectRows(
        [...target.tree.rows, ...Object.values(target.resource.rows).filter((row) => row !== null)],
        tree,
        host,
      ),
      resources: target.resource.resources,
    }).target
  }
  const containerKey = (binding: CompositionBinding) => `${binding.tree.hash}:${binding.profile.hash}`
  const open = async (binding: CompositionBinding): Promise<Container> => {
    const identity = containerKey(binding)
    const found = containers.get(identity)
    if (found) {
      idleSince.delete(found)
      return found
    }
    const pending = opening.get(identity)
    if (pending) return pending
    let attemptedGeneration: string | undefined
    const started = (async () => {
      const target = latestTarget ?? bootTarget?.()
      const pinned = generations.session(binding.sessionKey)
      attemptedGeneration = pinned?.generationId
      const skills = currentSkills
      // A newly opened composition must not import boot-time pins retired by a later update.
      // Existing sessions bootstrap from their own durable code snapshot instead.
      const sources = pinned
        ? (await generations.readAsync(pinned.generationId)).sources
        : target
          ? new RuntimePluginCatalogue(
              (await options.runtimePluginSources?.()) ??
                options.runtimePluginCatalogue ??
                options.runtimePluginSnapshots ??
                [],
            ).select(project(target, binding.tree))
          : options.runtimePluginSnapshots
      if (sources)
        await assertGenerationTrust(
          sources,
          options.profileDir,
          profile.name,
          options.agnesVersion ?? '0.0.0',
          options.runtimePluginSources,
        )
      const deployment = {
        ...binding.profile,
        ...(sources
          ? {
              packages: [
                // Unselected packages remain composition vocabulary, without executable authority.
                // Match cold generation restoration: only selected sources may enable their code.
                ...binding.profile.packages
                  .filter(
                    (pkg) =>
                      pkg.trust === 'builtin' ||
                      !sources.some((source) => source.snapshot.packageId === pkg.id),
                  )
                  .map((pkg) => (pkg.trust === 'builtin' ? pkg : { ...pkg, enabled: false })),
                ...sources.map(({ snapshot }) => ({
                  ...binding.profile.packages.find((pkg) => pkg.id === snapshot.packageId),
                  id: snapshot.packageId,
                  version: snapshot.version,
                  integrity: snapshot.integrity,
                  source: 'runtime-snapshot',
                  trust: 'trusted' as const,
                  enabled: true,
                })),
              ],
            }
          : {}),
        provider: modelProfile.provider,
        adapters: { ...binding.profile.adapters, secrets: modelProfile.adapters.secrets },
      }
      const host = await createRuntimeGenerationHost(
        binding.legacy ? deployment : profileForComposition(deployment, binding.tree),
        {
          ...options,
          compositionPin: binding.tree,
          ...(pinned && binding.sessionKey ? { retainedModelBootstrap: true } : {}),
          ...(binding.sessionKey ? { profileAuthorityPublication: 'retained' as const } : {}),
          ...(target && !pinned
            ? {
                ordinaryPluginLayers: pluginWorkspaceLayers(
                  projectRows(target.tree.rows, binding.tree),
                  options.ordinaryPluginLayers,
                ),
              }
            : {}),
          ...(sources
            ? {
                runtimePluginSnapshots: sources,
                packageDirs: new Map([
                  ...(options.packageDirs ?? []),
                  ...sources.map(({ snapshot }) => [snapshot.packageId, snapshot.directory] as const),
                ]),
              }
            : {}),
          ...(skills ? { skillResources: skills } : {}),
        },
        (generationProfile, generationOptions) =>
          factory(generationProfile, {
            ...generationOptions,
            childRoles: lazyRoleChildren(() => ({
              host: () => host,
              configuration,
              admission,
              resolve: prepareAgent,
              containers,
              sessionOwners,
              read: (key) => store.readIfValid(key),
              pin: (binding) => store.pin(binding),
              open,
            })),
            onGenerationSessionBinding: (key) => {
              // Includes children opened by Core directly, through the same generation callback.
              store.pin({ ...binding, sessionKey: key })
              generationOptions.onGenerationSessionBinding?.(key)
            },
          }),
        pinned?.generationId,
      )
      builtinRows.set(
        host,
        [...(host.runtimeTargetSnapshot?.()?.tree.rows ?? []), ...host.extensionRows.current()].filter(
          (row) => row.plugin.startsWith('builtin:'),
        ),
      )
      try {
        const rows = new Map(host.extensionRows.current().map((row) => [row.id, row]))
        for (const input of prepared.values()) {
          // A restored composition keeps its code pin, but must seed current resource factories.
          const dynamic =
            pinned && input.dynamic?.generation?.kind === 'mcp-server' && options.restoreGenerationExtension
              ? await options.restoreGenerationExtension(input.dynamic.generation)
              : input.dynamic
          const row = host.extensionRows.prepare({ ...input, ...(dynamic ? { dynamic } : {}) })
          rows.set(row.id, row)
        }
        if (target) {
          const report = await host.applyRuntimeTarget(project(target, binding.tree, host))
          assertHostPublication(report.publication)
          if (!report.ok) throw new Error('E_COMPOSITION_PUBLICATION: new container did not converge')
        }
        const selectedRows = latestRows ?? (prepared.size ? [...rows.values()] : undefined)
        if (selectedRows) {
          const report = await host.extensionRows.apply(projectRows(selectedRows, binding.tree, host))
          assertHostPublication(report.publication)
          if (!report.ok) throw new Error('E_COMPOSITION_PUBLICATION: new container rows did not converge')
        }
        const container = {
          host,
          tree: binding.tree,
          draining: target ? draining(target.tree.rows, binding.tree, host) : false,
        }
        containers.set(identity, container)
        if (attemptedGeneration) openingFailures.delete(attemptedGeneration)
        return container
      } catch (error) {
        await host.close()
        throw error
      }
    })()
    opening.set(identity, started)
    try {
      return await started
    } catch (error) {
      // Direct cold bootstrap can fail before a generation Host exists to record its refusal.
      // Keep that failure visible without creating a throwaway container just for diagnostics.
      if (attemptedGeneration)
        openingFailures.set(
          attemptedGeneration,
          String(error).match(/E_[A-Z0-9_]+/)?.[0] ?? 'Plugin generation failed; inspect local logs.',
        )
      throw error
    } finally {
      opening.delete(identity)
    }
  }
  const { current: bootProfile } = await sessionAdmission(
    profile,
    modelProfile,
    { ...options, runtimePluginSources: async () => options.runtimePluginSnapshots ?? [] },
    undefined,
  )
  let displayedBundles = bootProfile.bundleCatalog
  const initialTree = resolveComposition(
    { ...profile, bundleCatalog: bootProfile.bundleCatalog },
    {
      preset: resolvePreset(profile.presets.default, presets, { limits: profile.limits }).doc,
      packageCatalog: bootProfile.packages,
    },
  )
  const initial = await open({
    sessionKey: '',
    tree: initialTree,
    profile: profileForComposition(bootProfile, initialTree),
  }).catch((error) => {
    writer.close()
    throw error
  })
  bootTarget = initial.host.runtimeTargetSnapshot
  const owner = (key: string, coldRead = true): Container => {
    const binding = store.readIfValid(key)
    const active = binding
      ? containers.get(containerKey(binding))
      : (sessionOwners.get(key) ??
        [...containers.values()].find((container) => container.host.kernel.get(key)))
    if (active) return active
    if (binding && !coldRead) throw new Error('E_COMPOSITION_NOT_LIVE: open the bound session first')
    // Shared storage and cold descriptors need no live container; deletion tolerates damaged pins.
    return initial
  }
  const live = () => {
    const sessions = new Map([...containers.values()].flatMap(({ host }) => [...host.kernel.sessions]))
    return [...sessions.values()].map((session) => {
      const container = owner(session.key)
      return describeCapabilitySession(container.host, session, container.tree, profile.bundleCatalog)
    })
  }
  const publish = () => {
    try {
      writer.write(live())
    } catch {
      options.log.warn('Composition live status could not be written')
    }
  }
  const statusTimer = setInterval(() => {
    publish()
    scheduleCollection()
  }, 1000)
  statusTimer.unref()
  const convergence = (target = latestTarget) => {
    const reports = [...containers.values()].map(({ host, draining }) => {
      const report = host.ordinaryConvergence()
      return !draining
        ? report
        : {
            ...report,
            rows: report.rows.filter((row) =>
              host.extensionRows
                .current()
                .some(
                  (entry) => entry.id === row.id && (!!entry.liveResources?.length || liveResourceRow(entry)),
                ),
            ),
          }
    })
    const rows = new Map(reports.flatMap((report) => report.rows.map((row) => [row.id, row] as const)))
    for (const report of reports)
      for (const row of report.rows) if (row.state === 'failed') rows.set(row.id, row)
    // The deployment target is the input catalog. Each container reports its derived row tree;
    // acknowledge that input only when every composition has converged, retaining any row failure.
    return {
      hash: target?.tree.hash ?? reports[0]!.hash,
      ok: reports.every((report) => report.ok) && lastPublication?.ok !== false,
      ...(lastPublication ? { publication: lastPublication } : {}),
      rows: [...rows.values()],
    }
  }
  const collectIdle = () => collectIdleContainers(containers, initial, idleSince, idleMs)
  let collectionQueued = false
  const scheduleCollection = () => {
    if (closed || collectionQueued) return
    collectionQueued = true
    void calls
      .enqueue(collectIdle)
      .catch((error) => options.log.warn('Composition collection failed', { error: String(error) }))
      .finally(() => {
        collectionQueued = false
      })
  }
  const broadcast = async (
    operation: HostPublicationReport['operation'],
    apply: (container: Container) => Promise<unknown>,
  ): Promise<HostPublicationReport> => {
    const results: HostPublicationReport['containers'][number][] = []
    let failure: unknown
    for (const container of containers.values()) {
      try {
        const report = await apply(container)
        if (report && typeof report === 'object' && 'ok' in report && report.ok === false)
          throw new Error('Container did not converge; inspect ordinaryConvergence for row failures')
        results.push({ compositionHash: container.tree.hash, status: 'applied' })
      } catch (error) {
        failure ??= error
        results.push({ compositionHash: container.tree.hash, status: 'failed', error: String(error) })
      }
    }
    lastPublication = Object.freeze({
      operation,
      ok: results.every((result) => result.status === 'applied'),
      recovery: 'retry-same-input',
      containers: Object.freeze(results.map((result) => Object.freeze(result))),
    })
    // Live-source admission adds composition isolation without changing legacy publication errors.
    if (legacyPublication && failure) throw failure
    return lastPublication
  }
  const publishAdapters = modelCatalogPublisher(initial.host, options, () => modelProfile)
  await publishAdapters()
  const sessions = createSessionMapFacade(
    initial.host.kernel.sessions,
    (key) => owner(key).host.kernel.sessions,
    () => [...containers.values()].map(({ host }) => host.kernel.sessions),
  )
  const kernel = createKernelFacade(
    initial.host.kernel,
    () => initial.host.kernel,
    (key, coldRead = false) => owner(key, coldRead).host.kernel,
    sessions,
  )
  const admission = (
    rows = latestTarget?.tree.rows ?? initial.host.runtimeTargetSnapshot?.()?.tree.rows ?? [],
  ) => sessionAdmission(profile, modelProfile, options, activeAgentPackages(rows))
  const prepareAgent = createAgentResolver({
    admission,
    host: initial.host,
    packageDirs: options.packageDirs ?? new Map(),
    adminLoop: () => readAdminLoopDefault(configuration),
    open,
  })
  const mergeGenerationStatuses = (statuses: readonly PluginGenerationStatus[]) =>
    mergeCompositionStatuses(statuses, containers.values(), openingFailures)
  const overrides: HostFacadeOverrides = {
    resolveAgent: (ref) => calls.enqueue(async () => (await prepareAgent(ref)).plan),
    // The published catalog is descriptive. Actual session admission still verifies current sources.
    sessionBundleCatalog: async () => displayedBundles,
    ...sessionHostRoutes(
      (key, coldRead = false) => owner(key, coldRead).host,
      () => initial.host,
      () => initial.host,
    ),
    kernel,
    runtimeTargetSnapshot: () => latestTarget ?? initial.host.runtimeTargetSnapshot!(),
    ordinaryConvergence: () => convergence(),
    compositionSessions: live,
    securityStatus: () => {
      const initialStatus = initial.host.securityStatus?.()
      if (!initialStatus) throw new Error('Security status is unavailable')
      return combinedSecurityStatus(
        initialStatus,
        [...containers.values()].flatMap(({ host }) => host.securityStatus?.() ?? []),
      )
    },
    compositionPublicationStatus: () => lastPublication,
    createSession: (input) =>
      calls.enqueue(() =>
        withPackageVerification(async () => {
          const key =
            input.key ??
            input.binding?.sessionKey ??
            sessionKey(
              profile,
              await initial.host.resolveActor(input.credential ?? { kind: 'local' }, 'session'),
              input.cwd ?? options.workspaceRoot,
            )
          try {
            const agent = input.agent !== undefined ? await prepareAgent(input.agent) : undefined
            let binding = store.read(key)
            assertAgentRequest(input, agent, binding)
            if (!binding && agent)
              binding = store.pin({ sessionKey: key, tree: agent.tree, profile: agent.profile })
            if (!binding) {
              const parent = input.parent ? store.read(input.parent.key) : undefined
              const { current: admissionProfile } = await admission()
              const adminLoop = parent ? undefined : await readAdminLoopDefault(configuration)
              const admitted = admitSessionBundlePresets(admissionProfile, initial.host, parent ? {} : input)
              const tree =
                parent?.tree ??
                resolveComposition(
                  { ...profile, ...admitted.scope },
                  {
                    packageCatalog: admissionProfile.packages,
                    preset: admitted.preset,
                    ...(adminLoop ? { admin: { composition: loopPatch(adminLoop) } } : {}),
                    ...(input.loop ? { session: loopPatch(input.loop) } : {}),
                    ...(input.bundles !== undefined ? { sessionBundles: input.bundles } : {}),
                  },
                )
              const selectedLoop = resolveSessionCapabilities({ composition: tree }).loop.value
              if (
                !parent &&
                selectedLoop &&
                !initial.host.kernel.loops
                  .catalog()
                  .some((entry) => entry.id === selectedLoop.id && entry.version === selectedLoop.version)
              )
                throw new CoreError('E_LOOP_MISSING', 'The selected loop is unavailable.', {
                  loop: selectedLoop,
                })
              binding = store.pin({
                sessionKey: key,
                tree,
                profile: parent?.profile ?? profileForComposition(admitted.profile, tree),
              })
            }
            if (
              input.bundles !== undefined &&
              JSON.stringify(input.bundles) !== JSON.stringify(binding.tree.sessionBundles)
            )
              throw new HostError('E_PRESET_UNSUPPORTED', 'session bundle selection is immutable')
            try {
              const container = await open(binding)
              if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed')
              const loop = generations.session(key)?.loop ?? binding.tree.selection.loop
              if (input.loop && loop && (input.loop.id !== loop.id || input.loop.version !== loop.version))
                throw new Error(
                  'E_GENERATION_LOOP_INCOMPATIBLE: requested loop differs from the session composition',
                )
              const session = await container.host.createSession({
                ...input,
                ...(agent ? { strict: true } : {}),
                key,
                preset: binding.tree.preset,
                ...(binding.tree.selection.loop ? { loop: binding.tree.selection.loop } : {}),
              })
              if (agent) await verifyAgentPin(agent, session, binding.tree.hash, prepareAgent, container.host)
              sessionOwners.set(key, container)
              if (session.pluginGenerationId) openingFailures.delete(session.pluginGenerationId)
              const close = session.close.bind(session)
              session.close = async () => {
                try {
                  await close()
                } finally {
                  sessionOwners.delete(key)
                  scheduleCollection()
                  publish()
                }
              }
              publish()
              return session
            } catch (error) {
              if (!generations.session(key)) store.release(key)
              throw error
            }
          } catch (error) {
            throw translateSessionFailure(error, key)
          }
        }),
      ),
    releaseSessionGeneration: (key) =>
      calls.enqueue(async () => {
        const container = owner(key)
        await container.host.releaseSessionGeneration?.(key)
        store.release(key)
        sessionOwners.delete(key)
        await collectIdle()
        publish()
      }),
    migrateSessionGeneration: (key, context) =>
      calls.enqueue(async () => {
        const binding = store.read(key)
        if (!binding) {
          // Pre-composition durable generation pins retain the generation owner's migration checks.
          if (!initial.host.migrateSessionGeneration) throw new Error('E_GENERATION_MIGRATION_UNAVAILABLE')
          return initial.host.migrateSessionGeneration(key, context)
        }
        const container = await open(binding)
        if (container.draining) throw new Error('E_GENERATION_LOOP_INCOMPATIBLE: session bundle is disabled')
        if (!container.host.migrateSessionGeneration) throw new Error('E_GENERATION_MIGRATION_UNAVAILABLE')
        const result = await container.host.migrateSessionGeneration(key, context)
        publish()
        return result
      }),
    collectPluginGenerations: () =>
      calls.enqueue(async () => {
        for (const { host } of containers.values()) await host.collectPluginGenerations?.()
        await collectIdle()
      }),
    pluginGenerationStatus: () =>
      mergeGenerationStatuses(
        [...containers.values()].map((container) =>
          projectGenerationStatus(container.host.pluginGenerationStatus!(), container.draining),
        ),
      ),
    pluginGenerationStatusAsync: async () => {
      const statuses: PluginGenerationStatus[] = []
      // Bound each Host's historical reads before combining compositions.
      for (const container of containers.values()) {
        const status = container.host.pluginGenerationStatusAsync
          ? await container.host.pluginGenerationStatusAsync()
          : container.host.pluginGenerationStatus?.()
        if (!status) throw new Error('Plugin generation status is unavailable')
        statuses.push(projectGenerationStatus(status, container.draining))
      }
      return mergeGenerationStatuses(statuses)
    },
    setSessionPreset: (key, name) =>
      calls.enqueue(async () => {
        const result = await owner(key, false).host.setSessionPreset(key, name)
        publish()
        return result
      }),
    applyRuntimeTarget: (target) =>
      calls.enqueue(async () => {
        await refreshTrust()
        const { current: nextCatalog } = await admission(target.tree.rows)
        const publication = await broadcast('runtime-target', async (container) => {
          const report = await container.host.applyRuntimeTarget(
            project(target, container.tree, container.host),
          )
          container.draining = draining(target.tree.rows, container.tree, container.host)
          return report
        })
        if (publication.ok) {
          latestTarget = target
          displayedBundles = nextCatalog.bundleCatalog
          latestRows = undefined
          await publishAdapters()
        }
        return convergence(target)
      }),
    refreshSkillRow: (fresh) =>
      calls.enqueue(async () => {
        currentSkills = fresh
        return broadcast('skills', (container) => container.host.refreshSkillRow(fresh))
      }),
    reloadEcosystemExtension: async (id, input) => {
      if (
        !initial.host.extensionRows
          .current()
          .some((row) => row.id === `ext:${id}` && row.liveResources?.includes('skills'))
      )
        return initial.host.reloadEcosystemExtension(id, input)
      assertHostPublication(await overrides.refreshSkillRow!(input.skillResources))
      const result = initial.host.extensions().find((entry) => entry.id === id)
      if (!result) throw new Error('E_COMPOSITION_RESOURCE: Live resource consumer has no status')
      return result
    },
    applyModelProfile: (next) =>
      calls.enqueue(async () => {
        const deployment = modelProfileDeployment(next)
        if (
          ![profile, modelProfile, ...[...containers.values()].map(({ host }) => host.profile)].some(
            (current) => modelProfileDeployment(current) === deployment,
          )
        )
          throw new HostError('E_SEAM_IMMUTABLE', 'non-model configuration requires restart')
        modelProfile = next
        const report = await broadcast('models', (container) =>
          container.host.applyModelProfile(
            profileForComposition(
              {
                ...container.host.profile,
                provider: next.provider,
                adapters: { ...container.host.profile.adapters, secrets: next.adapters.secrets },
              },
              container.tree,
            ),
          ),
        )
        if (report.ok) await publishAdapters()
        return report
      }),
    extensionRows: {
      ...initial.host.extensionRows,
      prepare: (input) => {
        prepared.set(input.extensionId, input)
        let result: ReturnType<Host['extensionRows']['prepare']> | undefined
        for (const container of containers.values()) {
          const row = container.host.extensionRows.prepare(input)
          if (container === initial) result = row
        }
        return result!
      },
      apply: (rows) =>
        calls.enqueue(async () => {
          await refreshTrust()
          const { current: nextCatalog } = await admission(rows)
          latestRows = rows
          const selected = new Set(rows.map((row) => row.id))
          for (const id of prepared.keys()) if (!selected.has(`ext:${id}`)) prepared.delete(id)
          const publication = await broadcast('extension-rows', async (container) => {
            const projected = projectRows(rows, container.tree, container.host)
            const inactive = draining(rows, container.tree, container.host)
            const report = await container.host.extensionRows.apply(
              inactive
                ? [
                    ...container.host.extensionRows.current().filter((row) => !liveResourceRow(row)),
                    ...projected.filter(liveResourceRow),
                  ]
                : projected,
            )
            container.draining = inactive
            return report
          })
          if (publication.ok) displayedBundles = nextCatalog.bundleCatalog
          return convergence()
        }),
    },
    close() {
      if (closing) return closing
      closed = true
      clearInterval(statusTimer)
      idleSince.clear()
      const hosts = new Map([...containers.values()].map(({ host }) => [host, host.close()]))
      for (const close of hosts.values()) void close.catch(() => undefined)
      closing = (async () => {
        await calls.drain()
        for (const { host } of containers.values()) if (!hosts.has(host)) hosts.set(host, host.close())
        const results = await Promise.allSettled(hosts.values())
        writer.close()
        const failed = results.find((result) => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      })()
      return closing
    },
  }
  return createHostFacade(initial.host, overrides)
}
