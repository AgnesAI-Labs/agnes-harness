import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { McpStatus, McpToolCatalogPage, SkillDescriptor, SkillRootStatus } from '@agnes/protocol'
import { validateResourceControlData } from '@agnes/protocol'
import type { ResourceControlStore } from '@agnes/resource-control-store'

type ResourceHello = Readonly<{
  snapshotRevision: string
  skills: readonly SkillDescriptor[]
  mcp: readonly McpStatus[]
}>
type ResourceLink = Readonly<{
  hello: Promise<Readonly<{ resources?: ResourceHello }>>
  command(method: string, params: unknown, options: Readonly<{ timeoutMs: number }>): Promise<unknown>
  close(reason: string): void
  alive?: boolean
}>
type ResourcePool = Readonly<{
  acquire(key: string, options: Readonly<Record<string, unknown>>): Promise<ResourceLink>
  /** The one process every enabled MCP server's row now lives in (single-resident-worker design):
   *  `reconcile`/`reconnect`/`tools` are commands to it, not a candidate this file acquires and owns. */
  acquireSharedWorker(): Promise<ResourceLink>
}>
export type ResourceAdapterOptions = Readonly<{
  store: ResourceControlStore
  pool: ResourcePool
  profile: Readonly<{ name: string; hash: string }>
  workspaceRoot?: string
  resolveWorkspace?: (workspaceId?: string) => Promise<{ workspaceId: string; path: string }>
  refreshPackageSkills(): Promise<void>
}>

