import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createSkillCandidateRegistry,
  type ResourceActivationBarrier,
  type SkillCandidate,
  type SkillControlInput,
  type SkillRuntimeInput,
} from '@agnes/resource-control-runtime'
import { scanSkills, workspaceSkills } from '@agnes/resource-control-worker'

type Registry = ReturnType<typeof createSkillCandidateRegistry>
type Generation = { workspaces: SkillRuntimeInput; derived: Map<symbol, SkillRuntimeInput> }

/**
 * The views below are built inside a turn (a session's first Skill read), so they publish at once
 * instead of waiting on the Host's activation barrier, which would wait for that same turn.
 */
const PLAIN_BARRIER: ResourceActivationBarrier = Object.freeze({
  quiesce: <T>(_operationId: string, publish: (permit: unknown) => Promise<T>) => publish(undefined),
})

/** Where the daemon saves the Skill decisions its workers read: enable/disable, trust, removal. */
export const savedSkillControlFile = (dataDir: string, profile: string): string =>
  join(dataDir, 'resource-control', 'worker-snapshots', `${profile}.json`)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0

function parseControl(raw: unknown): SkillControlInput | undefined {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.skills) || !isRecord(raw.skills.control))
    return undefined
  const { desired, trust, removed, priorities } = raw.skills.control
  if (
    !Array.isArray(desired) ||
    !desired.every(
      (item) =>
        isRecord(item) && text(item.resourceId) && (item.state === 'enabled' || item.state === 'disabled'),
    ) ||
    !Array.isArray(trust) ||
    !trust.every(
      (item) =>
        isRecord(item) &&
        text(item.resourceId) &&
        text(item.revision) &&
        text(item.capabilityHash) &&
        ['trusted', 'untrusted', 'rejected'].includes(item.state as string),
    ) ||
    (removed !== undefined && (!Array.isArray(removed) || !removed.every(text))) ||
    (priorities !== undefined &&
      (!isRecord(priorities) || !Object.values(priorities).every((value) => Number.isFinite(value))))
  )
    return undefined
  return raw.skills.control as SkillControlInput
}

/** No file: the daemon never saw a decision, so every Skill is new. Unreadable: no disk Skills. */
async function savedControl(file: string): Promise<SkillControlInput | 'unreadable'> {
  let bytes: string
  try {
    bytes = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return { desired: [], trust: [] }
    return 'unreadable'
  }
  try {
    return parseControl(JSON.parse(bytes)) ?? 'unreadable'
  } catch {
    return 'unreadable'
  }
}

/**
 * The daemon's rules for the decisions it records: a recorded decision follows its Skill across edits
 * (rebound to the scanned revision), and a Skill seen for the first time is trusted and enabled.
 */
function controlFor(saved: SkillControlInput, candidates: readonly SkillCandidate[]): SkillControlInput {
  const byId = new Map(candidates.map((candidate) => [candidate.resourceId, candidate]))
  const removed = saved.removed ?? []
  const known = new Set([
    ...saved.desired.map((item) => item.resourceId),
    ...saved.trust.map((item) => item.resourceId),
  ])
  const trust = saved.trust.map((item) => {
    const candidate = byId.get(item.resourceId)
    return candidate
      ? { ...item, revision: candidate.revision, capabilityHash: candidate.capabilityHash }
      : item
  })
  const desired = [...saved.desired]
  for (const candidate of byId.values()) {
    if (known.has(candidate.resourceId) || removed.includes(candidate.resourceId)) continue
    trust.push({
      resourceId: candidate.resourceId,
      revision: candidate.revision,
      capabilityHash: candidate.capabilityHash,
      state: 'trusted',
    })
    desired.push({ resourceId: candidate.resourceId, state: 'enabled' })
  }
  return { priorities: saved.priorities ?? {}, removed, desired, trust }
}

export type LocalSkillsOptions = Readonly<{
  /** Receives plugin registrations; every view shares its runtime Skills. */
  registry: Registry
  agnesHome: string
  osHome: string
  importUserSkills: boolean
  /** The daemon's saved decisions, see `savedSkillControlFile`. */
  controlFile: string
  /** Non-fatal problems, including Skill files the scan skipped; never the terminal directly. */
  log: (line: string) => void
}>

export type LocalSkills = Readonly<{
  /** The Host's Skill resources. */
  input: SkillRuntimeInput
  /** Scan the Skill folders again before the next Skill read of any session. */
  refresh(): void
}>

