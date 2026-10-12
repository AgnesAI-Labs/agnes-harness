import type { ProviderCatalogEntry } from '@agnes/extension-api'
import type { SessionCapabilitySet, SessionRuntimeDescriptor } from '@agnes/protocol'
import type { Host } from '../lifecycle/host.js'

type Provider = SessionRuntimeDescriptor['providers'][number]
type Pending = NonNullable<Provider['pending']>
type Effect = Pending['effect']

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
  /** The container the session runs in, and the one new sessions would open in. */
  running: ContainerView
  configured: ContainerView
  /** Seam kinds whose binding is kept per session, so a later change cannot reach it. */
  pinnedSeams?: ReadonlySet<string>
  profileHash: string
  modelRevision?: string | null
  resourceRows: readonly Readonly<{
    id: string
    liveResources?: readonly string[]
    liveResourceRevision?: string
  }>[]
  sandbox?: Readonly<{
    policyDigest?: string
    enforcement?: NonNullable<SessionRuntimeDescriptor['policy']['sandbox']['enforcement']>
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
    .map(([kind, provider]) => {
      const next = configured.seams[kind]
      return {
        kind,
        provider,
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
  }>,
): SessionRuntimeDescriptor {
  const workspace = host.securityStatus?.().workspaces.find((item) => item.sessionId === sessionKey)
  return describeSessionRuntime({
    sessionKey,
    generation: {
      ...(generation.id ? { id: generation.id } : {}),
      state: generation.failed ? 'failed' : generation.newerId ? 'draining' : 'active',
      ...(generation.digest ? { digest: generation.digest } : {}),
      ...(generation.newerId ? { newerId: generation.newerId } : {}),
    },
    capabilities: host.sessionCapabilities!(sessionKey),
    running: { catalog: host.providers.catalog(), seams: host.profile.seams },
    configured: { catalog: head.providers.catalog(), seams: head.profile.seams },
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
