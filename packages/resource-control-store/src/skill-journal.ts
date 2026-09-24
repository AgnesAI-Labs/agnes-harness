import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  type ResourceOperation,
  rpcError,
  type SkillDescriptor,
  type SkillRootStatus,
  type TrustState,
  validateResourceControlData,
} from '@agnes/protocol'
import { renameWriteThrough } from '@agnes/system-node'
import { assertResourceProfile, type ResourceProfileScope } from './profile-scope.js'

const windows = process.platform === 'win32' // guards-allow-platform: serialize Windows read handles and retry file replacement.

export type SkillTrustDecision = Readonly<{ revision: string; capabilityHash: string; state: TrustState }>
export type ResourceOperationRecord = Readonly<{
  operation: ResourceOperation
  owner: Readonly<{ principalId: string; clientId: string }>
  command: Readonly<{ method: string; commandId: string; payloadHash: string }>
  cancelRequested?: boolean
  workspaceId?: string
  reinstall?: Readonly<{ resourceId: string; expectedRevision: string }>
}>
export type SkillJournal = Readonly<{
  version: 4
  priorities: Readonly<Record<string, number>>
  removed: readonly string[]
  discovered: readonly SkillDescriptor[]
  capability: Readonly<Record<string, string>>
  trust: Readonly<Record<string, SkillTrustDecision>>
  desired: Readonly<Record<string, 'enabled' | 'disabled'>>
  /** Adapter observation only; desired/operation never synthesize actual. */
  actual: Readonly<
    Record<
      string,
      Readonly<{ state: SkillDescriptor['actual']; lastSafeError?: { code: string; message: string } }>
    >
  >
  operations: readonly ResourceOperationRecord[]
  roots: readonly SkillRootStatus[]
}>

const limit = 1_000
const revisionPattern = /^[a-f0-9]{64}$/
const initial = (): SkillJournal => ({
  version: 4,
  priorities: {},
  removed: [],
  discovered: [],
  capability: Object.create(null),
  trust: Object.create(null),
  desired: Object.create(null),
  actual: Object.create(null),
  operations: [],
  roots: [],
})
const bad = (): never => {
  throw rpcError('INTERNAL_ERROR', { code: 'RESOURCE_JOURNAL_CORRUPT' })
}
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const own = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key))