/** Owns per-resource candidate generations. A candidate is published only after validation. */
export function installResourceServiceAdapters(input: ResourceAdapterOptions): {
  observeMcpStatus(input: { sessionKey: string; serverId: string; status: McpStatus }): void
} {
  const { store: localResourceStore, pool } = input
  const o = { profile: input.profile, workspaceRoot: input.workspaceRoot }
  const refreshPackageSkills = input.refreshPackageSkills
  let resourceCandidate = 0
  const snapshotPath = localResourceStore.snapshotPath(o.profile.name)
  const configuredRoot = (): string => {
    if (!o.workspaceRoot) {
      const error = Object.assign(new Error('E_WORKSPACE_REQUIRED: resource worker root is unavailable'), {
        code: 'E_WORKSPACE_REQUIRED',
      })
      throw error
    }
    return o.workspaceRoot
  }
  const boundWorkspace = async (workspaceId?: string): Promise<{ workspaceId: string; path: string }> => {
    if (input.resolveWorkspace) return input.resolveWorkspace(workspaceId)
    return { path: configuredRoot(), workspaceId: workspaceId ?? '' }
  }
  const currentSnapshotRevision = async (): Promise<string> => {
    const bytes = await readFile(snapshotPath, 'utf8')
    return createHash('sha256').update(bytes, 'utf8').digest('hex')
  }
  /** A short-lived candidate worker: MCP `test` is still a one-shot process, never the shared
   *  worker every enabled MCP server's row now lives in (single-resident-worker design). Skill
   *  scans/removals go to `@shared` instead (design §3.5, see `sharedWorker` below). */
  const service = async (signal: AbortSignal, serverId?: string) => {
    if (signal.aborted) throw new DOMException('resource operation aborted', 'AbortError')
    const revision = await currentSnapshotRevision()
    const generation = ++resourceCandidate
    const key = `@resources:test:${serverId ?? 'none'}:${o.profile.hash}:${revision}:${generation}`
    const link = await pool.acquire(key, {
      kind: 'service',
      resourceControl: true,
      cwd: configuredRoot(),
      ...(serverId ? { resourceTestServerId: serverId } : {}),
    })
    const hello = await link.hello
    if (!hello.resources || hello.resources.snapshotRevision !== revision)
      throw new Error('resource service worker did not confirm the durable snapshot')
    if (signal.aborted) throw new DOMException('resource operation aborted', 'AbortError')
    return { link, report: hello.resources }
  }
  const sharedWorker = async (signal: AbortSignal): Promise<ResourceLink> => {
    if (signal.aborted) throw new DOMException('resource operation aborted', 'AbortError')
    const link = await pool.acquireSharedWorker()
    if (link.alive === false) throw new Error('shared session worker is unavailable')
    if (signal.aborted) throw new DOMException('resource operation aborted', 'AbortError')
    return link
  }
  /** Forces a server's row to remount and reconnect right now (design §3.3), through the same
   *  run-admission barrier a session turn's own reload uses - a turn in flight is let to finish
   *  before rows are replaced. `resourceMcpReconnect` additionally bumps a worker-local epoch so a
   *  reconnect remounts even when the daemon's own revision for this server is unchanged. */
  const applyRow = async (serverId: string, reconnect: boolean, signal: AbortSignal): Promise<McpStatus> => {
    const link = await sharedWorker(signal)
    const raw = await link.command(
      reconnect ? 'resourceMcpReconnect' : 'resourceMcpApply',
      { serverId },
      { timeoutMs: 31_000 },
    )
    if (!validateResourceControlData('McpStatus', raw).ok)
      throw new Error('invalid resource MCP status reply')
    return raw as McpStatus
  }
  const observeMcpStatus = (update: { sessionKey: string; serverId: string; status: McpStatus }): void => {
    // Every enabled server's connection lives in exactly one place now, the shared session worker;
    // a report from anywhere else cannot be this server's current status.
    if (update.sessionKey !== '@shared') return
    if (!validateResourceControlData('McpStatus', update.status).ok) return
    void localResourceStore.mcp.observeWorker(o.profile.name, [update.status]).catch(() => undefined)
  }
  const removeSkill = async (
    profile: string,
    descriptor: SkillDescriptor,
    signal: AbortSignal,
    validateOnly: boolean,
  ) => {
    if (profile !== o.profile.name) throw new Error('resource profile mismatch')
    const bound = await boundWorkspace(descriptor.workspaceId)
    const link = await sharedWorker(signal)
    const result = await link.command(
      'resourceSkillRemove',
      { workspaceRoot: bound.path, descriptor, validateOnly },
      { timeoutMs: 31_000 },
    )
    if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== true)
      throw new Error('Skill deletion failed')
  }
  /** Parses and validates a `resourceSkillScan` reply. Shared by `refresh` (discovery of new/changed
   *  Skills) and `reconcile` (re-observation of already-tracked ones) so the two never drift apart
   *  on what a safe reply from `@shared` looks like. */
  const parseSkillScanReply = (
    raw: unknown,
  ): {
    skills: SkillDescriptor[]
    candidates: Array<{ descriptor: SkillDescriptor; capabilityHash: string }>
    failedRoots: Array<SkillDescriptor['sourceIdentity']['rootKey']>
    skippedResourceIds: string[]
    roots: SkillRootStatus[]
  } => {
    const fail = (): never => {
      throw new Error('invalid private skill scan reply')
    }
    if (
      !raw ||
      typeof raw !== 'object' ||
      !Array.isArray((raw as { skills?: unknown }).skills) ||
      !Array.isArray((raw as { candidates?: unknown }).candidates) ||
      !Array.isArray((raw as { failedRoots?: unknown }).failedRoots)
    )
      return fail()
    const skills = (raw as { skills: unknown[] }).skills
    if (!skills.every((skill) => validateResourceControlData('SkillDescriptor', skill).ok)) return fail()
    const discovered = (raw as { candidates: Array<{ descriptor?: unknown; capabilityHash?: unknown }> })
      .candidates
    const failedRoots = (raw as { failedRoots: unknown[] }).failedRoots
    const reportedRoots = (raw as { roots?: unknown }).roots
    const reportedSkipped = (raw as { skippedResourceIds?: unknown }).skippedResourceIds ?? []
    if (
      !Array.isArray(reportedSkipped) ||
      !reportedSkipped.every(
        (id) => typeof id === 'string' && /^skill\/(?:workspace|user)\/[a-z-]+\/[a-f0-9]{64}$/.test(id),
      )
    )
      return fail()
    if (
      !failedRoots.every(
        (root) =>
          typeof root === 'string' &&
          ['workspace-agnes', 'user-agnes', 'user-agents', 'user-claude', 'user-codex', 'package'].includes(
            root,
          ),
      )
    )
      return fail()
    if (
      !discovered.every(
        (row) =>
          typeof row.capabilityHash === 'string' &&
          /^[a-f0-9]{64}$/.test(row.capabilityHash) &&
          validateResourceControlData('SkillDescriptor', row.descriptor).ok,
      )
    )
      return fail()
    const roots = Array.isArray(reportedRoots)
      ? reportedRoots.filter((row) => validateResourceControlData('SkillRootStatus', row).ok)
      : []
    if (Array.isArray(reportedRoots) && roots.length !== reportedRoots.length) return fail()
    return {
      skills: skills as SkillDescriptor[],
      candidates: discovered.map((row) => ({
        descriptor: row.descriptor as SkillDescriptor,
        capabilityHash: row.capabilityHash as string,
      })),
      failedRoots: failedRoots as Array<SkillDescriptor['sourceIdentity']['rootKey']>,
      skippedResourceIds: reportedSkipped as string[],
      roots: roots as SkillRootStatus[],
    }
  }
  localResourceStore.setAdapters({
    skills: {
      validateRemove: ({ profile, descriptor }) =>
        removeSkill(profile, descriptor, new AbortController().signal, true),
      remove: ({ profile, descriptor, signal }) => removeSkill(profile, descriptor, signal, false),
      refresh: async ({ profile, rootKey, workspaceId, signal }) => {
        if (profile !== o.profile.name) throw new Error('resource profile mismatch')
        // PackageManager inventory is authoritative and verifies the installed tree on every
        // package-root refresh; this is never a free-form package directory scan.
        if (rootKey === 'package') await refreshPackageSkills()
        const bound = await boundWorkspace(workspaceId)
        const snapshotRevision = await currentSnapshotRevision()
        const link = await sharedWorker(signal)
        const raw = await link.command(
          'resourceSkillScan',
          { workspaceRoot: bound.path, ...(rootKey ? { rootKey } : {}), snapshotRevision },
          { timeoutMs: 31_000 },
        )
        const parsed = parseSkillScanReply(raw)
        return {
          candidates: parsed.candidates,
          failedRoots: parsed.failedRoots,
          ...(parsed.skippedResourceIds.length ? { skippedResourceIds: parsed.skippedResourceIds } : {}),
          ...(parsed.roots.length ? { roots: parsed.roots } : {}),
        }
      },
      reconcile: async ({ profile, resources, signal }) => {
        if (profile !== o.profile.name) throw new Error('resource profile mismatch')
        const workspaceIds = [
          ...new Set(
            resources.flatMap((resource) => {
              if (resource.kind !== 'skill') return []
              const skill = resource as SkillDescriptor
              return skill.sourceIdentity.rootKey === 'workspace-agnes' && skill.workspaceId
                ? [skill.workspaceId]
                : []
            }),
          ),
        ]
        const scans = workspaceIds.length ? workspaceIds : [undefined]
        const snapshotRevision = await currentSnapshotRevision()
        const byId = new Map<string, SkillDescriptor>()
        for (const workspaceId of scans) {
          const bound = await boundWorkspace(workspaceId)
          const link = await sharedWorker(signal)
          const raw = await link.command(
            'resourceSkillScan',
            { workspaceRoot: bound.path, snapshotRevision },
            { timeoutMs: 31_000 },
          )
          const parsed = parseSkillScanReply(raw)
          for (const value of parsed.skills) byId.set(value.resourceId, value)
        }
        return resources.map((resource) => {
          const observed = byId.get(resource.resourceId)
          if (!observed) throw new Error('resource worker did not observe every requested skill')
          return {
            resourceId: observed.resourceId,
            actual: observed.actual,
            resolution: observed.resolution,
            priority: observed.priority,
            ...(observed.lastSafeError ? { lastSafeError: observed.lastSafeError } : {}),
          }
        })
      },
    },
    mcp: {
      // Snapshot staging is daemon-durable before the candidate is acquired. There is no
      // connection or SecretRef resolution in this callback.
      stage: async () => undefined,
      unstage: async () => undefined,
      reconcile: async ({ profile, serverId, enabled, signal }) => {
        if (profile !== o.profile.name) throw new Error('resource profile mismatch')
        // The daemon's own snapshot write (this profile's write-then-drive sequencing) already
        // landed before this runs; the shared worker re-reads it fresh, no definition to hand it.
        const status = await applyRow(serverId, false, signal)
        if (enabled && status.connectionState !== 'ready')
          return {
            status,
            error: status.lastSafeError ?? {
              code: 'MCP_CANDIDATE_UNAVAILABLE',
              message: 'candidate worker did not report a ready MCP connection',
            },
          }
        return { status }
      },
      reconnect: async ({ profile, serverId, signal }) => {
        if (profile !== o.profile.name) throw new Error('resource profile mismatch')
        const status = await applyRow(serverId, true, signal)
        if (status.connectionState !== 'ready')
          return {
            status,
            error: status.lastSafeError ?? {
              code: 'MCP_CANDIDATE_UNAVAILABLE',
              message: 'candidate worker did not report a ready MCP connection',
            },
          }
        return { status }
      },
      test: async ({ profile, serverId, definition, signal }) => {
        if (profile !== o.profile.name) throw new Error('resource profile mismatch')
        const { link } = await service(signal, serverId)
        let raw: unknown
        try {
          raw = await link.command(
            'resourceMcpTest',
            { profile, serverId, definition },
            { timeoutMs: 31_000 },
          )
        } finally {
          link.close('resource-test-complete')
        }
        if (
          !raw ||
          typeof raw !== 'object' ||
          !Number.isSafeInteger((raw as { toolCount?: unknown }).toolCount) ||
          !/^[a-f0-9]{64}$/.test(String((raw as { catalogRevision?: unknown }).catalogRevision))
        )
          throw new Error('invalid resource MCP test reply')
        return raw as {
          toolCount: number
          catalogRevision: string
          error?: { code: string; message: string }
        }
      },
      tools: async ({ profile, serverId, cursor, signal }) => {
        if (profile !== o.profile.name) throw new Error('resource profile mismatch')
        // The journal's own current revision for this server is the fence: the shared worker only
        // ever answers a page from the row it actually has mounted, and refuses a stale ask (a
        // revision the journal itself has already moved past) rather than serving a wrong page.
        const observed = await localResourceStore.mcp.observedStatus(profile, serverId)
        const expectedRevision = observed?.observedRevision
        if (observed?.connectionState !== 'ready' || !expectedRevision)
          throw new Error('resource MCP catalog has no ready active generation')
        const link = await sharedWorker(signal)
        const raw = await link.command(
          'resourceMcpTools',
          { serverId, expectedRevision, ...(cursor ? { cursor } : {}) },
          { timeoutMs: 31_000 },
        )
        if (!validateResourceControlData('McpToolCatalogPage', raw).ok)
          throw new Error('invalid resource MCP catalog reply')
        return raw as McpToolCatalogPage
      },
    },
  })
  return { observeMcpStatus }
}
