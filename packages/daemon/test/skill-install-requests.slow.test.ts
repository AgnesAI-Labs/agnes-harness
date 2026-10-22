import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkillRoot, skillRoots } from '@agnes/base'
import { type AutomaticPermissionEvidence, withPermissionContext } from '@agnes/daemon-rpc/local/prompter'
import type { SkillInstallBridge, SkillInstallInvocation } from '@agnes/host'
import {
  createResourceControlService,
  createSkillResourceStore,
  RESOURCE_ALL_PERMISSIONS,
  type SkillJournal,
  SkillJournalStore,
} from '@agnes/resource-control-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readInstallBundle } from '../../host/src/resources/skill-install-files.js'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { createSkillInstallRequests } from '../src/supervisor/skill-install-requests.js'

const journalBoundary = vi.hoisted(() => ({ afterFlush: undefined as ((path: string) => void) | undefined }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'sync')
            return async () => {
              await target.sync()
              if (typeof args[0] === 'string') journalBoundary.afterFlush?.(args[0])
            }
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
})

const roots: string[] = []
it.each(['revoked', 'narrowed', 'closed', 'cancelled', 'expired', 'actor-changed'])(
  'round2: a %s background Skill installation cannot publish files',
  async (reason) => {
    const s = setup()
    const controller = new AbortController()
    const context = {
      sessionKey: 'session',
      sessionId: 'round2-skill',
      epoch: 0,
      policy: 'full-access',
      actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    }
    let current: typeof context | undefined = context
    const clock = vi.spyOn(Date, 'now')
    try {
      const prepared = await withPermissionContext(
        context,
        () => undefined,
        () => s.request(),
        async () => current,
        () => current,
      )
      await withPermissionContext(
        context,
        () => undefined,
        () =>
          s.handler(
            'session',
            'round2-skill-commit',
            'skill-install',
            {
              ...s.invocation,
              input: { action: 'commit', proposalId: prepared.proposalId },
            },
            controller.signal,
          ),
        async () => current,
        () => current,
      )
      if (reason === 'revoked' || reason === 'narrowed')
        current = { ...context, epoch: 1, policy: 'workspace-write' }
      if (reason === 'closed') current = undefined
      if (reason === 'actor-changed') current = { ...context, actor: { ...context.actor, id: 'other' } }
      if (reason === 'revoked' || reason === 'cancelled') controller.abort()
      if (reason === 'expired') clock.mockReturnValue(Date.now() + 110_001)
      const terminal = await vi.waitUntil(
        async () => {
          const status = await s.request({ action: 'status', proposalId: prepared.proposalId })
          return ['prepared', 'running'].includes(status.state) ? false : status
        },
        { timeout: 3_000 },
      )
      expect(terminal.state).toBe('failed')
      expect(existsSync(join(s.home, 'skills', 'demo', 'SKILL.md'))).toBe(false)
    } finally {
      clock?.mockRestore()
      await s.ep.close()
    }
  },
)
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
  let currentEp = ep
  const liveEndpoints = [ep]
  const refresh = async () => {
    const next = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
    Object.assign(next.conn, { authKind: 'local', credentialKind: 'local', clientId: 'refreshed' })
    next.conn.capabilities.permission = true
    next.conn.attached.set('session', {} as never)
    vi.spyOn(next, 'request').mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
    liveEndpoints.push(next)
    currentEp = next
    await ep.close()
    return next
  }
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
    current: () => currentEp.conn,
    connections: () => liveEndpoints.map((e) => e.conn),
    endpoint: (conn: typeof ep.conn) => liveEndpoints.find((e) => e.conn === conn),
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
  return { root, home, source, ep, refresh, ask, call, service, handler, invocation, request }
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
      s.ask.mockRestore()
      const pending = s.request()
      expect((await s.ep.notifications[Symbol.asyncIterator]().next()).value).toMatchObject({
        method: 'session/request_permission',
      })
      const refreshed = await s.refresh()
      const proposal = await pending
      await s.request({ action: 'commit', proposalId: proposal.proposalId })
      await expectReady(s.request, proposal.proposalId)
      expect(refreshed.request).toHaveBeenCalledTimes(2)
      expect(
        vi.mocked(refreshed.request).mock.calls.every(([method]) => method === 'session/request_permission'),
      ).toBe(true)
      await refreshed.close()
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

it.each(['full-access', 'workspace-write'])(
  'imports and enables a Skill under %s without losing source or install decision evidence',
  async (policy) => {
    const s = setup()
    const evidence: AutomaticPermissionEvidence[] = []
    await withPermissionContext(
      {
        sessionKey: 'session',
        sessionId: 'fixture-backend',
        epoch: 0,
        policy,
        actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      },
      (value) => evidence.push(value),
      async () => {
        const prepared = await s.request()
        if (!prepared.proposalId) throw new Error('Missing Skill proposal')
        await s.request({ action: 'commit', proposalId: prepared.proposalId })
        await expectReady(s.request, prepared.proposalId)
      },

      async () => ({
        sessionKey: 'session',
        sessionId: 'fixture-backend',
        epoch: 0,
        policy,
        actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      }),
      () => ({
        sessionKey: 'session',
        sessionId: 'fixture-backend',
        epoch: 0,
        policy,
        actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      }),
    )
    expect(s.ask).toHaveBeenCalledTimes(policy === 'full-access' ? 0 : 2)
    if (policy === 'full-access') {
      expect(evidence).toHaveLength(4)
      for (const decision of evidence)
        expect(decision).toMatchObject({
          reason: 'full-access',
          verdict: 'allowed-once',
          answeredBy: { role: 'system' },
        })
    } else expect(evidence).toEqual([])
    await s.ep.close()
  },
)

