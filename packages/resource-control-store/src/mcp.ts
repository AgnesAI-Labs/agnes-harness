import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ResourceControlMethodName } from '@agnes/protocol'
import {
  jcs,
  type McpServerDefinitionInput,
  type McpServerDescriptor,
  type McpStatus,
  type McpToolCatalogPage,
  type ResourceOperation,
  type ResourcePermission,
  rpcError,
  type SafeError,
  type TrustState,
  validateResourceControlData,
} from '@agnes/protocol'
import { renameWriteThrough } from '@agnes/system-node'
import type { McpLifecycleAdapter } from './adapters.js'
import type { ResourceAuthority } from './permissions.js'
import { assertResourceProfile, type ResourceProfileScope } from './profile-scope.js'

/** The value set an OAuth 2.1 authorization_code flow can durably record for an oauth-bound MCP
 * server, minus 'pending' - a callback only ever transitions *out of* pending, never back into it
 * (see resource-control-runtime/src/oauth-http-handler.ts's OAuthAuthorizationStatus, which this
 * mirrors deliberately: both name the same three outcomes a completed flow can settle into). Absent
 * on a row means "never yet reported" - descriptor()/authorizationStatusResult() below default that
 * to the wire value 'pending' for an oauth-bound server, so this field only needs to exist at all
 * once a flow has actually finished once.
 */
