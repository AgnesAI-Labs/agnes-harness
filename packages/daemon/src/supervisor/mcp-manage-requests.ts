import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import {
  jcs,
  type McpServerDefinitionInput,
  type McpServerDescriptor,
  type ResourceControlMethodName,
  type ResourceOperationReceipt,
  rpcError,
  validateResourceControlData,
} from '@agnes/protocol'
import { deploymentMcpPolicy } from '@agnes/resource-control-daemon'
import { validateManagedHttpUrl } from '@agnes/resource-control-runtime'
import {
  localResourceAuthority,
  type ResourceAuthorityResolver,
  type ResourceControlService,
  type ResourceControlStore,
} from '@agnes/resource-control-store'
import { type ConnectionState, connActor, type LocalEndpoint } from '../local/endpoint.js'
import { PrompterRouter } from '../local/prompter.js'

type Receipt = {
  proposalId: string
  owner: string
  sessionKey: string
  revision: string
  serverId: string
  state: 'prepared' | 'registered' | 'submitted' | 'cancelled' | 'failed'
  operationId?: string
}
type Proposal = { receipt: Receipt; definition: McpServerDefinitionInput; expires: number; busy: boolean }
const digest = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const fail = (code: string): never => {
  throw rpcError('SEMANTIC_REJECTED', { code })
}
async function executablePath(value: string): Promise<string> {
  const candidates = isAbsolute(value)
    ? [value]
    : value.includes('/') || value.includes('\\')
      ? []
      : (process.env.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, value))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return await realpath(candidate)
    } catch {
      /* Try the next PATH directory. */
    }
  }
  return fail('MCP_EXECUTABLE_NOT_FOUND')
}

