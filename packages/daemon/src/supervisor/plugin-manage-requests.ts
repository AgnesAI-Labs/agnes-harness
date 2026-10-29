import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AuthoringSandboxContext,
  authoringSandbox,
  createAuthoringTestRunner,
  localPackageAdminAuthority,
  type PackageAdminService,
} from '@agnes/daemon-admin/packages/index'
import { type ConnectionState, connActor, type LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import {
  acquirePermissionLease,
  assertCurrentPermission,
  assertPermissionBinding,
  currentPermissionContext,
  PrompterRouter,
} from '@agnes/daemon-rpc/local/prompter'
import { createFileAudit } from '@agnes/host'
import {
  type AuthoringCandidate,
  automaticPermissionDecision,
  type PackageAdminMethodName,
  rpcError,
} from '@agnes/protocol'
import { managementConnection } from './management-connection.js'
import { checkedPluginFiles } from './plugin-files.js'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** Agent authoring uses the effective session permission decision for tests and publication. */
export function createPluginManageRequests(options: {
  directory: string
  home?: string
  profile: string
  service(): PackageAdminService | undefined
  connections?(): ConnectionState[]
  current(key: string): ConnectionState | undefined
  endpoint(conn: ConnectionState): LocalEndpoint | undefined
  owner(key: string): { principalId: string; active: boolean } | undefined
}) {
  const pending = new Map<string, AbortController>()
  return async (
    sessionKey: string,
    requestId: string,
    method: string,
    raw: unknown,
    workerSignal?: AbortSignal,
  ): Promise<unknown> => {
    const key = `${sessionKey}\0${requestId}`
    if (method === 'plugin-manage-abort') {
      if (object(raw) && typeof raw.requestId === 'string')
        pending.get(`${sessionKey}\0${raw.requestId}`)?.abort()
      return undefined
    }
    const live = managementConnection(options, sessionKey, 'PLUGIN_LOCAL_OWNER_REQUIRED', {
      permission: 'PLUGIN_PERMISSION_REQUIRED',
    })
    const conn = live.get()
    const assertActive = () => {
      live.get()
    }
    assertActive()
    if (
      !conn ||
      !object(raw) ||
      Object.keys(raw).some(
        (k) =>
          ![
            'input',
            'candidateTestSandbox',
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
    const candidateTestSandbox = raw.candidateTestSandbox as AuthoringSandboxContext['session']
    if (
      candidateTestSandbox !== undefined &&
      (!object(candidateTestSandbox) ||
        !object(candidateTestSandbox.policy) ||
        !Array.isArray(candidateTestSandbox.policy.rules) ||
        !['allow', 'deny'].includes(candidateTestSandbox.network) ||
        typeof candidateTestSandbox.local !== 'boolean')
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
        (k) =>
          !['action', 'files', 'proposalId', 'candidateId', 'expectedHash', 'mode', 'remove'].includes(k),
      )
    )
      throw rpcError('INVALID_PARAMS')
    if (pending.size >= 32 || pending.has(key))
      throw rpcError('SEMANTIC_REJECTED', { code: 'PLUGIN_REQUEST_LIMIT' })
    const controller = new AbortController()
    pending.set(key, controller)
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(120_000),
      ...(workerSignal ? [workerSignal] : []),
    ])
    let testContext: AuthoringSandboxContext | undefined
    const call = async (suffix: string, params: Record<string, unknown>) => {
      await assertCurrentPermission()
      assertActive()
      signal.throwIfAborted()
      const auth = localPackageAdminAuthority([
        'packages.read',
        'packages.install',
        'packages.trust',
        'packages.activate',
        'extensions.execute',
      ])({
        conn: live.get(),
        clock: Date.now,
        signal,
      })
      if (!auth) throw rpcError('CAPABILITY_DENIED')
      const service = options.service()
      if (!service) throw rpcError('SEMANTIC_REJECTED', { code: 'PLUGIN_MANAGEMENT_UNAVAILABLE' })
      const automaticPublication =
        suffix === 'submit' && automaticPermissionDecision(currentPermissionContext())
      const authoringAdmission = automaticPublication
        ? await acquirePermissionLease(
            { sessionKey, scope: 'plugin.publish', bindingHash: String(params.expectedHash) },
            signal,
          )
        : undefined
      return service.call(
        `_agnes/v1/plugins.candidates.${suffix}` as PackageAdminMethodName,
        { profile: options.profile, ...params },
        {
          ...auth,
          installer: 'agent',
          permissionContext: currentPermissionContext(),
          ...(automaticPublication
            ? {
                ...(authoringAdmission ? { authoringAdmission } : {}),
                authoringPermission: async (binding: { sessionKey: string; bindingHash: string }) => {
                  signal.throwIfAborted()
                  await assertPermissionBinding({ ...binding, scope: 'plugin.publish' })
                  signal.throwIfAborted()
                },
              }
            : {}),
          authoringSignal: signal,
          ...(testContext ? { authoringTestRunner: createAuthoringTestRunner(testContext) } : {}),
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
      const command = () => ({ clientId: live.get().clientId, commandId: `author-${requestId}` })
      if (action === 'create' || action === 'prepare') {
        const files = legacy ? checkedPluginFiles(input.files) : input.files
        const value = (await call('create', { ...command(), files })) as AuthoringCandidate
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
        if (!candidateTestSandbox)
          throw rpcError('CAPABILITY_DENIED', { code: 'PLUGIN_TEST_SANDBOX_REQUIRED' })
        testContext = {
          home: options.home ?? options.directory,
          ...(candidateTestSandbox ? { session: candidateTestSandbox } : {}),
        }
        const probe = mkdtempSync(join(tmpdir(), 'agh-candidate-probe-'))
        let isolated: boolean
        try {
          isolated = (await authoringSandbox(testContext, probe, signal)).isolated
        } finally {
          rmSync(probe, { recursive: true, force: true })
        }
        {
          const prompt = new PrompterRouter({
            record: (outcome) =>
              createFileAudit(join(options.directory, 'candidate-test-audit.jsonl')).write({
                kind: 'extension.service-call',
                detail: {
                  action: 'candidate.test',
                  session: sessionKey,
                  candidateId: id,
                  packageId: value.packageId,
                  bindingHash: value.candidateHash,
                  isolation: isolated ? 'sandbox' : 'unisolated',
                  ...outcome,
                },
              }),
            connections: live.candidates,
            originOf: () => live.candidates()[0],
            clock: Date.now,
            endpointFor: (target) => {
              const ep = options.endpoint(target)
              if (!ep) throw new Error('closed')
              return ep
            },
          })
          const answer = await prompt.ask(
            {
              requestId: `candidate-${randomUUID()}`,
              kind: 'tool',
              sessionKey,
              stepId: 'candidate-test',
              toolUseId: raw.toolUseId as string,
              summary: `${value.packageId} (${value.candidateHash.slice(7, 19)}) — ${isolated ? '在沙箱中运行作者测试 / Run author tests in sandbox' : '此平台未隔离，将在本机直接运行候选代码 / This platform is unisolated; candidate code runs directly on this machine'}. ${isolated ? '风险：候选代码可修改副本；保护路径和 AGH 私有目录拒绝访问 / Risk: candidate code can modify its copy; protected paths and AGH private directories are denied' : '风险：代码可按本机用户权限访问文件和网络 / Risk: code can access files and network with local user privileges'}. 仅此哈希一次 / This hash, once.`,
              tool: {
                name: 'plugin_candidate_test',
                args: {
                  packageId: value.packageId,
                  candidateHash: value.candidateHash,
                  execution: isolated ? 'sandbox' : 'unisolated',
                  runs: 'Node author tests',
                  scope: isolated ? 'candidate-directory' : 'local-user',
                  network: isolated ? candidateTestSandbox.network : 'unrestricted',
                },
                meta: {
                  isReadOnly: false,
                  isDestructive: false,
                  isConcurrencySafe: false,
                  isOpenWorld: true,
                  replay: 'never',
                  costHint: {},
                  deferLoading: false,
                  requiresApproval: 'always',
                },
              },
              risk: 'always',
              actor: connActor(conn),
              taint: false,
              bindingHash: value.candidateHash,
              deadline: new Date(Date.now() + 110_000).toISOString(),
              scope: 'plugin.test',
              options: ['allowed-once', 'rejected'],
            },
            { signal },
          )
          assertActive()
          signal.throwIfAborted()
          const verdict = typeof answer === 'string' ? answer : answer.verdict
          if (verdict !== 'allowed-once')
            throw rpcError('CAPABILITY_DENIED', {
              code: verdict === 'rejected' ? 'PLUGIN_TEST_REJECTED' : 'PLUGIN_TEST_UNANSWERED',
              reason: typeof answer === 'string' ? 'invalid-answer' : (answer.reason ?? 'invalid-answer'),
            })
          const admission = await acquirePermissionLease(
            { sessionKey, scope: 'plugin.test', bindingHash: value.candidateHash },
            signal,
          )
          if (admission) testContext = { ...testContext!, admission }
        }
      }
      if (
        (action === 'submit' || action === 'commit') &&
        automaticPermissionDecision(currentPermissionContext())
      ) {
        const prompt = new PrompterRouter({
          connections: live.candidates,
          originOf: () => live.candidates()[0],
          clock: Date.now,
          endpointFor: (target) => {
            const endpoint = options.endpoint(target)
            if (!endpoint) throw new Error('closed')
            return endpoint
          },
        })
        const answer = await prompt.ask(
          {
            requestId: `publish-${randomUUID()}`,
            kind: 'tool',
            sessionKey,
            stepId: 'candidate-publish',
            toolUseId: raw.toolUseId as string,
            summary: `Install, trust and enable ${value.packageId}`,
            risk: 'always',
            actor: connActor(conn),
            taint: false,
            bindingHash: value.candidateHash,
            deadline: new Date(Date.now() + 110_000).toISOString(),
            scope: 'plugin.publish',
            options: ['allowed-once', 'rejected'],
          },
          { signal },
        )
        if (
          typeof answer === 'string' ||
          !('verdict' in answer) ||
          answer.verdict !== 'allowed-once' ||
          answer.reason !== 'full-access'
        )
          throw rpcError('CAPABILITY_DENIED', { code: 'PLUGIN_PUBLICATION_UNANSWERED' })
        await assertPermissionBinding({
          scope: 'plugin.publish',
          bindingHash: value.candidateHash,
          sessionKey,
        })
        signal.throwIfAborted()
      }
      const result = (await call(action === 'commit' ? 'submit' : action, {
        ...command(),
        candidateId: id,
        expectedHash,
        ...(action === 'write'
          ? {
              files: input.files,
              ...(input.mode !== undefined ? { mode: input.mode } : {}),
              ...(input.remove !== undefined ? { remove: input.remove } : {}),
            }
          : {}),
      })) as AuthoringCandidate
      return legacy ? { ...result, proposalId: id } : result
    } finally {
      pending.delete(key)
    }
  }
}
