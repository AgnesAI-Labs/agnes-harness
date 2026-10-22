import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { type ConnectionState, connActor, type LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import {
  type AskOutcome,
  acquirePermissionLease,
  assertCurrentPermission,
  PrompterRouter,
} from '@agnes/daemon-rpc/local/prompter'
import {
  agnesHome,
  createSkillInstaller,
  type SkillInstallInvocation,
  validInstallPathPolicy,
} from '@agnes/host'
import { permissionEffectAdmission, rpcError } from '@agnes/protocol'
import {
  localResourceAuthority,
  type ResourceAuthorityResolver,
  type ResourceControlService,
} from '@agnes/resource-control-store'
import { discoverSkillRoot, skillRoots } from '@agnes/resource-control-worker'
import { managementConnection } from './management-connection.js'

/** This receiver is only reached over the authenticated worker channel, never a public model RPC. */
export function createSkillInstallRequests(options: {
  directory: string
  profile: string
  service: ResourceControlService
  authority?: ResourceAuthorityResolver
  connections?(): ConnectionState[]
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
  return async (
    sessionKey: string,
    requestId: string,
    method: string,
    params: unknown,
    workerSignal?: AbortSignal,
  ): Promise<unknown> => {
    if (method === 'skill-install-abort') {
      const id = (params as { requestId?: unknown } | null)?.requestId
      if (typeof id === 'string') pending.get(key(sessionKey, id))?.abort()
      return undefined
    }
    const live = managementConnection(options, sessionKey, 'SKILL_INSTALL_LOCAL_OWNER_REQUIRED', {
      attachment: 'SKILL_INSTALL_SESSION_NOT_ATTACHED',
    })
    const conn = live.get()
    const workspace = options.workspace(sessionKey)
    if (!workspace) throw rpcError('CAPABILITY_DENIED')
    const authority = (options.authority ?? localResourceAuthority())({ conn: live.get() })
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
      live.get()
      if (options.workspace(sessionKey) !== workspace) throw new Error('SKILL_INSTALL_PERMISSION_CHANGED')
    }
    await assertCurrentPermission()
    assertActive()
    if (
      pending.size >= 32 ||
      [...pending.keys()].filter((id) => id.startsWith(`${sessionKey}\0`)).length >= 4
    )
      throw rpcError('CAPABILITY_DENIED', { code: 'SKILL_INSTALL_BUSY' })
    const controller = new AbortController()
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(120_000),
      ...(workerSignal ? [workerSignal] : []),
    ])
    pending.set(key(sessionKey, requestId), controller)
    let background = false
    let lease: Awaited<ReturnType<typeof acquirePermissionLease>>
    let approvalOutcome: AskOutcome | undefined
    const admission = permissionEffectAdmission({
      signals: [signal],
      unavailable: () =>
        signal.reason instanceof Error ? signal.reason : new Error('SKILL_INSTALL_CANCELLED'),
      verify: async () => {
        if (lease) await lease.verify()
        else await assertCurrentPermission()
      },
      assertBound: () => {
        assertActive()
        lease?.assertActive()
      },
    })
    const prompt = new PrompterRouter({
      record: (outcome) => {
        approvalOutcome = outcome
      },
      connections: live.candidates,
      originOf: () => live.candidates()[0],
      clock: Date.now,
      endpointFor: (target) => {
        const endpoint = options.endpoint(target)
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
          assertActive: admission.assertActive,
          verifyPermission: admission.verify,
          background: (task) => {
            background = true
            void task.finally(() => pending.delete(key(sessionKey, requestId)))
          },
          ask: async (summary, bindingHash, requestSignal) => {
            await assertCurrentPermission()
            assertActive()
            approvalOutcome = undefined
            const verdict = await prompt.askVerdict(
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
                options: ['allowed-once', 'rejected'],
              },
              { signal: requestSignal },
            )
            await assertCurrentPermission()
            assertActive()
            const via = (approvalOutcome as AskOutcome | undefined)?.via
            if (via === 'transport' || via === 'absent')
              throw new Error('SKILL_INSTALL_PERMISSION_UNAVAILABLE')
            if (via === 'timeout') throw new Error('SKILL_INSTALL_PERMISSION_TIMEOUT')
            if ((approvalOutcome as AskOutcome | undefined)?.reason === 'no-handler')
              throw new Error('SKILL_INSTALL_PERMISSION_NO_HANDLER')
            if (via === 'malformed') throw new Error('SKILL_INSTALL_PERMISSION_INVALID')
            if (via === 'aborted' || verdict === 'cancelled') throw new Error('SKILL_INSTALL_CANCELLED')
            if (verdict === 'allowed-once')
              lease = await acquirePermissionLease(
                { scope: 'skills.install', bindingHash, sessionKey },
                signal,
              )
            return (
              verdict === 'allowed-once' || verdict === 'allowed-session' || verdict === 'allowed-permanent'
            )
          },
          resources: async (method, resourceParams) => {
            await admission.verify()
            const currentAuthority = (options.authority ?? localResourceAuthority())({ conn: live.get() })
            if (!currentAuthority || currentAuthority.principalId !== authority.principalId)
              throw rpcError('CAPABILITY_DENIED')
            const permitted = new Set([
              '_agnes/v1/resources.list',
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
              {
                ...currentAuthority,
                ...(lease ? { admission } : {}),
              },
            )
          },
        },
        signal,
      )
    } finally {
      if (!background) pending.delete(key(sessionKey, requestId))
    }
  }
}
