import {
  RefinementRegistry,
  type RefinementSkillInstallers,
  recordSkillRevocation,
  renewSkillForUser,
  reviewSkills,
} from '@agnes/host'
import type { ResourceControlMethodName } from '@agnes/protocol'
import type { ResourceAuthority, ResourceControlService } from '@agnes/resource-control-store'
import { savedSkillInstallers } from './refinement-skill-requests.js'
import { createRefinementSkillsAdmin } from './refinement-skills-admin.js'

/** Reading one skill's descriptor is all refinement does on a user's call; under its own name. */
const READ: ResourceAuthority = Object.freeze({
  audience: 'admin',
  principalId: 'system:refinement',
  clientId: 'refinement',
  permissions: Object.freeze(['resources.read'] as const),
})
/** Saved skills live only in the workspace's own skill folder. */
const WORKSPACE_SKILL = /^skill\/workspace\/workspace-agnes\/[a-f0-9]{64}$/
const HASH = /^[a-f0-9]{64}$/
const MAX_KNOWN_WORKSPACES = 128

type Raw = Record<string, unknown>
const plain = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** A user's change on the skills page that refinement keeps a record of. */
type UserChange = { kind: 'remove' | 'enable'; profile: string; resourceId: string; actor: string }

function userChange(
  method: ResourceControlMethodName,
  params: unknown,
  authority: ResourceAuthority | undefined,
): UserChange | undefined {
  if (!authority || !plain(params)) return undefined
  const kind =
    method === '_agnes/v1/skills.remove'
      ? 'remove'
      : method === '_agnes/v1/resources.desired.set' && params.state === 'enabled'
        ? 'enable'
        : undefined
  const { profile, resourceId } = params
  if (!kind || typeof profile !== 'string' || typeof resourceId !== 'string') return undefined
  if (!WORKSPACE_SKILL.test(resourceId)) return undefined
  return { kind, profile, resourceId, actor: authority.principalId.slice(0, 256) }
}

/**
 * Saved skills in the daemon: the installers every request shares, the 30-day review, and the record
 * of what the user takes back on the skills page.
 *
 * The review runs when a session opens in a workspace (a binding in the workspace catalog) and when
 * refinement is switched on (for the workspaces sessions opened in since the daemon started). There is
 * no timer. Nothing is reviewed while refinement is off.
 *
 * `endpoint` is the resource control service the Web and TUI skills pages call. It passes every call
 * through unchanged. When a user removes, or switches back on, a workspace skill that the registry
 * holds as installed by refinement, it also records that: a removal becomes a durable revocation and
 * the record `uninstalled`, switching it back on renews it. These are the user's own decisions, so they
 * are recorded whether refinement is on or off; a workspace refinement never saved anything into is
 * never written. The registry is found by the workspace id resource control gives the skill, so
 * nothing in the workspace is read or written on the way. Calls by the installer itself never pass
 * through here.
 */
export function createSavedSkills(options: {
  dataDir: string
  profile: string
  agnesHome: string
  service: ResourceControlService
  catalog: {
    onBound(listener: (workspaceId: string, root: string) => void): () => void
    /** The workspaces the owner may manage saved skills in. Absent: none. */
    list?(): Promise<{ items: readonly { path: string; available: boolean }[] }>
  }
  /** Read again for every review: the refinement switch. */
  enabled(): boolean
  /** A workspace this daemon was started for, reviewed when refinement is switched on. */
  defaultWorkspaceRoot?: string
  clock?: () => number
  pollMs?: number
}) {
  const clock = options.clock ?? Date.now
  const installers: RefinementSkillInstallers = savedSkillInstallers({ ...options, clock })
  const on = () => {
    try {
      return options.enabled() === true
    } catch {
      return false
    }
  }
  const known = new Map<string, string>()
  const remember = (workspaceId: string, root: string) => {
    known.delete(workspaceId)
    known.set(workspaceId, root)
    for (const oldest of known.keys()) {
      if (known.size <= MAX_KNOWN_WORKSPACES) break
      known.delete(oldest)
    }
  }
  if (options.defaultWorkspaceRoot) remember('default', options.defaultWorkspaceRoot)
  let closed = false
  const reviews = new Map<string, Promise<void>>()
  const review = (root: string) => {
    if (closed || reviews.has(root) || !on()) return
    const run = (async () => {
      const registry = new RefinementRegistry(options.dataDir, root, clock)
      await reviewSkills(
        registry,
        { disable: (name, expected) => installers(root).disable(name, expected) },
        clock(),
      )
    })()
      .catch(() => undefined)
      .finally(() => reviews.delete(root))
    reviews.set(root, run)
  }
  const stopBound = options.catalog.onBound((workspaceId, root) => {
    remember(workspaceId, root)
    review(root)
  })

  /** The registry record a user's change is about, when refinement installed that skill. */
  const savedSkill = async (change: UserChange) => {
    try {
      const descriptor = (await options.service.call(
        '_agnes/v1/resources.get',
        { profile: change.profile, resourceId: change.resourceId },
        READ,
      )) as { workspaceId?: unknown; revision?: unknown }
      const { workspaceId, revision } = descriptor
      if (typeof workspaceId !== 'string' || !HASH.test(workspaceId) || typeof revision !== 'string')
        return undefined
      const registry = new RefinementRegistry(options.dataDir, { workspaceId }, clock)
      if (registry.unreadable()) return undefined
      const record = registry
        .read()
        .skills.find(
          (skill) =>
            skill.resourceId === change.resourceId &&
            (skill.state === 'active' || skill.state === 'review-disabled'),
        )
      return record ? { registry, workspaceId, name: record.name, revision } : undefined
    } catch {
      return undefined
    }
  }

  const endpoint: ResourceControlService = Object.freeze({
    recover: () => options.service.recover(),
    async call(method: ResourceControlMethodName, params: unknown, authority: ResourceAuthority | undefined) {
      const change = userChange(method, params, authority)
      const found = change ? await savedSkill(change) : undefined
      if (!change || !found) return options.service.call(method, params, authority)
      // In the skill's own queue, so it never interleaves with an install, update or review of it.
      return installers.exclusive(found.workspaceId, found.name, async () => {
        const result = await options.service.call(method, params, authority)
        try {
          if (change.kind === 'remove')
            recordSkillRevocation(found.registry, {
              action: 'skill-uninstalled',
              resourceId: change.resourceId,
              revision: found.revision,
              actor: change.actor,
              at: clock(),
            })
          else renewSkillForUser(found.registry, change.resourceId, found.revision, clock())
        } catch {
          // The user's change stands either way; a registry that cannot be written already bars saves.
        }
        return result
      })
    },
  })

  const catalog = options.catalog
  return {
    installers,
    endpoint,
    /** The owner's list, uninstall or rollback of the skills refinement saved in a workspace. */
    manage: createRefinementSkillsAdmin({
      dataDir: options.dataDir,
      installers,
      workspaces: () => (catalog.list ? catalog.list() : Promise.resolve({ items: [] })),
      clock,
    }),
    /** Refinement was just switched on: review the workspaces sessions opened in. */
    switchedOn() {
      for (const root of known.values()) review(root)
    },
    /** Settles once every review started so far has finished. */
    async idle() {
      await Promise.all([...reviews.values()])
    },
    close() {
      closed = true
      stopBound()
    },
  }
}

export type SavedSkills = ReturnType<typeof createSavedSkills>
