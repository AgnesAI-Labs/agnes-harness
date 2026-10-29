import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { type AutomaticPermissionEvidence, withPermissionContext } from '@agnes/daemon-rpc/local/prompter'
import { createTestHost } from '@agnes/host/testkit'
import { jcs } from '@agnes/protocol'
import {
  createResourceControlService,
  createResourceControlStore,
  localResourceAuthority,
} from '@agnes/resource-control-store'
import * as systemNode from '@agnes/system-node'
import { afterEach, expect, it, vi } from 'vitest'
import { SharedSessionChannel, sessionPermissions } from '../../worker-runtime/src/shared-session-channel.js'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { encodeFrame } from '../src/supervisor/framing.js'
import { createMcpManageRequests } from '../src/supervisor/mcp-manage-requests.js'
import { permissionRequest } from '../src/supervisor/permission-requests.js'
import { WorkerLink } from '../src/supervisor/worker-link.js'

const roots: string[] = []
const endpoints: LocalEndpoint[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const ep of endpoints.splice(0)) await ep.close()
  // Accepted MCP effects keep driving in the background and may still be writing a worker
  // snapshot while the directory is removed; retry the removal instead of failing on ENOTEMPTY.
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
const definition = {
  serverId: 'fixture',
  displayName: 'Fixture',
  transport: { kind: 'stdio' as const, executable: process.execPath, args: [] },
  secretBinding: { kind: 'none' as const },
}
const revision = createHash('sha256').update(jcs(definition)).digest('hex')

it.each(['immediate-notification', 'queued-notification'] as const)(
  'security2: narrowing after the final MCP permission snapshot cannot publish enabled state with %s',
  async (notification) => {
    const s = await setup()
    const prepared = await s.request({ action: 'prepare', definition })
    let current = {
      sessionKey: 'session',
      sessionId: 'security2-mcp',
      epoch: 0,
      policy: 'full-access',
      actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    }
    const expected = structuredClone(current)
    let revoked = false
    let notified: Promise<unknown> | undefined
    const commits: { policy: string; epoch: number }[] = []
    const rename = systemNode.renameWriteThroughSync
    const spy = vi.spyOn(systemNode, 'renameWriteThroughSync').mockImplementation((source, target) => {
      if (target.endsWith('.mcp.json')) {
        const pending = JSON.parse(readFileSync(source, 'utf8')) as {
          servers?: Record<string, { desired?: string }>
        }
        if (pending.servers?.fixture?.desired === 'enabled')
          commits.push({ policy: current.policy, epoch: current.epoch })
      }
      return rename(source, target)
    })
    try {
      await withPermissionContext(
        expected,
        () => undefined,
        async () => {
          await s.request({ action: 'commit', proposalId: prepared.proposalId }).catch(() => undefined)
        },
        async () => {
          const snapshot = structuredClone(current)
          for (const relative of await readdir(s.root, { recursive: true })) {
            if (!String(relative).includes('.mcp.json.') || !String(relative).endsWith('.tmp')) continue
            let pending: { servers?: Record<string, { desired?: string }> }
            try {
              pending = JSON.parse(await readFile(join(s.root, String(relative)), 'utf8'))
            } catch {
              continue
            }
            if (!revoked && pending.servers?.fixture?.desired === 'enabled') {
              revoked = true
              queueMicrotask(() => {
                current = { ...current, epoch: 1, policy: 'workspace-write' }
                notified =
                  notification === 'immediate-notification'
                    ? s.abortLatest()
                    : new Promise((resolve) => {
                        setImmediate(() => {
                          void s.abortLatest().then(resolve)
                        })
                      })
              })
            }
          }
          return snapshot
        },
        () => current,
      )
      await notified
      expect(revoked).toBe(true)
      expect(current.policy).toBe('workspace-write')
      expect(s.ask).not.toHaveBeenCalled()
      expect(commits).not.toContainEqual({ policy: 'workspace-write', epoch: 1 })
      const rows = await s.store.mcp.workerManaged('local-dev')
      expect(rows[0]?.desired, JSON.stringify({ commits })).not.toBe('enabled')
    } finally {
      spy.mockRestore()
    }
  },
)

