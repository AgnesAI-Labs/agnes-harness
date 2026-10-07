import { createHash } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import { providerRestartRequired } from '@agnes/extension-api'
import {
  developmentPluginRows,
  type PluginGenerationSnapshot,
  RuntimeGenerationSnapshotStore,
  type RuntimePluginSnapshot,
  readDevelopmentPlugin,
} from '@agnes/package-manager'
import {
  decodeRuntimeTargetArtifact,
  encodeRuntimeTargetArtifact,
  type RuntimeTarget,
} from '@agnes/plugin-runtime/host'
import { composeExtensionRowTarget } from './assemble/ext-rows.js'
import { SKILL_ROW_ID, skillRowRevision } from './assemble/skill-row.js'
import { HostError } from './errors.js'
import { createExtensionActivationBarrier } from './ext-host/activation-barrier.js'
import type { Host, HostOptions } from './host.js'
import { createHostFacade } from './host-facade.js'
import { readLiveCompositionSessions } from './profile/composition-state.js'
import { modelProfileDeployment } from './profile/model-compatibility.js'
import type { ResolvedProfile } from './profile/types.js'
import type { SkillRuntimeInput } from './resources/skills.js'
import {
  captureGenerationResources,
  createGenerationSkills,
  restoreGenerationRows,
} from './runtime-generation-resources.js'
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
    drainingSessions: number
    error?: string
  }>[]
}>

type LiveGeneration = { snapshot: PluginGenerationSnapshot; host: Host }
type Factory = (profile: ResolvedProfile, options: HostOptions) => Promise<Host>
const targetRows = (target: RuntimeTarget) => [
  ...new Map(
    [...target.tree.rows, ...Object.values(target.resource.rows).flatMap((row) => (row ? [row] : []))].map(
      (row) => [row.id, row],
    ),
  ).values(),
]

const liveResource = (id: string) => id === SKILL_ROW_ID || /^ext:agnes\/mcp-[a-z0-9-]+-[a-f0-9]{8}$/.test(id)
const liveResourceRow = (row: ReturnType<typeof targetRows>[number]) =>
  liveResource(row.id) && row.plugin.startsWith('builtin:@agnes/base/')
const codeRevision = (target: RuntimeTarget) =>
  buildCompleteRuntimeTarget({
    rows: targetRows(target).filter((row) => !liveResourceRow(row)),
    resources: { mcp: [], skills: {} },
  }).artifact.digest