function decode(value: unknown): SkillJournal {
  if (!plain(value)) return bad()
  const row: Record<string, unknown> = value
  if (row.version !== 2 && row.version !== 3 && row.version !== 4) return bad()
  const allowed =
    row.version === 2
      ? ['version', 'discovered', 'capability', 'trust', 'desired', 'actual', 'operations']
      : ['version', 'discovered', 'capability', 'trust', 'desired', 'actual', 'operations', 'roots']
  if (row.version === 4) allowed.push('priorities', 'removed')
  if (!own(row, allowed)) bad()
  const priorities = row.version === 4 ? row.priorities : {}
  const removed = row.version === 4 ? row.removed : []
  if (
    !plain(priorities) ||
    Object.keys(priorities).length > limit ||
    !Object.entries(priorities).every(
      ([id, n]) => /^skill\//.test(id) && typeof n === 'number' && Number.isInteger(n) && n >= 50 && n <= 500,
    )
  )
    bad()
  if (
    !Array.isArray(removed) ||
    removed.length > limit ||
    !removed.every((id) => typeof id === 'string' && /^skill\//.test(id))
  )
    bad()
  const { discovered, capability, trust, desired, actual, operations } = row
  const roots: unknown[] = row.version === 2 ? [] : Array.isArray(row.roots) ? row.roots : bad()
  if (
    !Array.isArray(discovered) ||
    discovered.length > limit ||
    !plain(capability) ||
    !plain(trust) ||
    !plain(desired) ||
    !plain(actual) ||
    !Array.isArray(operations) ||
    operations.length > limit ||
    !Array.isArray(roots) ||
    roots.length > 64
  )
    bad()
  if (!roots.every((entry) => validateResourceControlData('SkillRootStatus', entry).ok)) bad()
  const discoveredRows = discovered as unknown[]
  const capabilityRows = capability as Record<string, unknown>
  const trustRows = trust as Record<string, unknown>
  const desiredRows = desired as Record<string, unknown>
  const actualRows = actual as Record<string, unknown>
  const operationRows = operations as unknown[]
  if (!discoveredRows.every((entry) => validateResourceControlData('SkillDescriptor', entry).ok)) bad()
  const ids = new Set((discoveredRows as SkillDescriptor[]).map((entry) => entry.resourceId))
  if (ids.size !== discoveredRows.length) bad()
  if (Object.keys(capabilityRows).length !== ids.size) bad()
  for (const [id, value] of Object.entries(capabilityRows))
    if (!ids.has(id) || !revisionPattern.test(String(value))) bad()
  for (const [id, decision] of Object.entries(trustRows)) {
    const descriptor = (discoveredRows as SkillDescriptor[]).find((item) => item.resourceId === id)
    if (
      !ids.has(id) ||
      !descriptor ||
      !plain(decision) ||
      !own(decision, ['revision', 'capabilityHash', 'state']) ||
      decision.revision !== descriptor.revision ||
      decision.capabilityHash !== capabilityRows[id] ||
      !['untrusted', 'trusted', 'rejected'].includes(String(decision.state))
    )
      bad()
  }
  for (const [id, state] of Object.entries(desiredRows))
    if (!ids.has(id) || (state !== 'enabled' && state !== 'disabled')) bad()
  for (const [id, value] of Object.entries(actualRows))
    if (
      !ids.has(id) ||
      !plain(value) ||
      !own(value, ['state', 'lastSafeError']) ||
      !['unavailable', 'disabled', 'preparing', 'ready', 'degraded'].includes(String(value.state)) ||
      (value.lastSafeError !== undefined && !validateResourceControlData('SafeError', value.lastSafeError).ok)
    )
      bad()
  for (const row of operationRows) {
    if (
      !plain(row) ||
      !own(row, ['operation', 'owner', 'command', 'cancelRequested', 'workspaceId', 'reinstall']) ||
      !validateResourceControlData('ResourceOperation', row.operation).ok ||
      !plain(row.owner) ||
      !own(row.owner, ['principalId', 'clientId']) ||
      typeof row.owner.principalId !== 'string' ||
      typeof row.owner.clientId !== 'string' ||
      !plain(row.command) ||
      !own(row.command, ['method', 'commandId', 'payloadHash']) ||
      typeof row.command.method !== 'string' ||
      typeof row.command.commandId !== 'string' ||
      !revisionPattern.test(String(row.command.payloadHash)) ||
      (row.cancelRequested !== undefined && typeof row.cancelRequested !== 'boolean') ||
      (row.workspaceId !== undefined && !revisionPattern.test(String(row.workspaceId))) ||
      (row.reinstall !== undefined &&
        (!plain(row.reinstall) ||
          !own(row.reinstall, ['resourceId', 'expectedRevision']) ||
          typeof row.reinstall.resourceId !== 'string' ||
          !/^skill\//.test(row.reinstall.resourceId) ||
          !revisionPattern.test(String(row.reinstall.expectedRevision))))
    )
      bad()
  }
  return {
    version: 4,
    priorities: priorities as SkillJournal['priorities'],
    removed: removed as string[],
    discovered: discoveredRows as SkillDescriptor[],
    capability: capabilityRows as SkillJournal['capability'],
    trust: trustRows as SkillJournal['trust'],
    desired: desiredRows as SkillJournal['desired'],
    actual: actualRows as SkillJournal['actual'],
    operations: operationRows as ResourceOperationRecord[],
    roots: roots as SkillRootStatus[],
  }
}

/** One profile is a serial, bounded durable control-plane transaction domain. */
export class SkillJournalStore {
  private readonly root: string
  private readonly tails = new Map<string, Promise<unknown>>()
  constructor(
    dir: string,
    private readonly scope: ResourceProfileScope,
  ) {
    this.root = resolve(dir)
  }
  private path(profile: string): string {
    assertResourceProfile(this.scope, profile)
    return join(this.root, `${profile}.skills.json`)
  }
  private async load(profile: string): Promise<SkillJournal> {
    const path = this.path(profile)
    try {
      return decode(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initial()
      if ((error as { code?: unknown }).code === 'INTERNAL_ERROR') throw error
      return bad()
    }
  }
  private async write(profile: string, journal: SkillJournal): Promise<void> {
    const next = decode(journal) // validation precedes every write
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const destination = this.path(profile)
    const temporary = `${destination}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(next), 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      // guards-allow-platform: Windows readers can briefly deny replacement of the journal.
      if (windows) await renameWriteThrough(temporary, destination)
      else await rename(temporary, destination)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
  async transact<T>(
    profile: string,
    fn: (
      current: SkillJournal,
    ) => Promise<{ next: SkillJournal; result: T }> | { next: SkillJournal; result: T },
  ): Promise<T> {
    return this.serialize(profile, async () => {
      const out = await fn(await this.load(profile))
      await this.write(profile, out.next)
      return out.result
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
  async read<T>(profile: string, fn: (current: SkillJournal) => T | Promise<T>): Promise<T> {
    // guards-allow-platform: do not hold an asynchronous read handle across a Windows replacement.
    const journal = windows
      ? await this.serialize(profile, () => this.load(profile))
      : await this.load(profile)
    return fn(journal)
  }
  async profiles(): Promise<string[]> {
    try {
      return (await readdir(this.root)).flatMap((name) =>
        name.endsWith('.skills.json') && this.scope.allowedProfiles.includes(name.slice(0, -12))
          ? [name.slice(0, -12)]
          : [],
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}
