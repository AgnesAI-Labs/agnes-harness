import { dirname } from 'node:path'
import { RuntimeGenerationSnapshotStore } from '@agnes/package-manager'
import type { RuntimeTarget } from '@agnes/plugin-runtime/host'
import { readAdminLoopDefault } from '../assemble/loop-selection.js'
import { SKILL_ROW_ID } from '../assemble/skill-row.js'
import { createConfigurationService } from '../configuration.js'
import { HostError } from '../errors.js'
import type { Host, HostOptions } from '../host.js'
import { assertHostPublication, createHostFacade, type HostPublicationReport } from '../host-facade.js'
import { resolvePreset } from '../presets/resolve.js'
import { createRuntimeGenerationHost } from '../runtime-generation-host.js'
import { pluginSnapshotIdentity, RuntimePluginCatalogue } from '../runtime-plugin-catalogue.js'
import { buildCompleteRuntimeTarget } from '../runtime-target-builder.js'
import { sessionKey } from '../session.js'
import { profileForComposition, type ResolvedComposition, resolveComposition } from './composition.js'
import { compositionPresets } from './composition-presets.js'
import {
  type CompositionBinding,
  CompositionSessionStore,
  createLiveCompositionWriter,
} from './composition-state.js'
import { compositionSkillOwners, compositionSkills } from './composition-visibility.js'
import { modelProfileDeployment } from './model-compatibility.js'
import type { ResolvedProfile } from './types.js'

type Factory = (profile: ResolvedProfile, options: HostOptions) => Promise<Host>
type Container = { host: Host; tree: ResolvedComposition }

