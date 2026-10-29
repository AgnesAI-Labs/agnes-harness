import type { ProviderCatalogEntry } from '@agnes/extension-api'
import type { PluginGenerationSnapshot, RuntimeGenerationSnapshotStore } from '@agnes/package-manager'
import {
  publicErrorContract,
  type SessionCapabilitySet,
  type SessionRuntimeDescriptor,
} from '@agnes/protocol'
import type { Host } from '../lifecycle/host.js'
import { type GenerationFailure, generationFailure } from './failure.js'

type Provider = SessionRuntimeDescriptor['providers'][number]
type Pending = NonNullable<Provider['pending']>
type Effect = Pending['effect']

const selectedProviders = (seams: Host['profile']['seams']): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(seams).map(([kind, selection]) => [kind, selection.provider]))

/** One container's view: what its own configuration selects, independent of any session. */
export type ContainerView = Readonly<{
  catalog: readonly ProviderCatalogEntry[]
  seams: Readonly<Record<string, string>>
}>

export type SessionRuntimeInput = Readonly<{
  sessionKey: string
  generation: Readonly<{
    id?: string
    state: SessionRuntimeDescriptor['generation']['state']
    digest?: string
    /** Id of the generation new sessions open on, when it is not this one. */
    newerId?: string
  }>
  capabilities: SessionCapabilitySet
  permission?: { policy: string; principal: string }
  /** The container the session runs in, and the one new sessions would open in. */
  running: ContainerView
  configured: ContainerView
  /** Seam kinds whose binding is kept per session, so a later change cannot reach it. */
  pinnedSeams?: ReadonlySet<string>
  /** What the session was bound to for those kinds; the binding shown is this one, not today's selection. */
  pinnedBindings?: readonly Readonly<{ kind: string; provider: string; version: string }>[]
  profileHash: string
  modelRevision?: string | null
  resourceRows: readonly Readonly<{
    id: string
    liveResources?: readonly string[]
    liveResourceRevision?: string
  }>[]
  sandbox?: Readonly<{
    policyDigest?: string
    enforcement?: NonNullable<NonNullable<SessionRuntimeDescriptor['policy']>['sandbox']['enforcement']>
  }>
  restartRequired: readonly string[]
}>

const entryKey = (entry: Pick<ProviderCatalogEntry, 'id' | 'version'>) => `${entry.id}@${entry.version}`
const active = (catalog: readonly ProviderCatalogEntry[], kind: string) =>
  catalog.filter((entry) => entry.kind === kind && entry.active)

/** The session's own choice for a kind, as the capability snapshot records it. */
function selectedIds(capabilities: SessionCapabilitySet): Map<string, readonly string[]> {
  const { compaction, persistence, sandbox, permissions, loop, selectedModelAdapters } = capabilities
  const single = (kind: string, id: string | null | undefined): [string, readonly string[]][] =>
    id ? [[kind, [id]]] : []
  return new Map([
    ...single('loop', loop.value.id),
    ...(selectedModelAdapters.length ? ([['model-adapter', selectedModelAdapters]] as const) : []),
    ...single('compaction', compaction.engine),
    ...single('persistence', persistence.provider),
    ...single('sandbox', sandbox.provider),
    ...single('tool-runtime', permissions.toolRuntime),
    ...single('tool-policy', permissions.policy),
  ])
}

const effectFor = (scope: ProviderCatalogEntry['scope']): Effect =>
  scope === 'process' ? 'restart-required' : 'new-sessions'

/**
 * Describes one session from facts the Host already holds. A provider shows `pending` only when
 * the session still follows its container's own selection and the configured container selects
 * something else; a session that chose its own provider is not behind.
 */
