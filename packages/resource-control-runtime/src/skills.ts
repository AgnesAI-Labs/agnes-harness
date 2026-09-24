import type {
  DesiredState,
  SkillSourceIdentity as ProtocolSkillSourceIdentity,
  SafeError,
  SkillDescriptor,
  SkillResolution,
  TrustState,
} from '@agnes/protocol'
import type { ResourceActivationBarrier, ResourceActivationPermit } from './activation.js'

export type SkillSourceIdentity = ProtocolSkillSourceIdentity
/** Candidate bodies are Host-private and must never be returned by status or protocol methods. */
export type SkillCandidate = Readonly<{
  resourceId: string
  name: string
  description: string
  revision: string
  capabilityHash: string
  sourceIdentity: SkillSourceIdentity
  priority: number
  body: string
  workspaceId?: string
  files?: readonly Readonly<{
    relativePath: string
    sha256: string
    kind: 'text' | 'binary'
    mime: string
    bytes: Uint8Array
  }>[]
  /** Host-private absolute base directory. Never projected into descriptors. */
  directory?: string
}>
export type SkillDesiredInput = Readonly<{ resourceId: string; state: DesiredState }>
export type SkillTrustInput = Readonly<{
  resourceId: string
  revision: string
  capabilityHash: string
  state: TrustState
}>
export type SkillControlInput = Readonly<{
  priorities?: Readonly<Record<string, number>>
  removed?: readonly string[]
  desired: readonly SkillDesiredInput[]
  trust: readonly SkillTrustInput[]
}>
/** The Host reports the shared Protocol descriptor, never a parallel status DTO. */
export type SkillActual = SkillDescriptor
export type SkillRead =
  | Readonly<{ ok: true; content: string; revision?: string; directory?: string }>
  | Readonly<{
      ok: false
      code: 'DISABLED' | 'UNTRUSTED_REVISION' | 'TRUST_REJECTED' | 'SHADOWED' | 'NOT_FOUND' | 'UNAUTHORIZED'
    }>
export type SkillFileRead =
  | Readonly<{ ok: true; content: string; mime: string }>
  | Readonly<{ ok: true; bytes: Uint8Array; mime: string; binary: true }>
  | Readonly<{
      ok: false
      code: 'DISABLED' | 'UNTRUSTED_REVISION' | 'TRUST_REJECTED' | 'SHADOWED' | 'NOT_FOUND' | 'UNAUTHORIZED'
    }>
export type SkillRuntimeInput = Readonly<{
  list(): readonly SkillActual[]
  read(resourceId: string, session: { sessionKey: string }): SkillRead
  readFile(
    resourceId: string,
    expectedRevision: string,
    relativePath: string,
    session: { sessionKey: string },
  ): SkillFileRead
  /**
   * Host-private: real directories of ready user-level Skills, which the file fence opens for
   * reading. Recomputed on every call so a disabled or untrusted Skill closes at once.
   */
  readRoots?(): readonly string[]
  /** Host attaches the per-session workspace invocation boundary before exposing this snapshot. */
  runInWorkspace?<T>(sessionKey: string, invoke: () => Promise<T>): Promise<T>
  /** Host-private: enter only with a root obtained from an acquired workspace invocation. */
  scopeWorkspace?<T>(root: string, sessionKey: string, invoke: () => Promise<T>): Promise<T>
}>

type Options = Readonly<{
  barrier: ResourceActivationBarrier
  /** Authorization stays Host-owned; desired/trust decisions never imply session access. */
  canRead?: (resourceId: string, session: { sessionKey: string }) => boolean
}>
type RootState = Readonly<{ candidates: readonly SkillCandidate[]; stale: boolean }>
type RegistryState = {
  roots: Map<SkillSourceIdentity['rootKey'], RootState>
  control: SkillControlInput
  /** Cordis runtime contributions. Independent of staged/applied root replacement. */
  runtime: Map<string, SkillCandidate>
}
/** Between workspace-agnes (500) and user-agnes (400). Internal; not a protocol promise. */
export const RUNTIME_SKILL_PRIORITY = 450
const rootPolicy: ReadonlyMap<
  SkillSourceIdentity['rootKey'],
  Readonly<{ scope: SkillSourceIdentity['scope']; priority: number }>
