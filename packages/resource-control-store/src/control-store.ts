import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResourceControlMethodName } from '@agnes/protocol'
import { windowsWritePrivateFile } from '@agnes/system-node'
import type { McpLifecycleAdapter, SkillCatalogAdapter } from './adapters.js'
import type { ResourceStateStore } from './handler.js'
import { McpResourceStore } from './mcp.js'
import type { ResourceAuthority } from './permissions.js'
import { assertResourceProfile, type ResourceProfileScope } from './profile-scope.js'
import { createSkillResourceStore, type SkillResourceStore } from './skills.js'

/** One daemon service with independently durable Skill and MCP journals. */
export class ResourceControlStore implements ResourceStateStore {
  readonly skills: SkillResourceStore
  readonly mcp: McpResourceStore
  private readonly directory: string
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly drives = new Map<string, Promise<unknown>>()
  private onSuccessfulSnapshot: ((profile: string) => void) | undefined
  constructor(options: {
    directory: string
    scope: ResourceProfileScope
    skills?: SkillCatalogAdapter
    mcp?: McpLifecycleAdapter
    resolveWorkspaceId?: (workspaceId?: string) => Promise<string>
  }) {
    this.directory = options.directory
    this.scope = options.scope
    this.skills = createSkillResourceStore({
      directory: `${options.directory}/skills`,
      scope: options.scope,
      ...(options.skills ? { adapter: options.skills } : {}),
      ...(options.resolveWorkspaceId ? { resolveWorkspaceId: options.resolveWorkspaceId } : {}),
    })
    this.mcp = new McpResourceStore(`${options.directory}/mcp`, options.scope, options.mcp)
    // An effect may start only after this facade has atomically published its worker snapshot.
    this.skills.setDeferredDrive(true)
    this.mcp.setDeferredDrive(true)
  }
  private readonly scope: ResourceProfileScope
  async call(
    method: ResourceControlMethodName,
    params: Record<string, unknown>,
    authority: ResourceAuthority,
  ): Promise<unknown> {
    const profile = params.profile as string
    assertResourceProfile(this.scope, profile)
    const previous = this.tails.get(profile) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(() => this.callSerial(method, params, authority))
    this.tails.set(profile, run)
    try {
      return await run
    } finally {
      if (this.tails.get(profile) === run) this.tails.delete(profile)
    }
  }
  private async callSerial(
    method: ResourceControlMethodName,
    params: Record<string, unknown>,
    authority: ResourceAuthority,
  ): Promise<unknown> {
    const effect =
      method !== '_agnes/v1/resources.list' &&
      method !== '_agnes/v1/resources.get' &&
      method !== '_agnes/v1/resources.operation.get' &&
      method !== '_agnes/v1/mcp.servers.list' &&
      method !== '_agnes/v1/mcp.servers.get' &&
      method !== '_agnes/v1/mcp.servers.status' &&
      method !== '_agnes/v1/mcp.servers.tools.list'
    if (method.startsWith('_agnes/v1/mcp.')) {
      const result = await this.mcp.call(method, params, authority)
      await this.writeWorkerSnapshot(params.profile as string)
      const afterSuccess =
        method === '_agnes/v1/mcp.servers.test'
          ? undefined
          : () => this.onSuccessfulSnapshot?.(params.profile as string)
      if (effect && 'operationId' in (result as object))
        this.enqueueDrive(params.profile as string, async () => {
          await this.mcp.driveOperation(
            params.profile as string,
            (result as { operationId: string }).operationId,
            () => this.writeWorkerSnapshot(params.profile as string),
            afterSuccess,
          )
        })
      return result
    }
    if (method === '_agnes/v1/resources.list') {
      const mcpAll = async (): Promise<unknown[]> => {
        const items: unknown[] = []
        let cursor: string | undefined
        do {
          const page = (await this.mcp.call(
            '_agnes/v1/mcp.servers.list',
            { profile: params.profile, ...(cursor ? { cursor } : {}) },
            authority,
          )) as { items: unknown[]; nextCursor?: string }
          items.push(...page.items)
          cursor = page.nextCursor
        } while (cursor)
        return items
      }
      const skillAll = async (): Promise<{ items: unknown[]; skillRoots?: unknown }> => {
        const items: unknown[] = []
        let skillRoots: unknown
        let cursor: string | undefined
        do {
          const page = (await this.skills.call(
            method,
            {
              profile: params.profile,
              ...(params.kind ? { kind: params.kind } : {}),
              ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
              ...(cursor ? { cursor } : {}),
            },
            authority,
          )) as { items: unknown[]; nextCursor?: string; skillRoots?: unknown }
          items.push(...page.items)
          if (skillRoots === undefined && page.skillRoots) skillRoots = page.skillRoots
          cursor = page.nextCursor
        } while (cursor)
        return { items, ...(skillRoots === undefined ? {} : { skillRoots }) }
      }
      const [skills, mcp] = await Promise.all([
        skillAll(),
        // Unified resources.list owns its resourceId cursor. MCP's native list cursor is a bare
        // serverId and cannot safely consume `mcp/foo` from this merged namespace.
        mcpAll(),
      ])
      const kind = params.kind
      const all = (
        [...(kind === 'mcp' ? [] : skills.items), ...(kind === 'skill' ? [] : mcp)] as Array<{
          resourceId: string
        }>
      )
        .sort((a, b) => a.resourceId.localeCompare(b.resourceId))
        .filter((item) => !params.cursor || item.resourceId > params.cursor)
      const items = all.slice(0, 100)
      const last = items.at(-1)
      return {
        items,
        ...(all.length > items.length && last ? { nextCursor: last.resourceId } : {}),
        ...(kind === 'mcp' || skills.skillRoots === undefined ? {} : { skillRoots: skills.skillRoots }),
      }
    }
    if (method === '_agnes/v1/resources.get')
      return String(params.resourceId).startsWith('mcp/')
        ? this.mcp.call(
            '_agnes/v1/mcp.servers.get',
            { profile: params.profile, serverId: String(params.resourceId).slice(4) },
            authority,
          )
        : this.skills.call(method, params, authority)
    if (method === '_agnes/v1/resources.operation.get' || method === '_agnes/v1/resources.operation.cancel') {
      try {
        return await this.skills.call(method, params, authority)
      } catch (error) {
        // The operation id has no kind prefix. Both stores enforce owner/capability checks, and
        // only a genuinely absent Skill operation may be routed to MCP.
        if ((error as { data?: { code?: unknown } }).data?.code !== 'RESOURCE_OPERATION_UNAVAILABLE')
          throw error
        return this.mcp.call(method, params, authority)
      }
    }
    const result = await this.skills.call(method, params, authority)
    await this.writeWorkerSnapshot(params.profile as string)
    if (effect && 'operationId' in (result as object))
      this.enqueueDrive(params.profile as string, async () => {
        await this.skills.driveOperation(
          params.profile as string,
          (result as { operationId: string }).operationId,
          () => this.writeWorkerSnapshot(params.profile as string),
          () => this.onSuccessfulSnapshot?.(params.profile as string),
        )
      })
    return result
  }
  /** Effects remain asynchronous for cancellation/progress, while each profile's durable snapshot
   * admission is serialized before the corresponding driver is allowed to start. */
  private enqueueDrive(profile: string, action: () => Promise<void>): void {
    const prior = this.drives.get(profile) ?? Promise.resolve()
    const run = prior.catch(() => undefined).then(action)
    this.drives.set(profile, run)
    void run
      .catch(() => undefined)
      .finally(() => {
        if (this.drives.get(profile) === run) this.drives.delete(profile)
      })
  }
  async recover(): Promise<void> {
    await Promise.all([
      this.skills.recover((profile) => this.writeWorkerSnapshot(profile)),
      this.mcp.recover((profile) => this.writeWorkerSnapshot(profile)),
    ])
  }
  /** Called only after a successful effect's latest worker snapshot and terminal operation commit. */
  setSuccessfulSnapshotHandler(handler: (profile: string) => void): void {
    if (this.onSuccessfulSnapshot) throw new Error('worker snapshot handler is already configured')
    this.onSuccessfulSnapshot = handler
  }
  async requiresSecretUse(
    method: ResourceControlMethodName,
    params: Record<string, unknown>,
    _authority: ResourceAuthority,
  ): Promise<boolean> {
    return this.mcp.requiresSecretUse(method, params)
  }
  snapshotPath(profile: string): string {
    assertResourceProfile(this.scope, profile)
    return join(this.directory, 'worker-snapshots', `${profile}.json`)
  }
  async writeWorkerSnapshot(profile: string): Promise<void> {
    assertResourceProfile(this.scope, profile)
    const snapshot = {
      version: 1,
      profile,
      skills: { control: await this.skills.workerControl(profile) },
      mcp: await this.mcp.workerManaged(profile),
      mcpAuthority: 'resource-control' as const,
    }
    const target = this.snapshotPath(profile)
    const windows = process.platform === 'win32' // guards-allow-platform: select shared Windows persistence; retain POSIX.
    if (windows) {
      await windowsWritePrivateFile(target, Buffer.from(JSON.stringify(snapshot)))
      return
    }
    await mkdir(join(this.directory, 'worker-snapshots'), { recursive: true, mode: 0o700 })
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(snapshot))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
  async observeWorker(
    profile: string,
    report: {
      snapshotRevision: string
      skills: readonly import('@agnes/protocol').SkillDescriptor[]
      mcp: readonly import('@agnes/protocol').McpStatus[]
    },
  ): Promise<void> {
    assertResourceProfile(this.scope, profile)
    if (!/^[a-f0-9]{64}$/.test(report.snapshotRevision)) throw new Error('invalid worker snapshot revision')
    await this.skills.observeWorker(profile, report.skills)
    await this.mcp.observeWorker(profile, report.mcp)
  }
  async seedLegacyPreset(
    profile: string,
    definitions: readonly import('@agnes/protocol').McpServerDefinitionInput[],
  ): Promise<void> {
    assertResourceProfile(this.scope, profile)
    await this.mcp.seedLegacyPreset(profile, definitions)
    await this.writeWorkerSnapshot(profile)
  }
  setAdapters(adapters: { skills: SkillCatalogAdapter; mcp: McpLifecycleAdapter }): void {
    this.skills.setAdapter(adapters.skills)
    this.mcp.setAdapter(adapters.mcp)
  }
}
export function createResourceControlStore(options: {
  directory: string
  scope: ResourceProfileScope
  skills?: SkillCatalogAdapter
  mcp?: McpLifecycleAdapter
  resolveWorkspaceId?: (workspaceId?: string) => Promise<string>
}): ResourceControlStore {
  return new ResourceControlStore(options)
}