export function describeSessionRuntime(input: SessionRuntimeInput): SessionRuntimeDescriptor {
  const { capabilities, running, configured } = input
  const chosen = selectedIds(capabilities)
  for (const entry of running.catalog)
    if (entry.active && !chosen.has(entry.kind) && !['loop', 'model-adapter'].includes(entry.kind))
      chosen.set(entry.kind, [entry.id])
  const providers: Provider[] = []
  for (const [kind, ids] of [...chosen].sort(([a], [b]) => a.localeCompare(b))) {
    const runningDefault = active(running.catalog, kind)
    const configuredDefault = active(configured.catalog, kind)
    const drifted =
      runningDefault.map(entryKey).sort().join() !== configuredDefault.map(entryKey).sort().join()
    for (const id of ids) {
      const entry =
        running.catalog.find(
          (candidate) => candidate.kind === kind && candidate.id === id && candidate.active,
        ) ??
        running.catalog.find(
          (candidate) => candidate.kind === kind && (candidate.id === id || candidate.sourcePackage === id),
        )
      const follows = runningDefault.length === 0 || runningDefault.some((item) => item.id === id)
      const next = drifted && follows ? configuredDefault[0] : undefined
      providers.push({
        kind,
        id: entry?.id ?? id,
        ...(entry ? { version: entry.version, sourcePackage: entry.sourcePackage, scope: entry.scope } : {}),
        binding: entry?.scope === 'process' ? 'process' : 'generation',
        ...(next ? { pending: { id: next.id, version: next.version, effect: effectFor(next.scope) } } : {}),
      })
    }
  }
  const seams = Object.entries(running.seams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, running]) => {
      const next = configured.seams[kind]
      const bound = input.pinnedBindings?.find((binding) => binding.kind === kind)
      const provider = bound?.provider ?? running
      return {
        kind,
        provider,
        ...(bound ? { version: bound.version } : {}),
        pinned: input.pinnedSeams?.has(kind) ?? false,
        ...(next !== undefined && next !== provider
          ? { pending: { id: next, effect: 'new-sessions' as const } }
          : {}),
      }
    })
  const restartRequired = [
    ...new Set([
      ...input.restartRequired,
      ...providers.filter((item) => item.pending?.effect === 'restart-required').map((item) => item.kind),
    ]),
  ].sort()
  const { permissions, sandbox } = capabilities
  const resources = input.resourceRows.filter((row) => row.liveResources?.length)
  return {
    sessionKey: input.sessionKey,
    loaded: true,
    generation: {
      ...(input.generation.id ? { id: input.generation.id } : {}),
      current: input.generation.newerId === undefined,
      state: input.generation.state,
      ...(input.generation.newerId
        ? { newer: { id: input.generation.newerId, effect: 'new-sessions' as const } }
        : {}),
    },
    ...(capabilities.compositionHash ? { composition: { hash: capabilities.compositionHash } } : {}),
    preset: { name: capabilities.preset, bundles: [...capabilities.bundles] },
    loop: { id: capabilities.loop.value.id, version: capabilities.loop.value.version },
    providers,
    seams,
    resources: {
      profileHash: input.profileHash,
      ...(input.modelRevision ? { modelRevision: input.modelRevision } : {}),
      ...(input.generation.digest ? { generationDigest: input.generation.digest } : {}),
      items: resources.map((row) => ({
        id: row.id,
        resources: [...(row.liveResources ?? [])],
        ...(row.liveResourceRevision ? { revision: row.liveResourceRevision } : {}),
      })),
    },
    policy: {
      ...(input.permission ? { permission: input.permission } : {}),
      ...(permissions.approvalMode ? { approvalMode: permissions.approvalMode } : {}),
      toolPolicy: permissions.policy,
      toolRuntime: permissions.toolRuntime,
      readOnly: permissions.readOnly,
      sandbox: {
        provider: sandbox.provider,
        onUnavailable: sandbox.onUnavailable,
        ...(input.sandbox?.policyDigest ? { policyDigest: input.sandbox.policyDigest } : {}),
        ...(input.sandbox?.enforcement ? { enforcement: input.sandbox.enforcement } : {}),
      },
    },
    restartRequired,
  }
}

export type ColdSessionInput = Readonly<{
  sessionKey: string
  /** The session's durable generation pin; absent in a deployment without pins. */
  pin?: Readonly<{
    generationId: string
    loop?: Readonly<{ id: string; version: string }>
    seams?: readonly Readonly<{ kind: string; provider: string; version: string }>[]
  }>
  /** Where the head of the session's composition is found. */
  head: ColdHeadInput
  failed: boolean
  /** The session's recorded composition intent. */
  composition?: Readonly<{ hash: string; preset: string; bundles: readonly string[] }>
}>

type ColdHeadInput = Readonly<{
  /** This host serves one composition among several, rather than being the whole deployment. */
  scoped: boolean
  ownKey: string
  ownHeadId?: string
  durableHeadId(compositionHash: string): string | undefined
}>

/**
 * The generation new sessions open on for the composition a cold session belongs to. Inside a
 * composition container this host may only be the fallback owner of a session of another composition,
 * so its own head answers only for its own composition; another composition's head is read from the
 * durable record. With no readable composition record the head is unknown and none is claimed.
 */
export function coldHeadId(input: ColdHeadInput & { compositionHash?: string }): string | undefined {
  if (!input.scoped) return input.ownHeadId
  if (input.compositionHash === undefined) return undefined
  return input.compositionHash === input.ownKey ? input.ownHeadId : input.durableHeadId(input.compositionHash)
}

/**
 * Describes a session no container has open from its durable records alone. Providers, resources and
 * policy need a live container, so they are left out instead of being read from today's Host, which
 * may not be the configuration this session was written under.
 */
