// The skill side of saving refined task experience, for the embedded host behind run-agh.ts.
//
// The daemon installs a saved skill through resource control, which lives in its own process; an
// embedded host has no such process, so its skill saves are refused `unavailable` (the host builds
// the skill sender only when it is given a transport, see `createRefinementHost`). This file gives
// the embedded host that transport: it runs the same request handler the daemon runs
// (`createRefinementSkillRequests`, with the daemon's installers) over a resource-control store of its
// own, kept in the run's home. Nothing here installs a skill itself.
//
// The store's catalogue adapter is the small one the daemon's own end-to-end test uses: it lists the
// skill folders of the workspace and reports a trusted, enabled skill as ready.
//
// The host offers the skills it finds on disk, scanned when a session first reads skills; a skill saved
// during a session is offered to that session only after the host is told to scan again, so every save
// the handler accepts is followed by that refresh (`refreshAfterSave`), and the next request offers it.
//
// A run with refinement off gets no transport at all (`skillSaveTransport` returns undefined), and the
// handler also answers `refinement-off` while the switch reads off, so an off run can never write a skill.
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages')

/** `RefinementSaveTransport` of `@agnes/host`: one installer request for a session, answered with its reply. */
export type SkillSaveTransport = (
  sessionKey: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>

type Root = { path: string }
type Candidate = {
  resourceId: string
  name: string
  description: string
  revision: string
  sourceIdentity: unknown
  priority: number
  capabilityHash: string
  workspaceId?: string
}
type Descriptor = { resourceId: string; desired: string; trust: string }
type Store = { workerControl(profile: string): Promise<{ removed: string[] }> }

/** The parts of the repository packages this file uses, loaded from source like the CLI boot code. */
export type SkillSaveModules = {
  createSkillResourceStore(options: {
    directory: string
    scope: { allowedProfiles: string[] }
    adapter: object
  }): Store
  createResourceControlService(store: Store): unknown
  createRefinementSkillRequests(options: {
    dataDir: string
    profile: string
    agnesHome: string
    service: unknown
    workspace(sessionKey: string): string | undefined
    owner(sessionKey: string): { active: boolean } | undefined
    enabled(): boolean
    pollMs?: number
  }): (sessionKey: string, params: unknown) => Promise<unknown>
  skillRoots(input: { workspaceRoot: string; osHomeDir: string; agnesHomeDir: string }): Root[]
  discoverSkillRoot: unknown
  readInstallBundle(
    folder: string,
    root: Root,
    selected: unknown[],
    discovery: { discover: unknown },
  ): Promise<{ candidate: Candidate }>
  removeFilesystemSkill(input: {
    cwd: string
    osHomeDir: string
    agnesHomeDir: string
    stateDirectory: string
    descriptor: unknown
    validateOnly?: boolean
  }): Promise<unknown>
}

const load = async <T>(...path: string[]): Promise<T> =>
  (await import(pathToFileURL(join(PACKAGES, ...path)).href)) as T

export const loadSkillSaveModules = async (): Promise<SkillSaveModules> => {
  const [store, requests, worker, files, remove] = await Promise.all([
    load<Pick<SkillSaveModules, 'createSkillResourceStore' | 'createResourceControlService'>>(
      'resource-control-store',
      'src',
      'index.ts',
    ),
    load<Pick<SkillSaveModules, 'createRefinementSkillRequests'>>(
      'daemon',
      'src',
      'supervisor',
      'refinement-skill-requests.ts',
    ),
    load<Pick<SkillSaveModules, 'skillRoots' | 'discoverSkillRoot'>>(
      'resource-control-worker',
      'src',
      'skill-bootstrap.ts',
    ),
    load<Pick<SkillSaveModules, 'readInstallBundle'>>(
      'host-extensions',
      'src',
      'resources',
      'skill-install-files.ts',
    ),
    load<Pick<SkillSaveModules, 'removeFilesystemSkill'>>(
      'resource-control-worker',
      'src',
      'skill-remove.ts',
    ),
  ])
  return { ...store, ...requests, ...worker, ...files, ...remove }
}

export type SkillSaveInput = {
  /** The run's home: the installers' Agnes home and the skill root's user home. */
  home: string
  /** The host's data dir: the workspace registry the installer records the save in lives there. */
  dataDir: string
  profile: string
  /** The workspace a live session is bound to; undefined for a session that is not open. */
  workspaceOf(sessionKey: string): string | undefined
  /** Read for every request: the refinement switch. */
  enabled(): boolean
  modules: SkillSaveModules
  /** How often the installer looks at an operation it waits for; the daemon's default when absent. */
  pollMs?: number
}

/**
 * The transport an embedded host is given for saved skills: each request goes to the daemon's request
 * handler for the workspace of the requesting session. One store and handler per workspace, made on
 * first use.
 */
export function createSkillSaveTransport(input: SkillSaveInput): SkillSaveTransport {
  const { modules: m } = input
  const handlers = new Map<string, (sessionKey: string, params: unknown) => Promise<unknown>>()
  const handlerFor = (workspace: string) => {
    const known = handlers.get(workspace)
    if (known) return known
    const stores = join(input.dataDir, 'rsi-eval-resources', String(handlers.size))
    const target = () => {
      const root = m.skillRoots({
        workspaceRoot: workspace,
        osHomeDir: input.home,
        agnesHomeDir: input.home,
      })[0]
      if (!root) throw new Error('missing workspace skill root')
      return root
    }
    const removal = {
      cwd: workspace,
      osHomeDir: input.home,
      agnesHomeDir: input.home,
      stateDirectory: join(input.dataDir, 'deletions'),
    }
    const store: Store = m.createSkillResourceStore({
      directory: stores,
      scope: { allowedProfiles: [input.profile] },
      adapter: {
        validateRemove: ({ descriptor }: { descriptor: unknown }) =>
          m.removeFilesystemSkill({ ...removal, descriptor, validateOnly: true }),
        remove: ({ descriptor }: { descriptor: unknown }) =>
          m.removeFilesystemSkill({ ...removal, descriptor }),
        refresh: async () => {
          const root = target()
          const control = await store.workerControl(input.profile)
          const found = []
          for (const name of existsSync(root.path) ? readdirSync(root.path) : []) {
            if (name.startsWith('.')) continue
            const { candidate: c } = await m.readInstallBundle(join(root.path, name), root, [], {
              discover: m.discoverSkillRoot,
            })
            const removed = control.removed.includes(c.resourceId)
            found.push({
              capabilityHash: c.capabilityHash,
              descriptor: {
                kind: 'skill' as const,
                resourceId: c.resourceId,
                name: c.name,
                description: c.description,
                revision: c.revision,
                sourceIdentity: c.sourceIdentity,
                priority: c.priority,
                resolution: { winner: !removed, shadowed: [] },
                trust: 'untrusted' as const,
                desired: 'disabled' as const,
                actual: removed ? ('unavailable' as const) : ('disabled' as const),
                stale: false,
                ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}),
              },
            })
          }
          return found
        },
        reconcile: async ({ resources }: { resources: (Descriptor & { resourceId: string })[] }) => {
          const removed = new Set((await store.workerControl(input.profile)).removed)
          return resources.map((r) => ({
            resourceId: r.resourceId,
            actual:
              r.desired === 'enabled' && r.trust === 'trusted' ? ('ready' as const) : ('disabled' as const),
            resolution: { winner: !removed.has(r.resourceId), shadowed: [] },
          }))
        },
      },
    })
    const handler = m.createRefinementSkillRequests({
      dataDir: input.dataDir,
      profile: input.profile,
      agnesHome: input.home,
      service: m.createResourceControlService(store),
      workspace: (key) => (input.workspaceOf(key) === workspace ? workspace : undefined),
      owner: (key) => (input.workspaceOf(key) === workspace ? { active: true } : undefined),
      enabled: input.enabled,
      ...(input.pollMs === undefined ? {} : { pollMs: input.pollMs }),
    })
    handlers.set(workspace, handler)
    return handler
  }
  return async (sessionKey, params) => {
    const workspace = input.workspaceOf(sessionKey)
    if (workspace === undefined)
      return { ok: false, reason: 'unavailable', code: 'SKILL_WORKSPACE_UNAVAILABLE' }
    return handlerFor(workspace)(sessionKey, params)
  }
}

/**
 * The transport for a run, or none: a run whose refinement switch is off is given no way to save a
 * skill at all.
 */
export function skillSaveTransport(
  refinement: { enabled: boolean } | undefined,
  input: SkillSaveInput,
): SkillSaveTransport | undefined {
  return refinement?.enabled ? createSkillSaveTransport(input) : undefined
}

/**
 * The transport with the host's skill refresh after every save the handler accepted (`ok: true`), so the
 * saved skill is offered from the session's next request. A refused save changes nothing on disk and
 * asks for no scan.
 */
export function refreshAfterSave(transport: SkillSaveTransport, refresh: () => void): SkillSaveTransport {
  return async (sessionKey, params, signal) => {
    const reply = await transport(sessionKey, params, signal)
    if (typeof reply === 'object' && reply !== null && (reply as { ok?: unknown }).ok === true) refresh()
    return reply
  }
}