/** Requests arrive only on the authenticated worker channel. No model-accessible admin RPC. */
export function createMcpManageRequests(options: {
  directory: string
  profile: string
  service: ResourceControlService
  store?: ResourceControlStore
  authority?: ResourceAuthorityResolver
  current(sessionKey: string): ConnectionState | undefined
  endpoint(conn: ConnectionState): LocalEndpoint | undefined
  owner(sessionKey: string): { principalId: string; active: boolean } | undefined
}) {
  const proposals = new Map<string, Proposal>()
  const pending = new Map<string, AbortController>()
  const policy = deploymentMcpPolicy(process.env)
  const directory = join(options.directory, 'mcp-onboarding')
  const receiptPath = (id: string) => join(directory, `${id}.json`)
  const save = async (receipt: Receipt) => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${receiptPath(receipt.proposalId)}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 })
    await rename(temporary, receiptPath(receipt.proposalId))
  }
  return async (sessionKey: string, requestId: string, method: string, raw: unknown): Promise<unknown> => {
    const requestKey = `${sessionKey}\0${requestId}`
    if (method === 'mcp-manage-abort') {
      if (object(raw) && typeof raw.requestId === 'string')
        pending.get(`${sessionKey}\0${raw.requestId}`)?.abort()
      return undefined
    }
    const conn = options.current(sessionKey)
    const owner = options.owner(sessionKey)
    const assertActive = () => {
      const currentOwner = options.owner(sessionKey)
      if (
        conn?.authKind !== 'local' ||
        conn.credentialKind !== 'local' ||
        !conn.capabilities.permission ||
        !conn.attached.has(sessionKey) ||
        !options.endpoint(conn) ||
        !currentOwner?.active ||
        currentOwner.principalId !== conn.principalId ||
        currentOwner.principalId !== owner?.principalId
      )
        throw rpcError('CAPABILITY_DENIED', { code: 'MCP_LOCAL_OWNER_REQUIRED' })
    }
    assertActive()
    if (!conn || !options.store) throw rpcError('CAPABILITY_DENIED')
    if (
      !object(raw) ||
      Object.keys(raw).some(
        (key) =>
          !['input', 'sessionKey', 'toolUseId', 'leaseId', 'packageId', 'snapshotId', 'rowId'].includes(key),
      ) ||
      raw.sessionKey !== sessionKey ||
      !['toolUseId', 'leaseId', 'packageId', 'snapshotId', 'rowId'].every(
        (key) =>
          typeof raw[key] === 'string' &&
          (raw[key] as string).length > 0 &&
          (raw[key] as string).length <= 512,
      ) ||
      !object(raw.input)
    )
      throw rpcError('INVALID_PARAMS')
    const input = raw.input
    if (
      !['prepare', 'commit', 'status', 'cancel', 'list'].includes(String(input.action)) ||
      Object.keys(input).some((key) => !['action', 'definition', 'proposalId'].includes(key))
    )
      throw rpcError('INVALID_PARAMS')
    if (pending.size >= 32) fail('MCP_REQUEST_LIMIT')
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    pending.set(requestKey, controller)
    const authority = () => {
      assertActive()
      signal.throwIfAborted()
      const value = (options.authority ?? localResourceAuthority())({ conn })
      if (!value) throw rpcError('CAPABILITY_DENIED')
      return value
    }
    const call = (name: ResourceControlMethodName, params: Record<string, unknown>) =>
      options.service.call(name, { ...params, profile: options.profile }, authority())
    const effect = async (name: ResourceControlMethodName, params: Record<string, unknown>, id: string) => {
      const auth = authority()
      return (await call(name, {
        ...params,
        clientId: auth.clientId,
        commandId: id,
      })) as ResourceOperationReceipt
    }
    const get = async (serverId: string) =>
      (await call('_agnes/v1/mcp.servers.get', { serverId })) as McpServerDescriptor
    const list = async () => {
      const items: McpServerDescriptor[] = []
      let cursor: string | undefined
      do {
        const page = (await call('_agnes/v1/mcp.servers.list', cursor ? { cursor } : {})) as {
          items: McpServerDescriptor[]
          nextCursor?: string
        }
        items.push(...page.items)
        cursor = page.nextCursor
      } while (cursor)
      return items
    }
    const publicReceipt = async (receipt: Receipt) => {
      if (receipt.state === 'prepared' || receipt.state === 'cancelled' || receipt.state === 'failed')
        return { proposalId: receipt.proposalId, state: receipt.state, serverId: receipt.serverId }
      const row = await get(receipt.serverId)
      const status = (await call('_agnes/v1/mcp.servers.status', { serverId: receipt.serverId })) as {
        connectionState: string
        observedRevision: string | null
        toolCount: number
        lastSafeError?: { code: string }
      }
      const operation = receipt.operationId
        ? ((await call('_agnes/v1/resources.operation.get', { operationId: receipt.operationId })) as {
            state: string
          })
        : undefined
      const ready =
        row.revision === receipt.revision &&
        row.trust === 'trusted' &&
        row.desired === 'enabled' &&
        status.connectionState === 'ready' &&
        status.observedRevision === receipt.revision
      if (!ready && (operation?.state === 'failed' || operation?.state === 'cancelled'))
        return {
          proposalId: receipt.proposalId,
          serverId: receipt.serverId,
          state: operation.state,
          connectionState: status.connectionState,
          code: status.lastSafeError?.code ?? 'MCP_CONNECT_FAILED',
          message: 'MCP 已登记，但接入尚未完成。请在 AGH 设置 → MCP 查看并修复连接；不能报告工具可用。',
        }
      return {
        proposalId: receipt.proposalId,
        serverId: receipt.serverId,
        state:
          row.revision !== receipt.revision
            ? 'changed'
            : ready
              ? 'ready'
              : row.trust !== 'trusted'
                ? 'blocked'
                : row.desired === 'disabled'
                  ? 'disabled'
                  : receipt.state,
        connectionState: status.connectionState,
        toolCount: status.toolCount,
        effective: 'next-turn',
        message: ready
          ? 'MCP 已在 AGH 连接成功。请根据本轮实际工具列表判断能否调用。'
          : '服务已登记到 AGH：设置 → MCP。连接和工具快照在轮次边界生效；本轮请结束回复，下一轮再核验。',
      }
    }
    try {
      if (input.action === 'list')
        return {
          host: 'Agnes Harness',
          items: (await list()).map((row) => ({
            serverId: row.serverId,
            name: row.displayName,
            state: row.actual,
            enabled: row.desired === 'enabled',
          })),
        }
      if (input.action === 'prepare') {
        if (!validateResourceControlData('McpServerDefinitionInput', input.definition).ok)
          throw rpcError('INVALID_PARAMS')
        const definition = structuredClone(input.definition) as McpServerDefinitionInput
        if (definition.secretBinding.kind !== 'none') fail('MCP_CREDENTIALS_USE_AGH_SETTINGS')
        if (definition.transport.kind === 'stdio') {
          const resolvedExecutable = await executablePath(definition.transport.executable)
          if (policy.localStartApprovals) definition.transport.executable = resolvedExecutable
          if (
            !policy.localStartApprovals &&
            !policy.allowedExecutables.includes(definition.transport.executable)
          )
            fail('MCP_DEPLOYMENT_POLICY_DENIED')
        } else validateManagedHttpUrl(new URL(definition.transport.url), policy)
        if (!validateResourceControlData('McpServerDefinitionInput', definition).ok)
          throw rpcError('INVALID_PARAMS')
        for (const [id, p] of proposals) if (!p.busy && p.expires < Date.now()) proposals.delete(id)
        if (proposals.size >= 32) fail('MCP_PROPOSAL_LIMIT')
        const revision = digest(definition)
        const prior = (await list()).find((row) => row.serverId === definition.serverId)
        if (prior && prior.revision !== revision) fail('MCP_DEFINITION_CONFLICT')
        const receipt: Receipt = {
          proposalId: `mcp-onboard-${randomUUID()}`,
          owner: authority().principalId,
          sessionKey,
          revision,
          serverId: definition.serverId,
          state: 'prepared',
        }
        proposals.set(receipt.proposalId, { receipt, definition, expires: Date.now() + 600_000, busy: false })
        return {
          proposalId: receipt.proposalId,
          state: 'prepared',
          target: 'Agnes Harness',
          name: definition.displayName,
          transport: definition.transport,
          shared: 'current-profile',
          next: 'commit asks the local user to approve this exact configuration',
        }
      }
      if (typeof input.proposalId !== 'string' || !/^mcp-onboard-[a-f0-9-]{36}$/.test(input.proposalId))
        throw rpcError('INVALID_PARAMS')
      const proposal = proposals.get(input.proposalId)
      let receipt = proposal?.receipt
      if (!receipt) {
        try {
          receipt = JSON.parse(await readFile(receiptPath(input.proposalId), 'utf8')) as Receipt
        } catch {
          fail('MCP_REQUEST_NOT_FOUND')
        }
      }
      if (!receipt || receipt.owner !== authority().principalId || receipt.sessionKey !== sessionKey)
        throw rpcError('CAPABILITY_DENIED')
      if (input.action === 'status') return publicReceipt(receipt)
      if (proposal?.busy) fail('MCP_REQUEST_BUSY')
      if (input.action === 'cancel') {
        if (receipt.operationId)
          await effect(
            '_agnes/v1/resources.operation.cancel',
            { operationId: receipt.operationId },
            `${receipt.proposalId}-cancel`,
          )
        receipt.state = 'cancelled'
        await save(receipt)
        return publicReceipt(receipt)
      }
      if (receipt.state !== 'prepared') return publicReceipt(receipt)
      if (!proposal || proposal.expires < Date.now())
        throw rpcError('SEMANTIC_REJECTED', { code: 'MCP_PROPOSAL_EXPIRED' })
      proposal.busy = true
      try {
        const summary = `接入到 Agnes Harness：${proposal.definition.displayName}\n${JSON.stringify(proposal.definition.transport)}\n在当前 AGH 配置的会话中共享；登记、信任并启用此配置。启动命令可能下载并运行第三方软件。仅批准本服务的这份配置，不修改其他客户端。`
        const prompt = new PrompterRouter({
          record: () => {},
          connections: () => [conn],
          originOf: () => conn,
          clock: Date.now,
          endpointFor: () => {
            const ep = options.endpoint(conn)
            if (!ep) throw new Error('closed')
            return ep
          },
        })
        const verdict = await prompt.ask(
          {
            requestId: `mcp-${randomUUID()}`,
            kind: 'tool',
            sessionKey,
            stepId: 'mcp-manage',
            toolUseId: raw.toolUseId as string,
            summary,
            risk: 'always',
            actor: connActor(conn),
            taint: false,
            bindingHash: receipt.revision,
            deadline: new Date(Date.now() + 110_000).toISOString(),
            scope: 'mcp.connect',
          },
          { signal },
        )
        authority()
        if (!['allowed-once', 'allowed-session', 'allowed-permanent'].includes(verdict)) {
          receipt.state = 'cancelled'
          await save(receipt)
          return publicReceipt(receipt)
        }
        const prior = (await list()).find((row) => row.serverId === receipt.serverId)
        if (prior && prior.revision !== receipt.revision) fail('MCP_DEFINITION_CONFLICT')
        // Persist intent before admission. Recovery never silently repeats approval or an unknown write.
        receipt.state = 'registered'
        await save(receipt)
        if (!prior)
          await effect(
            '_agnes/v1/mcp.servers.create',
            { definition: proposal.definition },
            `${receipt.proposalId}-create`,
          )
        await effect(
          '_agnes/v1/mcp.servers.trust.set',
          { serverId: receipt.serverId, expectedRevision: receipt.revision, trust: 'trusted' },
          `${receipt.proposalId}-trust`,
        )
        if (policy.localStartApprovals && proposal.definition.transport.kind === 'stdio') {
          authority()
          await options.store.mcp.approveLocalStart(options.profile, receipt.serverId, receipt.revision)
        }
        const enabled = await effect(
          '_agnes/v1/mcp.servers.enable',
          { serverId: receipt.serverId, expectedRevision: receipt.revision },
          `${receipt.proposalId}-enable`,
        )
        receipt.operationId = enabled.operationId
        receipt.state = 'submitted'
        await save(receipt)
        return publicReceipt(receipt)
      } catch (error) {
        if (receipt.state !== 'prepared' && receipt.state !== 'cancelled' && receipt.state !== 'submitted') {
          receipt.state = 'failed'
          await save(receipt)
        }
        throw error
      } finally {
        proposal.busy = false
      }
    } finally {
      pending.delete(requestKey)
    }
  }
}