export function describeColdSession(input: ColdSessionInput): SessionRuntimeDescriptor {
  const { pin } = input,
    headId = coldHeadId({
      ...input.head,
      ...(input.composition ? { compositionHash: input.composition.hash } : {}),
    })
  const current = !pin || headId === undefined || pin.generationId === headId
  return {
    sessionKey: input.sessionKey,
    loaded: false,
    generation: {
      ...(pin ? { id: pin.generationId } : {}),
      current,
      state: input.failed ? 'failed' : current ? 'active' : 'historical',
      ...(current || !headId ? {} : { newer: { id: headId, effect: 'new-sessions' as const } }),
    },
    ...(input.composition ? { composition: { hash: input.composition.hash } } : {}),
    ...(input.composition
      ? { preset: { name: input.composition.preset, bundles: [...input.composition.bundles] } }
      : {}),
    ...(pin?.loop ? { loop: { id: pin.loop.id, version: pin.loop.version } } : {}),
    providers: [],
    seams: (pin?.seams ?? []).map((seam) => ({
      kind: seam.kind,
      provider: seam.provider,
      version: seam.version,
      pinned: true,
    })),
    restartRequired: [],
  }
}

/** Gathers one container's facts for the session it hosts; `head` is the container new sessions open on. */
export function describeHostSession(
  host: Host,
  head: Host,
  sessionKey: string,
  generation: Readonly<{
    id?: string
    digest?: string | undefined
    failed: boolean
    newerId?: string | undefined
    restartRequired: readonly string[]
    /** The session's recorded pinned bindings, from its durable pin. */
    pins?: readonly Readonly<{ kind: string; provider: string; version: string }>[] | undefined
  }>,
): SessionRuntimeDescriptor {
  const workspace = host.securityStatus?.().workspaces.find((item) => item.sessionId === sessionKey)
  const permission = host.kernel.get(sessionKey)?.permissionContext
  return describeSessionRuntime({
    sessionKey,
    generation: {
      ...(generation.id ? { id: generation.id } : {}),
      state: generation.failed ? 'failed' : generation.newerId ? 'draining' : 'active',
      ...(generation.digest ? { digest: generation.digest } : {}),
      ...(generation.newerId ? { newerId: generation.newerId } : {}),
    },
    capabilities: host.sessionCapabilities!(sessionKey),
    ...(permission ? { permission: { policy: permission.policy, principal: permission.actor.id } } : {}),
    running: { catalog: host.providers.catalog(), seams: selectedProviders(host.profile.seams) },
    configured: { catalog: head.providers.catalog(), seams: selectedProviders(head.profile.seams) },
    ...(generation.pins?.length
      ? {
          pinnedSeams: new Set(generation.pins.map((pin) => pin.kind)),
          pinnedBindings: generation.pins,
        }
      : {}),
    profileHash: host.profile.hash,
    modelRevision: host.providerFingerprint,
    resourceRows: host.extensionRows.current(),
    ...(workspace
      ? {
          sandbox: {
            ...(workspace.policyDigest ? { policyDigest: workspace.policyDigest } : {}),
            ...(workspace.enforcement ? { enforcement: workspace.enforcement } : {}),
          },
        }
      : {}),
    restartRequired: generation.restartRequired,
  })
}

/** The bounded session list one admin generation entry shows. */
export const generationSessions = (
  pins: readonly Readonly<{ sessionKey: string; generationId: string }>[],
  generationId: string,
  open: (sessionKey: string) => boolean,
) =>
  pins
    .filter((pin) => pin.generationId === generationId)
    .slice(0, 256)
    .map((pin) => ({ key: pin.sessionKey, open: open(pin.sessionKey) }))

type Generation = ReturnType<NonNullable<Host['pluginGenerationStatus']>>['generations'][number]

/** Each composition reports its open subset of the same durable generation pins. */
export function mergeGenerationStatus(
  previous: Generation,
  item: Generation,
  opened: Iterable<{ key: string; pluginGenerationId?: string }>,
): Generation {
  const sessions = new Map<string, { key: string; open: boolean }>()
  for (const session of [...(previous.sessions ?? []), ...(item.sessions ?? [])])
    sessions.set(session.key, { ...session, open: session.open || sessions.get(session.key)?.open === true })
  // The displayed list is capped at 256; count actual live sessions, including those outside it.
  const openSessions = [...opened].filter((session) => session.pluginGenerationId === item.id).length
  return {
    ...item,
    state:
      previous.state === 'active' || item.state === 'active'
        ? 'active'
        : previous.state === 'failed' || item.state === 'failed'
          ? 'failed'
          : openSessions > 0
            ? 'draining'
            : 'historical',
    boundSessions: Math.max(previous.boundSessions, item.boundSessions),
    ...(previous.current !== undefined || item.current !== undefined
      ? { current: previous.current === true || item.current === true }
      : {}),
    openSessions,
    live: previous.live || item.live,
    ...(previous.sessions || item.sessions ? { sessions: [...sessions.values()] } : {}),
  }
}