/**
 * The Skills a host embedded in the CLI offers: the same disk folders a daemon worker scans for a
 * session's workspace (workspace and user Skill roots), with the daemon's saved decisions, plus the
 * Skills plugins register. A view is built again when a session uses Skills for the first time and
 * after `refresh`; a call that already entered a view keeps it to the end.
 */
export function createLocalSkills(options: LocalSkillsOptions): LocalSkills {
  const view = async (root: string | undefined, saved: SkillControlInput | 'unreadable') => {
    const scoped = createSkillCandidateRegistry({ barrier: PLAIN_BARRIER })
    scoped.shareRuntimeFrom(options.registry)
    try {
      if (saved !== 'unreadable') {
        const scan = await scanSkills(
          root,
          undefined,
          undefined,
          options.osHome,
          options.agnesHome,
          options.importUserSkills,
          undefined,
          options.log,
        )
        for (const item of scan.roots) scoped.replaceRoot(item.rootKey, item.candidates)
        for (const failed of scan.failedRoots) scoped.failRoot(failed, new Error('Skill scan failed'))
        scoped.setControl(
          controlFor(
            saved,
            scan.roots.flatMap((item) => item.candidates),
          ),
        )
      }
      await scoped.activate('local-skills', async () => undefined)
      return scoped.snapshot()
    } catch {
      // A Skill the registry refuses fails the whole view; plugin Skills stay offered.
      options.log('skills: the Skill folders could not be read; only plugin Skills are offered')
      return options.registry.snapshot()
    }
  }
  const build = async (): Promise<Generation> => {
    const saved = await savedControl(options.controlFile)
    if (saved === 'unreadable') options.log('skills: the saved Skill decisions are unreadable')
    return {
      workspaces: workspaceSkills(await view(undefined, saved), (root) => view(root, saved)),
      derived: new Map(),
    }
  }
  // Until a session reads Skills, only plugin Skills exist; the first read builds the disk view.
  let current: Generation = {
    workspaces: workspaceSkills(options.registry.snapshot(), async () => options.registry.snapshot()),
    derived: new Map(),
  }
  let stale = true
  let building: Promise<void> | undefined
  const seen = new Set<string>()
  // One scan at a time. A refresh asked for while a scan runs is served by one more scan after it.
  const settle = async () => {
    while (stale || building) {
      if (!building) {
        stale = false
        building = build().then(
          (next) => {
            current = next
          },
          () => options.log('skills: the Skill folders could not be scanned again; the last scan stays'),
        )
      }
      const flight = building
      await flight
      if (building === flight) building = undefined
    }
  }
  const follow = (variant: (generation: Generation) => SkillRuntimeInput): SkillRuntimeInput => {
    const entered = new AsyncLocalStorage<SkillRuntimeInput>()
    const now = () => entered.getStore() ?? variant(current)
    return Object.freeze({
      scopeRuntime: (accept: Parameters<NonNullable<SkillRuntimeInput['scopeRuntime']>>[0]) => {
        const id = Symbol('scoped')
        return follow((generation) => {
          const known = generation.derived.get(id)
          if (known) return known
          const base = variant(generation)
          const made = base.scopeRuntime?.(accept) ?? base
          generation.derived.set(id, made)
          return made
        })
      },
      generationSnapshot: () => {
        const view = now()
        if (!view.generationSnapshot)
          throw new Error('E_GENERATION_SKILLS_WORKSPACE: workspace view cannot be serialized')
        return view.generationSnapshot()
      },
      list: () => now().list(),
      invocation: (resourceId) => now().invocation?.(resourceId),
      readRoots: () => now().readRoots?.() ?? [],
      read: (resourceId, session) => now().read(resourceId, session),
      readFile: (resourceId, revision, path, session) => now().readFile(resourceId, revision, path, session),
      async scopeWorkspace<T>(root: string, sessionKey: string, invoke: () => Promise<T>): Promise<T> {
        if (!seen.has(sessionKey)) {
          seen.add(sessionKey)
          stale = true
        }
        await settle()
        const pinned = variant(current)
        const scope = pinned.scopeWorkspace
        if (!scope) return entered.run(pinned, invoke)
        return entered.run(pinned, () => scope(root, sessionKey, invoke))
      },
    } satisfies SkillRuntimeInput)
  }
  return Object.freeze({
    input: follow((generation) => generation.workspaces),
    refresh: () => {
      stale = true
    },
  })
}