type McpAuthorizationStatus = 'authorized' | 'needs-reconnect' | 'error'
type McpRow = Readonly<{
  definition: McpServerDefinitionInput
  revision: string
  trust: TrustState
  desired: 'enabled' | 'disabled'
  status: McpStatus
  localStartApproval?: string
  authorizationStatus?: McpAuthorizationStatus
}>
type Op = Readonly<{
  operation: ResourceOperation
  owner: { principalId: string; clientId: string }
  command: { method: string; commandId: string; hash: string }
  params: Record<string, unknown>
}>
type Journal = Readonly<{
  version: 1
  servers: Record<string, McpRow>
  operations: readonly Op[]
  legacyPresetImported: boolean
}>
const terminal = new Set<ResourceOperation['state']>(['succeeded', 'failed', 'cancelled'])
const windows = process.platform === 'win32' // guards-allow-platform: Windows journal replacement and read handle lifetime.
const digest = (value: unknown) => createHash('sha256').update(jcs(value), 'utf8').digest('hex')
const copy = <T>(value: T): T => structuredClone(value)
const initial = (): Journal => ({
  version: 1,
  servers: Object.create(null),
  operations: [],
  legacyPresetImported: false,
})
const fail = (code: string, message: string): SafeError => ({ code, message })
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
class McpJournalStore {
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
  ): Promise<T> {
    return this.serialize(profile, async () => {
      const result = await fn(await this.load(profile))
      const next = decode(result.next)
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const target = this.path(profile)
      const tmp = `${target}.${randomUUID()}.tmp`
      const handle = await open(tmp, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(next))
        await handle.sync()
        await handle.close()
        if (windows) await renameWriteThrough(tmp, target)
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
function descriptor(row: McpRow): McpServerDescriptor {
  const status = row.status
  return {
    kind: 'mcp',
    resourceId: `mcp/${row.definition.serverId}`,
    serverId: row.definition.serverId,
    displayName: row.definition.displayName,
    revision: row.revision,
    definition: copy(row.definition),
    transportKind: row.definition.transport.kind,
    secretBindingKind: row.definition.secretBinding.kind,
    trust: row.trust,
    desired: row.desired,
    actual:
      status.connectionState === 'ready'
        ? 'ready'
        : status.connectionState === 'disabled'
          ? 'disabled'
          : status.connectionState === 'degraded'
            ? 'degraded'
            : 'unavailable',
    source: 'managed',
    ...(status.lastSafeError ? { lastSafeError: status.lastSafeError } : {}),
    ...(row.definition.secretBinding.kind === 'oauth'
      ? { authorizationStatus: row.authorizationStatus ?? 'pending' }
      : {}),
  }
}

/** Shared projection for both the mcp.servers.oauth.status read and the .status.set write's own
 * result (the write returns the value it just committed, so a caller can trust its own response
 * instead of always issuing a second read): reuses McpStatus.lastSafeError verbatim rather than
 * inventing a parallel OAuth-specific error field, per the Task 5 brief's explicit instruction (this
 * one connection-level failure record is what a subsequent, credential-driven connection attempt
 * would populate; it is not this file's job to distinguish "why did OAuth itself fail" from "why did
 * the resulting connection fail" beyond what McpStatus already records - see oauth-http-handler.ts's
 * `OnOAuthAuthorizationStatus`, which deliberately carries no error detail of its own either). A
 * server whose secretBinding is not 'oauth' reports `null`: the field simply does not apply to it.
 */
function authorizationStatusResult(row: McpRow): {
  authorizationStatus: McpAuthorizationStatus | 'pending' | null
  lastSafeError?: SafeError
} {
  return {
    authorizationStatus:
      row.definition.secretBinding.kind === 'oauth' ? (row.authorizationStatus ?? 'pending') : null,
    ...(row.status.lastSafeError ? { lastSafeError: row.status.lastSafeError } : {}),
  }
}
const status = (
  serverId: string,
  state: McpStatus['connectionState'] = 'unavailable',
  error?: SafeError,
): McpStatus => ({
  serverId,
  connectionState: state,
  observedRevision: null,
  catalogRevision: null,
  toolCount: 0,
  observedAt: new Date().toISOString(),
  ...(error ? { lastSafeError: error } : {}),
})

/** Durable MCP control plane. It passes definitions/SecretRefs unchanged to the Host lifecycle adapter. */
export class McpResourceStore {
  private readonly journal: McpJournalStore
  private readonly active = new Map<string, AbortController>()
  private deferDrive = false
  constructor(
    directory: string,
    scope: ResourceProfileScope,
    private adapter?: McpLifecycleAdapter,
  ) {
    this.journal = new McpJournalStore(directory, scope)
  }
  setAdapter(adapter: McpLifecycleAdapter): void {
    this.adapter = adapter
  }
  setDeferredDrive(defer: boolean): void {
    this.deferDrive = defer
  }
  async driveOperation(
    profile: string,
    operationId: string,
    beforeTerminal?: () => Promise<void>,
    afterSuccess?: () => void,
  ): Promise<void> {
    await this.drive(profile, operationId, beforeTerminal, afterSuccess)
  }
  async requiresSecretUse(
    method: ResourceControlMethodName,
    params: Record<string, unknown>,
  ): Promise<boolean> {
    if (method !== '_agnes/v1/mcp.servers.test') return false
    return this.journal.read(params.profile as string, (j) => {
      const row = j.servers[params.serverId as string]
      return !!row && row.definition.secretBinding.kind !== 'none'
    })
  }
  async call(
    method: ResourceControlMethodName,
    params: Record<string, unknown>,
    authority: ResourceAuthority,
  ): Promise<unknown> {
    if (method === '_agnes/v1/resources.operation.get')
      return this.journal.read(params.profile as string, (j) => {
        const op = j.operations.find((entry) => entry.operation.operationId === params.operationId)
        if (!op) throw rpcError('CAPABILITY_DENIED', { code: 'RESOURCE_OPERATION_UNAVAILABLE' })
        if (
          op.owner.principalId !== authority.principalId &&
          !authority.permissions.includes('resources.reconcile' as ResourcePermission)
        )
          throw rpcError('CAPABILITY_DENIED', { code: 'RESOURCE_OPERATION_OWNER_REQUIRED' })
        return copy(op.operation)
      })
    if (method === '_agnes/v1/mcp.servers.list')
      return this.journal.read(params.profile as string, (j) => {
        const all = Object.values(j.servers)
          .map(descriptor)
          .sort((a, b) => a.serverId.localeCompare(b.serverId))
          .filter((item) => !params.cursor || item.serverId > params.cursor)
        const items = all.slice(0, 100)
        const last = items.at(-1)
        return { items, ...(all.length > items.length && last ? { nextCursor: last.serverId } : {}) }
      })
    if (method === '_agnes/v1/mcp.servers.get') return this.one(params, descriptor)
    if (method === '_agnes/v1/mcp.servers.status') return this.one(params, (row) => copy(row.status))
    if (method === '_agnes/v1/mcp.servers.tools.list') return this.tools(params)
    // Pure durable-journal read/write, dispatched directly here rather than through effect()'s
    // generic journal-operation/receipt pipeline: unlike create/update/trust.set/enable/disable/
    // test/reconnect, neither of these has any business driving apply()'s reconcile/test/reconnect
    // machinery (there is no MCP connection lifecycle work to do - only a status field to read or
    // write), and mcp.servers.oauth.status.set's caller (the daemon HTTP callback endpoint, running
    // in a different process - see oauth-http-handler.ts's OnOAuthAuthorizationStatus) needs the
    // committed value back synchronously, not an operationId to poll.
    if (method === '_agnes/v1/mcp.servers.oauth.status') return this.one(params, authorizationStatusResult)
    if (method === '_agnes/v1/mcp.servers.oauth.status.set') return this.setAuthorizationStatus(params)
    if (!method.startsWith('_agnes/v1/mcp.servers.') && method !== '_agnes/v1/resources.operation.cancel')
      throw rpcError('METHOD_NOT_FOUND', { method })
    return this.effect(method, params, authority)
  }
  async recover(beforeTerminal?: (profile: string) => Promise<void>): Promise<void> {
    for (const profile of await this.journal.profiles()) {
      // A journal records the last Host observation, never a live connection. A new daemon has no
      // active generation yet, so it must not surface the departed process's ready catalog while it
      // restores the current Host. Disabled rows are safe without a connection; every other live
      // observation is demoted before any client can inspect it.
      await this.invalidateDepartedObservations(profile)
      await this.recoverProfile(profile, beforeTerminal)
      await this.restoreCurrentObservations(profile)
    }
  }
  async recoverProfile(profile: string, beforeTerminal?: (profile: string) => Promise<void>): Promise<void> {
    const operations = await this.journal.read(profile, (journal) =>
      journal.operations.filter((row) => !terminal.has(row.operation.state)),
    )
    for (const operation of operations)
      await this.drive(
        profile,
        operation.operation.operationId,
        () => beforeTerminal?.(profile) ?? Promise.resolve(),
      )
  }
  /** Demote observations made by a departed Host; durable definitions and operations remain intact. */
  private async invalidateDepartedObservations(profile: string): Promise<void> {
    await this.journal.txn(profile, (journal) => {
      let changed = false
      const servers = Object.fromEntries(
        Object.entries(journal.servers).map(([serverId, row]) => {
          if (row.status.connectionState === 'disabled') return [serverId, row]
          changed = true
          return [
            serverId,
            {
              ...row,
              status: status(
                serverId,
                'unavailable',
                fail('MCP_RESTART_REQUIRED', 'MCP connection awaits current Host observation'),
              ),
            },
          ]
        }),
      ) as Record<string, McpRow>
      return { next: changed ? { ...journal, servers } : journal, result: undefined }
    })
  }
  /** Restore only trusted enabled definitions, and publish only the current worker's observation. */
  private async restoreCurrentObservations(profile: string): Promise<void> {
    if (!this.adapter) return
    const servers = await this.journal.read(profile, (journal) =>
      Object.values(journal.servers)
        .filter((row) => row.trust === 'trusted' && row.desired === 'enabled')
        .map(copy),
    )
    for (const row of servers) {
      const serverId = row.definition.serverId
      try {
        const result = await this.adapter.reconcile({
          profile,
          serverId,
          definition: row.definition,
          enabled: true,
          signal: new AbortController().signal,
        })
        await this.observe(profile, serverId, result.status)
        // The adapter's safe candidate status is retained even when it did not publish a current
        // generation. This keeps descriptor/status honest and catalog reads stably unavailable.
      } catch {
        await this.observe(
          profile,
          serverId,
          status(
            serverId,
            'unavailable',
            fail('MCP_CONNECT_FAILED', 'MCP connection could not be restored by the current Host'),
          ),
        )
      }
    }
  }
  /** Daemon-only: called after approval bound to this exact definition, never exposed as RPC. */
  async approveLocalStart(profile: string, serverId: string, revision: string): Promise<void> {
    await this.journal.txn(profile, (journal) => {
      const row = journal.servers[serverId]
      if (!row || row.revision !== revision || row.trust !== 'trusted')
        throw rpcError('SEMANTIC_REJECTED', { code: 'REVISION_CONFLICT' })
      return {
        next: {
          ...journal,
          servers: { ...journal.servers, [serverId]: { ...row, localStartApproval: revision } },
        },
        result: undefined,
      }
    })
  }
  async workerManaged(profile: string): Promise<
    Array<{
      definition: McpServerDefinitionInput
      revision: string
      desired: 'enabled' | 'disabled'
      trust: TrustState
      localStartApproval?: string
    }>
  > {
    return this.journal.read(profile, (journal) =>
      Object.values(journal.servers).map((row) => ({
        definition: copy(row.definition),
        ...(row.localStartApproval ? { localStartApproval: row.localStartApproval } : {}),
        revision: row.revision,
        desired: row.desired,
        trust: row.trust,
      })),
    )
  }
  /** One-way migration seam for already parsed, trusted legacy preset definitions. It is idempotent
   * for byte-identical input and fail-closed on an existing managed server id. */
  async seedLegacyPreset(profile: string, definitions: readonly McpServerDefinitionInput[]): Promise<void> {
    await this.journal.txn(profile, (journal) => {
      if (journal.legacyPresetImported) return { next: journal, result: undefined }
      const servers = { ...journal.servers }
      for (const definition of definitions) {
        if (!validateResourceControlData('McpServerDefinitionInput', definition).ok)
          throw rpcError('SEMANTIC_REJECTED', { code: 'LEGACY_MCP_INVALID' })
        const revision = digest(definition)
        const prior = servers[definition.serverId]
        if (
          prior &&
          (prior.revision !== revision || prior.trust !== 'trusted' || prior.desired !== 'enabled')
        )
          throw rpcError('SEMANTIC_REJECTED', { code: 'LEGACY_MCP_CONFLICT', serverId: definition.serverId })
        if (!prior)
          servers[definition.serverId] = {
            definition: copy(definition),
            revision,
            trust: 'trusted',
            desired: 'enabled',
            status: status(definition.serverId),
          }
      }
      return { next: { ...journal, servers, legacyPresetImported: true }, result: undefined }
    })
  }
  /** The journal's own current view of one server's observed status, or `undefined` for an unknown
   *  server. The one thing a caller outside this store needs from the raw journal today: the
   *  revision the shared session worker's row is expected to still be running, so a paginated
   *  catalog read can be refused rather than served against a definition the journal has moved
   *  past (single-resident-worker design §3.4). */
  async observedStatus(profile: string, serverId: string): Promise<McpStatus | undefined> {
    return this.journal.read(profile, (journal) => journal.servers[serverId]?.status)
  }
  async observeWorker(profile: string, statuses: readonly McpStatus[]): Promise<void> {
    if (!statuses.every((value) => validateResourceControlData('McpStatus', value).ok))
      throw new Error('invalid worker MCP observation')
    for (const value of statuses) await this.observe(profile, value.serverId, value)
    await this.journal.txn(profile, (journal) => ({
      next: {
        ...journal,
        operations: journal.operations.map((entry) =>
          terminal.has(entry.operation.state) ||
          !statuses.some(
            (value) =>
              entry.operation.target === `mcp/${value.serverId}` &&
              (value.connectionState === 'ready' || value.connectionState === 'disabled'),
          )
            ? entry
            : {
                ...entry,
                operation: {
                  ...entry.operation,
                  state: 'succeeded' as const,
                  updatedAt: new Date().toISOString(),
                  progress: 100,
                },
              },
        ),
      },
      result: undefined,
    }))
  }
  private async one<T>(params: Record<string, unknown>, map: (row: McpRow) => T): Promise<T> {
    return this.journal.read(params.profile as string, (j) => {
      const row = j.servers[params.serverId as string]
      if (!row) throw rpcError('SEMANTIC_REJECTED', { code: 'MCP_NOT_FOUND' })
      return map(row)
    })
  }
  /** _agnes/v1/mcp.servers.oauth.status.set's implementation: a direct journal write of exactly one
   * field, deliberately not routed through effect()'s replay/journal-operation/apply() pipeline (see
   * the call() dispatch comment). No expectedRevision guard: authorizationStatus is not part of
   * McpServerDefinitionInput (the thing a revision digests), and its one real caller reports the
   * outcome of a flow it alone drove end to end - there is no concurrent-writer race to guard
   * against the way trust.set/enable/disable guard against a stale definition view. */
  private async setAuthorizationStatus(
    params: Record<string, unknown>,
  ): Promise<{ authorizationStatus: McpAuthorizationStatus | 'pending' | null; lastSafeError?: SafeError }> {
    const serverId = params.serverId as string
    const nextStatus = params.status as McpAuthorizationStatus
    return this.journal.txn(params.profile as string, (journal) => {
      const row = journal.servers[serverId]
      if (!row) throw rpcError('SEMANTIC_REJECTED', { code: 'MCP_NOT_FOUND' })
      const updated: McpRow = { ...row, authorizationStatus: nextStatus }
      return {
        next: { ...journal, servers: { ...journal.servers, [serverId]: updated } },
        result: authorizationStatusResult(updated),
      }
    })
  }
  private async tools(params: Record<string, unknown>): Promise<McpToolCatalogPage> {
    const serverId = params.serverId as string
    const row = await this.one(params, (value) => value)
    if (!this.adapter || row.status.connectionState !== 'ready' || !row.status.catalogRevision)
      throw rpcError('SEMANTIC_REJECTED', { code: 'MCP_CATALOG_UNAVAILABLE' })
    const page = await this.adapter.tools({
      profile: params.profile as string,
      serverId,
      ...(params.cursor ? { cursor: params.cursor as string } : {}),
      signal: new AbortController().signal,
    })
    if (page.serverId !== serverId || page.catalogRevision !== row.status.catalogRevision)
      throw rpcError('SEMANTIC_REJECTED', { code: 'MCP_CATALOG_UNAVAILABLE' })
    return page
  }
  private async effect(
    method: ResourceControlMethodName,
    params: Record<string, unknown>,
    authority: ResourceAuthority,
  ): Promise<unknown> {
    const profile = params.profile as string
    const receipt = await this.journal.txn(profile, (journal) => {
      const commandId = params.commandId as string
      const requestHash = digest({
        method,
        payload: Object.fromEntries(
          Object.entries(params).filter(([key]) => key !== 'clientId' && key !== 'commandId'),
        ),
      })
      const replay = journal.operations.find(
        (op) =>
          op.owner.principalId === authority.principalId &&
          op.owner.clientId === authority.clientId &&
          op.command.commandId === commandId,
      )
      if (replay) {
        if (replay.command.method !== method || replay.command.hash !== requestHash)
          throw rpcError('SEMANTIC_REJECTED', { code: 'COMMAND_CONFLICT' })
        return {
          next: journal,
          result: {
            operationId: replay.operation.operationId,
            state: replay.operation.kind.includes('.cancel') ? 'succeeded' : 'received',
          },
        }
      }
      const cancellation =
        method === '_agnes/v1/resources.operation.cancel'
          ? journal.operations.find((entry) => entry.operation.operationId === params.operationId)
          : undefined
      const serverId = (params.serverId ??
        (params.definition as McpServerDefinitionInput | undefined)?.serverId ??
        cancellation?.operation.target.slice(4)) as string
      const prior = journal.servers[serverId]
      if (!serverId || (!prior && method !== '_agnes/v1/mcp.servers.create' && !cancellation))
        throw rpcError('SEMANTIC_REJECTED', { code: 'MCP_NOT_FOUND' })
      if (
        method === '_agnes/v1/mcp.servers.remove' &&
        (prior?.desired === 'enabled' ||
          journal.operations.some(
            (entry) => entry.operation.target === `mcp/${serverId}` && !terminal.has(entry.operation.state),
          ))
      )
        throw rpcError('SEMANTIC_REJECTED', {
          code: 'RESOURCE_REMOVE_BLOCKED',
          reason: 'disable and settle the MCP resource before removal',
        })
      if (params.expectedRevision && prior?.revision !== params.expectedRevision)
        throw rpcError('SEMANTIC_REJECTED', { code: 'REVISION_CONFLICT' })
      const existingRevision = prior?.revision ?? cancellation?.operation.revision
      const revision =
        method === '_agnes/v1/mcp.servers.create' || method === '_agnes/v1/mcp.servers.update'
          ? digest(params.definition)
          : existingRevision
      if (!revision) throw rpcError('SEMANTIC_REJECTED', { code: 'MCP_NOT_FOUND' })
      const time = new Date().toISOString()
      const operation: ResourceOperation = {
        operationId: `resource-${randomUUID()}`,
        kind: method,
        state: 'received',
        profile,
        target: `mcp/${serverId}`,
        revision,
        createdAt: time,
        updatedAt: time,
        progress: 0,
      }
      if (method === '_agnes/v1/mcp.servers.create' && prior)
        throw rpcError('SEMANTIC_REJECTED', { code: 'MCP_ALREADY_EXISTS', serverId })
      // Candidate activation may replace the journal row temporarily, but the operation retains
      // the verified prior generation so a failed candidate cannot erase its durable LKG.
      const op: Op = {
        operation,
        owner: { principalId: authority.principalId, clientId: authority.clientId },
        command: { method, commandId, hash: requestHash },
        params: copy(method === '_agnes/v1/mcp.servers.update' ? { ...params, previous: prior } : params),
      }
      const servers = { ...journal.servers }
      if (method === '_agnes/v1/mcp.servers.create' || method === '_agnes/v1/mcp.servers.update') {
        const definition = copy(params.definition as McpServerDefinitionInput)
        servers[serverId] = {
          definition,
          revision,
          trust: 'untrusted',
          desired: prior?.desired ?? 'disabled',
          status: status(serverId, 'unavailable'),
        }
      }
      if (method === '_agnes/v1/mcp.servers.trust.set') {
        if (!prior) throw rpcError('SEMANTIC_REJECTED', { code: 'MCP_NOT_FOUND' })
        const { localStartApproval, ...unapproved } = prior
        servers[serverId] = {
          ...(params.trust === 'trusted' ? prior : unapproved),
          trust: params.trust as TrustState,
        }
      }
      if (method === '_agnes/v1/mcp.servers.enable') {
        if (!prior) throw rpcError('SEMANTIC_REJECTED', { code: 'MCP_NOT_FOUND' })
        servers[serverId] = { ...prior, desired: 'enabled' }
      }
      if (method === '_agnes/v1/mcp.servers.disable') {
        if (!prior) throw rpcError('SEMANTIC_REJECTED', { code: 'MCP_NOT_FOUND' })
        servers[serverId] = { ...prior, desired: 'disabled' }
      }
      if (method === '_agnes/v1/resources.operation.cancel') {
        const target = cancellation
        if (!target) throw rpcError('CAPABILITY_DENIED', { code: 'RESOURCE_OPERATION_UNAVAILABLE' })
        if (
          target.owner.principalId !== authority.principalId &&
          !authority.permissions.includes('resources.reconcile' as ResourcePermission)
        )
          throw rpcError('CAPABILITY_DENIED', { code: 'RESOURCE_OPERATION_OWNER_REQUIRED' })
        // Do this inside the journal admission transaction, before allocating an accepted
        // cancellation operation or touching an active controller. Terminal work is immutable.
        if (terminal.has(target.operation.state))
          throw rpcError('SEMANTIC_REJECTED', {
            code: 'RESOURCE_OPERATION_TERMINAL',
            reason: 'operation has already reached a terminal state',
          })
        this.active.get(target.operation.operationId)?.abort()
        const operations = [
          ...journal.operations.map((entry) =>
            entry.operation.operationId === target.operation.operationId &&
            !terminal.has(entry.operation.state)
              ? {
                  ...entry,
                  operation: {
                    ...entry.operation,
                    state: 'cancelled' as const,
                    updatedAt: new Date().toISOString(),
                    progress: 100,
                    lastSafeError: fail('CANCELLED', 'operation cancellation was requested'),
                  },
                }
              : entry,
          ),
          { ...op, operation: { ...operation, state: 'succeeded' as const, progress: 100 } },
        ]
        return {
          next: { ...journal, servers, operations },
          result: { operationId: operation.operationId, state: 'succeeded' },
        }
      }
      const pending = journal.operations.filter((entry) => !terminal.has(entry.operation.state))
      if (pending.length >= 900)
        throw rpcError('OVERLOADED', {
          code: 'RESOURCE_OPERATION_LIMIT',
          reason: 'too many non-terminal resource operations',
        })
      const finished = journal.operations.filter((entry) => terminal.has(entry.operation.state)).slice(-500)
      return {
        next: { ...journal, servers, operations: [...pending, ...finished, op] },
        result: { operationId: operation.operationId, state: 'received' },
      }
    })
    if (!this.deferDrive) void this.drive(profile, receipt.operationId)
    return receipt
  }
  private async drive(
    profile: string,
    id: string,
    beforeTerminal?: () => Promise<void>,
    afterSuccess?: () => void,
  ): Promise<void> {
    const ac = new AbortController()
    this.active.set(id, ac)
    const op = await this.journal.txn(profile, (j) => {
      const row = j.operations.find((entry) => entry.operation.operationId === id)
      if (!row || terminal.has(row.operation.state)) return { next: j, result: undefined }
      return {
        next: {
          ...j,
          operations: j.operations.map((entry) =>
            entry.operation.operationId === id
              ? {
                  ...entry,
                  operation: {
                    ...entry.operation,
                    state: 'running',
                    updatedAt: new Date().toISOString(),
                    progress: 50,
                  },
                }
              : entry,
          ),
        },
        result: copy(row),
      }
    })
    if (!op) {
      this.active.delete(id)
      return
    }
    try {
      if (!this.adapter) throw new Error('MCP adapter unavailable')
      const result = await this.apply(profile, op, ac.signal)
      await beforeTerminal?.()
      await this.finish(profile, id, 'succeeded', undefined, result)
      try {
        afterSuccess?.()
      } catch {}
    } catch {
      if (!ac.signal.aborted) {
        await this.restorePrevious(profile, op)
        await beforeTerminal?.().catch(() => undefined)
        await this.finish(
          profile,
          id,
          'failed',
          fail('MCP_RECONCILE_FAILED', 'MCP lifecycle adapter failed safely'),
        )
      }
    } finally {
      this.active.delete(id)
    }
  }
  private async apply(
    profile: string,
    op: Op,
    signal: AbortSignal,
  ): Promise<{ toolCount?: number; catalogRevision?: string } | undefined> {
    if (!this.adapter) throw new Error('MCP adapter unavailable')
    const serverId = op.operation.target.slice(4)
    const row = await this.journal.read(profile, (j) => j.servers[serverId])
    if (!row) {
      if (op.operation.kind === '_agnes/v1/mcp.servers.remove') return
      throw new Error('MCP definition unavailable')
    }
    await this.adapter.stage?.({
      definition: row.definition,
      revision: row.revision,
      desired: row.desired,
      trust: row.trust,
    })
    if (op.operation.kind === '_agnes/v1/mcp.servers.test') {
      const tested = await this.adapter.test({ profile, serverId, definition: row.definition, signal })
      if (tested.error) throw new Error('MCP test failed')
      return { toolCount: tested.toolCount, catalogRevision: tested.catalogRevision }
    }
    if (op.operation.kind === '_agnes/v1/mcp.servers.reconnect') {
      const result = await this.adapter.reconnect({ profile, serverId, definition: row.definition, signal })
      // A reconnect is a candidate generation. If it cannot connect, the adapter has kept the
      // prior active generation alive; publishing the candidate's unavailable observation here
      // would make the durable catalog reject that still-safe active generation. The terminal
      // operation records the safe failure while the previous ready observation remains usable.
      if (result.error) throw new Error('MCP reconnect failed')
      await this.observe(profile, serverId, result.status)
      return
    }
    if (op.operation.kind === '_agnes/v1/mcp.servers.remove') {
      await this.adapter.unstage?.(serverId)
      await this.journal.txn(profile, (j) => {
        const servers = { ...j.servers }
        delete servers[serverId]
        return { next: { ...j, servers }, result: undefined }
      })
      return
    }
    const result = await this.adapter.reconcile({
      profile,
      serverId,
      definition: row.definition,
      enabled: row.desired === 'enabled',
      signal,
    })
    await this.observe(profile, serverId, result.status)
    if (result.error) throw new Error('MCP reconcile failed')
  }
  private async observe(profile: string, serverId: string, observed: McpStatus): Promise<void> {
    if (!validateResourceControlData('McpStatus', observed).ok) throw new Error('invalid MCP observation')
    await this.journal.txn(profile, (j) => {
      const row = j.servers[serverId]
      return {
        next: row ? { ...j, servers: { ...j.servers, [serverId]: { ...row, status: copy(observed) } } } : j,
        result: undefined,
      }
    })
  }
  private async restorePrevious(profile: string, op: Op): Promise<void> {
    if (op.operation.kind !== '_agnes/v1/mcp.servers.update') return
    const previous = op.params.previous
    if (
      !plain(previous) ||
      !validateResourceControlData('McpServerDefinitionInput', previous.definition).ok ||
      !validateResourceControlData('McpStatus', previous.status).ok
    )
      return
    await this.journal.txn(profile, (j) => ({
      next: { ...j, servers: { ...j.servers, [op.operation.target.slice(4)]: copy(previous as McpRow) } },
      result: undefined,
    }))
  }
  private async finish(
    profile: string,
    id: string,
    state: ResourceOperation['state'],
    error?: SafeError,
    result?: { toolCount?: number; catalogRevision?: string },
  ): Promise<void> {
    await this.journal.txn(profile, (j) => ({
      next: {
        ...j,
        operations: j.operations.map((op) =>
          op.operation.operationId === id && !terminal.has(op.operation.state)
            ? {
                ...op,
                operation: {
                  ...op.operation,
                  state,
                  updatedAt: new Date().toISOString(),
                  progress: 100,
                  ...(error ? { lastSafeError: error } : {}),
                  ...(result ? { result } : {}),
                },
              }
            : op,
        ),
      },
      result: undefined,
    }))
  }
}
