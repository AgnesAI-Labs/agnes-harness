import { createHash } from 'node:crypto'
import {
  type PluginGenerationSnapshot,
  RuntimeGenerationSnapshotStore,
  readDevelopmentPlugin,
  developmentPluginRows,
  type RuntimePluginSnapshot,
} from '@agnes/package-manager'
import {
  decodeRuntimeTargetArtifact,
  encodeRuntimeTargetArtifact,
  type RuntimeTarget,
} from '@agnes/plugin-runtime/host'
import { composeExtensionRowTarget } from './assemble/ext-rows.js'
import { SKILL_ROW_ID, skillRowRevision } from './assemble/skill-row.js'
import { createExtensionActivationBarrier } from './ext-host/activation-barrier.js'
import type { Host, HostOptions } from './host.js'
import type { ResolvedProfile } from './profile/types.js'
import type { SkillRuntimeInput } from './resources/skills.js'
import { RuntimePluginCatalogue } from './runtime-plugin-catalogue.js'
import { buildCompleteRuntimeTarget } from './runtime-target-builder.js'
import { captureGenerationResources, createGenerationSkills, restoreGenerationRows } from './runtime-generation-resources.js'
import { sessionKey } from './session.js'

export type PluginGenerationStatus = Readonly<{
  currentGenerationId?: string
  generations: readonly Readonly<{
    id: string
    state: 'active' | 'draining' | 'failed'
    boundSessions: number
    packages: readonly Readonly<{ id: string; version: string }>[]
    error?: string
  }>[]
  plugins: readonly Readonly<{
    id: string
    state: 'active' | 'draining' | 'restart-required' | 'failed'
    boundSessions: number
    drainingSessions: number
    error?: string
  }>[]
}>

type LiveGeneration = { snapshot: PluginGenerationSnapshot; host: Host }
type Factory = (profile: ResolvedProfile, options: HostOptions) => Promise<Host>

/**
 * Generation-local containers keep Cordis row identities, extension leases, loop registries and
 * model adapters independent. Storage remains the configured backend; no ledger is duplicated.
 * A closed connection is still a durable session reference, including after worker hibernation.
 */
