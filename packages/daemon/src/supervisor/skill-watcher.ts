import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, realpathSync, statSync, watch as watchFs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { agnesHome } from '@agnes/host'
import type { ResourceAuthority, ResourceControlService } from '@agnes/resource-control-store'
import { skillRoots } from '@agnes/resource-control-worker'
import type { WorkspaceCatalog } from '../storage/workspaces.js'

/** No rootKey means every root, scoped to `workspaceId` for the project one. */
export type SkillRefreshTarget = Readonly<{ rootKey?: string; workspaceId?: string }>
export type WatchHandle = Readonly<{ close(): void }>
export type WatchFn = (
  path: string,
  recursive: boolean,
  onEvent: (file: string | null) => void,
  onError: (error: unknown) => void,
) => WatchHandle
export type SkillWatcher = Readonly<{
  /** Schedules a refresh of `target` as if one of its files had changed. */
  changed(target: SkillRefreshTarget): void
  watchRoot(target: { rootKey: string }, path: string, options?: { followLinks?: boolean }): void
  watchWorkspace(
    workspaceId: string,
    paths: string | readonly string[],
    options?: { refresh?: boolean },
  ): void
  close(): Promise<void>
}>

// A Skill entry plus attachments up to four segments below it; dot folders and node_modules never count.
const MAX_SEGMENTS = 5
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

/** Whether a path relative to a Skill root can change some Skill's revision. */
export function isSkillChange(file: string | null): boolean {
  if (file === null) return true
  const parts = file.split(/[\\/]+/).filter(Boolean)
  return (
    parts.length <= MAX_SEGMENTS && parts.every((part) => !part.startsWith('.') && part !== 'node_modules')
  )
}

export type SkillLink = Readonly<{ path: string; dir: boolean }>

/** Resolved targets of the linked entries directly under a user Skill root. */
function nodeLinks(root: string): readonly SkillLink[] {
  const found: SkillLink[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isSymbolicLink() || entry.name.startsWith('.')) continue
    try {
      const path = realpathSync(join(root, entry.name))
      found.push({ path, dir: statSync(path).isDirectory() })
    } catch {}
  }
  return found
}

const nodeWatch: WatchFn = (path, recursive, onEvent, onError) => {
  const watcher = watchFs(path, { recursive, persistent: false }, (_event, file) =>
    onEvent(typeof file === 'string' ? file : null),
  )
  watcher.on('error', onError)
  return { close: () => watcher.close() }
}

/**
 * Watches Skill roots and refreshes the matching resource-control source after a change. Refreshes
 * are debounced per target and never overlap: changes seen while one runs trigger one follow-up.
 */
