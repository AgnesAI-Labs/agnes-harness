import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkillRoot, skillRoots } from '@agnes/base'
import type { SkillInstallBridge, SkillInstallInvocation } from '@agnes/host'
import {
  createResourceControlService,
  createSkillResourceStore,
  RESOURCE_ALL_PERMISSIONS,
} from '@agnes/resource-control-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readInstallBundle } from '../../host/src/resources/skill-install-files.js'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { createSkillInstallRequests } from '../src/supervisor/skill-install-requests.js'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-install-rpc-')))
  roots.push(root)
  const home = join(root, 'home')
  const source = join(root, 'source', 'demo')
  const workspace = join(root, 'workspace')
  mkdirSync(source, { recursive: true })
  mkdirSync(workspace)
  writeFileSync(join(source, 'SKILL.md'), '---\nname: demo\ndescription: fixture\n---\nTest only.\n')
  vi.stubEnv('AGH_HOME', home)
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
  Object.assign(ep.conn, { authKind: 'local', credentialKind: 'local', clientId: 'client' })
  ep.conn.capabilities.permission = true
  ep.conn.attached.set('session', {} as never)
  const ask = vi
    .spyOn(ep, 'request')
    .mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
  let store: ReturnType<typeof createSkillResourceStore>
  store = createSkillResourceStore({
    directory: join(root, 'resources'),
    scope: { allowedProfiles: ['local-dev'] },
    adapter: {
      validateRemove: async () => undefined,
      remove: async () => rmSync(join(home, 'skills', 'demo'), { recursive: true }),
      refresh: async () => {
        const target = skillRoots({ workspaceRoot: workspace, osHomeDir: home, agnesHomeDir: home })[1]
        if (!target) throw new Error('missing user skill root')
        const { candidate: c } = await readInstallBundle(join(target.path, 'demo'), target, [], {
          discover: discoverSkillRoot,
        })
        const removed = (await store.workerControl('local-dev')).removed.includes(c.resourceId)
        return [
          {
            capabilityHash: c.capabilityHash,
            descriptor: {
              kind: 'skill' as const,
              resourceId: c.resourceId,
              name: c.name,
              description: c.description,
              revision: c.revision,
              sourceIdentity: c.sourceIdentity,
              priority: c.priority,
              resolution: { winner: !removed, shadowed: [] },
              trust: 'untrusted' as const,
              desired: 'disabled' as const,
              actual: removed ? ('unavailable' as const) : ('disabled' as const),
              stale: false,
            },
          },
        ]
      },
      reconcile: async ({ resources }) => {
        const removed = new Set((await store.workerControl('local-dev')).removed)
        return resources.map((r) => ({
          resourceId: r.resourceId,
          actual: r.desired === 'enabled' ? ('ready' as const) : ('disabled' as const),
          resolution: { winner: !removed.has(r.resourceId), shadowed: [] },
        }))
      },
    },
  })
  const service = createResourceControlService(store)
  const call = vi.spyOn(service, 'call')
  const handler = createSkillInstallRequests({
    directory: join(root, 'receipts'),
    profile: 'local-dev',
    service,
    current: () => ep.conn,
    endpoint: () => ep,
    owner: () => ({ principalId: 'local', active: true }),
    workspace: () => workspace,
  })
  const invocation: SkillInstallInvocation = {
    sessionKey: 'session',
    packageId: '@fixture/install',
    snapshotId: 'snapshot',
    rowId: 'ext:fixture/install',
    leaseId: 'lease',
    toolUseId: 'tool',
    deniedPaths: [],
    input: { action: 'prepare', sourceDirectory: source, scope: 'user', enable: true },
  }
  let count = 0
  const request = (input = invocation.input, changes: Partial<SkillInstallInvocation> = {}) =>
    handler('session', `request-${++count}`, 'skill-install', {
      ...invocation,
      ...changes,
      input,
    }) as ReturnType<SkillInstallBridge>
  return { root, home, source, ep, ask, call, service, handler, invocation, request }
}

