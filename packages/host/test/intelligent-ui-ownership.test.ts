import { Context, type Fiber } from '@agnes/cordis'
import { pluginRowSource } from '@agnes/host-extensions/ext-host/row-extension-host'
import {
  DEFERRED_INVOCATION_EVENT,
  DEFERRED_NOTIFICATION_EVENT,
  DeferredInvocationsService,
} from '@agnes/host-providers/assemble/deferred-invocations'
import { type IntelligentUiServicePorts, intelligentUiKind, UI_OWNER } from '@agnes/intelligent-ui-contract'
import type { DeferredToolInvocationQueue } from '@agnes/plugin-runtime/deferred-contract'
import type { RowOrigin } from '@agnes/plugin-runtime/host'
import type { EventEnvelope } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import type { HostSession } from '../src/runtime/lifecycle/host.js'
import { createExtensionServiceHost, type ServiceAdmission } from '../src/runtime/services/author-port.js'
import {
  bindDeferredInvocations,
  rememberDeferredInvocations,
} from '../src/runtime/sessions/deferred-invocations.js'
import { createIntelligentUiBridge } from '../src/runtime/sessions/intelligent-ui.js'

async function fixture() {
  const root = new Context()
  const index = new WeakMap<Fiber, RowOrigin>()
  const origins = { lookup: (fiber: Fiber) => index.get(fiber) }
  const rowId = 'ext:ordinary-ui'
  const owner = pluginRowSource(rowId)
  const packageId = '@fixture/ordinary-ui'
  const actor = { id: 'human', org: 'synthetic', role: 'owner', deptPath: [], attrs: {} }
  const invocation = {
    id: 'human-command',
    source: UI_OWNER,
    sourceSeq: 1,
    sessionKey: 'session',
    lane: 'main',
    actor,
    tool: 'approve',
    args: { privateNote: 'human UI only' },
  }
  const rows: EventEnvelope[] = [
    {
      seq: 1,
      id: 'row-1',
      ts: '2026-10-18T00:00:00Z',
      type: DEFERRED_INVOCATION_EVENT,
      origin: 'system',
      trust: 'trusted',
      lane: 'main',
      actor,
      data: { invocation, state: 'queued' },
    },
  ]
  const session = {
    key: 'session',
    lane: 'main',
    workspaceRoot: '/synthetic',
    closingOrClosed: false,
    pluginGenerationId: 'generation',
    get lastSeq() {
      return rows.length
    },
    lastTurnNumber: () => 1,
    op: () => false,
    d: { log: { parent: undefined }, loopFactory: { capabilities: ['deferred-invocations'] } },
    state: { registers: { decisionStates: new Map() } },
    currentTools: () => ({ list: () => [] }),
    async scan(query: { type?: string | string[]; fromSeq?: number; toSeq?: number }) {
      return rows.filter(
        (row) =>
          (!query.type || [query.type].flat().includes(row.type)) &&
          row.seq >= (query.fromSeq ?? 1) &&
          row.seq <= (query.toSeq ?? Infinity),
      )
    },
    async append(events: EventEnvelope[]) {
      const seqs = events.map((event) => {
        const seq = rows.length + 1
        rows.push({ ...event, seq, id: `row-${seq}`, ts: '2026-10-18T00:00:00Z' })
        return seq
      })
      return { seqs }
    },
  } as unknown as HostSession
  const admission: ServiceAdmission = {
    token: {},
    owner,
    active: true,
    signal: new AbortController().signal,
    session: session as unknown as ServiceAdmission['session'],
  }
  const host = createExtensionServiceHost({
    providers: () => root.providers,
    sessionGeneration: () => 'generation',
    readAdmission: () => admission,
  })
  const deferred = new DeferredInvocationsService(root, origins)
  rememberDeferredInvocations(root, deferred)
  const release = bindDeferredInvocations({ pluginTree: { root } } as never, session)
  const bridge = createIntelligentUiBridge({
    dataDir: '/synthetic',
    profileDir: '/synthetic',
    profileName: 'fixture',
    agnesVersion: '0.0.0',
    extensionHost: host,
    sessionGeneration: () => 'generation',
    session: () => session,
    providers: () => root.providers,
  } as never)
  bridge.attach(root, origins, deferred)
  root.providers.verifyRows(origins)
  host.attachBinder(root.providers)
  const officialOpen = vi.fn(() => {
    throw Error('ordinary binding must not open official factory')
  })
  host.ports.register(
    intelligentUiKind,
    { id: UI_OWNER, version: '0.1.0', open: officialOpen },
    { owner: UI_OWNER, packageId: '@agnes/base' },
  )
  let queue!: DeferredToolInvocationQueue
  const fiber = root.plugin({
    apply(ctx: Context) {
      index.set(ctx.fiber, {
        trustTier: 'third-party',
        packageId,
        snapshotId: 'one',
        rowId,
        exportName: 'main',
        declaredProvides: [],
      })
      ctx.providers.register(intelligentUiKind, {
        id: 'fixture/ordinary-ui',
        version: '1.0.0',
        open(ports: IntelligentUiServicePorts) {
          queue = ports.capabilities.queue
          return { read: () => queue.read(invocation.id, new AbortController().signal) } as never
        },
      })
    },
  })
  await fiber
  expect(host.packageFor(intelligentUiKind, owner)).toBe(packageId)
  expect(host.packageFor(intelligentUiKind, UI_OWNER)).toBe('@agnes/base')
  await root.providers.bindOwn(intelligentUiKind)
  expect(officialOpen).not.toHaveBeenCalled()
  return {
    queue,
    rows,
    owner,
    deferred,
    invocation,
    async dispose() {
      release()
      await root.fiber.dispose()
    },
  }
}

it('bindOwn grants the real Intelligent UI bridge only its admitted owner queue, including notifications', async () => {
  const f = await fixture()
  const signal = new AbortController().signal
  try {
    await expect(f.queue.read('human-command', signal)).rejects.toThrow('another producer')
    expect(await f.queue.next(signal)).toBeNull()
    await expect(f.queue.transition('human-command', 1, 'executing')).rejects.toThrow('another producer')
    // A foreign receipt must neither be delivered nor acknowledged by an ordinary owner.
    await f.queue.notify(signal)
    expect(f.rows).toHaveLength(1)
    const own = { ...f.invocation, id: 'own-command', source: f.owner }
    f.rows.push({ ...f.rows[0]!, seq: 2, id: 'row-2', data: { invocation: own, state: 'queued' } })
    expect(await f.queue.read(own.id, signal)).toMatchObject({ invocation: own, state: 'queued' })
    expect(await f.queue.transition(own.id, 2, 'executing')).toMatchObject({
      invocation: own,
      state: 'executing',
    })
    const changed = vi.fn()
    f.deferred.register({ source: f.owner, validate: async () => {}, changed })
    await f.queue.notify(signal)
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ invocation: own }), signal)
    expect(f.rows.filter((row) => row.type === DEFERRED_NOTIFICATION_EVENT).map((row) => row.data)).toEqual([
      { id: own.id, receiptSeq: 3 },
    ])
    expect(
      f.rows.filter(
        (row) =>
          row.type === DEFERRED_INVOCATION_EVENT &&
          (row.data as { invocation: { source: string } }).invocation.source === UI_OWNER,
      ),
    ).toHaveLength(1)
  } finally {
    await f.dispose()
  }
})