> = new Map([
  ['workspace-agnes', { scope: 'workspace', priority: 500 }],
  ['user-agnes', { scope: 'user', priority: 400 }],
  ['user-agents', { scope: 'user', priority: 300 }],
  ['user-claude', { scope: 'user', priority: 200 }],
  ['user-codex', { scope: 'user', priority: 100 }],
  ['package', { scope: 'package', priority: 50 }],
])

const copyCandidate = (candidate: SkillCandidate): SkillCandidate =>
  Object.freeze({
    ...candidate,
    sourceIdentity: Object.freeze({ ...candidate.sourceIdentity }),
    ...(candidate.files
      ? { files: Object.freeze(candidate.files.map((file) => Object.freeze({ ...file }))) }
      : {}),
  })
const copyControl = (input: SkillControlInput): SkillControlInput =>
  Object.freeze({
    priorities: Object.freeze({ ...input.priorities }),
    removed: Object.freeze([...(input.removed ?? [])]),
    desired: Object.freeze(input.desired.map((decision) => Object.freeze({ ...decision }))),
    trust: Object.freeze(input.trust.map((decision) => Object.freeze({ ...decision }))),
  })
const copyState = (state: RegistryState, runtime: Map<string, SkillCandidate>): RegistryState => ({
  roots: new Map(state.roots),
  control: copyControl(state.control),
  runtime,
})
const empty = (runtime: Map<string, SkillCandidate> = new Map()): RegistryState => ({
  roots: new Map(),
  control: Object.freeze({ desired: [], trust: [] }),
  runtime,
})
const desiredFor = (state: RegistryState, resourceId: string) =>
  state.control.desired.find((decision) => decision.resourceId === resourceId)?.state ?? 'disabled'
const trustFor = (state: RegistryState, candidate: SkillCandidate): TrustState =>
  state.control.trust.find(
    (decision) =>
      decision.resourceId === candidate.resourceId &&
      decision.revision === candidate.revision &&
      decision.capabilityHash === candidate.capabilityHash,
  )?.state ?? 'untrusted'
const stale = (state: RegistryState, candidate: SkillCandidate) =>
  state.roots.get(candidate.sourceIdentity.rootKey)?.stale === true
const descriptorDescription = (description: string) => {
  if (description.length <= 512) return description
  const prefix = description.slice(0, 512)
  // The protocol validator counts UTF-16 code units; avoid ending on half a surrogate pair.
  return /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix
}
const safe = (candidate: SkillCandidate) =>
  Object.freeze({
    kind: 'skill' as const,
    resourceId: candidate.resourceId,
    name: candidate.name,
    description: descriptorDescription(candidate.description),
    revision: candidate.revision,
    sourceIdentity: Object.freeze({ ...candidate.sourceIdentity }),
    priority: candidate.priority,
    ...(candidate.workspaceId ? { workspaceId: candidate.workspaceId } : {}),
  })

const skillNameKey = (name: string) => name.trim().toLocaleLowerCase('en-US')

/**
 * Clash scope for one runtime registration.
 * A later fiber of the same row may overlap: EntryTree replace mounts it before unmounting the previous fiber.
 * A different row on that scope, or a second registration with no row, still clashes.
 */
export type RuntimeSkillOwner = Readonly<{
  scope: string
  rowId?: string
  fiberId?: string
}>

export function runtimeSkillOwnerBlocks(
  existing: RuntimeSkillOwner | undefined,
  owner: RuntimeSkillOwner,
): boolean {
  if (!existing || existing.scope !== owner.scope) return false
  if (
    owner.rowId !== undefined &&
    existing.rowId === owner.rowId &&
    owner.fiberId !== undefined &&
    existing.fiberId !== undefined &&
    owner.fiberId !== existing.fiberId
  )
    return false
  return true
}
const isRuntimeCandidate = (candidate: SkillCandidate) =>
  candidate.sourceIdentity.rootKey === 'runtime' && candidate.sourceIdentity.scope === 'runtime'