it.each(['epoch', 'deadline'])(
  'round3: Skill trust cannot commit when its lease loses %s inside the journal transaction',
  async (boundary) => skillLeaseBoundary(boundary, 'callback'),
)

it.each([
  ['epoch', 'queued'],
  ['deadline', 'queued'],
  ['epoch', 'temp-written'],
  ['deadline', 'temp-written'],
])('round3: Skill trust cannot commit after losing %s at the %s boundary', async (boundary, stage) =>
  skillLeaseBoundary(boundary, stage),
)

async function skillLeaseBoundary(boundary: string, stage: string) {
  const s = setup()
  const context = {
    sessionKey: 'session',
    sessionId: 'round3-skill',
    epoch: 0,
    policy: 'full-access',
    actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
  }
  let current = context
  let intercepted = false
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const revoke = () => {
    intercepted = true
    if (boundary === 'epoch') current = { ...context, epoch: 1, policy: 'workspace-write' }
    else clock.mockReturnValue(now + 110_001)
  }
  if (stage === 'temp-written')
    journalBoundary.afterFlush = (path) => {
      if (intercepted || !path.includes('.skills.json.')) return
      const next: SkillJournal = JSON.parse(readFileSync(path, 'utf8'))
      if (Object.values(next.trust).some((decision) => decision.state === 'trusted')) revoke()
    }
  const transact = SkillJournalStore.prototype.transact
  const spy = vi.spyOn(SkillJournalStore.prototype, 'transact').mockImplementation(function <T>(
    this: SkillJournalStore,
    profile: string,
    fn: (
      journal: SkillJournal,
    ) => { next: SkillJournal; result: T } | Promise<{ next: SkillJournal; result: T }>,
    ...extra: unknown[]
  ): Promise<T> {
    if (stage === 'queued' && !intercepted && extra[0]) {
      intercepted = true
      let enter!: () => void
      let release!: () => void
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const first = Reflect.apply(transact, this, [
        profile,
        async (journal: SkillJournal) => {
          enter()
          await held
          return { next: journal, result: undefined }
        },
      ]) as Promise<void>
      const pending = Reflect.apply(transact, this, [profile, fn, ...extra]) as Promise<T>
      void entered.then(() => {
        revoke()
        release()
      })
      return Promise.all([first, pending]).then(([, result]) => result)
    }
    return Reflect.apply(transact, this, [
      profile,
      async (journal: SkillJournal) => {
        const out = await fn(journal)
        if (
          stage === 'callback' &&
          !intercepted &&
          Object.entries(out.next.trust).some(
            ([id, decision]) => decision.state === 'trusted' && journal.trust[id]?.state !== 'trusted',
          )
        ) {
          revoke()
        }
        return out
      },
      ...extra,
    ]) as Promise<T>
  })
  try {
    const prepared = await withPermissionContext(
      context,
      () => undefined,
      () => s.request(),
      async () => current,
      () => current,
    )
    await withPermissionContext(
      context,
      () => undefined,
      () => s.request({ action: 'commit', proposalId: prepared.proposalId }),
      async () => current,
      () => current,
    )
    const terminal = await vi.waitUntil(
      async () => {
        const status = await s.request({ action: 'status', proposalId: prepared.proposalId })
        return ['prepared', 'running'].includes(status.state) ? false : status
      },
      { timeout: 3_000 },
    )
    expect(intercepted).toBe(true)
    expect(['failed', 'interrupted']).toContain(terminal.state)
    const persisted = JSON.parse(readFileSync(join(s.root, 'resources', 'local-dev.skills.json'), 'utf8'))
    expect(Object.values(persisted.trust)).not.toContainEqual(expect.objectContaining({ state: 'trusted' }))
    expect(readdirSync(join(s.root, 'resources'))).toEqual(['local-dev.skills.json'])
  } finally {
    journalBoundary.afterFlush = undefined
    spy.mockRestore()
    clock.mockRestore()
    await s.ep.close()
  }
}

it.each([
  [{ code: -32006, data: { code: 'CAPABILITY_DENIED' } }, 'SKILL_INSTALL_CAPABILITY_DENIED'],
  [{ code: -32602, data: { code: 'INVALID_PARAMS' } }, 'SKILL_INSTALL_INVALID'],
  [{ code: 'SKILL_INSTALL_REJECTED', message: 'private log' }, 'SKILL_INSTALL_REJECTED'],
  [{ code: 'UNKNOWN_DENIED', message: 'private log' }, 'SKILL_INSTALL_FAILED'],
])('keeps installation error categories scoped to the generated contract', async (error, code) => {
  const { skillInstallReplyError } = await import('../src/supervisor/skill-install-error.js')
  expect(skillInstallReplyError(error)).toEqual({ code, message: code })
})
