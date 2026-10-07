import type { Host, HostOptions } from '../host.js'
import type { ResolvedProfile } from './types.js'
import { RuntimeGenerationSnapshotStore } from '@agnes/package-manager'
import type { RuntimeTarget } from '@agnes/plugin-runtime/host'
import { createRuntimeGenerationHost } from '../runtime-generation-host.js'
import { buildCompleteRuntimeTarget } from '../runtime-target-builder.js'
import { pluginSnapshotIdentity } from '../runtime-plugin-catalogue.js'
import { resolvePreset } from '../presets/resolve.js'
import { sessionKey } from '../session.js'
import { compositionPresets } from './composition-presets.js'
import { readAdminLoopDefault } from '../assemble/loop-selection.js'
import { profileForComposition, resolveComposition, type ResolvedComposition } from './composition.js'
import { compositionSkills, compositionSkillOwners } from './composition-visibility.js'
import {
  CompositionSessionStore,
  createLiveCompositionWriter,
  type CompositionBinding,
} from './composition-state.js'

type Factory = (profile: ResolvedProfile, options: HostOptions) => Promise<Host>
type Container = { host: Host; tree: ResolvedComposition }

/** Composition selects a container; W7 continues to own generations, leases and durable pins. */
export async function createCompositionHost(
  profile: ResolvedProfile,
  options: HostOptions,
  factory: Factory,
): Promise<Host> {
  const store = new CompositionSessionStore(options.profileDir)
  const generations = new RuntimeGenerationSnapshotStore(options.profileDir)
  const containers = new Map<string, Container>()
  const opening = new Map<string, Promise<Container>>()
  const sessionOwners = new Map<string, Container>()
  const prepared = new Map<string, Parameters<Host['extensionRows']['prepare']>[0]>()
  const skillOwners = compositionSkillOwners(
    options.runtimePluginCatalogue ?? options.runtimePluginSnapshots ?? [],
  )
  let currentSkills = options.skillResources
  const presets = await compositionPresets(profile, options)
  let closed = false
  let queue: Promise<unknown> = Promise.resolve()
  let latestTarget: RuntimeTarget | undefined
  const writer = await createLiveCompositionWriter(options.profileDir)
  const projectRows = <T extends RuntimeTarget['tree']['rows'][number]>(
    rows: readonly T[],
    tree: ResolvedComposition,
  ): T[] => {
    const packages = new Map(tree.selection.packages?.map((pkg) => [pkg.id, pkg.enabled !== false]))
    return rows.map((row) => {
      const identity = pluginSnapshotIdentity(row.plugin)
      const packageId =
        identity?.packageId ??
        (row.plugin.startsWith('builtin:')
          ? row.plugin.slice('builtin:'.length, row.plugin.lastIndexOf('/'))
          : undefined)
      const override = tree.selection.plugins?.[row.id]
      return {
        ...row,
        ...(override?.config === undefined ? {} : { config: override.config }),
        disabled:
          (override?.enabled === undefined ? row.disabled : !override.enabled) ||
          (!!packageId && packages.get(packageId) === false),
      }
    })
  }
  const project = (target: RuntimeTarget, tree: ResolvedComposition): RuntimeTarget => {
    return buildCompleteRuntimeTarget({
      rows: projectRows(
        [...target.tree.rows, ...Object.values(target.resource.rows).filter((row) => row !== null)],
        tree,
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
      const sources = pinned ? generations.read(pinned.generationId).sources : undefined
      const packageDirs = new Map(options.packageDirs)
      for (const source of sources ?? [])
        packageDirs.set(source.snapshot.packageId, source.snapshot.directory)
      const skills = compositionSkills(currentSkills, binding.tree.selection, skillOwners)
      const host = await createRuntimeGenerationHost(
        binding.profile,
        {
          ...options,
          packageDirs,
          ...(skills ? { skillResources: skills } : {}),
          ...(sources ? { runtimePluginSnapshots: sources } : {}),
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
          const row = host.extensionRows.prepare(input)
          rows.set(row.id, row)
        }
        if (latestTarget && !pinned) await host.applyRuntimeTarget(project(latestTarget, binding.tree))
        else if (prepared.size && !pinned)
          await host.extensionRows.apply(projectRows([...rows.values()], binding.tree))
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
      ok: reports.every((report) => report.ok),
      rows: [...rows.values()],
    }
  }
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error('E_HOST_CLOSED: host is closed'))
    const next = queue.then(run)
    queue = next.catch(() => undefined)
    return next
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
          const loop =
            input.loop ?? (parent ? undefined : await readAdminLoopDefault(options.profileDir, profile.name))
          const tree =
            parent?.tree ??
            resolveComposition(profile, {
              preset: resolvePreset(input.preset ?? profile.presets.default, initial.host.presets, {
                limits: profile.limits,
              }).doc,
              ...(loop ? { session: { loop } } : {}),
            })
          binding = store.pin({
            sessionKey: key,
            tree,
            profile: parent?.profile ?? profileForComposition(profile, tree),
          })
        }
        try {
          const container = await open(binding)
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
        for (const container of containers.values()) {
          await container.host.applyRuntimeTarget(project(target, container.tree))
        }
        latestTarget = target
        return convergence(target)
      }),
    refreshSkillRow: (fresh) =>
      enqueue(async () => {
        for (const container of containers.values())
          await container.host.refreshSkillRow(
            compositionSkills(fresh, container.tree.selection, skillOwners),
          )
        currentSkills = fresh
      }),
    reloadEcosystemExtension: async (id, input) => {
      if (id !== 'agnes/skills') return initial.host.reloadEcosystemExtension(id, input)
      await overrides.refreshSkillRow!(input.skillResources)
      const result = initial.host.extensions().find((entry) => entry.id === id)
      if (!result) throw new Error('E_COMPOSITION_SKILLS: Skills row has no status')
      return result
    },
    applyModelProfile: (next) =>
      enqueue(async () => {
        for (const container of containers.values())
          await container.host.applyModelProfile(
            profileForComposition({ ...container.host.profile, provider: next.provider }, container.tree),
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
          for (const container of containers.values())
            await container.host.extensionRows.apply(projectRows(rows, container.tree))
          return convergence()
        }),
    },
    async close() {
      if (closed) return
      closed = true
      clearInterval(statusTimer)
      await queue
      const results = await Promise.allSettled([...containers.values()].map(({ host }) => host.close()))
      writer.close()
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    },
  }
  return new Proxy(initial.host, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return Reflect.get(overrides, property)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
