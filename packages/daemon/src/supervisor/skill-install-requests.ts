import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  agnesHome,
  createSkillInstaller,
  type SkillInstallInvocation,
  validInstallPathPolicy,
} from '@agnes/host'
import { rpcError } from '@agnes/protocol'
import {
  localResourceAuthority,
  type ResourceAuthorityResolver,
  type ResourceControlService,
} from '@agnes/resource-control-store'
import { discoverSkillRoot, skillRoots } from '@agnes/resource-control-worker'
import { type ConnectionState, connActor, type LocalEndpoint } from '../local/endpoint.js'
import { type AskOutcome, PrompterRouter } from '../local/prompter.js'

/** This receiver is only reached over the authenticated worker channel, never a public model RPC. */
export function createSkillInstallRequests(options: {
  directory: string
  profile: string
  service: ResourceControlService
  authority?: ResourceAuthorityResolver
  current(sessionKey: string): ConnectionState | undefined
  endpoint(connection: ConnectionState): LocalEndpoint | undefined
  owner(sessionKey: string): { principalId: string; active: boolean } | undefined
  workspace(sessionKey: string): string | undefined
}) {
  const installer = createSkillInstaller(join(options.directory, 'skill-installs'), {
    roots: skillRoots,
    discover: discoverSkillRoot,
  })
  const pending = new Map<string, AbortController>()
  const key = (session: string, request: string) => `${session}\0${request}`
  return async (sessionKey: string, requestId: string, method: string, params: unknown): Promise<unknown> => {
    if (method === 'skill-install-abort') {
      const id = (params as { requestId?: unknown } | null)?.requestId
      if (typeof id === 'string') pending.get(key(sessionKey, id))?.abort()
      return undefined
    }
    const conn = options.current(sessionKey)
    const owner = options.owner(sessionKey)
    const workspace = options.workspace(sessionKey)
    // Remote/JWT/channel sessions cannot turn an installation request into local admin authority.
    if (
      conn?.authKind !== 'local' ||
      conn.credentialKind !== 'local' ||
      !conn.capabilities.permission ||
      !owner?.active ||
      owner.principalId !== conn.principalId ||
      !workspace
    )
      throw rpcError('CAPABILITY_DENIED', { code: 'SKILL_INSTALL_LOCAL_OWNER_REQUIRED' })
    const authority = (options.authority ?? localResourceAuthority())({ conn })
    if (!authority) throw rpcError('CAPABILITY_DENIED')
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw rpcError('INVALID_PARAMS')
    const input = params as Record<string, unknown>
    const fields = [
      'packageId',
      'snapshotId',
      'rowId',
      'leaseId',
      'toolUseId',
      'sessionKey',
      'deniedPaths',
      'pathPolicy',
      'input',
    ]
    if (
      Object.keys(input).some((k) => !fields.includes(k)) ||
      input.sessionKey !== sessionKey ||
      !['packageId', 'snapshotId', 'rowId', 'leaseId', 'toolUseId'].every(
        (k) =>
          typeof input[k] === 'string' &&
          (input[k] as string).length > 0 &&
          (input[k] as string).length <= 512,
      ) ||
      (input.pathPolicy !== undefined && !validInstallPathPolicy(input.pathPolicy)) ||
      !Array.isArray(input.deniedPaths) ||
      input.deniedPaths.length > 256 ||
      !input.deniedPaths.every((v) => typeof v === 'string' && v.length <= 4096)
    )
      throw rpcError('INVALID_PARAMS')
    const assertActive = () => {
      const activeOwner = options.owner(sessionKey)
      if (!options.endpoint(conn)) throw new Error('SKILL_INSTALL_CONNECTION_CLOSED')
      if (!conn.attached.has(sessionKey)) throw new Error('SKILL_INSTALL_SESSION_NOT_ATTACHED')
      if (
        conn.authKind !== 'local' ||
        conn.credentialKind !== 'local' ||
        !conn.capabilities.permission ||
        !activeOwner?.active ||
        activeOwner.principalId !== owner.principalId ||
        options.workspace(sessionKey) !== workspace
      )
        throw new Error('SKILL_INSTALL_PERMISSION_CHANGED')
    }
    assertActive()
    if (
      pending.size >= 32 ||
      [...pending.keys()].filter((id) => id.startsWith(`${sessionKey}\0`)).length >= 4
    )
      throw rpcError('CAPABILITY_DENIED', { code: 'SKILL_INSTALL_BUSY' })
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    pending.set(key(sessionKey, requestId), controller)
    let approvalOutcome: AskOutcome | undefined
    const prompt = new PrompterRouter({
      record: (outcome) => {
        approvalOutcome = outcome
      },
      connections: () => [conn],
      originOf: () => conn,
      clock: Date.now,
      endpointFor: () => {
        const endpoint = options.endpoint(conn)
        if (!endpoint) throw new Error('closed')
        return endpoint
      },
    })
    try {
      return await installer.request(
        input as unknown as SkillInstallInvocation,
        {
          principalId: authority.principalId,
          profile: options.profile,
          workspaceRoot: workspace,
          agnesHome: agnesHome(process.env),
          assertActive,
          ask: async (summary, bindingHash, requestSignal) => {
            assertActive()
            approvalOutcome = undefined
            const verdict = await prompt.ask(
              {
                requestId: `skill-install-${randomUUID()}`,
                kind: 'tool',
                sessionKey,
                stepId: 'skill-install',
                toolUseId: input.toolUseId as string,
                summary,
                risk: 'always',
                actor: connActor(conn),
                taint: false,
                bindingHash,
                deadline: new Date(Date.now() + 110_000).toISOString(),
                scope: 'skills.install',
              },
              { signal: requestSignal },
            )
            assertActive()
            const via = (approvalOutcome as AskOutcome | undefined)?.via
            if (via === 'transport' || via === 'absent')
              throw new Error('SKILL_INSTALL_PERMISSION_UNAVAILABLE')
            if (via === 'timeout') throw new Error('SKILL_INSTALL_PERMISSION_TIMEOUT')
            if (via === 'malformed') throw new Error('SKILL_INSTALL_PERMISSION_INVALID')
            if (via === 'aborted' || verdict === 'cancelled') throw new Error('SKILL_INSTALL_CANCELLED')
            return (
              verdict === 'allowed-once' || verdict === 'allowed-session' || verdict === 'allowed-permanent'
            )
          },
          resources: (method, resourceParams) => {
            assertActive()
            const currentAuthority = (options.authority ?? localResourceAuthority())({ conn })
            if (!currentAuthority || currentAuthority.principalId !== authority.principalId)
              throw rpcError('CAPABILITY_DENIED')
            const permitted = new Set([
              '_agnes/v1/resources.get',
              '_agnes/v1/resources.operation.get',
              '_agnes/v1/skills.refresh',
              '_agnes/v1/skills.trust.set',
              '_agnes/v1/resources.desired.set',
            ])
            if (!permitted.has(method)) throw rpcError('CAPABILITY_DENIED')
            return options.service.call(
              method,
              {
                ...resourceParams,
                ...('commandId' in resourceParams ? { clientId: currentAuthority.clientId } : {}),
              },
              currentAuthority,
            )
          },
        },
        signal,
      )
    } finally {
      pending.delete(key(sessionKey, requestId))
    }
  }
}
