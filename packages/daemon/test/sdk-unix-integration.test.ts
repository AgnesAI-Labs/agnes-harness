import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { resolveWorkspaceDirectory } from '@agnes/host'
import type { Provider, RequestBody } from '@agnes/protocol'
import { createClient, fileJournal, memoryJournal, TransportClosed } from '@agnes/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { type createLocalEndpoint, MemoryWorkspaceStore, WorkspaceCatalog } from '../src/local/index.js'
import { MemorySessionWorkspaces } from '../src/storage/lister.js'
import { bindConnection } from '../src/supervisor/connection.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { openTestHost, say, slowProvider } from './host.js'
import { localSdkTransport, localSocketPath } from './local-socket-path.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function service(options: Parameters<typeof openTestHost>[0] = {}) {
  const h = await openTestHost(options)
  const connections: Promise<void>[] = []
  const endpoints: ReturnType<typeof createLocalEndpoint>[] = []
  const workspaces = new WorkspaceCatalog(
    new MemoryWorkspaceStore(),
    new MemorySessionWorkspaces(),
    resolveWorkspaceDirectory,
  )
  let closedCount = 0
  const path = localSocketPath(join(h.dataDir, 'daemon', 'sdk.sock'))
  const server = await listenUnix(path, (socket) => {
    const ep = h.endpoint({ pollMs: 5, workspaces })
    endpoints.push(ep)
    connections.push(
      bindConnection(socket, ep, {
        onClose() {
          closedCount++
        },
      }).closed,
    )
  })
  const client = createClient({ journal: memoryJournal(), transport: localSdkTransport(path) })
  await client.workspace.add(h.dataDir)
  cleanup.push(async () => {
    await client.close()
    await server.close()
    await Promise.all(connections)
    await h.close()
  })
  return { h, client, connections, endpoints, closedCount: () => closedCount }
}
it('uses the default SDK Unix factory across daemon, Host and core with real output delivery', async () => {
  const { h, client } = await service({ script: [say('SDK actual core output')] })
  const session = await client.session.new({ cwd: h.dataDir })
  const notifications: unknown[] = []
  session.listeners.add((method, params) => notifications.push({ method, params }))
  expect(await session.prompt('hello')).toMatchObject({ stopReason: 'end_turn', reason: 'completed' })
  expect(JSON.stringify(notifications)).toContain('SDK actual core output')
  expect(session.lastSeq).toBeGreaterThan(0)
  await client.close()
  expect(session.closed).toBe(true)
})
it('client disconnect rejects the pending SDK prompt and aborts the actual core provider', async () => {
  let begin!: () => void
  const started = new Promise<void>((resolve) => {
    begin = resolve
  })
  let observed: AbortSignal | undefined
  const inner = slowProvider(60_000)
  const provider: Provider = {
    models: () => inner.models(),
    async *infer(request: RequestBody, options: { signal: AbortSignal; toolNames: string[] }) {
      observed = options.signal
      begin()
      yield* inner.infer(request, options)
    },
  }
  const s = await service({ provider })
  const session = await s.client.session.new({ cwd: s.h.dataDir })
  const result = session.prompt('pending').catch((error: unknown) => error)
  await started
  await s.client.close()
  expect(await result).toBeInstanceOf(TransportClosed)
  await Promise.all(s.connections)
  expect(observed?.aborted).toBe(true)
  expect(s.closedCount()).toBe(1)
  expect(session.closed).toBe(true)
})