export function createSkillWatcher(o: {
  refresh(target: SkillRefreshTarget, signal: AbortSignal): Promise<void>
  debounceMs?: number
  retryMs?: number
  maxWorkspaces?: number
  watch?: WatchFn
  exists?: (path: string) => boolean
  links?: (root: string) => readonly SkillLink[]
  log?: Pick<Console, 'warn'>
}): SkillWatcher {
  // Matches dsh's write-stability threshold: a file counts as changed once quiet for 200 ms.
  const debounceMs = o.debounceMs ?? 200
  const retryMs = o.retryMs ?? 5000
  const maxWorkspaces = o.maxWorkspaces ?? 128
  const watch = o.watch ?? nodeWatch
  const exists = o.exists ?? existsSync
  const lifetime = new AbortController()
  const roots = new Map<string, () => void>()
  const workspaces = new Map<string, () => void>()
  type Pending = {
    timer: ReturnType<typeof setTimeout> | undefined
    running: Promise<void> | undefined
    dirty: boolean
  }
  const pending = new Map<string, Pending>()

  const schedule = (target: SkillRefreshTarget) => {
    if (lifetime.signal.aborted) return
    const key = `${target.rootKey ?? '*'}\0${target.workspaceId ?? ''}`
    const current: Pending = pending.get(key) ?? { timer: undefined, running: undefined, dirty: false }
    pending.set(key, current)
    if (current.running) {
      current.dirty = true
      return
    }
    clearTimeout(current.timer)
    current.timer = setTimeout(() => {
      current.timer = undefined
      current.running = o
        .refresh(target, lifetime.signal)
        .catch((error) =>
          o.log?.warn(`skill watcher: refresh of ${target.rootKey ?? 'every root'} failed: ${String(error)}`),
        )
        .finally(() => {
          current.running = undefined
          if (current.dirty) {
            current.dirty = false
            schedule(target)
          }
        })
    }, debounceMs)
    current.timer.unref?.()
  }

  const nearestExisting = (path: string) => {
    let ancestor = dirname(path)
    while (!exists(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor)
    return ancestor
  }

  const listLinks = o.links ?? nodeLinks
  // Watches `path` recursively when it exists, otherwise its nearest existing ancestor until it appears.
  // With `followLinks`, the target of each linked entry is watched too: a recursive watch stops at links.
  const arm = (target: SkillRefreshTarget, path: string, followLinks = false): (() => void) => {
    let handle: WatchHandle | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const linked = new Map<string, WatchHandle>()
    const syncLinks = () => {
      if (!followLinks) return
      let found: readonly SkillLink[] = []
      try {
        found = listLinks(path)
      } catch {}
      const wanted = new Map(found.map((link) => [link.path, link]))
      for (const [linkPath, linkHandle] of linked)
        if (!wanted.has(linkPath)) {
          linkHandle.close()
          linked.delete(linkPath)
        }
      for (const link of wanted.values()) {
        if (linked.has(link.path)) continue
        try {
          const onEvent = (file: string | null) => {
            if (!link.dir || isSkillChange(file === null ? null : `linked/${file}`)) schedule(target)
          }
          const drop = () => {
            linked.get(link.path)?.close()
            linked.delete(link.path)
          }
          linked.set(link.path, watch(link.path, link.dir, onEvent, drop))
        } catch {}
      }
    }
    const reset = () => {
      handle?.close()
      handle = undefined
      for (const linkHandle of linked.values()) linkHandle.close()
      linked.clear()
    }
    const fail = (error: unknown) => {
      reset()
      o.log?.warn(`skill watcher: watching ${target.rootKey} failed: ${String(error)}`)
      retry = setTimeout(start, retryMs)
      retry.unref?.()
    }
    function start() {
      if (stopped || lifetime.signal.aborted) return
      reset()
      try {
        if (exists(path)) {
          handle = watch(
            path,
            true,
            (file) => {
              if (!exists(path)) {
                start()
                schedule(target)
                return
              }
              syncLinks()
              if (isSkillChange(file)) schedule(target)
            },
            fail,
          )
          syncLinks()
          return
        }
        const ancestor = nearestExisting(path)
        handle = watch(
          ancestor,
          false,
          () => {
            const appeared = exists(path)
            start()
            if (appeared) schedule(target)
          },
          fail,
        )
        // Directories created between the probe and the watch raised no event.
        if (exists(path)) {
          start()
          schedule(target)
        } else if (nearestExisting(path) !== ancestor) start()
      } catch (error) {
        fail(error)
      }
    }
    start()
    return () => {
      stopped = true
      clearTimeout(retry)
      reset()
    }
  }

  return Object.freeze({
    watchRoot(target: { rootKey: string }, path: string, options?: { followLinks?: boolean }) {
      if (lifetime.signal.aborted || roots.has(target.rootKey)) return
      roots.set(target.rootKey, arm(target, path, options?.followLinks === true))
    },
    changed: schedule,
    watchWorkspace(workspaceId: string, paths: string | readonly string[], options?: { refresh?: boolean }) {
      if (lifetime.signal.aborted) return
      const target = { rootKey: 'workspace-agnes', workspaceId }
      const existing = workspaces.get(workspaceId)
      if (existing) {
        workspaces.delete(workspaceId)
        workspaces.set(workspaceId, existing)
        return
      }
      const stops = (typeof paths === 'string' ? [paths] : paths).map((path) => arm(target, path))
      workspaces.set(workspaceId, () => {
        for (const stop of stops) stop()
      })
      // Changes made while this workspace was not watched - before this daemon started, or after
      // it was evicted - were never observed.
      if (options?.refresh !== false) schedule(target)
      for (const [oldest, stop] of workspaces) {
        if (workspaces.size <= maxWorkspaces) break
        stop()
        workspaces.delete(oldest)
      }
    },
    async close() {
      lifetime.abort(new Error('skill watcher closed'))
      for (const stop of [...roots.values(), ...workspaces.values()]) stop()
      roots.clear()
      workspaces.clear()
      const running = [...pending.values()].map((state) => {
        clearTimeout(state.timer)
        return state.running
      })
      await Promise.allSettled(running)
    },
  })
}

type PackageOperationFeed = Readonly<{
  subscribe(
    listener: (operation: Readonly<{ profile: string; operation: string; state: string }>) => void,
  ): () => void
}>
// `cancelled` is only reported for an abort proven to precede the package manager's commit.
const PACKAGE_SETTLED = new Set(['completed', 'failed', 'rolled-back'])

/**
 * Starts the daemon's Skill watcher: the user roots immediately, the daemon's own workspace when it
 * was launched for one, every other workspace once a session binds to it, and package Skills after
 * each settled package operation (install, trust, enable and the rest all change that inventory).
 */
export async function startSkillWatcher(o: {
  service: ResourceControlService
  profile: string
  catalog: WorkspaceCatalog
  packages?: PackageOperationFeed
  defaultWorkspaceRoot?: string
  env?: NodeJS.ProcessEnv
  log?: Pick<Console, 'warn'>
}): Promise<SkillWatcher> {
  const env = o.env ?? process.env
  const homes = { osHomeDir: env.HOME ?? env.USERPROFILE ?? homedir(), agnesHomeDir: agnesHome(env) }
  const workspaceSkills = (workspaceRoot: string) =>
    (skillRoots({ workspaceRoot, ...homes })[0]?.dirs ?? []).map((dir) => dir.path)
  const watcher = createSkillWatcher({
    refresh: refreshThroughService(o.service, o.profile),
    ...(o.log ? { log: o.log } : {}),
  })
  for (const root of skillRoots({ workspaceRoot: homes.agnesHomeDir, ...homes })) {
    if (root.rootKey !== 'workspace-agnes')
      watcher.watchRoot({ rootKey: root.rootKey }, root.path, { followLinks: root.scope === 'user' })
  }
  const stopBound = o.catalog.onBound((workspaceId, root) =>
    watcher.watchWorkspace(workspaceId, workspaceSkills(root)),
  )
  const stopPackages = o.packages?.subscribe((operation) => {
    if (operation.profile !== o.profile || operation.operation === 'inspect') return
    if (PACKAGE_SETTLED.has(operation.state)) watcher.changed({ rootKey: 'package' })
  })
  let defaultWorkspaceId: string | undefined
  if (o.defaultWorkspaceRoot) {
    try {
      const bound = await o.catalog.bind(undefined, o.defaultWorkspaceRoot)
      watcher.watchWorkspace(bound.workspaceId, workspaceSkills(bound.path), { refresh: false })
      defaultWorkspaceId = bound.workspaceId
    } catch (error) {
      o.log?.warn(`skill watcher: default workspace is not watched: ${String(error)}`)
    }
  }
  // Nothing that changed while the daemon was down raised an event. One scan covers every root; it
  // is scoped to a workspace so other workspaces' records stay as they are. Without one, the user
  // roots are refreshed one by one instead.
  if (defaultWorkspaceId) watcher.changed({ workspaceId: defaultWorkspaceId })
  else
    for (const root of skillRoots({ workspaceRoot: homes.agnesHomeDir, ...homes }))
      if (root.rootKey !== 'workspace-agnes') watcher.changed({ rootKey: root.rootKey })
  return Object.freeze({
    ...watcher,
    close: () => {
      stopBound()
      stopPackages?.()
      return watcher.close()
    },
  })
}

const WATCHER_AUTHORITY: ResourceAuthority = {
  audience: 'admin',
  principalId: 'system:skill-watcher',
  clientId: 'skill-watcher',
  permissions: ['skills.refresh', 'resources.read'],
}

/** Submits `skills.refresh` as the watcher principal and resolves once the operation is terminal. */
export function refreshThroughService(
  service: ResourceControlService,
  profile: string,
  options: { pollMs?: number } = {},
): (target: SkillRefreshTarget, signal: AbortSignal) => Promise<void> {
  const pollMs = options.pollMs ?? 250
  return async (target, signal) => {
    const receipt = (await service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: WATCHER_AUTHORITY.clientId, commandId: randomUUID(), ...target },
      WATCHER_AUTHORITY,
    )) as { operationId: string }
    while (!signal.aborted) {
      const operation = (await service.call(
        '_agnes/v1/resources.operation.get',
        { profile, operationId: receipt.operationId },
        WATCHER_AUTHORITY,
      )) as { state: string }
      if (TERMINAL.has(operation.state)) return
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }
}
