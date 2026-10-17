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
import { readRuntimeBundles } from '@agnes/host-providers/profile/bundles-reader'
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
import { RuntimeGenerationSnapshotStore } from '@agnes/package-manager'
import type { PluginRow, RuntimeTarget } from '@agnes/plugin-runtime/host'
import { createRuntimeGenerationHost, type PluginGenerationStatus } from '../generation/host.js'
import { mergeGenerationStatus } from '../generation/runtime-descriptor.js'
import { translateSessionFailure } from '../generation/seam-pins.js'
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
import { compositionPresets } from './composition-presets.js'
import { profileForComposition } from './composition-selection.js'
import { admitSessionBundlePresets, sessionBundleCatalog } from './session-bundle-presets.js'
import { capabilityEnabled, resolveSessionCapabilities } from './session-capabilities.js'
import { describeCapabilitySession } from './session-capability-view.js'

type Factory = (profile: ResolvedProfile, options: HostOptions) => Promise<Host>
type Container = { host: Host; tree: ResolvedComposition; draining?: boolean }

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
  const opening = new Map<string, Promise<Container>>()
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
  let latestTarget: RuntimeTarget | undefined
  let latestRows: Parameters<Host['extensionRows']['apply']>[0] | undefined
  const writer = await createLiveCompositionWriter(options.profileDir)
  const projectRows = <T extends RuntimeTarget['tree']['rows'][number]>(
    rows: readonly T[],
    tree: ResolvedComposition,
    host?: Host,
  ): T[] => {
    // Skills are live resources. A replayed target can carry a row from an earlier worker boot.
    // Use this container's prepared row so its mount identity matches its current importer.
    const consumers = new Map(
      host?.extensionRows
        .current()
        .filter((row) => row.liveResources?.length)
        .map((row) => [row.id, row]),
    )
    const candidates = rows.map((row) => {
      const live = consumers.get(row.id)
      return live && live.plugin === row.plugin && live.entryRevision === row.entryRevision
        ? (live as T)
        : row
    })
    const plugins = resolveSessionCapabilities({
      composition: tree,
      installed: {
        plugins: candidates.map((row) => ({
          id: row.id,
          enabled: !row.disabled,
          packageId:
            pluginSnapshotIdentity(row.plugin)?.packageId ??
            (row.plugin.startsWith('builtin:')
              ? row.plugin.slice('builtin:'.length, row.plugin.lastIndexOf('/'))
              : undefined),
        })),
      },
    }).plugins
    return candidates.map((row) => {
      const override = tree.selection.plugins?.[row.id]
      return Object.freeze({
        ...row,
        ...(override?.config === undefined ? {} : { config: override.config }),
        disabled: !capabilityEnabled(plugins, row.id),
      })
    })
  }
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
  const liveResource = (row: PluginRow) =>
    row.plugin.startsWith('builtin:@agnes/base/') && /^ext:agnes\/mcp-[a-z0-9-]+-[a-f0-9]{8}$/.test(row.id)
  const project = (target: RuntimeTarget, tree: ResolvedComposition, host?: Host): RuntimeTarget => {
    const previous = host?.runtimeTargetSnapshot?.()
    // A disabled bundle has no new-session container. Retained sessions still need its exact
    // loop/provider code; publish only live resources until the bundle becomes eligible again.
    if (previous && draining(target.tree.rows, tree, host))
      return buildCompleteRuntimeTarget({
        rows: [
          ...previous.tree.rows.filter((row) => !liveResource(row)),
          ...projectRows(
            [...target.tree.rows, ...Object.values(target.resource.rows).filter((row) => row !== null)],
            tree,
            host,
          ).filter(liveResource),
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
  const open = async (binding: CompositionBinding): Promise<Container> => {
    const found = containers.get(binding.tree.hash)
    if (found) {
      idleSince.delete(found)
      return found
    }
    const pending = opening.get(binding.tree.hash)
    if (pending) return pending
    const started = (async () => {
      const pinned = generations.session(binding.sessionKey)
      const skills = currentSkills
      // A newly opened composition must not import boot-time pins retired by a later update.
      // Existing sessions bootstrap from their own durable code snapshot instead.
      const sources = pinned
        ? generations.read(pinned.generationId).sources
        : latestTarget
          ? new RuntimePluginCatalogue(
              (await options.runtimePluginSources?.()) ??
                options.runtimePluginCatalogue ??
                options.runtimePluginSnapshots ??
                [],
            ).select(project(latestTarget, binding.tree))
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
                ...binding.profile.packages.filter((pkg) => pkg.trust === 'builtin' || !pkg.enabled),
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
          ...(binding.sessionKey ? { profileAuthorityPublication: 'retained' as const } : {}),
          ...(latestTarget && !pinned
            ? {
                ordinaryPluginLayers: {
                  ...options.ordinaryPluginLayers,
                  workspace: {
                    ...options.ordinaryPluginLayers?.workspace,
                    ...Object.fromEntries(
                      projectRows(latestTarget.tree.rows, binding.tree)
                        .filter((row) => pluginSnapshotIdentity(row.plugin))
                        .map((row) => [
                          row.id,
                          {
                            enabled: !row.disabled,
                            ...(row.config === undefined ? {} : { config: row.config }),
                          },
                        ]),
                    ),
                  },
                },
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
            onGenerationSessionBinding: (key) => {
              // Includes children opened by Core directly, through the same generation callback.
              store.pin({ ...binding, sessionKey: key })
              generationOptions.onGenerationSessionBinding?.(key)
            },
          }),
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
        if (latestTarget) {
          const report = await host.applyRuntimeTarget(project(latestTarget, binding.tree, host))
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
          draining: latestTarget ? draining(latestTarget.tree.rows, binding.tree, host) : false,
        }
        containers.set(binding.tree.hash, container)
        return container
      } catch (error) {
        await host.close()
        throw error
      }
    })()
    opening.set(binding.tree.hash, started)
    try {
      return await started
    } finally {
      opening.delete(binding.tree.hash)
    }
  }
  const initialTree = resolveComposition(profile, {
    preset: resolvePreset(profile.presets.default, presets, { limits: profile.limits }).doc,
  })
  const initial = await open({
    sessionKey: '',
    tree: initialTree,
    profile: profileForComposition(profile, initialTree),
  }).catch((error) => {
    writer.close()
    throw error
  })
  const owner = (key: string, coldRead = true): Container => {
    const binding = store.readIfValid(key)
    const active = binding
      ? containers.get(binding.tree.hash)
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
            rows: report.rows.filter(
              (row) =>
                !!host.extensionRows.current().find((entry) => entry.id === row.id)?.liveResources?.length ||
                /^ext:agnes\/mcp-[a-z0-9-]+-[a-f0-9]{8}$/.test(row.id),
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
  const enqueue = calls.enqueue
  const collectIdle = () => collectIdleContainers(containers, initial, idleSince, idleMs)
  let collectionQueued = false
  const scheduleCollection = () => {
    if (closed || collectionQueued) return
    collectionQueued = true
    void enqueue(collectIdle)
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
  const overrides: HostFacadeOverrides = {
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
      enqueue(async () => {
        const key =
          input.key ??
          input.binding?.sessionKey ??
          sessionKey(
            profile,
            await initial.host.resolveActor(input.credential ?? { kind: 'local' }, 'session'),
            input.cwd ?? options.workspaceRoot,
          )
        try {
          let binding = store.read(key)
          if (!binding) {
            const parent = input.parent ? store.read(input.parent.key) : undefined
            const sources =
              latestTarget && !parent
                ? new RuntimePluginCatalogue(
                    (await options.runtimePluginSources?.()) ??
                      options.runtimePluginCatalogue ??
                      options.runtimePluginSnapshots ??
                      [],
                  ).select(latestTarget)
                : []
            const admissionProfile = {
              ...profile,
              // Admission uses the published code catalog, including packages installed after boot.
              // Persist it with the composition so cold opens can mount its loop before Kernel creation.
              packages: [
                ...profile.packages.filter(
                  (pkg) => !sources.some((source) => source.snapshot.packageId === pkg.id),
                ),
                ...sources.map(({ snapshot, trusted }) => ({
                  ...profile.packages.find((pkg) => pkg.id === snapshot.packageId),
                  id: snapshot.packageId,
                  version: snapshot.version,
                  integrity: snapshot.integrity,
                  source:
                    profile.packages.find((pkg) => pkg.id === snapshot.packageId)?.source ??
                    'runtime-snapshot',
                  trust: 'trusted' as const,
                  enabled:
                    trusted &&
                    (profile.packages.find((pkg) => pkg.id === snapshot.packageId)?.enabled ?? true),
                })),
              ],
              bundleCatalog: sessionBundleCatalog(
                profile,
                latestTarget ? readRuntimeBundles(sources) : undefined,
              ),
            }
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
              key,
              preset: binding.tree.preset,
              ...(binding.tree.selection.loop ? { loop: binding.tree.selection.loop } : {}),
            })
            sessionOwners.set(key, container)
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
    releaseSessionGeneration: (key) =>
      enqueue(async () => {
        const container = owner(key)
        await container.host.releaseSessionGeneration?.(key)
        store.release(key)
        sessionOwners.delete(key)
        await collectIdle()
        publish()
      }),
    migrateSessionGeneration: (key, context) =>
      enqueue(async () => {
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
      enqueue(async () => {
        for (const { host } of containers.values()) await host.collectPluginGenerations?.()
        await collectIdle()
      }),
    pluginGenerationStatus: () => {
      const statuses = [...containers.values()].map(({ host, draining }) => {
        const status = host.pluginGenerationStatus!()
        return !draining
          ? status
          : {
              ...status,
              generations: status.generations.map((item) => ({
                ...item,
                state:
                  item.state === 'active'
                    ? item.openSessions > 0
                      ? ('draining' as const)
                      : ('historical' as const)
                    : item.state,
              })),
              plugins: status.plugins.map((item) => ({
                ...item,
                state:
                  item.state === 'active'
                    ? status.generations.some(
                        (generation) =>
                          generation.openSessions > 0 &&
                          generation.packages.some((pkg) => pkg.id === item.id),
                      )
                      ? ('draining' as const)
                      : ('historical' as const)
                    : item.state,
                drainingSessions: item.boundSessions,
                historicalSessions: status.generations
                  .filter((generation) => generation.packages.some((pkg) => pkg.id === item.id))
                  .reduce(
                    (count, generation) =>
                      count + Math.max(0, generation.boundSessions - generation.openSessions),
                    0,
                  ),
              })),
            }
      })
      const opened = new Map([...containers.values()].flatMap(({ host }) => [...host.kernel.sessions]))
      const all = new Map<string, PluginGenerationStatus['generations'][number]>()
      for (const status of statuses)
        for (const item of status.generations) {
          const previous = all.get(item.id)
          if (!previous) {
            all.set(item.id, item)
            continue
          }
          all.set(item.id, mergeGenerationStatus(previous, item, opened.values()))
        }
      const blocked = [
        ...new Map(statuses.flatMap((status) => status.blocked ?? []).map((i) => [i.file, i])).values(),
      ]
      return {
        ...statuses[0]!,
        ...(blocked.length ? { blocked } : {}),
        generations: [...all.values()],
        plugins: [
          ...new Map(
            statuses.flatMap((status) => status.plugins.map((item) => [item.id, item] as const)),
          ).values(),
        ].map((plugin) => {
          if (plugin.state === 'failed' || plugin.state === 'restart-required') return plugin
          const relevant = [...all.values()].filter((generation) =>
            generation.packages.some((pkg) => pkg.id === plugin.id),
          )
          return {
            ...plugin,
            state: relevant.some((generation) => generation.state === 'active')
              ? ('active' as const)
              : relevant.some((generation) => generation.openSessions > 0)
                ? ('draining' as const)
                : ('historical' as const),
            boundSessions: relevant.reduce((count, generation) => count + generation.boundSessions, 0),
            historicalSessions: relevant.reduce(
              (count, generation) =>
                count +
                (generation.state === 'active'
                  ? 0
                  : Math.max(0, generation.boundSessions - generation.openSessions)),
              0,
            ),
            drainingSessions: relevant.reduce(
              (count, generation) => count + (generation.state !== 'active' ? generation.boundSessions : 0),
              0,
            ),
          }
        }),
      }
    },
    setSessionPreset: (key, name) =>
      enqueue(async () => {
        const result = await owner(key, false).host.setSessionPreset(key, name)
        publish()
        return result
      }),
    applyRuntimeTarget: (target) =>
      enqueue(async () => {
        await refreshTrust()
        latestTarget = target
        latestRows = undefined
        await broadcast('runtime-target', async (container) => {
          const report = await container.host.applyRuntimeTarget(
            project(target, container.tree, container.host),
          )
          container.draining = draining(target.tree.rows, container.tree, container.host)
          return report
        })
        return convergence(target)
      }),
    refreshSkillRow: (fresh) =>
      enqueue(async () => {
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
      enqueue(async () => {
        const deployment = modelProfileDeployment(next)
        if (
          ![profile, modelProfile, ...[...containers.values()].map(({ host }) => host.profile)].some(
            (current) => modelProfileDeployment(current) === deployment,
          )
        )
          throw new HostError('E_SEAM_IMMUTABLE', 'non-model configuration requires restart')
        modelProfile = next
        return broadcast('models', (container) =>
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
        enqueue(async () => {
          await refreshTrust()
          latestRows = rows
          const selected = new Set(rows.map((row) => row.id))
          for (const id of prepared.keys()) if (!selected.has(`ext:${id}`)) prepared.delete(id)
          await broadcast('extension-rows', async (container) => {
            const projected = projectRows(rows, container.tree, container.host)
            const inactive = draining(rows, container.tree, container.host)
            const report = await container.host.extensionRows.apply(
              inactive
                ? [
                    ...container.host.extensionRows.current().filter((row) => !liveResource(row)),
                    ...projected.filter(liveResource),
                  ]
                : projected,
            )
            container.draining = inactive
            return report
          })
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