it('routes real daemon permission requests to SDK sessions and defaults to rejection', async () => {
  const s = await service()
  const session = await s.client.session.new({ cwd: s.h.dataDir })
  const ep = s.endpoints[0]
  if (!ep) throw new Error('missing connected endpoint')
  expect(ep.conn.capabilities.permission).toBe(true)
  const ask = () =>
    ep.request('session/request_permission', {
      sessionId: session.id,
      toolCall: { toolCallId: 't' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    })
  expect(await ask()).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
  session.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
  expect(await ask()).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
  let start!: () => void
  const started = new Promise<void>((resolve) => {
    start = resolve
  })
  let late!: (value: { optionId: string }) => void
  session.onPermissionRequest(
    () =>
      new Promise((resolve) => {
        late = resolve
        start()
      }),
  )
  const pending = ask().catch((error: unknown) => error)
  await started
  await s.client.close()
  await Promise.all(s.connections)
  expect(await pending).toMatchObject({ data: { code: 'CLOSED' } })
  late({ optionId: 'allow' })
  expect(ep.pendingRequests()).toBe(0)
})

it('persists an actually consumed cursor and resumes after explicit session load over real Unix', async () => {
  const serviceState = await service({ script: [say('first durable turn'), say('second durable turn')] })
  const directory = join(serviceState.h.dataDir, 'sdk-journal')
  const create = () =>
    createClient({
      transport: localSdkTransport(localSocketPath(join(serviceState.h.dataDir, 'daemon', 'sdk.sock'))),
      journal: fileJournal(directory),
    })
  const first = create()
  cleanup.push(() => first.close())
  const original = await first.session.new({ cwd: serviceState.h.dataDir })
  await original.attach()
  const seen: number[] = []
  const drained = (async () => {
    for await (const event of original.events()) {
      seen.push(event.seq)
      if (event.type === 'turn/end') break
    }
  })()
  await original.prompt('first')
  await drained
  await first.close()
  // service() keeps its setup client connected after workspace.add. This case opens its own two
  // clients and waits for every accepted socket, so close that otherwise-idle setup connection too.
  await serviceState.client.close()
  await Promise.all(serviceState.connections)
  const saved = await fileJournal(directory).cursor(original.id)
  expect(saved?.fromSeq).toBe(seen.at(-1))
  expect(saved?.fromSeq).toBeGreaterThan(0)
  const second = create()
  cleanup.push(() => second.close())
  expect(await second.clientId()).toBe(await first.clientId())
  const resumed = await second.session.load(original.id, { cwd: serviceState.h.dataDir })
  await resumed.attach()
  const resumedRows: number[] = []
  const next = (async () => {
    for await (const event of resumed.events()) {
      resumedRows.push(event.seq)
      if (event.type === 'turn/end') break
    }
  })()
  await resumed.prompt('second')
  await next
  await second.close()
  expect(resumedRows.length).toBeGreaterThan(0)
  expect(resumedRows.every((seq) => seq > (saved?.fromSeq ?? 0))).toBe(true)
  expect(await fileJournal(directory).cursor(original.id)).toEqual({
    fromSeq: resumedRows.at(-1),
    generation: saved?.generation,
  })
})
it('projects the actual core timeline with generation and historical cuts through SDK Unix', async () => {
  const s = await service({ script: [say('project first'), say('project second')] })
  const session = await s.client.session.new({ cwd: s.h.dataDir })
  await session.prompt('first question')
  const first = await session.projectUI()
  expect(first.sessionId).toBe(session.id)
  expect(first.generation).toBe(1)
  expect(first.upto).toBeGreaterThan(0)
  expect(JSON.stringify(first.nodes)).toContain('project first')
  expect(JSON.stringify(first.nodes)).toContain('first question')
  await session.prompt('second question')
  const update = await session.projectUIPatch(first.upto)
  expect(update.kind).toBe('patch')
  if (update.kind !== 'patch') throw new Error('expected projection patch')
  expect(update.patch.from).toBe(first.upto)
  expect(update.patch.upto).toBeGreaterThan(first.upto)
  expect(update.patch.changes.length).toBeGreaterThan(0)
  const latest = await session.projectUI(undefined, { surface: 'tui' })
  expect(latest.upto).toBeGreaterThan(first.upto)
  expect(JSON.stringify(latest.nodes)).toContain('project second')
  const historical = await session.projectUI(first.upto, { surface: 'tui' })
  expect(historical.nodes).toEqual(first.nodes)
  expect(historical.upto).toBe(first.upto)
  expect(await session.projectUI(0)).toEqual({
    sessionId: session.id,
    generation: 1,
    upto: 0,
    opState: null,
    nodes: [],
    turns: [],
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: false,
      billingComplete: false,
      context: { tokens: 0, window: 128000, autoCompact: true, source: 'estimated' },
      model: { route: 'gw', id: 'm1', thinking: 'off' },
    },
  })
  await expect(session.projectUI(Number.MAX_SAFE_INTEGER + 1)).rejects.toMatchObject({ code: -32602 })
  await expect(s.client.call('_agnes/v1/session.projectUI', { sessionId: 'absent' })).rejects.toMatchObject({
    code: -32003,
  })
})

