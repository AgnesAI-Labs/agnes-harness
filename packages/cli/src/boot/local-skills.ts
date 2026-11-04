import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile, stat } from 'node:fs/promises'
import {
  createSkillCandidateRegistry,
  type ResourceActivationBarrier,
  type SkillControlInput,
  type SkillRuntimeInput,
} from '@agnes/resource-control-runtime'
import {
  knownSkillIds,
  resourceControlDirectory,
  skillDecisionsAfterScan,
  workerSnapshotPath,
} from '@agnes/resource-control-store'
import { SkillScanCache, scanSkills, workspaceSkills } from '@agnes/resource-control-worker'

type Registry = ReturnType<typeof createSkillCandidateRegistry>
type Scan = Awaited<ReturnType<typeof scanSkills>>

/**
 * The views below are built inside a turn (a session's first Skill read), so they publish at once
 * instead of waiting on the Host's activation barrier, which would wait for that same turn.
 */
const PLAIN_BARRIER: ResourceActivationBarrier = Object.freeze({
  quiesce: <T>(_operationId: string, publish: (permit: unknown) => Promise<T>) => publish(undefined),
})
/** Session keys whose views are kept; the least recently used one is dropped past this. */
const MAX_SESSIONS = 256

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

const missing = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return false
  } catch (error) {
    return (error as { code?: unknown }).code === 'ENOENT'
  }
}

/**
 * The decisions the daemon saved for this profile. A data dir the daemon never kept resource state
 * in has none, so every Skill is new. Once it has, a missing or unreadable file offers no disk Skill.
 */
async function savedControl(dataDir: string, profile: string): Promise<SkillControlInput | 'closed'> {
  const directory = resourceControlDirectory(dataDir)
  let bytes: string
  try {
    bytes = await readFile(workerSnapshotPath(directory, profile), 'utf8')
  } catch {
    return (await missing(directory)) ? { desired: [], trust: [] } : 'closed'
  }
  try {
    return parseControl(JSON.parse(bytes)) ?? 'closed'
  } catch {
    return 'closed'
  }
}

/** The store's own rules applied to one scan. The snapshot keeps no discovered list, only decisions. */
function controlFor(saved: SkillControlInput, scan: Scan): SkillControlInput {
  const candidates = scan.roots.flatMap((root) => root.candidates)
  const recorded = {
    trust: Object.fromEntries(saved.trust.map(({ resourceId, ...decision }) => [resourceId, decision])),
    desired: Object.fromEntries(saved.desired.map((item) => [item.resourceId, item.state])),
  }
  const removed = saved.removed ?? []
  const { trust, desired } = skillDecisionsAfterScan({
    ...recorded,
    known: knownSkillIds({ discovered: [], ...recorded }),
    removed,
    current: candidates,
    observed: candidates,
    capability: Object.fromEntries(candidates.map((item) => [item.resourceId, item.capabilityHash])),
  })
  return {
    priorities: saved.priorities ?? {},
    removed,
    desired: Object.entries(desired).map(([resourceId, state]) => ({ resourceId, state })),
    trust: Object.entries(trust).map(([resourceId, decision]) => ({ resourceId, ...decision })),
  }
}

export type LocalSkillsOptions = Readonly<{
  /** Receives plugin registrations; every view shares its runtime Skills. */
  registry: Registry
  agnesHome: string
  osHome: string
  importUserSkills: boolean
  /** The data dir whose daemon decisions apply, and the profile they were saved for. */
  decisions: Readonly<{ dataDir: string; profile: string }>
  /** Non-fatal problems, including Skill files the scan skipped; never the terminal directly. */
  log: (line: string) => void
}>

export type LocalSkills = Readonly<{
  /** The Host's Skill resources. */
  input: SkillRuntimeInput
  /** Build every session's view again from a new scan, on its next Skill read. */
  refresh(): void
}>

/**
 * The Skills a host embedded in the CLI offers: the disk folders a daemon worker scans for a
 * session's workspace (workspace and user Skill roots) under the daemon's saved decisions, plus the
 * Skills plugins register. Each session key gets one view, built from one scan on its first Skill
 * read and kept for that session's life, so a new session never changes another session's list.
 * `refresh` is the only thing that rebuilds existing views.
 */