async function expectReady(request: ReturnType<typeof setup>['request'], proposalId: string) {
  const result = await vi.waitUntil(
    async () => {
      const status = await request({ action: 'status', proposalId })
      return status.state === 'prepared' || status.state === 'running' ? false : status
    },
    { timeout: 3_000 },
  )
  // Stop on terminal failure and report its phase/message instead of timing out waiting for ready.
  expect(result, `Skill install result: ${JSON.stringify(result)}`).toMatchObject({ state: 'ready' })
}

describe('daemon controlled Skill requests', () => {
  it('uses real resource validation and approval to refresh, trust, enable and verify', async () => {
    const s = setup()
    try {
      const proposal = await s.request()
      await s.request({ action: 'commit', proposalId: proposal.proposalId })
      await expectReady(s.request, proposal.proposalId)
      expect(s.ask).toHaveBeenCalledTimes(2)
      expect(s.ask.mock.calls.every(([method]) => method === 'session/request_permission')).toBe(true)
      expect(s.call.mock.calls.map(([method]) => method)).toContain('_agnes/v1/skills.trust.set')
      expect(readFileSync(join(s.home, 'skills', 'demo', 'SKILL.md'), 'utf8')).toContain('Test only.')
    } finally {
      await s.ep.close()
    }
  })

  it('reinstalls the same path after a completed deletion with a new approval', async () => {
    const s = setup()
    try {
      const first = await s.request()
      await s.request({ action: 'commit', proposalId: first.proposalId })
      await expectReady(s.request, first.proposalId)
      const installed = await s.request({ action: 'status', proposalId: first.proposalId })
      const authority = {
        audience: 'admin' as const,
        principalId: 'local',
        clientId: 'client',
        permissions: RESOURCE_ALL_PERMISSIONS,
      }
      const deleted = (await s.service.call(
        '_agnes/v1/skills.remove',
        {
          profile: 'local-dev',
          resourceId: installed.resourceId,
          expectedRevision: installed.revision,
          clientId: 'client',
          commandId: 'delete-before-reinstall',
        },
        authority,
      )) as { operationId: string }
      await vi.waitUntil(async () => {
        const result = (await s.service.call(
          '_agnes/v1/resources.operation.get',
          { profile: 'local-dev', operationId: deleted.operationId },
          authority,
        )) as { state: string }
        return result.state === 'succeeded'
      })
      const second = await s.request()
      await s.request({ action: 'commit', proposalId: second.proposalId })
      await expectReady(s.request, second.proposalId)
      expect(s.ask).toHaveBeenCalledTimes(4)
    } finally {
      await s.ep.close()
    }
  })

  it('validates real outbound approval frames and answers through the endpoint', async () => {
    const s = setup()
    s.ask.mockRestore()
    const pump = (async () => {
      for await (const message of s.ep.notifications) {
        if ('method' in message && message.method === 'session/request_permission' && 'id' in message) {
          await s.ep.handle({
            jsonrpc: '2.0',
            id: message.id,
            result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
          })
        }
      }
    })()
    try {
      const prepared = await s.request()
      expect(prepared.state).toBe('prepared')
      await s.request({ action: 'commit', proposalId: prepared.proposalId })
      await expectReady(s.request, prepared.proposalId)
    } finally {
      await s.ep.close()
      await pump
    }
  })

  it.each([
    ['transport', 'SKILL_INSTALL_PERMISSION_UNAVAILABLE'],
    ['malformed', 'SKILL_INSTALL_PERMISSION_INVALID'],
    ['rejected', 'SKILL_READ_REJECTED'],
  ])('distinguishes %s approval failure and never installs', async (kind, code) => {
    const s = setup()
    if (kind === 'transport') s.ask.mockRejectedValue(new Error('private connection detail'))
    else if (kind === 'malformed')
      s.ask.mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'invalid' } })
    else s.ask.mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'reject_once' } })
    try {
      await expect(s.request()).rejects.toThrow(code)
      expect(s.call).not.toHaveBeenCalled()
    } finally {
      await s.ep.close()
    }
  })

  it.each(['remote', 'no-permission', 'cross-session', 'forged-actor'])(
    'refuses %s before approval',
    async (kind) => {
      const s = setup()
      if (kind === 'remote') s.ep.conn.authKind = 'jwt'
      if (kind === 'no-permission') s.ep.conn.capabilities.permission = false
      const changes =
        kind === 'cross-session' ? { sessionKey: 'other' } : kind === 'forged-actor' ? { actor: 'admin' } : {}
      await expect(s.request(s.invocation.input, changes)).rejects.toBeDefined()
      expect(s.ask).not.toHaveBeenCalled()
      expect(s.call).not.toHaveBeenCalled()
      await s.ep.close()
    },
  )

  it('accepts trusted complete policy and refuses malformed policy before approval', async () => {
    const s = setup()
    const pathPolicy = {
      caseSensitive: false,
      policy: {
        workspaceRoot: s.source,
        networkAllow: [],
        digest: '0'.repeat(64),
        rules: [
          { effect: 'deny' as const, path: s.root, hard: false, source: 'data' as const },
          { effect: 'allow' as const, path: s.source, hard: false, source: 'workspace' as const },
        ],
      },
    }
    try {
      expect((await s.request(s.invocation.input, { deniedPaths: [s.root], pathPolicy })).state).toBe(
        'prepared',
      )
      s.ask.mockClear()
      await expect(
        s.handler('session', 'invalid-policy', 'skill-install', {
          ...s.invocation,
          pathPolicy: { ...pathPolicy, caseSensitive: 'false' },
        }),
      ).rejects.toBeDefined()
      expect(s.ask).not.toHaveBeenCalled()
      expect(s.call).not.toHaveBeenCalled()
    } finally {
      await s.ep.close()
    }
  })

  it('cancels the pending commit prompt through the proposal API', async () => {
    const s = setup()
    const proposal = await s.request()
    let promptSignal: AbortSignal | undefined
    s.ask.mockImplementation(async (_method, _params, options) => {
      promptSignal = options?.signal
      return new Promise((_resolve, reject) => {
        promptSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    const commit = s.request({ action: 'commit', proposalId: proposal.proposalId }).catch((error) => error)
    try {
      await expect.poll(() => promptSignal !== undefined).toBe(true)
      expect((await s.request({ action: 'cancel', proposalId: proposal.proposalId })).state).toBe('cancelled')
      expect(promptSignal?.aborted).toBe(true)
      await commit
      expect(s.call).not.toHaveBeenCalled()
      expect((await s.request({ action: 'status', proposalId: proposal.proposalId })).state).toBe('cancelled')
    } finally {
      await s.ep.close()
    }
  })

  it('cancels the actual pending approval when the worker aborts', async () => {
    const s = setup()
    s.ask.mockImplementation(
      async (_method, _params, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    )
    const pending = s.handler('session', 'pending', 'skill-install', s.invocation)
    const rejected = expect(pending).rejects.toBeDefined()
    await expect.poll(() => s.ask.mock.calls.length).toBe(1)
    await s.handler('session', 'cancel', 'skill-install-abort', { requestId: 'pending' })
    await rejected
    expect(s.call).not.toHaveBeenCalled()
    await s.ep.close()
  })
})

it('reports missing attachment precisely and preserves the installation guard', async () => {
  const s = setup()
  s.ep.conn.attached.delete('session')
  await expect(s.request()).rejects.toThrow('SKILL_INSTALL_SESSION_NOT_ATTACHED')
  expect(s.ask).not.toHaveBeenCalled()
  expect(s.call).not.toHaveBeenCalled()
  await s.ep.close()
})