export async function createRuntimeGenerationHost(
  profile: ResolvedProfile,
  options: HostOptions,
  factory: Factory,
): Promise<Host> {
  const store = new RuntimeGenerationSnapshotStore(options.profileDir)
  const live = new Map<string, LiveGeneration>()
  const opening = new Map<string, Promise<LiveGeneration>>()
  const preparedRows = new Map<string, Parameters<Host['extensionRows']['prepare']>[0]>()
  const rowsByGeneration = new Map<string, typeof preparedRows>()
  const skillsByGeneration = new Map<string, SkillRuntimeInput | undefined>()
  const resourceSkills = new Map<string, ReturnType<typeof createGenerationSkills>>()
  const developmentSources = new Map<string, RuntimePluginSnapshot>()
  const developmentDirectories = new Map(options.developmentPluginDirectories)
  const failures = new Map<string, string>()
  const failedSnapshots = new Map<string, PluginGenerationSnapshot>()
  let initialBinding: ((key: string) => void) | undefined
  const initialSkills = createGenerationSkills(options.skillResources, store)
  const initial = await factory(profile, {
    ...options,
    ...(options.skillResources ? { skillResources: initialSkills.input } : {}),
    onGenerationSessionBinding: (key) => initialBinding?.(key),
  })
  let current: LiveGeneration | undefined
  let closed = false
  let queue: Promise<unknown> = Promise.resolve()
  let closing: Promise<void> | undefined
  const basePackages = new Set(
    [
      profile.seams.sandbox,
      profile.seams.platform,
      ...profile.packages
        .filter((pkg) => Object.values(profile.adapters).includes(pkg.id))
        .map((pkg) => pkg.id),
    ].filter((id): id is string => typeof id === 'string'),
  )
  // Model/loop selections are checked by their generation's registries on open. Process backends
  // and deployment routes must remain compatible when reopening a durable snapshot.
  const compatibility = createHash('sha256')
    .update(
      JSON.stringify({
        adapters: profile.adapters,
        sandbox: profile.seams.sandbox,
        platform: profile.seams.platform,
        provider: profile.provider,
        agnesVersion: options.agnesVersion,
        builtinPackages: profile.packages
          .filter((pkg) => pkg.trust === 'builtin')
          .map(({ id, version, integrity }) => ({ id, version, integrity })),
      }),
    )
    .digest('hex')

  const sourcesFor = async (target: RuntimeTarget): Promise<readonly RuntimePluginSnapshot[]> => {
    const sources =
      (await options.runtimePluginSources?.()) ??
      options.runtimePluginSnapshots ??
      options.runtimePluginCatalogue ??
      []
    const catalogue = new Map([...sources, ...developmentSources.values()].map((source) => [`${source.snapshot.packageId}@${source.snapshot.snapshotId}`, source]))
    return new RuntimePluginCatalogue([...catalogue.values()]).select(target)
  }
  const bindGeneration = (key: string, id: string): void => {
    if (store.pin(key, id).generationId !== id)
      throw new Error('E_GENERATION_BINDING_CONFLICT: session was bound by another worker')
  }
  const snapshotTarget = (target: RuntimeTarget, sources: readonly RuntimePluginSnapshot[], skills: SkillRuntimeInput | undefined) =>
    store.create(target, sources, compatibility, [
      ...profile.packages
        .filter((pkg) => pkg.trust === 'builtin' && pkg.enabled !== false)
        .map((pkg) => ({ id: pkg.id, version: pkg.version })),
      ...sources.map((source) => ({ id: source.snapshot.packageId, version: source.snapshot.version })),
    ], captureGenerationResources(skills, preparedRows.values()))
  const ensureCurrent = async (): Promise<LiveGeneration> => {
    if (current) return current
    const target = initial.runtimeTargetSnapshot?.()
    if (!target) throw new Error('E_GENERATION_TARGET_MISSING: Host has no runtime snapshot')
    const snapshot = snapshotTarget(target, await sourcesFor(target), options.skillResources)
    if (snapshot.resources) initialSkills.seal(snapshot.resources, true)
    resourceSkills.set(snapshot.id, initialSkills)
    current = { snapshot, host: initial }
    live.set(snapshot.id, current)
    skillsByGeneration.set(snapshot.id, options.skillResources)
    rowsByGeneration.set(snapshot.id, new Map(preparedRows))
    initialBinding = (key) => {
      bindGeneration(key, snapshot.id)
    }
    return current
  }
  const build = async (snapshot: PluginGenerationSnapshot): Promise<LiveGeneration> => {
    if (snapshot.compatibility !== compatibility)
      throw new Error(
        `E_GENERATION_INCOMPATIBLE: generation ${snapshot.id} needs its original loop/adapter deployment`,
      )
    const skills = skillsByGeneration.has(snapshot.id)
      ? skillsByGeneration.get(snapshot.id)
      : options.skillResources
    const target = decodeRuntimeTargetArtifact(snapshot.artifact)
    const generationSkills = createGenerationSkills(skills, store)
    if (snapshot.resources) generationSkills.seal(snapshot.resources, skillsByGeneration.has(snapshot.id))
    const pinnedSkillRow = target.tree.rows.find((row) => row.id === SKILL_ROW_ID)
    if (
      !snapshot.resources && !skillsByGeneration.has(snapshot.id) &&
      pinnedSkillRow &&
      pinnedSkillRow.entryRevision !== skillRowRevision(skills)
    )
      throw new Error(
        `E_GENERATION_SKILLS_SNAPSHOT_MISSING: generation ${snapshot.id} needs its original Skills view`,
      )
    const hasSkills = !!skills || !!(snapshot.resources?.data as { skills?: unknown } | undefined)?.skills
    const packages = profile.packages.filter((pkg) => pkg.trust === 'builtin')
    const packageDirs = new Map(options.packageDirs)
    for (const source of snapshot.sources) {
      const previous = profile.packages.find((pkg) => pkg.id === source.snapshot.packageId)
      packages.push({
        ...previous,
        id: source.snapshot.packageId,
        version: source.snapshot.version,
        integrity: source.snapshot.integrity,
        source: previous?.source ?? 'runtime-snapshot',
        trust: 'trusted',
        enabled: true,
      })
      packageDirs.set(source.snapshot.packageId, source.snapshot.directory)
    }
    const { skillResources: _skills, ...generationOptions } = options
    const host = await factory(
      { ...profile, packages },
      {
        ...generationOptions,
        ...(hasSkills ? { skillResources: generationSkills.input } : {}),
        packageDirs,
        runtimePluginSnapshots: snapshot.sources,
        runtimePluginSources: async () => snapshot.sources,
        activationBarrier: createExtensionActivationBarrier(),
        onGenerationSessionBinding: (key) => {
          bindGeneration(key, snapshot.id)
        },
      },
    )
    try {
      const savedRows = snapshot.resources ? await restoreGenerationRows(snapshot.resources, options, rowsByGeneration.get(snapshot.id)) : [...(rowsByGeneration.get(snapshot.id) ?? preparedRows).values()]
      for (const input of savedRows)
        host.extensionRows.prepare(input)
      if (pinnedSkillRow) host.extensionRows.prepare({ extensionId: 'agnes/skills', entryRevision: pinnedSkillRow.entryRevision, ...(hasSkills ? { skillResources: generationSkills.input } : {}) })
      await host.applyRuntimeTarget(decodeRuntimeTargetArtifact(snapshot.artifact))
    } catch (error) {
      await host.close().catch(() => undefined)
      throw error
    }
    const generation = { snapshot, host }
    resourceSkills.set(snapshot.id, generationSkills)
    live.set(snapshot.id, generation)
    return generation
  }
  const resolve = async (id: string): Promise<LiveGeneration> => {
    const found = live.get(id)
    if (found) return found
    const pending = opening.get(id)
    if (pending) return pending
    const started = Promise.resolve().then(() => build(store.read(id)))
    opening.set(id, started)
    try {
      return await started
    } catch (error) {
      failures.set(id, error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      opening.delete(id)
    }
  }
  const owner = (key: string): Host => {
    for (const generation of live.values()) if (generation.host.kernel.get(key)) return generation.host
    return current?.host ?? initial
  }
  const collect = async (): Promise<void> => {
    const referenced = new Set(store.sessions().map((pin) => pin.generationId))
    const retired = new Set<string>()
    for (const [id, generation] of live) {
      if (id === current?.snapshot.id || referenced.has(id)) continue
      await generation.host.close()
      live.delete(id)
      skillsByGeneration.delete(id)
      rowsByGeneration.delete(id)
      resourceSkills.delete(id)
      retired.add(id)
    }
    store.collect(new Set([...live.keys(), ...opening.keys()]), retired)
  }
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error('E_HOST_CLOSED: host is closed'))
    const next = queue.then(run)
    queue = next.catch(() => undefined)
    return next
  }
  const status = (): PluginGenerationStatus => {
    const errors = new Map(failures)
    const counts = new Map<string, number>()
    for (const pin of store.sessions()) counts.set(pin.generationId, (counts.get(pin.generationId) ?? 0) + 1)
    const snapshots = new Map([
      ...failedSnapshots,
      ...[...live].map(([id, generation]) => [id, generation.snapshot] as const),
    ])
    for (const id of counts.keys())
      if (!snapshots.has(id)) {
        try {
          snapshots.set(id, store.read(id))
        } catch (error) {
          errors.set(id, String(error))
        }
      }
    const active = new Set(current?.snapshot.packages.map((pkg) => pkg.id) ?? [])
    const plugins = new Map<string, PluginGenerationStatus['plugins'][number]>()
    const generations: PluginGenerationStatus['generations'][number][] = []
    for (const [id, snapshot] of snapshots) {
      const boundSessions = counts.get(id) ?? 0
      generations.push({
        id,
        state: errors.has(id) ? 'failed' : id === current?.snapshot.id ? 'active' : 'draining',
        ...(errors.has(id) ? { error: errors.get(id) as string } : {}),
        boundSessions,
        packages: snapshot.packages,
      })
      for (const pkg of snapshot.packages) {
        const packageId = pkg.id,
          previous = plugins.get(packageId)
        const failed = live
          .get(id)
          ?.host.extensions()
          .find((entry) => entry.package === packageId && entry.error)
        const error = failed?.error?.message ?? errors.get(id)
        plugins.set(packageId, {
          id: packageId,
          state: basePackages.has(packageId)
            ? 'restart-required'
            : active.has(packageId) && !(id === current?.snapshot.id && error)
              ? 'active'
              : error
                ? 'failed'
                : 'draining',
          boundSessions: (previous?.boundSessions ?? 0) + boundSessions,
          drainingSessions: (previous?.drainingSessions ?? 0) + (id === current?.snapshot.id ? 0 : boundSessions),
          ...(error ? { error } : {}),
        })
      }
    }
    for (const id of basePackages)
      if (!plugins.has(id))
        plugins.set(id, { id, state: 'restart-required', boundSessions: store.sessions().length, drainingSessions: 0 })
    for (const [id, error] of errors) {
      if (snapshots.has(id)) continue
      generations.push({ id, state: 'failed', boundSessions: counts.get(id) ?? 0, packages: [], error })
    }
    return Object.freeze({
      ...(current ? { currentGenerationId: current.snapshot.id } : {}),
      generations: Object.freeze(generations.map((item) => ({ ...item, ...(item.error ? { error: item.error.match(/E_[A-Z0-9_]+/)?.[0] ?? 'Plugin generation failed; inspect local logs.' } : {}) }))),
      plugins: Object.freeze([...plugins.values()].map((item) => ({ ...item, ...(item.error ? { error: item.error.match(/E_[A-Z0-9_]+/)?.[0] ?? 'Plugin generation failed; inspect local logs.' } : {}) }))),
    })
  }
  // Keep the public Kernel coordination view valid for sessions hosted in any generation.
  const sessions = new Proxy(initial.kernel.sessions, {
    get(_map, property) {
      const all = () =>
        new Map([...live.values()].flatMap((generation) => [...generation.host.kernel.sessions]))
      if (property === 'delete') return (key: string) => owner(key).kernel.sessions.delete(key)
      const map = all(),
        value = Reflect.get(map, property, map)
      return typeof value === 'function' ? value.bind(map) : value
    },
  })
  const kernel = new Proxy(initial.kernel, {
    get(_kernel, property) {
      if (property === 'sessions') return sessions
      if (property === 'get') return (key: string) => owner(key).kernel.get(key)
      const target = current?.host.kernel ?? initial.kernel,
        value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const publishTarget = async (target: RuntimeTarget, skills?: { input: SkillRuntimeInput | undefined }) => {
    const head = await ensureCurrent()
    if (head.snapshot.artifact.digest === encodeRuntimeTargetArtifact(target).digest)
      return head.host.ordinaryConvergence()
    const oldTarget = decodeRuntimeTargetArtifact(head.snapshot.artifact)
    // Backend facets are process configuration. A package generation cannot replace them live.
    for (const row of [...oldTarget.tree.rows, ...target.tree.rows])
      if (row.id === 'seam:sandbox' || row.id === 'seam:platform' || row.id.startsWith('adapter:')) {
        if (
          JSON.stringify(oldTarget.tree.rows.find((old) => old.id === row.id)) !==
          JSON.stringify(target.tree.rows.find((next) => next.id === row.id))
        )
          throw new Error(`E_GENERATION_RESTART_REQUIRED: ${row.id} requires restart`)
      }
    const sources = await sourcesFor(target)
    for (const previous of head.snapshot.sources)
      if (basePackages.has(previous.snapshot.packageId)) {
        const next = sources.find((item) => item.snapshot.packageId === previous.snapshot.packageId)
        if (
          previous.snapshot.integrity !== next?.snapshot.integrity ||
          previous.snapshot.version !== next?.snapshot.version
        )
          throw new Error(`E_GENERATION_RESTART_REQUIRED: ${previous.snapshot.packageId} requires restart`)
      }
    const skillInput = skills ? skills.input : skillsByGeneration.get(head.snapshot.id)
    const snapshot = snapshotTarget(target, sources, skillInput)
    skillsByGeneration.set(snapshot.id, skills ? skills.input : skillsByGeneration.get(head.snapshot.id))
    rowsByGeneration.set(snapshot.id, new Map(preparedRows))
    try {
      current = await build(snapshot)
    } catch (error) {
      failures.set(snapshot.id, error instanceof Error ? error.message : String(error))
      failedSnapshots.set(snapshot.id, snapshot)
      throw error
    }
    // Publication has committed. Retirement failure belongs to the retired generation, and cannot
    // turn a successful head change into a rejected apply/compensation transaction.
    try {
      await collect()
    } catch (error) {
      for (const id of live.keys())
        if (id !== current.snapshot.id && !store.sessions().some((pin) => pin.generationId === id))
          failures.set(id, `E_GENERATION_DISPOSE: ${String(error)}`)
    }
    return current.host.ordinaryConvergence()
  }
  const overrides: Partial<Host> = {
    kernel,
    pluginGenerationStatus: status,
    sessionGeneration: (key) => store.session(key)?.generationId,
    collectPluginGenerations: () => enqueue(collect),
    reloadPlugin: (id, directory) => enqueue(async () => {
      const head = await ensureCurrent()
      const pkg = profile.packages.find((pkg) => pkg.id === id)
      if (pkg?.trust === 'builtin' || basePackages.has(id))
        throw new Error(`E_GENERATION_RESTART_REQUIRED: ${id} is a base backend or bundled package`)
      const available = (await options.runtimePluginSources?.()) ?? options.runtimePluginSnapshots ?? []
      const path = directory ?? developmentDirectories.get(id) ?? (pkg?.source.startsWith('file:') ? pkg.source.slice(5) : undefined) ?? available.find((source) => source.snapshot.packageId === id)?.snapshot.directory ?? options.packageDirs?.get(id)
      if (!path) throw new Error(`E_PLUGIN_RELOAD_SOURCE_MISSING: register a local directory for ${id}`)
      const source = readDevelopmentPlugin(path, profile.name)
      if (source.snapshot.packageId !== id) throw new Error('E_PLUGIN_RELOAD_IDENTITY: local package name differs from the requested id')
      const target = decodeRuntimeTargetArtifact(head.snapshot.artifact)
      const oldRows = [...target.tree.rows, ...Object.values(target.resource.rows).flatMap((row) => row ? [row] : [])]
      const owned = (plugin: string) => plugin.startsWith(`${id}@`) || plugin.startsWith(`builtin:${id}/`)
      const sourcesBefore = new Map(developmentSources)
      developmentSources.set(`${id}@${source.snapshot.snapshotId}`, source)
      try {
        await publishTarget(buildCompleteRuntimeTarget({ rows: [...oldRows.filter((row) => !owned(row.plugin)), ...developmentPluginRows(source, oldRows)], resources: target.resource.resources }).target)
        developmentDirectories.set(id, path)
        const next = await ensureCurrent()
        return { generationId: next.snapshot.id, changed: next.snapshot.id !== head.snapshot.id }
      } catch (error) {
        developmentSources.clear()
        for (const [key, value] of sourcesBefore) developmentSources.set(key, value)
        throw error
      }
    }),
    releaseSessionGeneration: (key) =>
      enqueue(async () => {
        if (owner(key).kernel.get(key))
          throw new Error('E_GENERATION_SESSION_OPEN: close the deleted session first')
        store.releaseSession(key)
        await collect()
      }),
    createSession: (input) =>
      enqueue(async () => {
        const head = await ensureCurrent()
        const key =
          input.key ??
          input.binding?.sessionKey ??
          sessionKey(
            profile,
            await head.host.resolveActor(input.credential ?? { kind: 'local' }, 'session'),
            input.cwd ?? options.workspaceRoot,
          )
        const existing = store.session(key)
        const desiredId = input.parent
          ? (store.session(input.parent.key)?.generationId ?? head.snapshot.id)
          : head.snapshot.id
        const pin = existing ?? { sessionKey: key, generationId: desiredId }
        const generation = await resolve(pin.generationId)
        try {
          if (
            pin.loop &&
            input.loop &&
            (pin.loop.id !== input.loop.id || pin.loop.version !== input.loop.version)
          )
            throw new Error('E_GENERATION_LOOP_INCOMPATIBLE: requested loop differs from the session pin')
          if (pin.loop) generation.host.kernel.loops.resolve(pin.loop)
          const session = await generation.host.createSession({
            ...input,
            key,
            ...(pin.loop ? { loop: pin.loop } : {}),
          })
          try {
            store.recordLoop(key, session.loop)
            await resourceSkills.get(pin.generationId)?.bind(key, session.d.cwd, !!existing)
          } catch (error) {
            await session.close()
            throw error
          }
          Object.defineProperty(session, 'pluginGenerationId', {
            value: generation.snapshot.id,
            configurable: true,
          })
          const close = session.close.bind(session)
          session.close = async () => {
            try {
              await close()
            } finally {
              generation.host.kernel.sessions.delete(key)
            }
          }
          failures.delete(pin.generationId)
          return session
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (message.includes('E_GENERATION_') || message.startsWith('Loop '))
            failures.set(pin.generationId, message)
          throw error
        }
      }),
    applyRuntimeTarget: (target) => enqueue(() => publishTarget(target)),
    refreshSkillRow: (fresh) =>
      enqueue(async () => {
        const head = await ensureCurrent(),
          target = decodeRuntimeTargetArtifact(head.snapshot.artifact)
        const revision = skillRowRevision(fresh)
        if (target.tree.rows.find((row) => row.id === SKILL_ROW_ID)?.entryRevision === revision) return
        const row = head.host.extensionRows.prepare({
          extensionId: 'agnes/skills',
          entryRevision: revision,
          skillResources: fresh,
        })
        const previous = preparedRows.get('agnes/skills')
        preparedRows.set('agnes/skills', {
          extensionId: 'agnes/skills',
          entryRevision: revision,
          skillResources: fresh,
        })
        const rows = [
          ...target.tree.rows.filter((old) => old.id !== SKILL_ROW_ID),
          row,
          ...Object.values(target.resource.rows).flatMap((resource) => (resource ? [resource] : [])),
        ]
        try {
          await publishTarget(
            buildCompleteRuntimeTarget({
              rows,
              resources: { ...target.resource.resources, skills: { entries: fresh?.list() ?? [] } },
            }).target,
            { input: fresh },
          )
        } catch (error) {
          if (previous) preparedRows.set('agnes/skills', previous)
          else preparedRows.delete('agnes/skills')
          throw error
        }
      }),
    reloadEcosystemExtension: async (id, freshInit) => {
      if (id !== 'agnes/skills') return (current?.host ?? initial).reloadEcosystemExtension(id, freshInit)
      await overrides.refreshSkillRow?.(freshInit.skillResources)
      const result = (current?.host ?? initial).extensions().find((entry) => entry.id === id)
      if (!result) throw new Error('E_GENERATION_SKILLS: Skills row has no status')
      return result
    },
    setSessionPreset: (key, preset) => owner(key).setSessionPreset(key, preset),
    validatePresetSwitch: (name, key) =>
      (key ? owner(key) : (current?.host ?? initial)).validatePresetSwitch(name),
    validateModelSwitch: (selection, key) =>
      (key ? owner(key) : (current?.host ?? initial)).validateModelSwitch(selection),
    callService: (params, ...rest) => owner(params.sessionId).callService(params, ...rest),
    inspectService: (params, ...rest) => owner(params.sessionId).inspectService(params, ...rest),
    extensionRows: {
      current: () => {
        if (!current) return initial.extensionRows.current()
        const owned = new Set([
          ...initial.extensionRows.current().map((row) => row.id),
          ...[...preparedRows.keys()].map((id) => `ext:${id}`),
        ])
        return decodeRuntimeTargetArtifact(current.snapshot.artifact).tree.rows.filter((row) =>
          owned.has(row.id),
        )
      },
      prepare: (input) => {
        preparedRows.set(input.extensionId, input)
        return (current?.host ?? initial).extensionRows.prepare(input)
      },
      apply: (rows) =>
        enqueue(async () => {
          const head = await ensureCurrent()
          return publishTarget(
            buildCompleteRuntimeTarget(
              composeExtensionRowTarget({
                live: decodeRuntimeTargetArtifact(head.snapshot.artifact),
                fallbackRows: [],
                rows,
                extraOwnedRowIds: new Set([...preparedRows.keys()].map((id) => `ext:${id}`)),
              }),
            ).target,
          )
        }),
    },
    close: () => {
      if (closing) return closing
      closed = true
      closing = (async () => {
        await queue
        await Promise.allSettled(opening.values())
        const hosts = new Set([initial, ...[...live.values()].map((generation) => generation.host)])
        const results = await Promise.allSettled([...hosts].map((host) => host.close()))
        const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
        if (errors.length) throw new AggregateError(errors, 'generation shutdown failed')
        store.collect(new Set())
      })()
      return closing
    },
  }
  try {
    await ensureCurrent()
  } catch (error) {
    await initial.close().catch(() => undefined)
    throw error
  }
  return new Proxy(initial, {
    get(_host, property) {
      if (property in overrides) return Reflect.get(overrides, property)
      const target = current?.host ?? initial,
        value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
