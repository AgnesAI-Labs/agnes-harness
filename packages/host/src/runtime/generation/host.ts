import { createHash } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import { providerRestartRequired } from '@agnes/extension-api'
import { HostError } from '@agnes/host-common/errors'
import { modelProfileDeployment } from '@agnes/host-common/profile/model-compatibility'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { composeExtensionRowTarget } from '@agnes/host-extensions/assemble/ext-rows'
import { createExtensionActivationBarrier } from '@agnes/host-extensions/ext-host/activation-barrier'
import type { SkillRuntimeInput } from '@agnes/host-extensions/resources/skills'
import { readGitWorktreeRegistry } from '@agnes/host-infrastructure/git-worktrees'
import { compileRunPlan, seamSelectionsOf } from '@agnes/host-providers/assemble/run-plan'
import { skillRowRevision } from '@agnes/host-providers/assemble/skill-row'
import {
  CompositionSessionStore,
  readLiveCompositionSessions,
} from '@agnes/host-providers/profile/composition-state'
import { RuntimePluginCatalogue } from '@agnes/host-providers/runtime-plugin-catalogue'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import {
  developmentPluginRows,
  generationResourcesDigest,
  type PluginGenerationSnapshot,
  type RuntimePluginSnapshot,
  readDevelopmentPlugin,
} from '@agnes/package-manager'
import {
  decodeRuntimeTargetArtifact,
  encodeRuntimeTargetArtifact,
  type RuntimeTarget,
  type RuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import type { Host, HostOptions } from '../lifecycle/host.js'
import { createHostFacade } from '../lifecycle/host-facade.js'
import { applyLivePluginConfig, overlayLivePluginConfig } from '../lifecycle/live-plugin-config.js'
import { sessionKey } from '../sessions/session.js'
import {
  type ChangeResult,
  type ContainerHandle,
  changeResult,
  type SessionBinding,
} from './change-result.js'
import { assertMigrationSettled } from './migration-state.js'
import { openGenerationStore } from './process-liveness.js'
import { captureGenerationResources, createGenerationSkills, restoreGenerationRows } from './resources.js'
import { describeColdSession, describeHostSession, generationSessions } from './runtime-descriptor.js'
import {
  assertPinsMatch,
  assertRepinConsented,
  describeDifferences,
  diffPins,
  pinnedBindings,
  translateSessionFailure,
} from './seam-pins.js'
import {
  codeRevision,
  codeRow,
  liveResource,
  liveResourceRow,
  registryCodeRevision,
  targetRows,
} from './target-code.js'
import { assertGenerationTrust } from './trust.js'

export type PluginGenerationStatus = Readonly<{
  currentGenerationId?: string
  generations: readonly Readonly<{
    id: string
    state: 'active' | 'draining' | 'historical' | 'failed'
    boundSessions: number
    openSessions: number
    live: boolean
    packages: readonly Readonly<{ id: string; version: string }>[]
    sessions?: readonly Readonly<{ key: string; open: boolean }>[]
    error?: string
  }>[]
  plugins: readonly Readonly<{
    id: string
    state: 'active' | 'draining' | 'historical' | 'restart-required' | 'failed'
    boundSessions: number
    drainingSessions: number
    historicalSessions: number
    error?: string
  }>[]
}>

type LiveGeneration = { snapshot: PluginGenerationSnapshot; host: Host }
type Factory = (profile: ResolvedProfile, options: HostOptions) => Promise<Host>
/**
 * Generation-local containers keep Cordis row identities, extension leases, loop registries and
 * model adapters independent. Storage remains the configured backend; no ledger is duplicated.
 * Durable pins retain disk snapshots; only open sessions keep retired containers in memory.
 */
export async function createRuntimeGenerationHost(
  profile: ResolvedProfile,
  options: HostOptions,
  factory: Factory,
): Promise<Host> {
  const store = await openGenerationStore(options.profileDir)
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
  const pendingRestart = new Set<string>()
  let lastChange: ChangeResult | undefined
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
    sessionGeneration: (key) => store.session(key)?.generationId ?? options.sessionGeneration?.(key),
  })
  let current: LiveGeneration | undefined
  let closed = false
  let queue: Promise<unknown> = Promise.resolve()
  let closing: Promise<void> | undefined
  const idleSince = new Map<Host, number>()
  const configuredIdle = profile.limits['worker.generation_idle_close_ms']
  const idleMs =
    typeof configuredIdle === 'number' && Number.isSafeInteger(configuredIdle) && configuredIdle >= 0
      ? configuredIdle
      : 60_000
  let collector: ReturnType<typeof setTimeout> | undefined
  for (const id of profile.packages
    .filter((pkg) => Object.values(profile.adapters).includes(pkg.id))
    .map((pkg) => pkg.id))
    basePackages.add(id)
  // Mutable model routes and credential stores follow applyModelProfile. Deployment identity
  // still pins backend and plugin registries, including their loop/adapter selections.
  const compatibilityFor = (profile: ResolvedProfile) =>
    compileRunPlan({
      profile,
      ...(options.agnesVersion === undefined ? {} : { agnesVersion: options.agnesVersion }),
    }).processFacets.digest

  const sourcesFor = async (target: RuntimeTarget): Promise<readonly RuntimePluginSnapshot[]> => {
    const sources =
      (await options.runtimePluginSources?.()) ??
      options.runtimePluginSnapshots ??
      options.runtimePluginCatalogue ??
      []
    const catalogue = new Map(
      [...(options.runtimePluginSnapshots ?? []), ...sources, ...developmentSources.values()].map(
        (source) => [`${source.snapshot.packageId}@${source.snapshot.snapshotId}`, source],
      ),
    )
    return new RuntimePluginCatalogue([...catalogue.values()]).select(target)
  }
  const bindGeneration = (key: string, id: string, host: Host): void => {
    const existing = store.session(key)
    const bound = pinnedBindings(host.seamBindings())
    if (existing) assertPinsMatch(key, existing.seams, bound)
    if (existing && live.get(existing.generationId)?.host === host) return
    const pin = store.pin(key, id, bound)
    if (pin.generationId !== id)
      throw new Error('E_GENERATION_BINDING_CONFLICT: session was bound by another worker')
    if (!existing)
      options.audit?.write({
        kind: 'session.seams.pinned',
        detail: { sessionKey: key, generationId: id, seams: bound },
      })
  }
  const headKey = options.compositionPin?.hash ?? 'default'
  const snapshotTarget = (
    target: RuntimeTarget,
    sources: readonly RuntimePluginSnapshot[],
    skills: SkillRuntimeInput | undefined,
    extensionRows?: readonly ReturnType<Host['extensionRows']['prepare']>[],
    reuseHead = false,
  ) => {
    const compatibility = compatibilityFor(profile),
      packages = [
        ...profile.packages
          .filter((pkg) => pkg.trust === 'builtin' && pkg.enabled !== false)
          .map((pkg) => ({ id: pkg.id, version: pkg.version })),
        ...sources.map((source) => ({ id: source.snapshot.packageId, version: source.snapshot.version })),
      ],
      resources = captureGenerationResources(
        skills,
        [...preparedRows.values()].filter((row) =>
          targetRows(target).some(
            (targetRow) => !targetRow.disabled && targetRow.id === `ext:${row.extensionId}`,
          ),
        ),
        (extensionRows ?? (current?.host ?? initial).extensionRows.current()).map((row) => row.id),
      ),
      seams = seamSelectionsOf(
        compileRunPlan({
          profile,
          ...(options.agnesVersion === undefined ? {} : { agnesVersion: options.agnesVersion }),
        }),
      )
    // Workers of one composition share a recorded head instead of each snapshotting the same target.
    const reused = reuseHead
      ? store.reusableHead(headKey, {
          artifactDigest: encodeRuntimeTargetArtifact(target).digest,
          compatibility,
          packages,
          resourcesDigest: generationResourcesDigest(resources),
          seams,
        })
      : undefined
    return reused ?? store.create(target, sources, compatibility, packages, resources, seams)
  }
  const recordHead = (id: string): void => {
    try {
      store.setHead(headKey, id)
    } catch {
      // The pointer is a shortcut; the next worker snapshots afresh.
    }
  }
  const ensureCurrent = async (): Promise<LiveGeneration> => {
    if (current) return current
    const target = initial.runtimeTargetSnapshot?.()
    if (!target) throw new Error('E_GENERATION_TARGET_MISSING: Host has no runtime snapshot')
    const snapshot = snapshotTarget(target, await sourcesFor(target), options.skillResources, undefined, true)
    recordHead(snapshot.id)
    current = { snapshot, host: initial }
    live.set(snapshot.id, current)
    rowsByGeneration.set(snapshot.id, new Map(preparedRows))
    const binding = { id: snapshot.id }
    bindings.set(initial, binding)
    initialBinding = (key) => bindGeneration(key, binding.id, initial)
    return current
  }
  const build = async (
    snapshot: PluginGenerationSnapshot,
    refreshLiveConfig = true,
  ): Promise<LiveGeneration> => {
    if (snapshot.compatibility !== compatibilityFor(profile))
      throw new Error(
        `E_GENERATION_INCOMPATIBLE: generation ${snapshot.id} needs its original loop/adapter deployment`,
      )
    if (!snapshot.seams)
      throw new Error(
        `E_GENERATION_SEAMS_MISSING: generation ${snapshot.id} predates recorded seam selections and cannot be resumed`,
      )
    // The container is compiled from what the generation recorded, not from today's profile, so a
    // selection changed before a restart does not change what an old session resumes on.
    const plan = compileRunPlan({
      profile,
      ...(options.agnesVersion === undefined ? {} : { agnesVersion: options.agnesVersion }),
      snapshotSeams: snapshot.seams,
    })
    await assertGenerationTrust(
      snapshot.sources,
      options.profileDir,
      profile.name,
      options.agnesVersion ?? '0.0.0',
      options.runtimePluginSources,
    )
    const skills = latestSkills
    const archivedTarget = decodeRuntimeTargetArtifact(snapshot.artifact)
    const acceptedConfig = store.liveConfig(snapshot.id)
    const pinnedTarget = acceptedConfig
      ? buildCompleteRuntimeTarget({
          rows: overlayLivePluginConfig(
            targetRows(archivedTarget),
            decodeRuntimeTargetArtifact(acceptedConfig),
          ),
          resources: archivedTarget.resource.resources,
        }).target
      : archivedTarget
    const freshTarget = (current?.host ?? initial).runtimeTargetSnapshot?.() ?? pinnedTarget
    const target = buildCompleteRuntimeTarget({
      rows: [
        ...(refreshLiveConfig
          ? overlayLivePluginConfig(
              targetRows(pinnedTarget).filter((row) => !liveResourceRow(row)),
              freshTarget,
            )
          : targetRows(pinnedTarget).filter((row) => !liveResourceRow(row))),
        ...(current?.host ?? initial).extensionRows.current().filter((row) => liveResourceRow(row)),
      ],
      resources: freshTarget.resource.resources,
    }).target
    const generationSkills = createGenerationSkills(skills)
    const hasSkills = !!skills
    // A disabled row has no selected snapshot, but its package remains part of the composition
    // vocabulary. Keep inactive metadata without importing it; old sessions retain their code pin.
    const packages = profile.packages
      .filter(
        (pkg) =>
          pkg.trust === 'builtin' || !snapshot.sources.some((source) => source.snapshot.packageId === pkg.id),
      )
      .map((pkg) => (pkg.trust === 'builtin' ? pkg : { ...pkg, enabled: false }))
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
    const seams = Object.fromEntries(
      plan.seams.map((seam) => [seam.kind, seam.selection]),
    ) as ResolvedProfile['seams']
    const host = await factory(
      { ...profile, packages, seams },
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
        // Target identities still pin imports; an unbound container may receive newer targets.
        runtimePluginSources: options.runtimePluginSources ?? (async () => snapshot.sources),
        activationBarrier: createExtensionActivationBarrier(),
        sessionGeneration: (key) => store.session(key)?.generationId ?? binding.id,
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
        const selected = targetRows(target).find((row) => row.id === `ext:${input.extensionId}`)
        const row = host.extensionRows.prepare({
          ...input,
          ...(selected?.liveResources?.includes('skills')
            ? {
                liveResourceRevision: skillRowRevision(skills),
                skillResources: hasSkills ? generationSkills.input : undefined,
              }
            : {}),
        })
        claims.set(row.id, row)
      }
      for (const selected of targetRows(target).filter((row) => row.liveResources?.includes('skills'))) {
        const extensionId = selected.id.slice('ext:'.length)
        const input = restored.get(extensionId)
        claims.set(
          selected.id,
          host.extensionRows.prepare({
            ...input,
            extensionId,
            entryRevision: selected.entryRevision,
            liveResourceRevision: skillRowRevision(skills),
            ...(selected.config === undefined ? {} : { config: selected.config }),
            disabled: selected.disabled,
            skillResources: hasSkills ? generationSkills.input : undefined,
          }),
        )
      }
      const rowIds = (snapshot.resources?.data as { extensionRowIds?: string[] } | undefined)?.extensionRowIds
      // Daemon targets omit Host defaults. Keep pinned consumers even when that target names none;
      // explicitly selected resource rows above have already replaced their claims with live inputs.
      if (rowIds)
        await host.extensionRows.apply([
          ...rowIds.filter((id) => !liveResource(id)).flatMap((id) => claims.get(id) ?? []),
          ...targetRows(target)
            .filter(
              (row) => liveResource(row.id) || (!!row.liveResources?.length && !rowIds.includes(row.id)),
            )
            .flatMap((row) => claims.get(row.id) ?? []),
        ])
      await host.applyRuntimeTarget(
        buildCompleteRuntimeTarget({
          rows: targetRows(target).map((row) =>
            row.liveResources?.length ? (claims.get(row.id) ?? row) : row,
          ),
          resources: target.resource.resources,
        }).target,
      )
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
    if (found) {
      await assertGenerationTrust(
        found.snapshot.sources,
        options.profileDir,
        profile.name,
        options.agnesVersion ?? '0.0.0',
        options.runtimePluginSources,
      )
      return found
    }
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
  const openOwner = (key: string): Host | undefined => {
    for (const generation of live.values()) if (generation.host.kernel.get(key)) return generation.host
    const head = current?.host ?? initial
    return head.kernel.get(key) ? head : undefined
  }
  const owner = (key: string): Host => openOwner(key) ?? current?.host ?? initial
  const collect = async (retiredIds: ReadonlySet<string> = new Set()): Promise<void> => {
    if (collector) clearTimeout(collector)
    collector = undefined
    const retired = new Set(retiredIds)
    const errors: unknown[] = []
    const now = Date.now()
    const referenced = new Set(store.sessions().map((pin) => live.get(pin.generationId)?.host))
    const hosts = new Set([...live.values()].map((generation) => generation.host))
    for (const host of hosts) {
      if (host === current?.host || host.kernel.sessions.size > 0) {
        idleSince.delete(host)
        continue
      }
      const since = idleSince.get(host) ?? now
      idleSince.set(host, since)
      if (referenced.has(host) && now - since < idleMs) continue
      try {
        await host.close()
      } catch (error) {
        errors.push(error)
        // close() seals admission even when teardown fails; cold resume must build a new container.
        for (const [id, generation] of live)
          if (generation.host === host) failures.set(id, `E_GENERATION_DISPOSE: ${String(error)}`)
      }
      bindings.delete(host)
      idleSince.delete(host)
      for (const [id, generation] of live)
        if (generation.host === host) {
          live.delete(id)
          rowsByGeneration.delete(id)
          retired.add(id)
        }
    }
    if (!closed && idleSince.size) {
      const next = Math.min(...[...idleSince.values()].map((since) => since + idleMs))
      collector = setTimeout(
        () => {
          collector = undefined
          void enqueue(collect).catch(() => undefined)
        },
        Math.min(2_147_483_647, Math.max(1, next - Date.now())),
      )
      collector.unref()
    }
    await store.collect(new Set([...live.keys(), ...opening.keys()]), retired)
    if (errors.length) throw new AggregateError(errors, 'generation collection failed')
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
    const pins = store.sessions()
    const pinsByKey = new Map(pins.map((pin) => [pin.sessionKey, pin.generationId]))
    for (const pin of pins) counts.set(pin.generationId, (counts.get(pin.generationId) ?? 0) + 1)
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
      const openSessions = [...(live.get(id)?.host.kernel.sessions.values() ?? [])].filter(
        (session) => pinsByKey.get(session.key) === id,
      ).length
      generations.push({
        id,
        state: errors.has(id)
          ? 'failed'
          : id === current?.snapshot.id
            ? 'active'
            : openSessions > 0
              ? 'draining'
              : 'historical',
        ...(errors.has(id) ? { error: errors.get(id) as string } : {}),
        boundSessions,
        openSessions,
        live: live.has(id),
        packages: snapshot.packages,
        sessions: generationSessions(pins, id, (key) => !!live.get(id)?.host.kernel.get(key)),
      })
      for (const pkg of snapshot.packages) {
        const packageId = pkg.id,
          previous = plugins.get(packageId)
        const failed = errors.has(id)
          ? undefined
          : live
              .get(id)
              ?.host.extensions()
              .find((entry) => entry.package === packageId && entry.error)
        const error = failed?.error?.message ?? errors.get(id)
        plugins.set(packageId, {
          id: packageId,
          state:
            error || previous?.state === 'failed'
              ? 'failed'
              : requiresRestart(current?.host ?? initial, packageId)
                ? 'restart-required'
                : active.has(packageId)
                  ? 'active'
                  : openSessions > 0 || previous?.state === 'draining'
                    ? 'draining'
                    : 'historical',
          boundSessions: (previous?.boundSessions ?? 0) + boundSessions,
          drainingSessions:
            (previous?.drainingSessions ?? 0) + (id === current?.snapshot.id ? 0 : boundSessions),
          historicalSessions:
            (previous?.historicalSessions ?? 0) +
            (id === current?.snapshot.id ? 0 : Math.max(0, boundSessions - openSessions)),
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
          historicalSessions: 0,
        })
    for (const [id, error] of errors) {
      if (snapshots.has(id)) continue
      generations.push({
        id,
        state: 'failed',
        boundSessions: counts.get(id) ?? 0,
        openSessions: 0,
        live: false,
        packages: [],
        error,
      })
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
      generation.host.extensionRows.prepare({
        ...(saved?.get(extensionId) ?? {
          extensionId,
          entryRevision: row.entryRevision,
          ...(row.config === undefined ? {} : { config: row.config }),
          ...(row.disabled === undefined ? {} : { disabled: row.disabled }),
        }),
        ...(row.liveResources?.includes('skills')
          ? {
              ...(row.liveResourceRevision === undefined
                ? {}
                : { liveResourceRevision: row.liveResourceRevision }),
              skillResources: latestSkills ? createGenerationSkills(latestSkills).input : undefined,
            }
          : {}),
      })
    }
  }
  const publishTargetCore = async (
    target: RuntimeTarget,
    skills?: { input: SkillRuntimeInput | undefined },
    extensionRows?: readonly ReturnType<Host['extensionRows']['prepare']>[],
    previousTarget?: RuntimeTarget,
  ) => {
    pendingRestart.clear()
    const refuseRestart = (id: string): never => {
      pendingRestart.add(id)
      lastChange = changeResult({
        outcome: 'rejected',
        generationId: current?.snapshot.id ?? '',
        restartRequired: [id],
        failures: [
          {
            stage: 'admission',
            code: 'E_GENERATION_RESTART_REQUIRED',
            message: `${id} requires restart`,
          },
        ],
        recovered: true,
      })
      throw new Error(`E_GENERATION_RESTART_REQUIRED: ${id} requires restart`)
    }
    const head = await ensureCurrent()
    const oldTarget =
      previousTarget ??
      head.host.runtimeTargetSnapshot?.() ??
      decodeRuntimeTargetArtifact(head.snapshot.artifact)
    const extensionCodeChanged =
      extensionRows !== undefined &&
      JSON.stringify(
        head.host.extensionRows
          .current()
          .filter((row) => !liveResourceRow(row))
          .map(codeRow),
      ) !== JSON.stringify(extensionRows.filter((row) => !liveResourceRow(row)).map(codeRow))
    if (
      !skills &&
      !extensionCodeChanged &&
      encodeRuntimeTargetArtifact(oldTarget).digest === encodeRuntimeTargetArtifact(target).digest
    ) {
      lastChange = changeResult({ outcome: 'unchanged', generationId: head.snapshot.id })
      return head.host.ordinaryConvergence()
    }
    // Backend facets are process configuration. A package generation cannot replace them live, and the
    // deployment fingerprint is fixed per process, so these row and package checks are the restart guards.
    for (const row of [...oldTarget.tree.rows, ...target.tree.rows])
      if (row.id.startsWith('adapter:')) {
        if (
          JSON.stringify(oldTarget.tree.rows.find((old) => old.id === row.id)) !==
          JSON.stringify(target.tree.rows.find((next) => next.id === row.id))
        )
          refuseRestart(row.id)
      }
    const sources = await sourcesFor(target)
    for (const previous of head.snapshot.sources)
      if (requiresRestart(head.host, previous.snapshot.packageId)) {
        const next = sources.find((item) => item.snapshot.packageId === previous.snapshot.packageId)
        if (
          previous.snapshot.integrity !== next?.snapshot.integrity ||
          previous.snapshot.version !== next?.snapshot.version
        )
          refuseRestart(previous.snapshot.packageId)
      }
    const skillInput = skills ? skills.input : latestSkills
    const codeChanged = extensionCodeChanged || codeRevision(oldTarget) !== codeRevision(target)
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
        JSON.stringify(head.host.extensionRows.current().filter((row) => liveResourceRow(row))) !==
          JSON.stringify(extensionRows.filter((row) => liveResourceRow(row))))
    for (const host of resourcesChanged
      ? new Set([...live.values()].map((generation) => generation.host))
      : []) {
      if (skills)
        await host.refreshSkillRow(skillInput ? createGenerationSkills(skillInput).input : undefined)
      const resources = resourceInputs.map((input) => host.extensionRows.prepare(input))
      await host.extensionRows.apply([
        ...host.extensionRows.current().filter((row) => !liveResource(row.id)),
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
      if (!extensionRows && !skills) await head.host.applyRuntimeTarget(target)
      lastChange = changeResult({ outcome: 'in-place', generationId: head.snapshot.id })
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
        lastChange = changeResult({
          outcome: 'in-place',
          generationId: snapshot.id,
          before: head.host.seamBindings(),
          after: head.host.seamBindings(),
        })
      } else {
        const before = head.host.seamBindings()
        current = await build(snapshot, false)
        lastChange = changeResult({
          outcome: 'forked',
          generationId: snapshot.id,
          before,
          after: current.host.seamBindings(),
        })
      }
    } catch (error) {
      failures.set(snapshot.id, error instanceof Error ? error.message : String(error))
      const failure = error instanceof Error ? error.message : String(error)
      lastChange = changeResult({
        outcome: 'rejected',
        generationId: head.snapshot.id,
        failures: [
          { stage: 'build', code: failure.match(/E_[A-Z0-9_]+/)?.[0] ?? 'E_GENERATION', message: failure },
        ],
        recovered: true,
      })
      const { resources: _resources, sources: _sources, ...diagnostic } = snapshot
      failedSnapshots.set(snapshot.id, { ...diagnostic, sources: [] })
      rowsByGeneration.delete(snapshot.id)
      // Failed candidates were never published. Retain only their diagnostic, not resource
      // bodies, factory closures or executable archives with no session references.
      try {
        await store.collect(new Set([...live.keys(), ...opening.keys()]))
      } catch {
        /* Preserve the activation error. */
      }
      throw error
    }
    recordHead(current.snapshot.id)
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
  const publishTarget: typeof publishTargetCore = async (target, skills, extensionRows) => {
    const head = await ensureCurrent()
    const previous =
      head.host.runtimeTargetSnapshot?.() ?? decodeRuntimeTargetArtifact(head.snapshot.artifact)
    const beforeConfig = new Map([...live.values()].map(({ host }) => [host, host.runtimeTargetSnapshot?.()]))
    const configRecords: { id: string; previous: RuntimeTargetArtifact | undefined }[] = []
    const rollback = await applyLivePluginConfig(
      [...live.values()].map((generation) => generation.host),
      target,
    )
    const beforeSkills = latestSkills
    const retained = skills
      ? [...new Set([...live.values()].map((generation) => generation.host))].map((host) => ({
          host,
          target: host.runtimeTargetSnapshot?.(),
        }))
      : []
    try {
      for (const [id, generation] of live) {
        const before = beforeConfig.get(generation.host),
          after = generation.host.runtimeTargetSnapshot?.()
        if (!before || !after || JSON.stringify(before.tree.rows) === JSON.stringify(after.tree.rows))
          continue
        configRecords.push({ id, previous: store.liveConfig(id) })
        store.saveLiveConfig(id, encodeRuntimeTargetArtifact(after))
      }
      return await publishTargetCore(target, skills, extensionRows, previous)
    } catch (error) {
      const failures: unknown[] = []
      for (const { host, target } of retained.reverse()) {
        try {
          await host.refreshSkillRow(beforeSkills ? createGenerationSkills(beforeSkills).input : undefined)
          if (target) await host.applyRuntimeTarget(target)
        } catch (cause) {
          failures.push(cause)
        }
      }
      latestSkills = beforeSkills
      try {
        await rollback()
      } catch (cause) {
        failures.push(cause)
      }
      for (const { id, previous } of configRecords.reverse()) {
        try {
          store.saveLiveConfig(id, previous)
        } catch (cause) {
          failures.push(cause)
        }
      }
      if (failures.length)
        throw new AggregateError([error, ...failures], 'Live resource rollback was incomplete')
      throw error
    }
  }
  const overrides: Partial<Host> = {
    kernel,
    pluginGenerationStatus: status,
    securityStatus: () => {
      const head = (current?.host ?? initial).securityStatus?.()
      if (!head) throw new Error('Security status is unavailable')
      return {
        ...head,
        workspaces: [...live.values()].flatMap(({ host }) => host.securityStatus?.().workspaces ?? []),
      }
    },
    sessionGeneration: (key) => store.session(key)?.generationId,
    lastChange: () => lastChange,
    containerHandle: (id): ContainerHandle | undefined => {
      const generation = live.get(id)
      return generation
        ? { generationId: id, seams: generation.host.seamBindings(), close: () => generation.host.close() }
        : undefined
    },
    sessionBinding: (key): SessionBinding | undefined => {
      const pin = store.session(key)
      return pin
        ? {
            sessionKey: key,
            generationId: pin.generationId,
            ...(pin.loop ? { loop: pin.loop } : {}),
            pinnedSeams: pin.seams ?? [],
          }
        : undefined
    },
    sessionRuntime: (key) => {
      const host = openOwner(key)
      if (!host) {
        const pin = store.session(key)
        // A record this build cannot read leaves the composition unknown; a query never fails on it.
        const binding = (() => {
          try {
            return new CompositionSessionStore(options.profileDir).read(key)
          } catch {
            return undefined
          }
        })()
        return describeColdSession({
          sessionKey: key,
          ...(pin ? { pin } : {}),
          ...(current ? { headId: current.snapshot.id } : {}),
          failed: pin ? failures.has(pin.generationId) : false,
          ...(binding
            ? {
                composition: {
                  hash: binding.tree.hash,
                  preset: binding.tree.preset,
                  bundles: binding.tree.bundles,
                },
              }
            : {}),
        })
      }
      const id = store.session(key)?.generationId ?? bindings.get(host)?.id
      return describeHostSession(host, current?.host ?? initial, key, {
        ...(id ? { id, digest: live.get(id)?.snapshot.resourcesDigest } : {}),
        failed: failures.has(id ?? ''),
        newerId: current && host !== current.host ? current.snapshot.id : undefined,
        restartRequired: [...pendingRestart],
        pins: store.session(key)?.seams,
      })
    },
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
        const pin = store.session(key)
        store.releaseSession(key)
        await collect(new Set(pin ? [pin.generationId] : []))
      }),
    migrateSessionGeneration: (key, context) =>
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
        await assertMigrationSettled(
          owner(key).kernel.o.storage,
          key,
          pin.generationId,
          context?.recoveryRequired?.(),
          { workspaceRoot: options.workspaceRoot, records: readGitWorktreeRegistry(options.dataDir) },
        )
        if (pin.generationId === head.snapshot.id)
          return { previousGenerationId: pin.generationId, generationId: pin.generationId, changed: false }
        // A pinned seam is replaced only when the request names it; otherwise nothing durable changes.
        const target = pinnedBindings(head.host.seamBindings())
        const differences = pin.seams ? diffPins(pin.seams, target) : []
        assertRepinConsented(key, differences, context?.repin ?? [])
        store.migrateSession(key, pin.generationId, head.snapshot.id, target)
        if (differences.length)
          options.audit?.write({
            kind: 'session.seams.repinned',
            detail: {
              sessionKey: key,
              from: pin.generationId,
              to: head.snapshot.id,
              operator: context?.operator ?? 'unknown',
              changes: describeDifferences(differences),
              kinds: differences.map((item) => item.kind),
            },
          })
        try {
          await collect(new Set([pin.generationId]))
        } catch (error) {
          failures.set(pin.generationId, `E_GENERATION_DISPOSE: ${String(error)}`)
        }
        return {
          previousGenerationId: pin.generationId,
          generationId: head.snapshot.id,
          changed: true,
          ...(differences.length ? { repinned: differences.map((item) => item.kind) } : {}),
        }
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
        const existing = (() => {
          try {
            return store.session(key)
          } catch (error) {
            throw translateSessionFailure(error, key)
          }
        })()
        const desiredId = input.parent
          ? (store.session(input.parent.key)?.generationId ?? head.snapshot.id)
          : head.snapshot.id
        const pin = existing ?? { generationId: desiredId, loop: undefined }
        const generation = await resolve(pin.generationId).catch((error: unknown) => {
          throw translateSessionFailure(error, key)
        })
        idleSince.delete(generation.host)
        try {
          if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed')
          if (existing) assertPinsMatch(key, existing.seams, pinnedBindings(generation.host.seamBindings()))
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
              if (!closed) void enqueue(collect).catch(() => undefined)
            }
          }
          failures.delete(pin.generationId)
          return session
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!closed) void enqueue(collect).catch(() => undefined)
          if (message.includes('E_GENERATION_') || message.startsWith('Loop '))
            failures.set(pin.generationId, message)
          throw translateSessionFailure(error, key)
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
        const consumers = targetRows(target).filter((row) => row.liveResources?.includes('skills'))
        // An empty global catalogue cannot prove a supplied workspace-scoped source is unchanged.
        if (
          consumers.length &&
          consumers.every(
            (row) =>
              row.liveResourceRevision === revision &&
              (row.disabled || head.host.extensions().find((entry) => `ext:${entry.id}` === row.id)?.loaded),
          ) &&
          !fresh?.scopeWorkspace
        )
          return
        const previous = new Map(preparedRows)
        const restoreConsumers = () => {
          for (const row of consumers) {
            const extensionId = row.id.slice('ext:'.length)
            head.host.extensionRows.prepare({
              ...previous.get(extensionId),
              extensionId,
              entryRevision: row.entryRevision,
              ...(row.liveResourceRevision === undefined
                ? {}
                : { liveResourceRevision: row.liveResourceRevision }),
              ...(row.config === undefined ? {} : { config: row.config }),
              disabled: row.disabled,
              skillResources: latestSkills,
            })
          }
        }
        try {
          const replacements = new Map(
            consumers
              .filter((row) => !row.disabled)
              .map((row) => {
                const extensionId = row.id.slice('ext:'.length)
                const input = {
                  ...preparedRows.get(extensionId),
                  extensionId,
                  entryRevision: row.entryRevision,
                  liveResourceRevision: revision,
                  ...(row.config === undefined ? {} : { config: row.config }),
                  disabled: row.disabled,
                  skillResources: fresh,
                }
                const candidate = head.host.extensionRows.prepare(input)
                preparedRows.set(extensionId, input)
                return [row.id, candidate]
              }),
          )
          restoreConsumers()
          await publishTarget(
            buildCompleteRuntimeTarget({
              rows: targetRows(target).map((row) => replacements.get(row.id) ?? row),
              resources: { ...target.resource.resources, skills: { entries: fresh?.list() ?? [] } },
            }).target,
            { input: fresh },
          )
        } catch (error) {
          preparedRows.clear()
          for (const [id, input] of previous) preparedRows.set(id, input)
          try {
            restoreConsumers()
          } catch (cause) {
            throw new AggregateError([error, cause], 'Live resource prepared-row rollback was incomplete')
          }
          throw error
        }
      }),
    reloadEcosystemExtension: async (id, freshInit) => {
      if (
        !(current?.host ?? initial).extensionRows
          .current()
          .some((row) => row.id === `ext:${id}` && row.liveResources?.includes('skills'))
      )
        return (current?.host ?? initial).reloadEcosystemExtension(id, freshInit)
      await overrides.refreshSkillRow?.(freshInit.skillResources)
      const result = (current?.host ?? initial).extensions().find((entry) => entry.id === id)
      if (!result) throw new Error('E_GENERATION_RESOURCE: Live resource consumer has no status')
      return result
    },
    sessionCapabilities: (key) => owner(key).sessionCapabilities!(key),
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
      if (collector) clearTimeout(collector)
      collector = undefined
      idleSince.clear()
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
        await store.collect(new Set())
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