type GenerationStatus = ReturnType<NonNullable<Host['pluginGenerationStatus']>>
type GenerationDescription = Pick<PluginGenerationSnapshot, 'id' | 'packages'>

export function addBasePackageStatus(
  plugins: Map<string, GenerationStatus['plugins'][number]>,
  packages: Iterable<string>,
  boundSessions: number,
): void {
  for (const id of packages)
    if (!plugins.has(id))
      plugins.set(id, {
        id,
        state: 'restart-required',
        boundSessions,
        drainingSessions: 0,
        historicalSessions: 0,
      })
}

/** Build the status snapshot view without importing or restoring a cold runtime. */
export function generationStatusSnapshots(
  ids: Iterable<string>,
  live: ReadonlyMap<string, { snapshot: PluginGenerationSnapshot }>,
  failed: ReadonlyMap<string, PluginGenerationSnapshot>,
  errors: Map<string, GenerationFailure>,
  read: (id: string) => GenerationDescription,
): Map<string, GenerationDescription> {
  const snapshots = new Map<string, GenerationDescription>([
    ...failed,
    ...[...live].map(([id, generation]) => [id, generation.snapshot] as const),
  ])
  for (const id of ids) {
    if (snapshots.has(id)) continue
    try {
      snapshots.set(id, read(id))
    } catch (error) {
      errors.set(id, generationFailure(error))
    }
  }
  return snapshots
}

/** Freeze the public view; only schema-owned error identifiers may leave the Host. */
export function freezeGenerationStatus(status: GenerationStatus): GenerationStatus {
  const safe = <T extends { error?: string }>(item: T) =>
    Object.freeze({
      ...item,
      ...(item.error
        ? {
            error: publicErrorContract(item.error)
              ? item.error
              : 'Plugin generation failed; inspect local logs.',
          }
        : {}),
    })
  return Object.freeze({
    ...status,
    ...(status.blocked ? { blocked: Object.freeze(status.blocked.slice(0, 256)) } : {}),
    generations: Object.freeze(status.generations.map(safe)),
    plugins: Object.freeze(status.plugins.map(safe)),
  })
}

/** Show a draining composition without changing the underlying durable status. */
export function projectGenerationStatus(
  status: GenerationStatus,
  draining: boolean | undefined,
): GenerationStatus {
  if (!draining) return status
  const { currentGenerationId: _current, ...retained } = status
  return {
    ...retained,
    generations: status.generations.map((item) => ({
      ...item,
      current: false,
      state: item.state === 'active' ? (item.openSessions > 0 ? 'draining' : 'historical') : item.state,
    })),
    plugins: status.plugins.map((item) => ({
      ...item,
      state:
        item.state === 'active'
          ? status.generations.some(
              (generation) =>
                generation.openSessions > 0 && generation.packages.some((pkg) => pkg.id === item.id),
            )
            ? 'draining'
            : 'historical'
          : item.state,
      drainingSessions: item.boundSessions,
      historicalSessions: status.generations
        .filter((generation) => generation.packages.some((pkg) => pkg.id === item.id))
        .reduce(
          (count, generation) => count + Math.max(0, generation.boundSessions - generation.openSessions),
          0,
        ),
    })),
  }
}

/** Read historical descriptions; resume/migration separately verify the executable archive. */
export async function readGenerationStatusAsync(
  store: Pick<RuntimeGenerationSnapshotStore, 'sessions' | 'describe'>,
  describe: (
    pins: ReturnType<RuntimeGenerationSnapshotStore['sessions']>,
    read: (id: string) => GenerationDescription,
  ) => GenerationStatus,
  loaded: readonly ReadonlyMap<string, unknown>[],
): Promise<GenerationStatus> {
  const pins = store.sessions()
  const ids = [...new Set(pins.map((pin) => pin.generationId))].filter(
    (id) => !loaded.some((snapshots) => snapshots.has(id)),
  )
  const snapshots = new Map<string, GenerationDescription>()
  const errors = new Map<string, unknown>()
  for (const id of ids) {
    try {
      snapshots.set(id, store.describe(id))
    } catch (error) {
      errors.set(id, error)
    }
  }
  return describe(pins, (id) => {
    const snapshot = snapshots.get(id)
    if (!snapshot) throw errors.get(id) ?? new Error('E_GENERATION_SNAPSHOT_MISSING')
    return snapshot
  })
}