const registryCodeRevision = (target: RuntimeTarget) =>
  codeRevision(
    buildCompleteRuntimeTarget({
      rows: targetRows(target).filter((row) => !row.id.startsWith('web:') && !row.plugin.startsWith('web:')),
      resources: { mcp: [], skills: {} },
    }).target,
  )

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
  let latestSkills = options.skillResources
  const bindings = new Map<Host, { id: string }>()
  const developmentSources = new Map<string, RuntimePluginSnapshot>()
  const developmentDirectories = new Map(options.developmentPluginDirectories)
  const basePackages = new Set<string>()
  const failures = new Map<string, string>()
  const failedSnapshots = new Map<string, PluginGenerationSnapshot>()
  let initialBinding: ((key: string) => void) | undefined
  const initialSkills = createGenerationSkills(options.skillResources)
  const initial = await factory(profile, {
    ...options,
    ...(options.skillResources ? { skillResources: initialSkills.input } : {}),
    onGenerationBasePackages: (ids) => {
      for (const id of ids) basePackages.add(id)
      options.onGenerationBasePackages?.(ids)
    },
    onGenerationSessionBinding: (key) => initialBinding?.(key),
  })
  let current: LiveGeneration | undefined
  let closed = false
  let queue: Promise<unknown> = Promise.resolve()
  let closing: Promise<void> | undefined
  for (const id of [
    profile.seams.sandbox,
    profile.seams.platform,
    ...profile.packages
      .filter((pkg) => Object.values(profile.adapters).includes(pkg.id))
      .map((pkg) => pkg.id),
  ].filter((id): id is string => typeof id === 'string'))
    basePackages.add(id)
  // Mutable model routes and credential stores follow applyModelProfile. Deployment identity
  // still pins backend and plugin registries, including their loop/adapter selections.
  const compatibilityFor = (profile: ResolvedProfile) => {
    const { secrets: _secrets, ...fixedAdapters } = profile.adapters
    return createHash('sha256')
      .update(
        JSON.stringify({
          adapters: fixedAdapters,
          persistence: profile.persistence,
          sandbox: profile.seams.sandbox,
          sandboxProvider: profile.sandbox,
          platform: profile.seams.platform,
          composition: profile.composition,
          bundlePresets: profile.bundlePresets,
          agnesVersion: options.agnesVersion,
          builtinPackages: profile.packages
            .filter((pkg) => pkg.trust === 'builtin')
            .map(({ id, version, integrity }) => ({ id, version, integrity })),
        }),
      )
      .digest('hex')
  }

  const sourcesFor = async (target: RuntimeTarget): Promise<readonly RuntimePluginSnapshot[]> => {
    const sources =
      (await options.runtimePluginSources?.()) ??
      options.runtimePluginSnapshots ??
      options.runtimePluginCatalogue ??
      []
    const catalogue = new Map(
      [...sources, ...developmentSources.values()].map((source) => [
        `${source.snapshot.packageId}@${source.snapshot.snapshotId}`,
        source,
      ]),
    )
    return new RuntimePluginCatalogue([...catalogue.values()]).select(target)
  }
  const bindGeneration = (key: string, id: string, host: Host): void => {
    const existing = store.session(key)
    if (existing && live.get(existing.generationId)?.host === host) return
    if (store.pin(key, id).generationId !== id)
      throw new Error('E_GENERATION_BINDING_CONFLICT: session was bound by another worker')
  }
  const snapshotTarget = (
    target: RuntimeTarget,
    sources: readonly RuntimePluginSnapshot[],
    skills: SkillRuntimeInput | undefined,
    extensionRows?: readonly ReturnType<Host['extensionRows']['prepare']>[],
  ) =>
    store.create(
      target,
      sources,
      compatibilityFor(profile),
      [
        ...profile.packages
          .filter((pkg) => pkg.trust === 'builtin' && pkg.enabled !== false)
          .map((pkg) => ({ id: pkg.id, version: pkg.version })),
        ...sources.map((source) => ({ id: source.snapshot.packageId, version: source.snapshot.version })),
      ],
      captureGenerationResources(
        skills,
        [...preparedRows.values()].filter((row) =>
          targetRows(target).some(
            (targetRow) => !targetRow.disabled && targetRow.id === `ext:${row.extensionId}`,
          ),
        ),
        (extensionRows ?? (current?.host ?? initial).extensionRows.current()).map((row) => row.id),
      ),
    )
  const ensureCurrent = async (): Promise<LiveGeneration> => {
    if (current) return current
    const target = initial.runtimeTargetSnapshot?.()
    if (!target) throw new Error('E_GENERATION_TARGET_MISSING: Host has no runtime snapshot')
    const snapshot = snapshotTarget(target, await sourcesFor(target), options.skillResources)
    current = { snapshot, host: initial }
    live.set(snapshot.id, current)
    rowsByGeneration.set(snapshot.id, new Map(preparedRows))
    const binding = { id: snapshot.id }
    bindings.set(initial, binding)
    initialBinding = (key) => bindGeneration(key, binding.id, initial)
    return current
  }
  const build = async (snapshot: PluginGenerationSnapshot): Promise<LiveGeneration> => {
    if (snapshot.compatibility !== compatibilityFor(profile))
      throw new Error(
        `E_GENERATION_INCOMPATIBLE: generation ${snapshot.id} needs its original loop/adapter deployment`,
      )
    const skills = latestSkills
    const pinnedTarget = decodeRuntimeTargetArtifact(snapshot.artifact)
    const freshTarget = (current?.host ?? initial).runtimeTargetSnapshot?.() ?? pinnedTarget
    const target = buildCompleteRuntimeTarget({
      rows: [
        ...targetRows(pinnedTarget).filter((row) => !liveResourceRow(row)),
        ...(current?.host ?? initial).extensionRows.current().filter((row) => liveResourceRow(row)),
      ],
      resources: freshTarget.resource.resources,
    }).target
    const generationSkills = createGenerationSkills(skills)
    const pinnedSkillRow = targetRows(target).find((row) => row.id === SKILL_ROW_ID)
    const hasSkills = !!skills
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
    const binding = { id: snapshot.id }
    const host = await factory(
      { ...profile, packages },
      {
        ...generationOptions,
        generationBuiltinRows: targetRows(target).filter((row) => row.plugin.startsWith('builtin:')),
        onGenerationBasePackages: (ids) => {
          for (const id of ids) basePackages.add(id)
          options.onGenerationBasePackages?.(ids)
        },
        ...(hasSkills ? { skillResources: generationSkills.input } : {}),
        packageDirs,
        runtimePluginSnapshots: snapshot.sources,
        runtimePluginSources: async () => snapshot.sources,
        activationBarrier: createExtensionActivationBarrier(),
        onGenerationSessionBinding: (key) => {
          bindGeneration(key, binding.id, host)
        },
      },
    )
    try {
      const savedRows = snapshot.resources
        ? await restoreGenerationRows(snapshot.resources, options, rowsByGeneration.get(snapshot.id))
        : [...(rowsByGeneration.get(snapshot.id) ?? preparedRows).values()]
      const restored = new Map(
        savedRows
          .filter((input) => !liveResource(`ext:${input.extensionId}`))
          .map((input) => [input.extensionId, input]),
      )
      for (const input of preparedRows.values()) {
        if (
          input.dynamic?.generation?.kind !== 'mcp-server' ||
          !targetRows(target).some((row) => row.id === `ext:${input.extensionId}`)
        )
          continue
        const dynamic = options.restoreGenerationExtension
          ? await options.restoreGenerationExtension(input.dynamic.generation)
          : input.dynamic
        restored.set(input.extensionId, { ...input, dynamic })
      }
      for (const input of rowsByGeneration.get(snapshot.id)?.values() ?? [])
        if (!liveResource(`ext:${input.extensionId}`)) restored.set(input.extensionId, input)
      const builtins = host.extensionRows.current()
      for (const row of targetRows(target)) {
        if (!builtins.some((boot) => boot.id === row.id && boot.plugin === row.plugin)) continue
        const id = row.id.slice('ext:'.length)
        if (!restored.has(id))
          restored.set(id, {
            extensionId: id,
            entryRevision: row.entryRevision,
            ...(row.config === undefined ? {} : { config: row.config }),
            ...(row.disabled === undefined ? {} : { disabled: row.disabled }),
          })
      }
      const claims = new Map(builtins.map((row) => [row.id, row]))
      for (const input of restored.values()) {
        const row = host.extensionRows.prepare(input)
        claims.set(row.id, row)
      }
      if (pinnedSkillRow)
        claims.set(
          SKILL_ROW_ID,
          host.extensionRows.prepare({
            extensionId: 'agnes/skills',
            entryRevision: pinnedSkillRow.entryRevision,
            ...(hasSkills ? { skillResources: generationSkills.input } : {}),
          }),
        )
      const rowIds = (snapshot.resources?.data as { extensionRowIds?: string[] } | undefined)?.extensionRowIds
      if (rowIds)
        await host.extensionRows.apply([
          ...rowIds.filter((id) => !liveResource(id)).flatMap((id) => claims.get(id) ?? []),
          ...targetRows(target)
            .filter((row) => liveResource(row.id))
            .flatMap((row) => claims.get(row.id) ?? []),
        ])
      await host.applyRuntimeTarget(target)
    } catch (error) {
      await host.close().catch(() => undefined)
      throw error
    }
    const generation = { snapshot, host }
    bindings.set(host, binding)
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
      if (![...live].some(([otherId, other]) => otherId !== id && other.host === generation.host)) {
        await generation.host.close()
        bindings.delete(generation.host)
      }
      live.delete(id)
      rowsByGeneration.delete(id)
      retired.add(id)
    }
    store.collect(new Set([...live.keys(), ...opening.keys()]), retired)
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
  const requiresRestart = (host: Host, id: string): boolean =>
    basePackages.has(id) ||
    host.providers
      .catalog()
      .some((entry) => entry.sourcePackage === id && providerRestartRequired(entry.scope))
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
          state:
            error || previous?.state === 'failed'
              ? 'failed'
              : requiresRestart(live.get(id)?.host ?? initial, packageId)
                ? 'restart-required'
                : active.has(packageId)
                  ? 'active'
                  : 'draining',
          boundSessions: (previous?.boundSessions ?? 0) + boundSessions,
          drainingSessions:
            (previous?.drainingSessions ?? 0) + (id === current?.snapshot.id ? 0 : boundSessions),
          ...(error ? { error } : {}),
        })
      }
    }
    for (const id of basePackages)
      if (!plugins.has(id))
        plugins.set(id, {
          id,
          state: 'restart-required',
          boundSessions: store.sessions().length,
          drainingSessions: 0,
        })
    for (const [id, error] of errors) {
      if (snapshots.has(id)) continue
      generations.push({ id, state: 'failed', boundSessions: counts.get(id) ?? 0, packages: [], error })
    }
    return Object.freeze({
      ...(current ? { currentGenerationId: current.snapshot.id } : {}),
      generations: Object.freeze(
        generations.map((item) => ({
          ...item,
          ...(item.error
            ? {
                error:
                  item.error.match(/E_[A-Z0-9_]+/)?.[0] ?? 'Plugin generation failed; inspect local logs.',
              }
            : {}),
        })),
      ),
      plugins: Object.freeze(
        [...plugins.values()].map((item) => ({
          ...item,
          ...(item.error
            ? {
                error:
                  item.error.match(/E_[A-Z0-9_]+/)?.[0] ?? 'Plugin generation failed; inspect local logs.',
              }
            : {}),
        })),
      ),
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
  const restoreRetainedClaims = (generation: LiveGeneration) => {
    const saved = rowsByGeneration.get(generation.snapshot.id)
    for (const row of generation.host.extensionRows.current()) {
      if (liveResourceRow(row) || !row.plugin.startsWith('builtin:')) continue
      const extensionId = row.id.slice('ext:'.length)
      generation.host.extensionRows.prepare(
        saved?.get(extensionId) ?? {
          extensionId,
          entryRevision: row.entryRevision,
          ...(row.config === undefined ? {} : { config: row.config }),
          ...(row.disabled === undefined ? {} : { disabled: row.disabled }),
        },
      )
    }
  }
  const publishTarget = async (
    target: RuntimeTarget,
    skills?: { input: SkillRuntimeInput | undefined },
    extensionRows?: readonly ReturnType<Host['extensionRows']['prepare']>[],
  ) => {
    const head = await ensureCurrent()
    const extensionCodeChanged =
      extensionRows !== undefined &&
      JSON.stringify(head.host.extensionRows.current().filter((row) => !liveResourceRow(row))) !==
        JSON.stringify(extensionRows.filter((row) => !liveResourceRow(row)))
    if (
      !extensionCodeChanged &&
      encodeRuntimeTargetArtifact(
        head.host.runtimeTargetSnapshot?.() ?? decodeRuntimeTargetArtifact(head.snapshot.artifact),
      ).digest === encodeRuntimeTargetArtifact(target).digest &&
      head.snapshot.compatibility === compatibilityFor(profile)
    )
      return head.host.ordinaryConvergence()
    const oldTarget =
      head.host.runtimeTargetSnapshot?.() ?? decodeRuntimeTargetArtifact(head.snapshot.artifact)
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
      if (requiresRestart(head.host, previous.snapshot.packageId)) {
        const next = sources.find((item) => item.snapshot.packageId === previous.snapshot.packageId)
        if (
          previous.snapshot.integrity !== next?.snapshot.integrity ||
          previous.snapshot.version !== next?.snapshot.version
        )
          throw new Error(`E_GENERATION_RESTART_REQUIRED: ${previous.snapshot.packageId} requires restart`)
      }
    const skillInput = skills ? skills.input : latestSkills
    const codeChanged =
      extensionCodeChanged ||
      codeRevision(oldTarget) !== codeRevision(target) ||
      head.snapshot.compatibility !== compatibilityFor(profile)
    // prepare() may have replaced a claim on the incumbent before a bound code update forks.
    // Restore its pinned importers before any later resource-only transaction uses that container.
    if (store.sessions().some((pin) => live.get(pin.generationId)?.host === head.host))
      restoreRetainedClaims(head)
    // Resource rows publish to every retained code container, preserving its other row identities.
    const resourceInputs = [...preparedRows.values()].filter(
      (input) =>
        input.dynamic?.generation?.kind === 'mcp-server' &&
        (extensionRows ?? head.host.extensionRows.current()).some(
          (row) => row.id === `ext:${input.extensionId}`,
        ),
    )
    const resourcesChanged =
      !!skills ||
      (extensionRows !== undefined &&
        JSON.stringify(
          head.host.extensionRows.current().filter((row) => row.id !== SKILL_ROW_ID && liveResourceRow(row)),
        ) !== JSON.stringify(extensionRows.filter((row) => row.id !== SKILL_ROW_ID && liveResourceRow(row))))
    for (const host of resourcesChanged
      ? new Set([...live.values()].map((generation) => generation.host))
      : []) {
      if (skills) await host.refreshSkillRow(createGenerationSkills(skillInput).input)
      const resources = resourceInputs.map((input) => host.extensionRows.prepare(input))
      await host.extensionRows.apply([
        ...host.extensionRows.current().filter((row) => row.id === SKILL_ROW_ID || !liveResource(row.id)),
        ...resources,
      ])
      const retained = host.runtimeTargetSnapshot?.()
      if (retained)
        await host.applyRuntimeTarget(
          buildCompleteRuntimeTarget({
            rows: targetRows(retained),
            resources: target.resource.resources,
          }).target,
        )
    }
    latestSkills = skillInput
    if (!codeChanged) {
      if (!extensionRows) await head.host.applyRuntimeTarget(target)
      return head.host.ordinaryConvergence()
    }
    const snapshot = snapshotTarget(target, sources, skillInput, extensionRows)
    rowsByGeneration.set(snapshot.id, new Map(preparedRows))
    try {
      const bound = store.sessions().some((pin) => live.get(pin.generationId)?.host === head.host)
      const neutral =
        !extensionCodeChanged && registryCodeRevision(oldTarget) === registryCodeRevision(target)
      if (!bound || neutral) {
        if (extensionRows) await head.host.extensionRows.apply(extensionRows)
        else await head.host.applyRuntimeTarget(target)
        current = { snapshot, host: head.host }
        live.set(snapshot.id, current)
        const binding = bindings.get(head.host)
        if (binding) binding.id = snapshot.id
      } else {
        current = await build(snapshot)
      }
    } catch (error) {
      failures.set(snapshot.id, error instanceof Error ? error.message : String(error))
      const { resources: _resources, sources: _sources, ...diagnostic } = snapshot
      failedSnapshots.set(snapshot.id, { ...diagnostic, sources: [] })
      rowsByGeneration.delete(snapshot.id)
      // Failed candidates were never published. Retain only their diagnostic, not resource
      // bodies, factory closures or executable archives with no session references.
      try {
        store.collect(new Set([...live.keys(), ...opening.keys()]))
      } catch {
        /* Preserve the activation error. */
      }
      throw error
    }
    // Publication has committed. Retirement failure belongs to the retired generation, and cannot
    // turn a successful head change into a rejected apply/compensation transaction.
    const referenced = new Set(store.sessions().map((pin) => pin.generationId))
    for (const id of failedSnapshots.keys())
      if (!referenced.has(id)) {
        failedSnapshots.delete(id)
        failures.delete(id)
      }
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
    reloadPlugin: (id, directory) =>
      enqueue(async () => {
        const head = await ensureCurrent()
        const pkg = profile.packages.find((pkg) => pkg.id === id)
        if (requiresRestart(head.host, id))
          throw new Error(`E_GENERATION_RESTART_REQUIRED: ${id} owns a workspace/process provider or backend`)
        const available = (await options.runtimePluginSources?.()) ?? options.runtimePluginSnapshots ?? []
        const path =
          directory ??
          developmentDirectories.get(id) ??
          (pkg?.source.startsWith('file:') ? pkg.source.slice(5) : undefined) ??
          available.find((source) => source.snapshot.packageId === id)?.snapshot.directory ??
          options.packageDirs?.get(id)
        if (!path) throw new Error(`E_PLUGIN_RELOAD_SOURCE_MISSING: register a local directory for ${id}`)
        const source = readDevelopmentPlugin(resolvePath(options.workspaceRoot, path), profile.name)
        if (source.snapshot.packageId !== id)
          throw new Error('E_PLUGIN_RELOAD_IDENTITY: local package name differs from the requested id')
        const target =
          head.host.runtimeTargetSnapshot?.() ?? decodeRuntimeTargetArtifact(head.snapshot.artifact)
        const oldRows = [
          ...new Map(
            [
              ...target.tree.rows,
              ...Object.values(target.resource.rows).flatMap((row) => (row ? [row] : [])),
            ].map((row) => [row.id, row]),
          ).values(),
        ]
        const owned = (plugin: string) => plugin.startsWith(`${id}@`) || plugin.startsWith(`builtin:${id}/`)
        const sourcesBefore = new Map(developmentSources)
        developmentSources.set(`${id}@${source.snapshot.snapshotId}`, source)
        try {
          await publishTarget(
            buildCompleteRuntimeTarget({
              rows: [
                ...oldRows.filter((row) => !owned(row.plugin)),
                ...developmentPluginRows(source, oldRows),
              ],
              resources: target.resource.resources,
            }).target,
          )
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
    migrateSessionGeneration: (key) =>
      enqueue(async () => {
        if (
          owner(key).kernel.get(key) ||
          (await readLiveCompositionSessions(options.profileDir)).some(
            (session) => session.sessionKey === key,
          )
        )
          throw new Error('E_GENERATION_SESSION_OPEN: close the session before migration')
        const pin = store.session(key)
        if (!pin) throw new Error('E_GENERATION_PIN_MISSING: session is not bound')
        const head = await ensureCurrent()
        // Validate both immutable archives and the exact saved loop before changing durable facts.
        if (store.read(pin.generationId).compatibility !== head.snapshot.compatibility)
          throw new Error('E_GENERATION_INCOMPATIBLE: session migration needs a compatible deployment')
        store.read(head.snapshot.id)
        if (pin.loop) {
          try {
            head.host.kernel.loops.resolve(pin.loop)
          } catch (cause) {
            throw new Error('E_GENERATION_LOOP_INCOMPATIBLE: target cannot resolve the pinned loop', {
              cause,
            })
          }
        }
        if (pin.generationId === head.snapshot.id)
          return { previousGenerationId: pin.generationId, generationId: pin.generationId, changed: false }
        store.migrateSession(key, pin.generationId, head.snapshot.id)
        try {
          await collect()
        } catch (error) {
          failures.set(pin.generationId, `E_GENERATION_DISPOSE: ${String(error)}`)
        }
        return { previousGenerationId: pin.generationId, generationId: head.snapshot.id, changed: true }
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
          if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed')
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
            if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed')
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
    applyModelProfile: (next) =>
      enqueue(async () => {
        const head = await ensureCurrent()
        if (modelProfileDeployment(next) !== modelProfileDeployment(profile))
          throw new HostError('E_SEAM_IMMUTABLE', 'non-model configuration requires restart')
        const previous = profile
        const applied: { host: Host; profile: ResolvedProfile }[] = []
        try {
          for (const host of new Set([...live.values()].map((generation) => generation.host))) {
            const saved = host.profile
            await host.applyModelProfile({
              ...saved,
              provider: next.provider,
              adapters: { ...saved.adapters, secrets: next.adapters.secrets },
              hash: next.hash,
            })
            applied.push({ host, profile: saved })
          }
          profile = { ...profile, provider: next.provider, adapters: next.adapters, hash: next.hash }
          await publishTarget(
            head.host.runtimeTargetSnapshot?.() ?? decodeRuntimeTargetArtifact(head.snapshot.artifact),
          )
        } catch (error) {
          const rollback = await Promise.allSettled(
            applied.reverse().map(({ host, profile }) => host.applyModelProfile(profile)),
          )
          profile = previous
          const failures = rollback.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
          if (failures.length)
            throw new AggregateError([error, ...failures], 'Model configuration rollback was incomplete')
          throw error
        }
      }),
    applyRuntimeTarget: (target) => enqueue(() => publishTarget(target)),
    refreshSkillRow: (fresh) =>
      enqueue(async () => {
        const head = await ensureCurrent(),
          target = head.host.runtimeTargetSnapshot?.() ?? decodeRuntimeTargetArtifact(head.snapshot.artifact)
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
          ...Object.values(target.resource.rows).flatMap((resource) =>
            resource &&
            resource.id !== SKILL_ROW_ID &&
            !target.tree.rows.some((row) => row.id === resource.id)
              ? [resource]
              : [],
          ),
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
      current: () => (current?.host ?? initial).extensionRows.current(),
      prepare: (input) => {
        if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed')
        preparedRows.set(input.extensionId, input)
        return (current?.host ?? initial).extensionRows.prepare(input)
      },
      apply: (rows) =>
        enqueue(async () => {
          const head = await ensureCurrent()
          const report = await publishTarget(
            buildCompleteRuntimeTarget(
              composeExtensionRowTarget({
                live:
                  head.host.runtimeTargetSnapshot?.() ?? decodeRuntimeTargetArtifact(head.snapshot.artifact),
                fallbackRows: [],
                rows,
                extraOwnedRowIds: new Set([...preparedRows.keys()].map((id) => `ext:${id}`)),
              }),
            ).target,
            undefined,
            rows,
          )
          const wanted = new Set(rows.map((row) => row.id))
          for (const id of preparedRows.keys()) if (!wanted.has(`ext:${id}`)) preparedRows.delete(id)
          return report
        }),
    },
    close: () => {
      if (closing) return closing
      closed = true
      // Claim admitted openings now, before waiting for the outer mutation queue to drain.
      const hosts = new Map<Host, Promise<void>>()
      const claim = (host: Host) => {
        if (!hosts.has(host)) hosts.set(host, host.close())
      }
      claim(initial)
      for (const generation of live.values()) claim(generation.host)
      for (const close of hosts.values()) void close.catch(() => undefined)
      closing = (async () => {
        await queue
        await Promise.allSettled(opening.values())
        for (const generation of live.values()) claim(generation.host)
        const results = await Promise.allSettled(hosts.values())
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
  return createHostFacade(initial, overrides, () => current?.host ?? initial)
}