/** Composition selects a container; W7 continues to own generations, leases and durable pins. */
export async function createCompositionHost(
  profile: ResolvedProfile,
  options: HostOptions,
  factory: Factory,
): Promise<Host> {
  const store = new CompositionSessionStore(options.profileDir)
  const configuration = createConfigurationService({
    home: options.homeDir ?? dirname(dirname(options.profileDir)),
    profile: profile.name,
    profileDir: options.profileDir,
  })
  const generations = new RuntimeGenerationSnapshotStore(options.profileDir)
  const containers = new Map<string, Container>()
  const opening = new Map<string, Promise<Container>>()
  const sessionOwners = new Map<string, Container>()
  const prepared = new Map<string, Parameters<Host['extensionRows']['prepare']>[0]>()
  const skillOwners = compositionSkillOwners(
    options.runtimePluginCatalogue ?? options.runtimePluginSnapshots ?? [],
  )
  let currentSkills = options.skillResources
  let modelProfile = profile
  let lastPublication: HostPublicationReport | undefined
  const presets = await compositionPresets(profile, options)
  let closed = false
  let closing: Promise<void> | undefined
  let queue: Promise<unknown> = Promise.resolve()
  let latestTarget: RuntimeTarget | undefined
  let latestRows: Parameters<Host['extensionRows']['apply']>[0] | undefined
  const writer = await createLiveCompositionWriter(options.profileDir)
  const projectRows = <T extends RuntimeTarget['tree']['rows'][number]>(
    rows: readonly T[],
    tree: ResolvedComposition,
    host?: Host,
  ): T[] => {
    const packages = new Map(tree.selection.packages?.map((pkg) => [pkg.id, pkg.enabled !== false]))
    const skill = host?.extensionRows.current().find((row) => row.id === SKILL_ROW_ID)
    return rows.map((row) => {
      // Skills are live resources. A container's filtered view owns its current importer identity.
      if (skill && row.id === SKILL_ROW_ID) row = skill as T
      const identity = pluginSnapshotIdentity(row.plugin)
      const packageId =
        identity?.packageId ??
        (row.plugin.startsWith('builtin:')
          ? row.plugin.slice('builtin:'.length, row.plugin.lastIndexOf('/'))
          : undefined)
      const override = tree.selection.plugins?.[row.id]
      return Object.freeze({
        ...row,
        ...(override?.config === undefined ? {} : { config: override.config }),
        disabled:
          (override?.enabled === undefined ? row.disabled : !override.enabled) ||
          (!!packageId && packages.get(packageId) === false),
      })
    })
  }
  const project = (target: RuntimeTarget, tree: ResolvedComposition, host?: Host): RuntimeTarget => {
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
    if (found) return found
    const pending = opening.get(binding.tree.hash)
    if (pending) return pending
    const started = (async () => {
      const pinned = generations.session(binding.sessionKey)
      const skills = compositionSkills(currentSkills, binding.tree.selection, skillOwners)
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
        const container = { host, tree: binding.tree }
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
  let initial: Container
  try {
    initial = await open({
      sessionKey: '',
      tree: initialTree,
      profile: profileForComposition(profile, initialTree),
    })
  } catch (error) {
    writer.close()
    throw error
  }
  const owner = (key: string): Container =>
    sessionOwners.get(key) ??
    [...containers.values()].find((container) => container.host.kernel.get(key)) ??
    initial
  const live = () => {
    const sessions = new Map([...containers.values()].flatMap(({ host }) => [...host.kernel.sessions]))
    return [...sessions.values()].map((session) => {
      const container = owner(session.key),
        selection = container.tree.selection
      const routes = new Set(Object.values(session.preset.model.route))
      const adapters = [
        ...new Set(
          session.d.provider
            .models()
            .filter((model) => routes.has(model.route))
            .map((model) => model.api),
        ),
      ]
      const generationId = generations.session(session.key)?.generationId
      return {
        sessionKey: session.key,
        ...(generationId ? { generationId } : {}),
        compositionHash: container.tree.hash,
        preset: session.preset.name,
        bundles: container.tree.bundles,
        providers: {
          loop: session.loop,
          modelAdapters: adapters.length ? adapters : (selection.modelAdapters ?? []),
          ...(selection.compaction === undefined ? {} : { compaction: selection.compaction }),
          ...(selection.persistence ? { persistence: selection.persistence } : {}),
          ...(selection.sandbox ? { sandbox: selection.sandbox } : {}),
        },
      }
    })
  }
  const publish = () => {
    try {
      writer.write(live())
    } catch {
      options.log.warn('Composition live status could not be written')
    }
  }
  const statusTimer = setInterval(publish, 1000)
  statusTimer.unref()
  const convergence = (target = latestTarget) => {
    const reports = [...containers.values()].map(({ host }) => host.ordinaryConvergence())
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
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new HostError('E_HOST_CLOSED', 'host is closed'))
    const next = queue.then(() => {
      if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed')
      return run()
    })
    queue = next.catch(() => undefined)
    return next
  }
  const broadcast = async (
    operation: HostPublicationReport['operation'],
    apply: (container: Container) => Promise<unknown>,
  ): Promise<HostPublicationReport> => {
    const results: HostPublicationReport['containers'][number][] = []
    for (const container of containers.values()) {
      try {
        const report = await apply(container)
        if (report && typeof report === 'object' && 'ok' in report && report.ok === false)
          throw new Error('Container did not converge; inspect ordinaryConvergence for row failures')
        results.push({ compositionHash: container.tree.hash, status: 'applied' })
      } catch (error) {
        results.push({ compositionHash: container.tree.hash, status: 'failed', error: String(error) })
      }
    }
    lastPublication = Object.freeze({
      operation,
      ok: results.every((result) => result.status === 'applied'),
      recovery: 'retry-same-input',
      containers: Object.freeze(results.map((result) => Object.freeze(result))),
    })
    return lastPublication
  }
  const sessions = new Proxy(initial.host.kernel.sessions, {
    get(_target, property) {
      if (property === 'delete') return (key: string) => owner(key).host.kernel.sessions.delete(key)
      const map = new Map([...containers.values()].flatMap(({ host }) => [...host.kernel.sessions]))
      const value = Reflect.get(map, property, map)
      return typeof value === 'function' ? value.bind(map) : value
    },
  })
  const kernel = new Proxy(initial.host.kernel, {
    get(target, property) {
      if (property === 'sessions') return sessions
      if (property === 'get') return (key: string) => owner(key).host.kernel.get(key)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const overrides: Partial<Host> = {
    kernel,
    runtimeTargetSnapshot: () => latestTarget ?? initial.host.runtimeTargetSnapshot!(),
    ordinaryConvergence: () => convergence(),
    compositionSessions: live,
    securityStatus: () => {
      const initialStatus = initial.host.securityStatus?.()
      if (!initialStatus) throw new Error('Security status is unavailable')
      return {
        ...initialStatus,
        workspaces: [...containers.values()].flatMap(({ host }) => host.securityStatus?.().workspaces ?? []),
      }
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
        let binding = store.read(key)
        if (!binding) {
          const parent = input.parent ? store.read(input.parent.key) : undefined
          const loop = input.loop ?? (parent ? undefined : await readAdminLoopDefault(configuration))
          const tree =
            parent?.tree ??
            resolveComposition(profile, {
              preset: resolvePreset(input.preset ?? profile.presets.default, initial.host.presets, {
                limits: profile.limits,
              }).doc,
              ...(loop ? { session: { loop } } : {}),
              ...(input.bundles !== undefined ? { sessionBundles: input.bundles } : {}),
            })
          binding = store.pin({
            sessionKey: key,
            tree,
            profile: parent?.profile ?? profileForComposition(profile, tree),
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
              publish()
            }
          }
          publish()
          return session
        } catch (error) {
          if (!generations.session(key)) store.release(key)
          throw error
        }
      }),
    sessionGeneration: (key) => generations.session(key)?.generationId,
    releaseSessionGeneration: (key) =>
      enqueue(async () => {
        await owner(key).host.releaseSessionGeneration?.(key)
        store.release(key)
        sessionOwners.delete(key)
        publish()
      }),
    migrateSessionGeneration: (key) =>
      enqueue(async () => {
        const binding = store.read(key)
        if (!binding) throw new Error('E_COMPOSITION_BINDING_MISSING: session has no saved composition')
        const container = await open(binding)
        if (!container.host.migrateSessionGeneration) throw new Error('E_GENERATION_MIGRATION_UNAVAILABLE')
        const result = await container.host.migrateSessionGeneration(key)
        publish()
        return result
      }),
    collectPluginGenerations: () =>
      enqueue(async () => {
        for (const { host } of containers.values()) await host.collectPluginGenerations?.()
      }),
    pluginGenerationStatus: () => {
      const statuses = [...containers.values()].map(({ host }) => host.pluginGenerationStatus!())
      const all = new Map(
        statuses.flatMap((status) => status.generations.map((item) => [item.id, item] as const)),
      )
      // Each W7 facade sees the shared durable pins. Active in any container wins over draining.
      for (const status of statuses)
        for (const item of status.generations) if (item.state === 'active') all.set(item.id, item)
      return {
        ...statuses[0]!,
        generations: [...all.values()],
        plugins: [
          ...new Map(
            statuses.flatMap((status) => status.plugins.map((item) => [item.id, item] as const)),
          ).values(),
        ],
      }
    },
    setSessionPreset: (key, name) =>
      enqueue(async () => {
        const result = await owner(key).host.setSessionPreset(key, name)
        publish()
        return result
      }),
    validatePresetSwitch: (name, key) => owner(key ?? '').host.validatePresetSwitch(name, key),
    validateModelSwitch: (selection, key) => owner(key ?? '').host.validateModelSwitch(selection, key),
    callService: (params, ...args) => owner(params.sessionId).host.callService(params, ...args),
    inspectService: (params, ...args) => owner(params.sessionId).host.inspectService(params, ...args),
    applyRuntimeTarget: (target) =>
      enqueue(async () => {
        latestTarget = target
        latestRows = undefined
        await broadcast('runtime-target', (container) =>
          container.host.applyRuntimeTarget(project(target, container.tree, container.host)),
        )
        return convergence(target)
      }),
    refreshSkillRow: (fresh) =>
      enqueue(async () => {
        currentSkills = fresh
        return broadcast('skills', (container) =>
          container.host.refreshSkillRow(compositionSkills(fresh, container.tree.selection, skillOwners)),
        )
      }),
    reloadEcosystemExtension: async (id, input) => {
      if (id !== 'agnes/skills') return initial.host.reloadEcosystemExtension(id, input)
      assertHostPublication(await overrides.refreshSkillRow!(input.skillResources))
      const result = initial.host.extensions().find((entry) => entry.id === id)
      if (!result) throw new Error('E_COMPOSITION_SKILLS: Skills row has no status')
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
          latestRows = rows
          const selected = new Set(rows.map((row) => row.id))
          for (const id of prepared.keys()) if (!selected.has(`ext:${id}`)) prepared.delete(id)
          await broadcast('extension-rows', (container) =>
            container.host.extensionRows.apply(projectRows(rows, container.tree, container.host)),
          )
          return convergence()
        }),
    },
    close() {
      if (closing) return closing
      closed = true
      clearInterval(statusTimer)
      const hosts = new Map([...containers.values()].map(({ host }) => [host, host.close()]))
      for (const close of hosts.values()) void close.catch(() => undefined)
      closing = (async () => {
        await queue
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