function groups(state: RegistryState): SkillCandidate[][] {
  const grouped = new Map<string, SkillCandidate[]>()
  const push = (candidate: SkillCandidate) => {
    const key = skillNameKey(candidate.name)
    const group = grouped.get(key) ?? []
    group.push({
      ...candidate,
      priority: state.control.priorities?.[candidate.resourceId] ?? candidate.priority,
    })
    grouped.set(key, group)
  }
  for (const root of state.roots.values()) for (const candidate of root.candidates) push(candidate)
  for (const candidate of state.runtime.values()) push(candidate)
  return [...grouped.values()].map((group) =>
    group.sort(
      (a, b) =>
        Number(state.control.removed?.includes(a.resourceId) ?? false) -
          Number(state.control.removed?.includes(b.resourceId) ?? false) ||
        b.priority - a.priority ||
        a.sourceIdentity.sourceId.localeCompare(b.sourceIdentity.sourceId),
    ),
  )
}

const safeError = (code: string, message: string): SafeError => Object.freeze({ code, message })
const shadow = (candidate: SkillCandidate): SkillResolution['shadowed'][number] =>
  Object.freeze({
    resourceId: candidate.resourceId,
    sourceIdentity: Object.freeze({ ...candidate.sourceIdentity }),
    revision: candidate.revision,
    reason: 'lower-priority' as const,
  })

function actualFor(
  state: RegistryState,
  candidate: SkillCandidate,
  winner: boolean,
  shadowed: readonly SkillResolution['shadowed'][number][],
): SkillActual {
  const runtimeSource = isRuntimeCandidate(candidate)
  const base = {
    ...safe(candidate),
    resolution: Object.freeze({
      winner,
      shadowed: Object.freeze([...shadowed]) as unknown as SkillResolution['shadowed'],
    }),
    trust: runtimeSource ? ('trusted' as const) : trustFor(state, candidate),
    desired: runtimeSource ? ('enabled' as const) : desiredFor(state, candidate.resourceId),
    stale: runtimeSource ? false : stale(state, candidate),
  }
  if (state.control.removed?.includes(candidate.resourceId))
    return Object.freeze({
      ...base,
      actual: 'unavailable' as const,
      lastSafeError: safeError('SKILL_REMOVED', 'Skill deletion was requested'),
    })
  if (!winner)
    return Object.freeze({
      ...base,
      actual: 'unavailable' as const,
      lastSafeError: safeError('SHADOWED', 'skill is shadowed by a higher-priority source'),
    })
  if (runtimeSource) return Object.freeze({ ...base, actual: 'ready' as const })
  if (desiredFor(state, candidate.resourceId) !== 'enabled')
    return Object.freeze({ ...base, actual: 'disabled' as const })
  if (trustFor(state, candidate) === 'rejected')
    return Object.freeze({
      ...base,
      actual: 'unavailable' as const,
      lastSafeError: safeError('TRUST_REJECTED', 'skill revision was rejected'),
    })
  if (trustFor(state, candidate) !== 'trusted')
    return Object.freeze({
      ...base,
      actual: 'unavailable' as const,
      lastSafeError: safeError('UNTRUSTED_REVISION', 'skill revision requires trust'),
    })
  return Object.freeze({ ...base, actual: 'ready' as const })
}