export function createLocalSkills(options: LocalSkillsOptions): LocalSkills {
  const cache = new SkillScanCache()
  const pluginOnly = workspaceSkills(options.registry.snapshot(), async () => options.registry.snapshot())
  let epoch = 0
  let scans = 0
  let closedLogged = false
  /** What a read outside any session sees: the user roots of the latest scan, for the file fence. */
  let latestShared: SkillRuntimeInput = options.registry.snapshot()
  const sessions = new Map<string, { epoch: number; root: string; view: Promise<SkillRuntimeInput> }>()

  const publish = async (roots: Scan['roots'], failed: Scan['failedRoots'], control: SkillControlInput) => {
    const scoped = createSkillCandidateRegistry({ barrier: PLAIN_BARRIER })
    scoped.shareRuntimeFrom(options.registry)
    for (const item of roots) scoped.replaceRoot(item.rootKey, item.candidates)
    for (const root of failed) scoped.failRoot(root, new Error('Skill scan failed'))
    scoped.setControl(control)
    await scoped.activate('local-skills', async () => undefined)
    return scoped.snapshot()
  }
  const scanned = async (root: string, revision: string) => {
    const known = cache.get(root, revision)
    if (known) return known
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
    cache.observe(root, revision, scan)
    return scan
  }
  const build = async (root: string): Promise<SkillRuntimeInput> => {
    try {
      const saved = await savedControl(options.decisions.dataDir, options.decisions.profile)
      if (saved === 'closed') {
        if (!closedLogged) options.log('skills: the saved Skill decisions are unreadable; only plugin Skills')
        closedLogged = true
        return pluginOnly
      }
      // One scan per view: the user-level view and the workspace view below both read it.
      const revision = String(++scans)
      const scan = await scanned(root, revision)
      const control = controlFor(saved, scan)
      const shared = await publish(
        scan.roots.filter((item) => item.rootKey !== 'workspace-agnes'),
        scan.failedRoots.filter((item) => item !== 'workspace-agnes'),
        control,
      )
      latestShared = shared
      return workspaceSkills(shared, async (at) => {
        const own = await scanned(at, revision)
        return publish(own.roots, own.failedRoots, at === root ? control : controlFor(saved, own))
      })
    } catch {
      // A Skill the registry refuses fails the whole view; plugin Skills stay offered.
      options.log('skills: the Skill folders could not be read; only plugin Skills are offered')
      return pluginOnly
    }
  }
  const viewFor = (sessionKey: string, root: string) => {
    let session = sessions.get(sessionKey)
    sessions.delete(sessionKey)
    if (!session || session.epoch !== epoch || session.root !== root)
      session = { epoch, root, view: build(root) }
    sessions.set(sessionKey, session)
    for (const key of sessions.keys()) {
      if (sessions.size <= MAX_SESSIONS) break
      sessions.delete(key)
    }
    return session.view
  }

  const follow = (variant: (input: SkillRuntimeInput) => SkillRuntimeInput): SkillRuntimeInput => {
    const entered = new AsyncLocalStorage<SkillRuntimeInput>()
    const now = () => entered.getStore() ?? variant(latestShared)
    return Object.freeze({
      scopeRuntime: (accept: Parameters<NonNullable<SkillRuntimeInput['scopeRuntime']>>[0]) => {
        const derived = new WeakMap<SkillRuntimeInput, SkillRuntimeInput>()
        return follow((input) => {
          const base = variant(input)
          const known = derived.get(base)
          if (known) return known
          const made = base.scopeRuntime?.(accept) ?? base
          derived.set(base, made)
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
        const pinned = variant(await viewFor(sessionKey, root))
        const scope = pinned.scopeWorkspace
        if (!scope) return entered.run(pinned, invoke)
        return entered.run(pinned, () => scope(root, sessionKey, invoke))
      },
    } satisfies SkillRuntimeInput)
  }
  return Object.freeze({
    input: follow((input) => input),
    refresh: () => {
      epoch += 1
    },
  })
}
