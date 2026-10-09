import { randomUUID } from 'node:crypto'
import { localPackageAdminAuthority, type PackageAdminService } from '@agnes/daemon-admin/packages/index'
import { type ConnectionState, connActor, type LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { PrompterRouter } from '@agnes/daemon-rpc/local/prompter'
import { type AuthoringCandidate, type PackageAdminMethodName, rpcError } from '@agnes/protocol'
import { checkedPluginFiles } from './plugin-files.js'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** Agent lane can draft, test and submit. Only authenticated human administration can publish. */
export function createPluginManageRequests(options: {
  directory: string
  profile: string
  service(): PackageAdminService | undefined
  current(key: string): ConnectionState | undefined
  endpoint(conn: ConnectionState): LocalEndpoint | undefined
  owner(key: string): { principalId: string; active: boolean } | undefined
}) {
  const pending = new Map<string, AbortController>()
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
          ![
            'input',
            'turn',
            'sessionKey',
            'toolUseId',
            'leaseId',
            'packageId',
            'snapshotId',
            'rowId',
          ].includes(k),
      ) ||
      raw.sessionKey !== sessionKey ||
      !Number.isSafeInteger(raw.turn) ||
      Number(raw.turn) < 0 ||
      !['toolUseId', 'leaseId', 'packageId', 'snapshotId', 'rowId'].every(
        (k) =>
          typeof raw[k] === 'string' && (raw[k] as string).length > 0 && (raw[k] as string).length <= 512,
      ) ||
      !object(raw.input)
    )
      throw rpcError('INVALID_PARAMS')
    const input = raw.input,
      legacy =
        input.action === 'prepare' ||
        input.action === 'commit' ||
        input.action === 'status' ||
        input.action === 'cancel' ||
        input.action === 'test'
    const action = String(input.action).replace(/^candidate\./, '')
    if (
      !['create', 'write', 'test', 'submit', 'show', 'prepare', 'commit', 'status', 'cancel'].includes(
        action,
      ) ||
      Object.keys(input).some(
        (k) => !['action', 'files', 'proposalId', 'candidateId', 'expectedHash'].includes(k),
      )
    )
      throw rpcError('INVALID_PARAMS')
    if (pending.size >= 32 || pending.has(key))
      throw rpcError('SEMANTIC_REJECTED', { code: 'PLUGIN_REQUEST_LIMIT' })
    const controller = new AbortController()
    pending.set(key, controller)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    const call = (suffix: string, params: Record<string, unknown>) => {
      assertActive()
      signal.throwIfAborted()
      const auth = localPackageAdminAuthority(['packages.read', 'packages.install', 'extensions.execute'])({
        conn,
        clock: Date.now,
        signal,
      })
      if (!auth) throw rpcError('CAPABILITY_DENIED')
      const service = options.service()
      if (!service) throw rpcError('SEMANTIC_REJECTED', { code: 'PLUGIN_MANAGEMENT_UNAVAILABLE' })
      return service.call(
        `_agnes/v1/plugins.candidates.${suffix}` as PackageAdminMethodName,
        { profile: options.profile, ...params },
        {
          ...auth,
          installer: 'agent',
          authoringSignal: signal,
          authoringOrigin: {
            sessionKey,
            turn: raw.turn as number,
            toolUseId: raw.toolUseId as string,
            packageId: raw.packageId as string,
            snapshotId: raw.snapshotId as string,
            rowId: raw.rowId as string,
          },
        },
      )
    }
    try {
      const command = { clientId: conn.clientId, commandId: `author-${requestId}` }
      if (action === 'create' || action === 'prepare') {
        const files = legacy ? checkedPluginFiles(input.files) : input.files
        const value = (await call('create', { ...command, files })) as AuthoringCandidate
        return legacy ? { ...value, proposalId: value.candidateId } : value
      }
      const id = input.candidateId ?? input.proposalId
      if (typeof id !== 'string' || !/^candidate-[a-f0-9]{32}$/.test(id))
        throw rpcError('INVALID_PARAMS', { code: 'PLUGIN_LEGACY_PROPOSAL_REVIEW_REQUIRED' })
      const value = (await call('show', { candidateId: id })) as AuthoringCandidate
      if (action === 'show' || action === 'status') return legacy ? { ...value, proposalId: id } : value
      if (action === 'cancel') throw rpcError('SEMANTIC_REJECTED', { code: 'PLUGIN_REJECT_IN_REVIEW_UI' })
      const expectedHash = input.expectedHash ?? (legacy ? value.candidateHash : undefined)
      if (expectedHash !== value.candidateHash)
        throw rpcError('SEMANTIC_REJECTED', { code: 'PLUGIN_CANDIDATE_STALE' })
      if (action === 'test') {
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
        const verdict = await prompt.askVerdict(
          {
            requestId: `candidate-${randomUUID()}`,
            kind: 'tool',
            sessionKey,
            stepId: 'candidate-test',
            toolUseId: raw.toolUseId as string,
            summary: `Run Node author tests for ${value.packageId}\nCandidate SHA256: ${expectedHash}\nThis executes candidate JavaScript on this machine; it does not publish or trust the plugin. Review its source first in Settings → Plugins.`,
            risk: 'always',
            actor: connActor(conn),
            taint: false,
            bindingHash: value.candidateHash,
            deadline: new Date(Date.now() + 110_000).toISOString(),
            scope: 'plugin.test',
          },
          { signal },
        )
        assertActive()
        signal.throwIfAborted()
        if (!['allowed-once', 'allowed-session', 'allowed-permanent'].includes(verdict))
          throw rpcError('CAPABILITY_DENIED', { code: 'PLUGIN_TEST_REJECTED' })
      }
      const result = (await call(action === 'commit' ? 'submit' : action, {
        ...command,
        candidateId: id,
        expectedHash,
        ...(action === 'write' ? { files: input.files } : {}),
      })) as AuthoringCandidate
      return legacy ? { ...result, proposalId: id } : result
    } finally {
      pending.delete(key)
    }
  }
}
