import { createHash } from 'node:crypto'
import {
  type PluginGenerationSnapshot,
  RuntimeGenerationSnapshotStore,
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
  const skillsByGeneration = new Map<string, SkillRuntimeInput | undefined>()
  const failures = new Map<string, string>()
  const failedSnapshots = new Map<string, PluginGenerationSnapshot>()
  let initialBinding: ((key: string) => void) | undefined
  const initial = await factory(profile, {
    ...options,
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
    return new RuntimePluginCatalogue(sources).select(target)
  }
  const bindGeneration = (key: string, id: string): void => {
    if (store.pin(key, id).generationId !== id)
      throw new Error('E_GENERATION_BINDING_CONFLICT: session was bound by another worker')
  }
  const ensureCurrent = async (): Promise<LiveGeneration> => {
    if (current) return current
    const target = initial.runtimeTargetSnapshot?.()
    if (!target) throw new Error('E_GENERATION_TARGET_MISSING: Host has no runtime snapshot')
    const snapshot = store.create(target, await sourcesFor(target), compatibility)
    current = { snapshot, host: initial }
    live.set(snapshot.id, current)
    skillsByGeneration.set(snapshot.id, options.skillResources)
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
    const pinnedSkillRow = target.tree.rows.find((row) => row.id === SKILL_ROW_ID)
    if (
      !skillsByGeneration.has(snapshot.id) &&
      pinnedSkillRow &&
      pinnedSkillRow.entryRevision !== skillRowRevision(skills)
    )
      throw new Error(
        `E_GENERATION_SKILLS_SNAPSHOT_MISSING: generation ${snapshot.id} needs its original Skills view`,
      )
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
        ...(skills ? { skillResources: skills } : {}),
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
      for (const input of preparedRows.values()) host.extensionRows.prepare(input)
      await host.applyRuntimeTarget(decodeRuntimeTargetArtifact(snapshot.artifact))
    } catch (error) {
      await host.close().catch(() => undefined)
      throw error
    }
    const generation = { snapshot, host }
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
    const active = new Set(current?.snapshot.sources.map((source) => source.snapshot.packageId) ?? [])
    const plugins = new Map<string, PluginGenerationStatus['plugins'][number]>()
    const generations: PluginGenerationStatus['generations'][number][] = []
    for (const [id, snapshot] of snapshots) {
      const boundSessions = counts.get(id) ?? 0
      generations.push({
        id,
        state: errors.has(id) ? 'failed' : id === current?.snapshot.id ? 'active' : 'draining',
        ...(errors.has(id) ? { error: errors.get(id) as string } : {}),
        boundSessions,
        packages: snapshot.sources.map((source) => ({
          id: source.snapshot.packageId,
          version: source.snapshot.version,
        })),
      })
      for (const source of snapshot.sources) {
        const packageId = source.snapshot.packageId,
          previous = plugins.get(packageId)
        plugins.set(packageId, {
          id: packageId,
          state: basePackages.has(packageId)
            ? 'restart-required'
            : active.has(packageId)
              ? 'active'
              : errors.has(id)
                ? 'failed'
                : 'draining',
          boundSessions: (previous?.boundSessions ?? 0) + boundSessions,
        })
      }
    }
    for (const id of basePackages)
      if (!plugins.has(id))
        plugins.set(id, { id, state: 'restart-required', boundSessions: store.sessions().length })
    for (const [id, error] of errors) {
      if (snapshots.has(id)) continue
      generations.push({ id, state: 'failed', boundSessions: counts.get(id) ?? 0, packages: [], error })
    }
    return Object.freeze({
      ...(current ? { currentGenerationId: current.snapshot.id } : {}),
      generations: Object.freeze(generations),
      plugins: Object.freeze([...plugins.values()]),
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
    for (const row of target.tree.rows)
      if (row.id === 'seam:sandbox' || row.id === 'seam:platform' || row.id.startsWith('adapter:')) {
        if (JSON.stringify(oldTarget.tree.rows.find((old) => old.id === row.id)) !== JSON.stringify(row))
          throw new Error(`E_GENERATION_RESTART_REQUIRED: ${row.id} requires restart`)
      }
    const snapshot = store.create(target, await sourcesFor(target), compatibility)
    skillsByGeneration.set(snapshot.id, skills ? skills.input : skillsByGeneration.get(head.snapshot.id))
    for (const source of snapshot.sources)
      if (basePackages.has(source.snapshot.packageId)) {
        const previous = head.snapshot.sources.find(
          (item) => item.snapshot.packageId === source.snapshot.packageId,
        )
        if (previous?.snapshot.integrity !== source.snapshot.integrity)
          throw new Error(`E_GENERATION_RESTART_REQUIRED: ${source.snapshot.packageId} requires restart`)
      }
    try {
      current = await build(snapshot)
      await collect()
      return current.host.ordinaryConvergence()
    } catch (error) {
      failures.set(snapshot.id, error instanceof Error ? error.message : String(error))
      failedSnapshots.set(snapshot.id, snapshot)
      throw error
    }
  }
  const overrides: Partial<Host> = {
    kernel,
    pluginGenerationStatus: status,
    sessionGeneration: (key) => store.session(key)?.generationId,
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
          if (pin.loop) generation.host.kernel.loops.resolve(pin.loop)
          const session = await generation.host.createSession({ ...input, key })
          try {
            store.recordLoop(key, session.loop)
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
        await publishTarget(
          buildCompleteRuntimeTarget({
            rows,
            resources: { ...target.resource.resources, skills: { entries: fresh?.list() ?? [] } },
          }).target,
          { input: fresh },
        )
      }),
    setSessionPreset: (key, preset) => owner(key).setSessionPreset(key, preset),
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