it('round2: an automatic MCP decision that expires after the prompt cannot register, trust or enable', async () => {
  const s = await setup()
  const prepared = await s.request({ action: 'prepare', definition })
  const context = {
    sessionKey: 'session',
    sessionId: 'round2-backend',
    epoch: 0,
    policy: 'full-access',
    actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
  }
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  let consumed = false
  const effects: string[] = []
  const call = s.service.call.bind(s.service)
  const spy = vi.spyOn(s.service, 'call').mockImplementation((method, params, authority) => {
    if (consumed && method === '_agnes/v1/mcp.servers.list') clock.mockReturnValue(now + 110_001)
    if (
      consumed &&
      [
        '_agnes/v1/mcp.servers.create',
        '_agnes/v1/mcp.servers.trust.set',
        '_agnes/v1/mcp.servers.enable',
      ].includes(method)
    )
      effects.push(method)
    return call(method, params, authority)
  })
  try {
    await withPermissionContext(
      context,
      (row) => {
        if (row.consumption === 'consumed') consumed = true
      },
      () => s.request({ action: 'commit', proposalId: prepared.proposalId }).catch(() => undefined),
      async () => context,
      () => context,
    )
    expect(consumed).toBe(true)
    expect(
      await s.store.mcp.workerManaged('local-dev'),
      `Expired grant admitted ${effects.join(', ')}`,
    ).toEqual([])
    expect(effects).toEqual([])
  } finally {
    spy.mockRestore()
    clock.mockRestore()
  }
})

it.each(['intent', 'create', 'trust', 'local-start', 'journal-create', 'journal-local-start'])(
  'round2: expiry after %s persistence prevents the next MCP side effect',
  async (boundary) => {
    const s = await setup()
    const prepared = await s.request({ action: 'prepare', definition })
    const context = {
      sessionKey: 'session',
      sessionId: 'round2-exact-mcp',
      epoch: 0,
      policy: 'full-access',
      actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    }
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const effects: string[] = []
    const call = s.service.call.bind(s.service)
    const expire = () => clock.mockReturnValue(now + 110_001)
    const spy = vi.spyOn(s.service, 'call').mockImplementation(async (method, params, authority) => {
      if (method.endsWith('.create') || method.endsWith('.trust.set') || method.endsWith('.enable'))
        effects.push(method)
      const result = await call(method, params, authority)
      if (
        (boundary === 'create' && method.endsWith('.create')) ||
        (boundary === 'trust' && method.endsWith('.trust.set'))
      )
        expire()
      return result
    })
    const approve = s.store.mcp.approveLocalStart.bind(s.store.mcp)
    const start = vi.spyOn(s.store.mcp, 'approveLocalStart').mockImplementation(async (...args) => {
      effects.push('local-start')
      await approve(...args)
      if (boundary === 'local-start') expire()
    })
    try {
      const result = await withPermissionContext(
        context,
        () => undefined,
        () => s.request({ action: 'commit', proposalId: prepared.proposalId }),
        async () => {
          if (boundary === 'intent') {
            const receipt = await readFile(
              join(s.root, 'mcp-onboarding', `${prepared.proposalId}.json`),
              'utf8',
            ).catch(() => '')
            if (receipt && JSON.parse(receipt).state === 'registered') expire()
          }
          if (boundary.startsWith('journal-')) {
            for (const file of await readdir(join(s.root, 'mcp')).catch(() => [])) {
              if (!file.includes('.mcp.json.') || !file.endsWith('.tmp')) continue
              const bytes = await readFile(join(s.root, 'mcp', file), 'utf8').catch(() => '')
              if (!bytes) continue
              const row = JSON.parse(bytes).servers.fixture
              if (boundary === 'journal-create' || row?.localStartApproval) expire()
            }
          }
          return context
        },
        () => context,
      )
      expect(result).toMatchObject({ state: 'cancelled', via: 'unavailable' })
      const all = ['_agnes/v1/mcp.servers.create', '_agnes/v1/mcp.servers.trust.set', 'local-start']
      const admitted =
        boundary === 'journal-create'
          ? 1
          : boundary === 'journal-local-start'
            ? 3
            : ['intent', 'create', 'trust', 'local-start'].indexOf(boundary)
      expect(effects).toEqual(all.slice(0, admitted))
      const rows = await s.store.mcp.workerManaged('local-dev')
      if (boundary === 'intent' || boundary === 'journal-create') expect(rows).toEqual([])
      else
        expect(rows[0]).toMatchObject({
          desired: 'disabled',
          trust: boundary === 'create' ? 'untrusted' : 'trusted',
        })
      if (boundary === 'journal-local-start') expect(rows[0]).not.toHaveProperty('localStartApproval')
    } finally {
      spy.mockRestore()
      start.mockRestore()
      clock.mockRestore()
    }
  },
)

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'agh-mcp-onboard-'))
  roots.push(root)
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
  endpoints.push(ep)
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
    endpoints.push(next)
    liveEndpoints.push(next)
    currentEp = next
    await ep.close()
    return next
  }
  const ask = vi
    .spyOn(ep, 'request')
    .mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
  const connected = vi.fn(async ({ serverId, enabled }: { serverId: string; enabled: boolean }) => ({
    status: {
      serverId,
      connectionState: enabled ? ('ready' as const) : ('disabled' as const),
      observedRevision: revision,
      catalogRevision: 'a'.repeat(64),
      toolCount: enabled ? 1 : 0,
      observedAt: new Date().toISOString(),
    },
  }))
  const store = createResourceControlStore({
    directory: root,
    scope: { allowedProfiles: ['local-dev'] },
    mcp: {
      reconcile: connected,
      reconnect: (input) => connected({ ...input, enabled: true }),
      test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
      tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
    },
  })
  const service = createResourceControlService(store)
  const options = {
    directory: root,
    profile: 'local-dev',
    service,
    store,
    current: () => currentEp.conn,
    connections: () => liveEndpoints.map((e) => e.conn),
    endpoint: (conn: typeof ep.conn) => liveEndpoints.find((e) => e.conn === conn),
    owner: () => ({ principalId: 'local', active: true }),
  }
  let handler = createMcpManageRequests(options)
  let seq = 0
  const request = (input: unknown, overrides = {}) =>
    handler('session', `r${++seq}`, 'mcp-manage', {
      packageId: '@agnes/mcp-helper',
      snapshotId: 'snapshot',
      rowId: 'ext:mcp-helper/main',
      sessionKey: 'session',
      toolUseId: 'tool',
      leaseId: 'lease',
      input,
      ...overrides,
    }) as Promise<{ proposalId: string; state: string; items: unknown[] }>
  return {
    root,
    refresh,
    ep,
    ask,
    store,
    service,
    request,
    connected,
    dispatch: (key: string, id: string, method: string, raw: unknown, signal?: AbortSignal) =>
      handler(key, id, method, raw, signal),
    abortLatest: () => handler('session', 'security2-abort', 'mcp-manage-abort', { requestId: `r${seq}` }),
    restart: () => {
      handler = createMcpManageRequests(options)
    },
  }
}

