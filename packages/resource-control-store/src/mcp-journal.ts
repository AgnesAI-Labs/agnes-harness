import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type McpServerDefinitionInput, rpcError, validateResourceControlData } from '@agnes/protocol'
import { renameWriteThrough, renameWriteThroughSync } from '@agnes/system-node'
import type { McpOperation, McpRow } from './mcp.js'
import type { ResourceEffectAdmission } from './permissions.js'
import { assertResourceProfile, type ResourceProfileScope } from './profile-scope.js'

const windows = process.platform === 'win32' // guards-allow-platform: Windows journal replacement and read handle lifetime.
type Journal = Readonly<{
  version: 1
  servers: Record<string, McpRow>
  operations: readonly McpOperation[]
  legacyPresetImported: boolean
}>
const initial = (): Journal => ({
  version: 1,
  servers: Object.create(null),
  operations: [],
  legacyPresetImported: false,
})
const bad = (): never => {
  throw rpcError('INTERNAL_ERROR', { code: 'MCP_JOURNAL_CORRUPT' })
}
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
function decode(value: unknown): Journal {
  if (
    !plain(value) ||
    value.version !== 1 ||
    Object.keys(value).some(
      (key) => !['version', 'servers', 'operations', 'legacyPresetImported'].includes(key),
    ) ||
    !plain(value.servers) ||
    !Array.isArray(value.operations) ||
    value.operations.length > 1_000 ||
    (value.legacyPresetImported !== undefined && typeof value.legacyPresetImported !== 'boolean')
  )
    bad()
  const journal = value as Record<string, unknown>
  const servers = journal.servers as Record<string, unknown>
  const operations = journal.operations as unknown[]
  for (const [id, row] of Object.entries(servers)) {
    if (
      !plain(row) ||
      Object.keys(row).some(
        (key) =>
          ![
            'definition',
            'revision',
            'trust',
            'desired',
            'status',
            'authorizationStatus',
            'localStartApproval',
          ].includes(key),
      ) ||
      !validateResourceControlData('McpServerDefinitionInput', row.definition).ok ||
      (row.definition as McpServerDefinitionInput).serverId !== id ||
      !/^[a-f0-9]{64}$/.test(String(row.revision)) ||
      (row.localStartApproval !== undefined && row.localStartApproval !== row.revision) ||
      !['trusted', 'untrusted', 'rejected'].includes(String(row.trust)) ||
      !['enabled', 'disabled'].includes(String(row.desired)) ||
      !validateResourceControlData('McpStatus', row.status).ok ||
      (row.authorizationStatus !== undefined &&
        !['authorized', 'needs-reconnect', 'error'].includes(String(row.authorizationStatus)))
    )
      bad()
  }
  for (const op of operations)
    if (
      !plain(op) ||
      !validateResourceControlData('ResourceOperation', op.operation).ok ||
      !plain(op.owner) ||
      typeof op.owner.principalId !== 'string' ||
      typeof op.owner.clientId !== 'string' ||
      !plain(op.command) ||
      typeof op.command.method !== 'string' ||
      typeof op.command.commandId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(String(op.command.hash)) ||
      !plain(op.params)
    )
      bad()
  return {
    ...(journal as Omit<Journal, 'legacyPresetImported'>),
    legacyPresetImported: journal.legacyPresetImported === true,
  }
}
export class McpJournalStore {
  private readonly root: string
  private readonly tails = new Map<string, Promise<unknown>>()
  constructor(
    directory: string,
    private readonly scope: ResourceProfileScope,
  ) {
    this.root = resolve(directory)
  }
  private path(profile: string) {
    assertResourceProfile(this.scope, profile)
    return join(this.root, `${profile}.mcp.json`)
  }
  private async load(profile: string): Promise<Journal> {
    const path = this.path(profile)
    try {
      return decode(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initial()
      if ((error as { code?: unknown }).code === 'INTERNAL_ERROR') throw error
      return bad()
    }
  }
  async txn<T>(
    profile: string,
    fn: (value: Journal) => Promise<{ next: Journal; result: T }> | { next: Journal; result: T },
    admission?: ResourceEffectAdmission,
  ): Promise<T> {
    return this.serialize(profile, async () => {
      const journal = await this.load(profile)
      if (admission) {
        await admission.verify()
        admission.assertActive()
      }
      const result = await fn(journal)
      const next = decode(result.next)
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const target = this.path(profile)
      const tmp = `${target}.${randomUUID()}.tmp`
      const handle = await open(tmp, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(next))
        await handle.sync()
        await handle.close()
        if (admission) {
          await admission.verify()
          admission.assertActive()
        }
        if (admission) renameWriteThroughSync(tmp, target)
        else if (windows) await renameWriteThrough(tmp, target)
        else await rename(tmp, target)
      } catch (error) {
        await handle.close().catch(() => undefined)
        await rm(tmp, { force: true }).catch(() => undefined)
        throw error
      }
      return result.result
    })
  }
  private async serialize<T>(profile: string, action: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(profile) ?? Promise.resolve()
    const run = prior.catch(() => undefined).then(action)
    this.tails.set(profile, run)
    try {
      return await run
    } finally {
      if (this.tails.get(profile) === run) this.tails.delete(profile)
    }
  }
  async read<T>(profile: string, fn: (value: Journal) => T | Promise<T>): Promise<T> {
    const journal = windows
      ? await this.serialize(profile, () => this.load(profile))
      : await this.load(profile)
    return fn(journal)
  }
  async profiles(): Promise<string[]> {
    try {
      return (await readdir(this.root)).flatMap((name) =>
        name.endsWith('.mcp.json') && this.scope.allowedProfiles.includes(name.slice(0, -9))
          ? [name.slice(0, -9)]
          : [],
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}