const actual = (state: RegistryState): readonly SkillActual[] =>
  Object.freeze(
    groups(state)
      .flatMap((group) => {
        const winner = group[0]
        if (!winner) return []
        const shadows = group.slice(1).map(shadow)
        return group.map((candidate, index) =>
          actualFor(state, candidate, index === 0, index === 0 ? shadows : []),
        )
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.resourceId.localeCompare(b.resourceId)),
  )

function denyRead(
  found: { actual: SkillActual } | undefined,
  canRead: Options['canRead'],
  resourceId: string,
  session: { sessionKey: string },
): Extract<SkillRead, { ok: false }> | undefined {
  if (found?.actual.lastSafeError?.code === 'SKILL_REMOVED')
    return Object.freeze({ ok: false, code: 'NOT_FOUND' as const })
  if (!found) return Object.freeze({ ok: false, code: 'NOT_FOUND' as const })
  if (found.actual.actual === 'disabled') return Object.freeze({ ok: false, code: 'DISABLED' as const })
  if (found.actual.lastSafeError?.code === 'SHADOWED')
    return Object.freeze({ ok: false, code: 'SHADOWED' as const })
  if (found.actual.lastSafeError?.code === 'TRUST_REJECTED')
    return Object.freeze({ ok: false, code: 'TRUST_REJECTED' as const })
  if (found.actual.lastSafeError?.code === 'UNTRUSTED_REVISION')
    return Object.freeze({ ok: false, code: 'UNTRUSTED_REVISION' as const })
  if (canRead && !canRead(resourceId, session))
    return Object.freeze({ ok: false, code: 'UNAUTHORIZED' as const })
  return undefined
}

function indexState(state: RegistryState) {
  const listed = actual(state)
  const byId = new Map<
    string,
    {
      actual: SkillActual
      body?: string
      files?: SkillCandidate['files']
      directory?: string
    }
  >()
  for (const group of groups(state))
    for (const candidate of group) {
      const descriptor = listed.find((item) => item.resourceId === candidate.resourceId)
      if (descriptor)
        byId.set(candidate.resourceId, {
          actual: descriptor,
          ...(descriptor.actual === 'ready'
            ? {
                body: candidate.body,
                ...(candidate.files ? { files: candidate.files } : {}),
                ...(candidate.directory ? { directory: candidate.directory } : {}),
              }
            : {}),
        })
    }
  return { listed, byId }
}

// Mirrors dsh: the model resolves a Skill's relative paths against its real directory and uses its
// ordinary file and shell tools there, loading resources only when the instructions call for them.
const baseDirectoryNote = (directory: string) =>
  `Base directory for this Skill: ${directory}\n` +
  'Resolve relative paths this Skill mentions (for example scripts/ or references/) against that directory. ' +
  'Read those files with the read tool and run its scripts with the shell, loading them only as needed; ' +
  'the directory is read-only.\n\n'

/** Each list/read/readFile call re-reads the registry. A snapshot taken earlier still sees later writes. */
function liveSnapshot(current: () => RegistryState, canRead: Options['canRead']): SkillRuntimeInput {
  return Object.freeze({
    list: () => indexState(current()).listed,
    readRoots() {
      const roots = new Set<string>()
      for (const entry of indexState(current()).byId.values())
        if (entry.directory && entry.actual.sourceIdentity.scope === 'user') roots.add(entry.directory)
      return [...roots]
    },
    read(resourceId, session) {
      const found = indexState(current()).byId.get(resourceId)
      const denied = denyRead(found, canRead, resourceId, session)
      if (denied || !found) return denied ?? Object.freeze({ ok: false, code: 'NOT_FOUND' as const })
      const body = found.body ?? ''
      return Object.freeze({
        ok: true,
        content: found.directory ? baseDirectoryNote(found.directory) + body : body,
        revision: found.actual.revision,
        ...(found.directory ? { directory: found.directory } : {}),
      })
    },
    readFile(resourceId, expectedRevision, relativePath, session) {
      const found = indexState(current()).byId.get(resourceId)
      if (found && found.actual.revision !== expectedRevision)
        return Object.freeze({ ok: false, code: 'UNTRUSTED_REVISION' as const })
      const denied = denyRead(found, canRead, resourceId, session)
      if (denied) return denied
      const file = found?.files?.find((item) => item.relativePath === relativePath)
      if (!file) return Object.freeze({ ok: false, code: 'NOT_FOUND' as const })
      if (file.kind === 'binary')
        return Object.freeze({ ok: true, bytes: file.bytes, mime: file.mime, binary: true as const })
      return Object.freeze({
        ok: true,
        content: new TextDecoder('utf-8', { fatal: true }).decode(file.bytes),
        mime: file.mime,
      })
    },
  })
}

/**
 * Keeps staged discovery/control separate from the last applied Host generation. Only a successful
 * barrier callback publishes the new actual state, so active turns retain the prior immutable input.
 * Runtime contributions live on one map that activation never replaces.
 */
export function createSkillCandidateRegistry(options: Options) {
  let runtime = new Map<string, SkillCandidate>()
  let runtimeOwners = new Map<string, RuntimeSkillOwner>()
  let staged = empty(runtime)
  let applied = empty(runtime)
  /** What consumer snapshots read. Points at the generation being published, then at applied. */
  let view = applied
  const stage = (mutate: (next: RegistryState) => void) => {
    const next = copyState(staged, runtime)
    mutate(next)
    staged = next
  }
  const consumer = liveSnapshot(() => view, options.canRead)
  return Object.freeze({
    replaceRoot(root: SkillSourceIdentity['rootKey'], next: readonly SkillCandidate[]) {
      const policy = rootPolicy.get(root)
      if (!policy) throw new TypeError('unknown skill root')
      if (
        next.some(
          (candidate) =>
            candidate.sourceIdentity.rootKey !== root ||
            candidate.sourceIdentity.scope !== policy.scope ||
            candidate.priority !== policy.priority,
        )
      )
        throw new TypeError('candidate source does not match replacement root')
      stage((state) =>
        state.roots.set(
          root,
          Object.freeze({ candidates: Object.freeze(next.map(copyCandidate)), stale: false }),
        ),
      )
    },
    /** PackageManager contributes static artifacts only; the daemon supplies already-read candidates here. */
    replacePackage(next: readonly SkillCandidate[]) {
      if (
        next.some(
          (candidate) =>
            candidate.sourceIdentity.scope !== 'package' ||
            candidate.sourceIdentity.rootKey !== 'package' ||
            candidate.priority !== 50,
        )
      )
        throw new TypeError('invalid package skill contribution')
      stage((state) =>
        state.roots.set(
          'package',
          Object.freeze({ candidates: Object.freeze(next.map(copyCandidate)), stale: false }),
        ),
      )
    },
    /** Keep the prior successful staged root atomically and discard unsafe operating-system detail. */
    failRoot(root: SkillSourceIdentity['rootKey'], _error: unknown) {
      if (!rootPolicy.has(root)) throw new TypeError('unknown skill root')
      stage((state) => {
        const prior = state.roots.get(root)
        state.roots.set(
          root,
          Object.freeze({ candidates: prior?.candidates ?? Object.freeze([]), stale: true }),
        )
      })
    },
    setControl(next: SkillControlInput) {
      stage((state) => {
        state.control = copyControl(next)
      })
    },
    actual: () => actual(applied),
    read(resourceId: string, session: { sessionKey: string }) {
      return consumer.read(resourceId, session)
    },
    snapshot: () => consumer,
    /**
     * Direct write into the applied runtime map. Does not enter staged state and does not wait
     * for the activation barrier.
     */
    registerRuntime(candidate: SkillCandidate, owner: RuntimeSkillOwner = { scope: 'suite' }): string {
      if (!isRuntimeCandidate(candidate) || candidate.priority !== RUNTIME_SKILL_PRIORITY)
        throw new TypeError('runtime skill candidate must use the runtime source')
      if (owner.scope.length === 0) throw new TypeError('runtime skill owner is required')
      const key = skillNameKey(candidate.name)
      const storedOwner = Object.freeze({
        scope: owner.scope,
        ...(owner.rowId === undefined ? {} : { rowId: owner.rowId }),
        ...(owner.fiberId === undefined ? {} : { fiberId: owner.fiberId }),
      })
      for (const [id, existing] of runtime) {
        if (
          id === candidate.resourceId ||
          (skillNameKey(existing.name) === key && runtimeSkillOwnerBlocks(runtimeOwners.get(id), storedOwner))
        )
          throw new TypeError('runtime skill name already registered')
      }
      const stored = copyCandidate(candidate)
      runtime.set(stored.resourceId, stored)
      runtimeOwners.set(stored.resourceId, storedOwner)
      return stored.resourceId
    },
    /** Idempotent. A second call for the same id removes nothing further and does not throw. */
    unregisterRuntime(id: string): void {
      runtime.delete(id)
      runtimeOwners.delete(id)
    },
    /** The live map. A later registry generation can share it without copying contributions away. */
    runtimeMap(): Map<string, SkillCandidate> {
      return runtime
    },
    /** Owners travel with the runtime map so a shared generation keeps the same clash scope. */
    runtimeOwners(): Map<string, RuntimeSkillOwner> {
      return runtimeOwners
    },
    /** Point this registry at another registry's runtime map. Disk roots stay on this registry. */
    shareRuntimeFrom(source: {
      runtimeMap(): Map<string, SkillCandidate>
      runtimeOwners(): Map<string, RuntimeSkillOwner>
    }): void {
      runtime = source.runtimeMap()
      runtimeOwners = source.runtimeOwners()
      staged.runtime = runtime
      applied.runtime = runtime
      view.runtime = runtime
    },
    activate(
      operationId: string,
      apply: (input: SkillRuntimeInput, permit: ResourceActivationPermit) => Promise<void>,
    ) {
      return options.barrier.quiesce(operationId, async (permit) => {
        const next = copyState(staged, runtime)
        const previousView = view
        view = next
        try {
          await apply(consumer, permit)
          applied = next
        } catch (error) {
          view = previousView
          throw error
        }
      })
    },
  })
}