it('registers in the real AGH resource list, saves a revision grant and recovers the receipt', async () => {
  vi.stubEnv('AGNES_MCP_STDIO_ALLOWLIST', undefined)
  const s = await setup()
  const p = await s.request({ action: 'prepare', definition })
  expect((await s.request({ action: 'list' })).items).toEqual([])
  expect(s.ask).not.toHaveBeenCalled()
  s.ask.mockRestore()
  const pending = s.request({ action: 'commit', proposalId: p.proposalId })
  const first = await s.ep.notifications[Symbol.asyncIterator]().next()
  expect(first.value).toMatchObject({ method: 'session/request_permission' })
  const refreshed = await s.refresh()
  const receipt = await pending
  expect(refreshed.request).toHaveBeenCalledWith(
    'session/request_permission',
    expect.objectContaining({
      options: [
        expect.objectContaining({ kind: 'allow_once' }),
        expect.objectContaining({ kind: 'reject_once' }),
      ],
    }),
    expect.anything(),
  )
  expect(['submitted', 'ready']).toContain(receipt.state)
  await vi.waitFor(
    async () =>
      expect(await s.request({ action: 'status', proposalId: p.proposalId })).toMatchObject({
        state: 'ready',
      }),
    { timeout: 10_000 },
  )
  expect((await s.request({ action: 'list' })).items).toEqual([
    expect.objectContaining({ serverId: 'fixture', enabled: true, state: 'ready' }),
  ])
  const snapshot = JSON.parse(await readFile(s.store.snapshotPath('local-dev'), 'utf8'))
  expect(snapshot.mcp[0].localStartApproval).toBe(revision)
  s.restart()
  expect(await s.request({ action: 'commit', proposalId: p.proposalId })).toMatchObject({ state: 'ready' })
  expect(refreshed.request).toHaveBeenCalledTimes(1)
  const authority = localResourceAuthority()({ conn: s.ep.conn })
  await s.service.call(
    '_agnes/v1/mcp.servers.trust.set',
    {
      profile: 'local-dev',
      serverId: 'fixture',
      expectedRevision: revision,
      trust: 'rejected',
      clientId: 'client',
      commandId: 'revoke-1',
    },
    authority,
  )
  expect((await s.store.mcp.workerManaged('local-dev'))[0]?.localStartApproval).toBeUndefined()
})

