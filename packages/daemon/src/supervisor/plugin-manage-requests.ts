import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  type PackageAdminMethodName,
  type PackageInstalledDescriptor,
  type PackageOperation,
  type PackageOperationReceipt,
  type PackagePreview,
  rpcError,
} from '@agnes/protocol'
import { type ConnectionState, connActor, type LocalEndpoint } from '../local/endpoint.js'
import { PrompterRouter } from '../local/prompter.js'
import {
  localPackageAdminAuthority,
  type PackageAdminService,
  packageOperationTerminal,
} from '../packages/index.js'
import { checkedPluginFiles } from './plugin-files.js'

type Receipt = {
  proposalId: string
  owner: string
  sessionKey: string
  clientId: string
  packageId: string
  integrity: string
  capabilityHash: string
  state: 'prepared' | 'installing' | 'submitted' | 'cancelled' | 'failed'
  operationId?: string
}
type Proposal = {
  receipt: Receipt
  source: { type: 'file'; ref: string }
  preview: PackagePreview
  expires: number
  busy: boolean
  cancel?: () => void
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
function fail(code: string): never {
  throw rpcError('SEMANTIC_REJECTED', { code })
}
/** Narrow host-owned authoring lane. It grants no generic package RPC or arbitrary file reads. */
export function createPluginManageRequests(options: {
  directory: string
  profile: string
  service(): PackageAdminService | undefined
  current(key: string): ConnectionState | undefined
  endpoint(conn: ConnectionState): LocalEndpoint | undefined
  owner(key: string): { principalId: string; active: boolean } | undefined
}) {
  const directory = join(options.directory, 'plugin-onboarding')
  const proposals = new Map<string, Proposal>()
  const pending = new Map<string, AbortController>()
  const receiptPath = (id: string) => join(directory, `${id}.json`)
  const save = async (receipt: Receipt) => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temp = `${receiptPath(receipt.proposalId)}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(receipt), { mode: 0o600, flush: true })
    await rename(temp, receiptPath(receipt.proposalId))
  }
  return async (sessionKey: string, requestId: string, method: string, raw: unknown): Promise<unknown> => {
    const key = `${sessionKey}\0${requestId}`
    if (method === 'plugin-manage-abort') {
      if (object(raw) && typeof raw.requestId === 'string')
        pending.get(`${sessionKey}\0${raw.requestId}`)?.abort()
      return undefined
    }
    const conn = options.current(sessionKey)
    const assertActive = () => {
      const owner = options.owner(sessionKey)
      if (!conn || options.current(sessionKey) !== conn || !options.endpoint(conn))
        throw rpcError('CAPABILITY_DENIED', { code: 'PLUGIN_CONNECTION_CLOSED' })
      if (
        conn.authKind !== 'local' ||
        conn.credentialKind !== 'local' ||
        !owner?.active ||
        owner.principalId !== conn.principalId
      )
        throw rpcError('CAPABILITY_DENIED', { code: 'PLUGIN_LOCAL_OWNER_REQUIRED' })
      if (!conn.capabilities.permission)
        throw rpcError('CAPABILITY_DENIED', { code: 'PLUGIN_PERMISSION_REQUIRED' })
      if (!conn.attached.has(sessionKey))
        throw rpcError('CAPABILITY_DENIED', { code: 'PLUGIN_SESSION_NOT_ATTACHED' })
    }
    assertActive()
    if (
      !conn ||
      !object(raw) ||
      Object.keys(raw).some(
        (k) =>
          !['input', 'sessionKey', 'toolUseId', 'leaseId', 'packageId', 'snapshotId', 'rowId'].includes(k),
      ) ||
      raw.sessionKey !== sessionKey ||
      !['toolUseId', 'leaseId', 'packageId', 'snapshotId', 'rowId'].every(
        (k) =>
          typeof raw[k] === 'string' && (raw[k] as string).length > 0 && (raw[k] as string).length <= 512,
      ) ||
      !object(raw.input)
    )
      throw rpcError('INVALID_PARAMS')
    const input = raw.input
    if (
      !['prepare', 'commit', 'status', 'cancel'].includes(String(input.action)) ||
      Object.keys(input).some((k) => !['action', 'files', 'proposalId'].includes(k))
    )
      throw rpcError('INVALID_PARAMS')
    if (pending.size >= 32 || pending.has(key)) fail('PLUGIN_REQUEST_LIMIT')
    const controller = new AbortController()
    pending.set(key, controller)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    const authority = () => {
      assertActive()
      signal.throwIfAborted()
      const auth = localPackageAdminAuthority([
        'packages.read',
        'packages.install',
        'packages.trust',
        'packages.activate',
      ])({ conn, clock: Date.now, signal })
      if (!auth) throw rpcError('CAPABILITY_DENIED')
      return auth
    }
    const call = (method: PackageAdminMethodName, params: Record<string, unknown>) => {
      const auth = authority()
      const service = options.service()
      if (!service) return fail('PLUGIN_MANAGEMENT_UNAVAILABLE')
      return service.call(method, { ...params, profile: options.profile }, auth)
    }
    const effect = async (
      method: PackageAdminMethodName,
      params: Record<string, unknown>,
      commandId: string,
    ) => (await call(method, { ...params, clientId: conn.clientId, commandId })) as PackageOperationReceipt
    const list = async () =>
      ((await call('_agnes/v1/packages.list', {})) as { packages: PackageInstalledDescriptor[] }).packages
    const wait = async (operationId: string) => {
      while (true) {
        const op = (await call('_agnes/v1/packages.operation.get', { operationId })) as PackageOperation
        if (packageOperationTerminal(op.state)) {
          if (op.state !== 'completed') fail('PLUGIN_PACKAGE_OPERATION_FAILED')
          return op
        }
        await delay(20, undefined, { signal })
      }
    }
    const status = async (r: Receipt) => {
      const pkg = (await list()).find((p) => p.id === r.packageId)
      const op = r.operationId
        ? ((await call('_agnes/v1/packages.operation.get', {
            operationId: r.operationId,
          })) as PackageOperation)
        : undefined
      const matches = pkg?.integrity === r.integrity
      const ready =
        matches &&
        pkg?.trusted &&
        pkg.desired === 'enabled' &&
        pkg.actual === 'running' &&
        pkg.actualIntegrity === r.integrity
      return {
        proposalId: r.proposalId,
        packageId: r.packageId,
        state: ready
          ? 'ready'
          : pkg && !matches
            ? 'changed'
            : r.state === 'installing' && !proposals.get(r.proposalId)?.busy
              ? 'interrupted'
              : op?.state === 'failed'
                ? 'failed'
                : r.state,
        installed: !!pkg,
        trusted: pkg?.trusted ?? false,
        desired: pkg?.desired,
        actual: pkg?.actual,
        operationState: op?.state,
        effective: 'next-turn',
        message: ready
          ? '插件已在 AGH 运行；使用本轮实际工具列表验证贡献。前端效果需单独验证。'
          : '可在 AGH 设置 → 插件管理查看。submitted 仅表示提交启用，请结束本轮，下一轮查询实际状态。',
      }
    }
    let active: Receipt | undefined
    try {
      if (input.action === 'prepare') {
        let files: ReturnType<typeof checkedPluginFiles>
        try {
          files = checkedPluginFiles(input.files)
        } catch {
          return fail('PLUGIN_FILES_INVALID')
        }
        for (const [id, p] of proposals) if (!p.busy && p.expires < Date.now()) proposals.delete(id)
        if (proposals.size >= 32) fail('PLUGIN_PROPOSAL_LIMIT')
        const proposalId = `plugin-${randomUUID()}`
        const stage = join(directory, 'sources', proposalId)
        for (const file of files) {
          authority()
          const path = join(stage, file.path)
          await mkdir(dirname(path), { recursive: true, mode: 0o700 })
          await writeFile(path, file.content, { flag: 'wx', mode: 0o600 })
        }
        const source = { type: 'file' as const, ref: `file:./plugin-onboarding/sources/${proposalId}` }
        const inspected = await effect('_agnes/v1/packages.inspect', { source }, `${proposalId}-inspect`)
        const preview = (await wait(inspected.operationId)).preview
        if (!preview || preview.blockers.length || !preview.capabilityHash) fail('PLUGIN_PACKAGE_INVALID')
        if ((await list()).some((p) => p.id === preview.id)) fail('PLUGIN_PACKAGE_EXISTS')
        const receipt: Receipt = {
          proposalId,
          owner: authority().principalId,
          sessionKey,
          clientId: conn.clientId,
          packageId: preview.id,
          integrity: preview.integrity,
          capabilityHash: preview.capabilityHash,
          state: 'prepared',
        }
        await save(receipt)
        proposals.set(proposalId, { receipt, source, preview, expires: Date.now() + 600_000, busy: false })
        return {
          proposalId,
          state: 'prepared',
          target: 'Agnes Harness',
          preview,
          next: 'Review source and requested capabilities. commit asks the local user to approve this exact package for the current shared AGH profile.',
        }
      }
      if (typeof input.proposalId !== 'string' || !/^plugin-[a-f0-9-]{36}$/.test(input.proposalId))
        throw rpcError('INVALID_PARAMS')
      const proposal = proposals.get(input.proposalId)
      let receipt = proposal?.receipt
      if (!receipt) {
        try {
          receipt = JSON.parse(await readFile(receiptPath(input.proposalId), 'utf8')) as Receipt
        } catch {
          return fail('PLUGIN_PROPOSAL_NOT_FOUND')
        }
      }
      if (receipt.owner !== authority().principalId || receipt.sessionKey !== sessionKey)
        throw rpcError('CAPABILITY_DENIED')
      if (input.action === 'status') return status(receipt)
      if (proposal?.busy) {
        if (input.action !== 'cancel') fail('PLUGIN_REQUEST_BUSY')
        proposal.cancel?.()
        return {
          proposalId: receipt.proposalId,
          packageId: receipt.packageId,
          state: 'cancelling',
          message: '取消已请求；已发生的安装不会自动回滚，请稍后查询实际状态。',
        }
      }
      if (input.action === 'cancel') {
        if (receipt.operationId && receipt.clientId === conn.clientId)
          await effect(
            '_agnes/v1/packages.operation.cancel',
            { operationId: receipt.operationId },
            `${receipt.proposalId}-cancel`,
          )
        receipt.state = 'cancelled'
        await save(receipt)
        return status(receipt)
      }
      if (receipt.state !== 'prepared') return status(receipt)
      if (!proposal || proposal.expires < Date.now()) fail('PLUGIN_PROPOSAL_EXPIRED')
      if (receipt.clientId !== conn.clientId) fail('PLUGIN_CONNECTION_CHANGED')
      proposal.busy = true
      proposal.cancel = () => controller.abort()
      active = receipt
      try {
        if ((await list()).some((p) => p.id === receipt.packageId)) fail('PLUGIN_PACKAGE_EXISTS')
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
            requestId: `plugin-${randomUUID()}`,
            kind: 'tool',
            sessionKey,
            stepId: 'plugin-manage',
            toolUseId: raw.toolUseId as string,
            summary: `安装到 Agnes Harness：${receipt.packageId}@${proposal.preview.version}\n摘要：${receipt.integrity}\n能力：${JSON.stringify(proposal.preview)}\n将安装、信任并启用这份生成代码，在当前 AGH 配置的会话中共享。启用会以本机进程权限运行 JavaScript；结构检查不代表代码安全或功能已验证。`,
            risk: 'always',
            actor: connActor(conn),
            taint: false,
            bindingHash: receipt.integrity,
            deadline: new Date(Date.now() + 110_000).toISOString(),
            scope: 'plugin.install',
          },
          { signal },
        )
        authority()
        if (!['allowed-once', 'allowed-session', 'allowed-permanent'].includes(verdict)) {
          receipt.state = 'cancelled'
          await save(receipt)
          return status(receipt)
        }
        if ((await list()).some((p) => p.id === receipt.packageId)) fail('PLUGIN_PACKAGE_EXISTS')
        receipt.state = 'installing'
        await save(receipt)
        const installed = await effect(
          '_agnes/v1/packages.install',
          { source: proposal.source, expectedIntegrity: receipt.integrity },
          `${receipt.proposalId}-install`,
        )
        receipt.operationId = installed.operationId
        await save(receipt)
        await wait(installed.operationId)
        const trusted = await effect(
          '_agnes/v1/packages.trust',
          {
            id: receipt.packageId,
            expectedIntegrity: receipt.integrity,
            capabilityHash: receipt.capabilityHash,
          },
          `${receipt.proposalId}-trust`,
        )
        receipt.operationId = trusted.operationId
        await save(receipt)
        await wait(trusted.operationId)
        const enabled = await effect(
          '_agnes/v1/packages.enable',
          { id: receipt.packageId, expectedInstalledIntegrity: receipt.integrity },
          `${receipt.proposalId}-enable`,
        )
        receipt.operationId = enabled.operationId
        receipt.state = 'submitted'
        await save(receipt)
        return status(receipt)
      } catch (error) {
        // Recovery only reports effects; it never resumes a previously approved pipeline.
        if (receipt.state !== 'submitted' && receipt.state !== 'cancelled') {
          receipt.state = signal.aborted ? 'cancelled' : 'failed'
          await save(receipt)
        }
        throw error
      } finally {
        proposal.busy = false
        delete proposal.cancel
      }
    } finally {
      if (signal.aborted && active?.operationId && active.state !== 'submitted') {
        // Cancellation admission uses the previously verified connection, never continues the pipeline.
        const auth = localPackageAdminAuthority(['packages.install'])({ conn, clock: Date.now, signal })
        await options
          .service()
          ?.call(
            '_agnes/v1/packages.operation.cancel',
            {
              profile: options.profile,
              clientId: conn.clientId,
              commandId: `${active.proposalId}-abort`,
              operationId: active.operationId,
            },
            auth,
          )
          .catch(() => {})
      }
      pending.delete(key)
    }
  }
}