it('SDK detach reaches the real daemon, updates state and allows reattachment', async () => {
  const s = await service()
  const session = await s.client.session.new({ cwd: s.h.dataDir })
  await session.attach()
  expect(session.attached).toBe(true)
  expect(s.endpoints[0]?.conn.attached.has(session.id)).toBe(true)
  await session.detach()
  expect(session.attached).toBe(false)
  expect(session.closed).toBe(false)
  expect(s.endpoints[0]?.conn.attached.has(session.id)).toBe(false)
  expect(await s.client.journal.cursor(session.id)).toMatchObject({ generation: 1 })
  await session.attach()
  expect(session.attached).toBe(true)
  expect(s.endpoints[0]?.conn.attached.has(session.id)).toBe(true)
})

it('reads nullable budget and real inference fees through SDK Unix without pricing unknown as zero', async () => {
  const s = await service({ script: [say('priced later')] })
  const opened = vi.spyOn(s.h.host, 'createSession')
  const session = await s.client.session.new({ cwd: s.h.dataDir })
  expect(await session.budget()).toEqual({ state: null, ledger: [] })
  await session.prompt('run')
  const budget = await session.budget()
  expect(budget.state).toMatchObject({ slot: 'primary', creditsCap: null })
  expect(budget.ledger).toHaveLength(1)
  expect(budget.ledger[0]).toMatchObject({ creditSource: 'estimated', purpose: 'inference' })
  expect(budget.ledger[0]).not.toHaveProperty('credits')
  const core = await opened.mock.results[0]?.value
  if (!core) throw new Error('missing real core session')
  const rows = Array.from({ length: 201 }, (_, i) =>
    core.ev('cost/ledger', {
      purpose: 'tool',
      effectId: `budget-${i}`,
      credits: i === 200 ? 0 : i,
      creditSource: 'gateway',
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      model: 'script',
    }),
  )
  await core.append(rows)
  // Cost rows remain discoverable even with more than 2000 unrelated events after them.
  await core.append(
    Array.from({ length: 2001 }, () => core.ev('x/test/budget-noise', {}, { ignorable: true })),
  )
  const latest = await session.budget()
  expect(latest.ledger).toHaveLength(200)
  expect(latest.ledger.map((row) => row.credits)).toEqual(
    Array.from({ length: 200 }, (_, i) => (i === 199 ? 0 : i + 1)),
  )
  expect(latest.ledger.every((row, i) => i === 0 || row.seq > (latest.ledger[i - 1]?.seq ?? 0))).toBe(true)
  await expect(s.client.call('_agnes/v1/session.budget', { sessionId: 'absent' })).rejects.toMatchObject({
    code: -32003,
  })
  await expect(
    s.client.call('_agnes/v1/session.budget', { sessionId: session.id, actor: {} }),
  ).rejects.toMatchObject({ kind: 'protocol-violation' })
  expect(
    await s.endpoints[0]?.handle({
      jsonrpc: '2.0',
      id: 'bad-budget',
      method: '_agnes/v1/session.budget',
      params: { sessionId: session.id, actor: {} },
    }),
  ).toMatchObject({ error: { code: -32602 } })
})

it('stops before inference when projected credits exhaust the selected preset budget', async () => {
  const provider = new ScriptedProvider({ scripts: [say('must not be emitted')] })
  const projected: string[] = []
  const s = await service({
    provider,
    allowed: ['standard', 'budget-deny'],
    presets: {
      'budget-deny': {
        name: 'budget-deny',
        extends: 'standard',
        budget: { preflight: 'estimate', per_request_cap: 1, on_exceed: 'deny', max_steps: 50 },
      },
    },
    seams: {
      ledger: {
        projected: async ({ model }) => {
          projected.push(model)
          return { credits: 5, creditSource: 'estimated' }
        },
      },
    },
  })
  const session = await s.client.session.new({ cwd: s.h.dataDir, preset: 'budget-deny' })
  await expect(session.prompt('too expensive')).resolves.toMatchObject({
    stopReason: 'refusal',
    reason: 'budget',
  })
  expect(projected).toEqual(['m1'])
  expect(provider.calls).toHaveLength(0)
  expect(await session.budget()).toMatchObject({
    state: { creditsCap: 1, lastPreflight: { source: 'estimate' } },
    ledger: [],
  })
})