it('denial and malformed identity never register or authorize a server', async () => {
  vi.stubEnv('AGNES_MCP_STDIO_ALLOWLIST', undefined)
  const s = await setup()
  const p = await s.request({ action: 'prepare', definition })
  s.ask.mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'reject_once' } })
  expect(await s.request({ action: 'commit', proposalId: p.proposalId })).toMatchObject({
    state: 'cancelled',
    via: 'rejected',
    reason: 'user-rejected',
  })
  expect(await s.request({ action: 'commit', proposalId: p.proposalId })).toMatchObject({
    state: 'cancelled',
    via: 'rejected',
  })
  expect(s.ask).toHaveBeenCalledTimes(1)
  const held = await s.request({ action: 'prepare', definition })
  expect(await s.request({ action: 'cancel', proposalId: held.proposalId })).toMatchObject({
    state: 'cancelled',
    via: 'cancelled',
  })
  expect(await s.request({ action: 'commit', proposalId: held.proposalId })).toMatchObject({
    state: 'cancelled',
    via: 'cancelled',
  })
  expect(s.ask).toHaveBeenCalledTimes(1)
  expect((await s.request({ action: 'list' })).items).toEqual([])
  await expect(s.request({ action: 'prepare', definition }, { sessionKey: 'other' })).rejects.toMatchObject({
    message: 'INVALID_PARAMS',
  })
  s.ep.conn.authKind = 'jwt'
  await expect(s.request({ action: 'prepare', definition })).rejects.toMatchObject({
    message: 'CAPABILITY_DENIED',
  })
})

it('asks again when the connect approval timed out or never reached an approver', async () => {
  vi.stubEnv('AGNES_MCP_STDIO_ALLOWLIST', undefined)
  const timed = await setup()
  timed.ask.mockRejectedValueOnce(Object.assign(new Error('deadline'), { data: { code: 'TIMEOUT' } }))
  const p = await timed.request({ action: 'prepare', definition })
  expect(await timed.request({ action: 'commit', proposalId: p.proposalId })).toMatchObject({
    state: 'cancelled',
    via: 'timeout',
    reason: 'deadline',
  })
  expect((await timed.request({ action: 'list' })).items).toEqual([])
  expect(timed.ask).toHaveBeenCalledTimes(1)
  expect(['submitted', 'ready']).toContain(
    (await timed.request({ action: 'commit', proposalId: p.proposalId })).state,
  )
  expect(timed.ask).toHaveBeenCalledTimes(2)

  const missed = await setup()
  missed.ask.mockRejectedValueOnce(new Error('reset'))
  const q = await missed.request({ action: 'prepare', definition })
  expect(await missed.request({ action: 'commit', proposalId: q.proposalId })).toMatchObject({
    state: 'cancelled',
    via: 'unavailable',
    reason: 'transport',
  })
  expect(missed.ask).toHaveBeenCalledTimes(1)
  expect(['submitted', 'ready']).toContain(
    (await missed.request({ action: 'commit', proposalId: q.proposalId })).state,
  )
  expect(missed.ask).toHaveBeenCalledTimes(2)
})

it('an explicitly empty deployment ceiling cannot be overridden by a conversation', async () => {
  vi.stubEnv('AGNES_MCP_STDIO_ALLOWLIST', '')
  const s = await setup()
  await expect(s.request({ action: 'prepare', definition })).rejects.toMatchObject({
    data: { code: 'MCP_DEPLOYMENT_POLICY_DENIED' },
  })
  expect(s.ask).not.toHaveBeenCalled()
})

it('does not wait for an active-turn connection barrier before returning the submission', async () => {
  vi.stubEnv('AGNES_MCP_STDIO_ALLOWLIST', undefined)
  const s = await setup()
  let release: () => void = () => {}
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const original = s.connected.getMockImplementation()
  s.connected.mockImplementation(async (input) => {
    await barrier
    if (!original) throw new Error('fixture')
    return original(input)
  })
  const p = await s.request({ action: 'prepare', definition })
  try {
    expect(await s.request({ action: 'commit', proposalId: p.proposalId })).toMatchObject({
      state: 'submitted',
    })
  } finally {
    release()
  }
  await vi.waitFor(
    async () =>
      expect(await s.request({ action: 'status', proposalId: p.proposalId })).toMatchObject({
        state: 'ready',
      }),
    { timeout: 10_000 },
  )
})

it.each(['full-access', 'workspace-write'])(
  'registers, trusts and starts MCP with the effective %s permission context',
  async (policy) => {
    const s = await setup()
    const evidence: AutomaticPermissionEvidence[] = []
    if (policy === 'full-access') {
      s.ep.conn.capabilities.permission = false
      s.ep.conn.attached.clear()
      delete s.ep.conn.authKind
    }
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
        const prepared = await s.request({ action: 'prepare', definition })
        const receipt = await s.request({ action: 'commit', proposalId: prepared.proposalId })
        expect(['submitted', 'ready']).toContain(receipt.state)
        await vi.waitFor(async () =>
          expect(await s.request({ action: 'status', proposalId: prepared.proposalId })).toMatchObject({
            state: 'ready',
          }),
        )
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
    expect(s.ask).toHaveBeenCalledTimes(policy === 'full-access' ? 0 : 1)
    if (policy === 'full-access')
      expect(evidence).toMatchObject([
        {
          scope: 'mcp.connect',
          reason: 'full-access',
          answeredBy: { role: 'system' },
          consumption: 'authorized',
        },
        {
          scope: 'mcp.connect',
          reason: 'full-access',
          answeredBy: { role: 'system' },
          consumption: 'consumed',
        },
      ])
    else expect(evidence).toEqual([])
  },
)

it.each(['same-chunk', 'next-chunk'] as const)(
  'security3: production channel revocation prevents a stale MCP commit with FIFO %s delivery',
  async (delivery) => {
    const s = await setup()
    const prepared = await s.request({ action: 'prepare', definition })
    const { host } = await createTestHost({ dataDir: join(s.root, 'host'), disableSessionTitle: true })
    const session = await host.createSession({
      key: 'session',
      cwd: join(s.root, 'host'),
      permission: 'workspace-write',
    })
    const standardPolicy = session.permissionContext.policy
    expect(standardPolicy).not.toBe('full-access')
    await session.setYolo(true, session.d.actor)
    const expected = session.permissionContext
    expect(expected.policy).toBe('full-access')
    let buffered: unknown[] | undefined
    let narrowed = false
    let completed: Promise<unknown> | undefined
    let abortDelivered: Promise<void> | undefined
    let replyAndAbort: string[] = []
    const commits: number[] = []
    const commandErrors: unknown[] = []
    const socket = new EventEmitter() as EventEmitter & { write(chunk: Buffer): boolean; end(): void }
    const channel = new SharedSessionChannel(
      (frame) => {
        if ((frame as { method?: string }).method === 'permission-revoke') {
          const revoke = frame as {
            sessionKey: string
            requestId: string
            params: { sessionId: string; epoch: number }
          }
          link.permissionFence.revoke(revoke.sessionKey, revoke.params.sessionId, revoke.params.epoch)
          queueMicrotask(() =>
            channel.settle({
              kind: 'reply',
              sessionKey: revoke.sessionKey,
              requestId: revoke.requestId,
              result: null,
            }),
          )
          return
        }
        if (buffered) buffered.push(frame)
        else socket.emit('data', encodeFrame(frame))
      },
      sessionPermissions((key) => (key === session.key ? session : undefined)),
    )
    const respond = async (command: {
      kind: string
      requestId: string
      sessionKey: string
      method?: string
    }) => {
      if (command.kind === 'reply') {
        channel.settle(command as never)
        return
      }
      if (command.kind !== 'command' || command.method !== 'permissionContext')
        throw new Error('Unexpected worker command')
      const snapshot = session.permissionContext
      let enabling = false
      for (const relative of await readdir(s.root, { recursive: true })) {
        if (!String(relative).includes('.mcp.json.') || !String(relative).endsWith('.tmp')) continue
        const text = await readFile(join(s.root, String(relative)), 'utf8').catch(() => '')
        if (text && JSON.parse(text).servers?.fixture?.desired === 'enabled') enabling = true
      }
      const reply = {
        kind: 'reply',
        requestId: command.requestId,
        sessionKey: command.sessionKey,
        result: snapshot,
      }
      if (!narrowed && enabling) {
        narrowed = true
        // The query reply is already written, then the worker persists the real owner switch.
        // Buffer both outgoing frames to model IPC that has not delivered either frame yet.
        buffered = [reply]
        await session.setYolo(false, session.d.actor)
        const frames = buffered
        buffered = undefined
        replyAndAbort = frames.map(
          (frame) => (frame as { method?: string; kind: string }).method ?? (frame as { kind: string }).kind,
        )
        if (delivery === 'same-chunk') socket.emit('data', Buffer.concat(frames.map(encodeFrame)))
        else {
          socket.emit('data', encodeFrame(frames[0]))
          abortDelivered = new Promise((resolve) =>
            setImmediate(() => {
              socket.emit('data', Buffer.concat(frames.slice(1).map(encodeFrame)))
              resolve()
            }),
          )
        }
      } else socket.emit('data', encodeFrame(reply))
    }
    socket.write = (chunk) => {
      void respond(JSON.parse(chunk.toString())).catch((error) => commandErrors.push(error))
      return true
    }
    socket.end = () => {
      socket.emit('close')
    }
    const link = new WorkerLink(socket as unknown as Duplex, {
      onEvent() {},
      async onRequest(frame, signal) {
        if (frame.method === 'mcp-manage-abort')
          return s.dispatch(frame.sessionKey, frame.requestId, frame.method, frame.params, signal)
        completed = permissionRequest(
          frame.permissionContext,
          s.root,
          () => s.dispatch(frame.sessionKey, frame.requestId, frame.method, frame.params, signal),
          () => link.commandForSession(frame.sessionKey, 'permissionContext', {}) as Promise<typeof expected>,
          frame.permissionContext ? link.permissionFence.bind(frame.permissionContext) : undefined,
        )
        return completed
      },
    })
    const rename = systemNode.renameWriteThroughSync
    const spy = vi.spyOn(systemNode, 'renameWriteThroughSync').mockImplementation((source, target) => {
      if (
        target.endsWith('.mcp.json') &&
        JSON.parse(readFileSync(source, 'utf8')).servers?.fixture?.desired === 'enabled'
      )
        commits.push(session.permissionContext.epoch)
      return rename(source, target)
    })
    try {
      const pending = channel
        .run('session', () =>
          channel.request(
            'mcp-manage',
            {
              packageId: '@agnes/mcp-helper',
              snapshotId: 'snapshot',
              rowId: 'ext:mcp-helper/main',
              sessionKey: 'session',
              toolUseId: 'tool',
              leaseId: 'lease',
              input: { action: 'commit', proposalId: prepared.proposalId },
            },
            new AbortController().signal,
          ),
        )
        .catch(() => undefined)
      await pending
      await completed?.catch(() => undefined)
      await abortDelivered
      expect(commandErrors).toEqual([])
      expect(narrowed).toBe(true)
      expect(replyAndAbort).toEqual(['reply', 'mcp-manage-abort'])
      expect(session.permissionContext).toMatchObject({
        policy: standardPolicy,
        epoch: expected.epoch + 1,
      })
      expect(s.ask).not.toHaveBeenCalled()
      const row = (await s.store.mcp.workerManaged('local-dev'))[0]
      expect({ commits, enabled: row?.desired === 'enabled' }).toEqual({ commits: [], enabled: false })
    } finally {
      spy.mockRestore()
      channel.closeAll()
      link.close('test complete')
      await host.close()
    }
  },
)
