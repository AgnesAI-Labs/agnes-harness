import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HookEngine, HookRegistry, ResourceRegistry, SessionHookPort, SlotRegistry } from '@agnes/core'
import type { ExtensionManifest } from '@agnes/extension-api'
import { afterEach, expect, it, vi } from 'vitest'
import { bindExtensionInvocations } from '../../src/assemble/extension-ports.js'
import { buildExtensionAPI } from '../../src/ext-host/api-proxy.js'
import { DisposerBag } from '../../src/ext-host/disposers.js'
import { leaseFor } from '../../src/ext-host/lease.js'
import { createTestHost, type TestHost } from '../../testkit/index.js'
import { fixtureTool } from '../fixtures/tool.js'

const held: Array<{ dir: string; host: TestHost['host']; bag: DisposerBag }> = []
afterEach(async () => {
  for (const item of held.splice(0)) {
    await item.host.close()
    await item.bag.disposeAllAsync()
    rmSync(item.dir, { recursive: true, force: true })
  }
})
const log = { debug() {}, info() {}, warn() {}, error() {} }
const platform = Object.freeze({
  shell: 'posix',
  fs: Object.freeze({ caseSensitive: true, pathSep: '/' }),
  terminal: Object.freeze({ color: false }),
} as const)
const manifest: ExtensionManifest = {
  id: 'fixture/bound',
  version: '1.0.0',
  apiRange: '^1.0',
  entry: './index.ts',
  capabilities: {
    slots: ['status.line'],
    hooks: ['before_step'],
    tools: { prefix: 'fx_', names: ['fx_event'] },
    events: true,
  },
}
async function setup(wrongSession = false) {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-bound-'))
  const { host } = await createTestHost({
    dataDir: dir,
    currentRuntime: { current: () => undefined },
    script: [
      [
        {
          type: 'toolcall_end',
          call: { toolUseId: '', name: 'fx_event', args: {}, ordinal: 0 },
          via: 'native',
        },
        { type: 'done', reason: 'toolUse' },
      ],
      [
        { type: 'text_delta', delta: 'done' },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  const bag = new DisposerBag()
  held.push({ dir, host, bag })
  const a = await host.createSession({ cwd: dir, key: 'bound-a' }),
    b = await host.createSession({ cwd: dir, key: 'bound-b' })
  const hooks = new HookRegistry(),
    slots = new SlotRegistry(),
    resources = new ResourceRegistry()
  const ports = bindExtensionInvocations(
    {
      tools: host.kernel.tools,
      projections: host.kernel.projections,
      hooks,
      slots,
      resources,
      registrations: (source) => [
        ...hooks.registrations(source),
        ...slots.registrations(source),
        ...resources.registrations(source),
      ],
    },
    (ref) => (wrongSession ? b : host.kernel.get(ref.key)),
  )
  const lease = leaseFor(manifest, { now: Date.now(), ttlMs: 60000 })
  const api = buildExtensionAPI({
    manifest,
    packageIdentity: '@fixture/package',
    packageVersion: manifest.version,
    trust: 'trusted',
    lease,
    ports,
    bag,
    log,
    info: { agnesVersion: '0.0.0', apiVersion: '1.0.0', profileName: 'test' },
    platform,
    signal: new AbortController().signal,
    isRegistering: () => true,
  })
  const engine = new HookEngine({ diag() {}, onFailure() {}, platform }, hooks)
  a.hooks = new SessionHookPort(engine, {
    context: () => ({
      session: { key: a.key, lane: a.lane, workspaceRoot: a.d.cwd },
      signal: a.ac.signal,
      replayed: false,
      lease: lease.view(),
      log,
    }),
    budget: () => ({ remaining: 10, cap: null }),
    surface: () => [],
    surfaceDigest: () => ({ nodes: 0, tokensEstimate: 0 }),
    verifierTier: () => 0,
    contextOverflow() {},
    compactPlanIgnored() {},
  })
  return { a, b, api, bag, ports, slots }
}

it('writes hook and actual tool execution events through author API to the correct real ledger', async () => {
  const { a, b, api } = await setup()
  expect(() => api.events.append('outside', {})).toThrow('no active session')
  api.registerHook('before_step', async () => {
    await api.events.append('note', { kind: 'hook' })
    return {}
  })
  const tool = fixtureTool('fx_event')
  tool.execute = async (_args, context) => {
    expect(context.session.key).toBe(a.key)
    expect(context.session.toolUseId).not.toBe('')
    await api.events.append('note', { kind: 'tool' })
    return { content: [{ type: 'text', text: 'event written' }] }
  }
  api.registerTool(tool)
  await a.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor: a.d.actor })
  expect((await a.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe('completed')
  const rows = await a.scan({ type: 'x/fixture/bound/note', toSeq: a.lastSeq })
  expect(rows.map((row) => row.data)).toContainEqual({ kind: 'hook' })
  expect(rows.map((row) => row.data)).toContainEqual({ kind: 'tool' })
  expect(rows.every((row) => row.origin === 'ext:fixture/bound' && row.trust === 'untrusted')).toBe(true)
  expect(await b.scan({ type: 'x/fixture/bound/note', toSeq: b.lastSeq })).toEqual([])
  expect(() => api.events.append('outside', {})).toThrow('no active session')
})

it('refuses a mismatched session resolver instead of writing to another session', async () => {
  const { a, b, api } = await setup(true)
  api.registerHook('before_step', async () => {
    await api.events.append('note', {})
    return {}
  })
  await a.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor: a.d.actor })
  const outcome = await a.run({ until: 'turn-end', signal: new AbortController().signal })
  expect(await b.scan({ type: 'x/fixture/bound/note', toSeq: b.lastSeq })).toEqual([])
  expect(outcome.reason).toBe('blocked')
})

it('rejects late slot event writes at the real projection deadline while the author fill is pending', async () => {
  const { a, b, api, slots } = await setup()
  let resume!: () => void, entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    resume = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let rejected = false,
    completed!: () => void
  const finished = new Promise<void>((resolve) => {
    completed = resolve
  })
  api.registerSlot('status.line', async (context) => {
    expect(Object.keys(context).sort()).toEqual(['projections', 'session', 'surface', 'trigger'])
    await api.events.append('note', { kind: 'slot-start' })
    entered()
    await waiting
    try {
      await api.events.append('note', { kind: 'slot-late' })
    } catch {
      rejected = true
    } finally {
      completed()
    }
    return { text: 'late', level: 'info' }
  })
  vi.useFakeTimers()
  try {
    const pending = slots.snapshot(
      { key: a.key, lane: a.lane, workspaceRoot: a.d.cwd },
      { remainingMs: () => 10 },
    )('tui', {
      kind: 'tick',
    })
    await started
    vi.advanceTimersByTime(10)
    resume()
    await finished
    expect(rejected).toBe(true)
    expect(await pending).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect((await a.scan({ type: 'x/fixture/bound/note', toSeq: a.lastSeq })).map((row) => row.data)).toEqual(
      [{ kind: 'slot-start' }],
    )
    expect(await b.scan({ type: 'x/fixture/bound/note', toSeq: b.lastSeq })).toEqual([])
  } finally {
    vi.useRealTimers()
  }
})

it('refuses a mismatched slot session before the author can append', async () => {
  const { a, b, api, slots } = await setup(true)
  let called = false
  api.registerSlot('status.line', async () => {
    called = true
    await api.events.append('note', { kind: 'wrong-slot' })
    return { text: 'wrong', level: 'info' }
  })
  const rows = await slots.snapshot(
    { key: a.key, lane: a.lane, workspaceRoot: a.d.cwd },
    { remainingMs: () => 100 },
  )('tui', {
    kind: 'tick',
  })
  expect(await b.scan({ type: 'x/fixture/bound/note', toSeq: b.lastSeq })).toEqual([])
  expect(called).toBe(false)
  expect(rows).toEqual([])
})

it('closes a synchronous author slot before its queued microtask can write', async () => {
  const { a, api, slots } = await setup()
  let rejected = false,
    done!: () => void
  const finished = new Promise<void>((resolve) => {
    done = resolve
  })
  api.registerSlot('status.line', () => {
    queueMicrotask(async () => {
      try {
        await api.events.append('note', { kind: 'after-sync-return' })
      } catch {
        rejected = true
      } finally {
        done()
      }
    })
    return { text: 'sync', level: 'info' }
  })
  const rows = await slots.snapshot(
    { key: a.key, lane: a.lane, workspaceRoot: a.d.cwd },
    { remainingMs: () => 100 },
  )('tui', {
    kind: 'tick',
  })
  await finished
  expect(rejected).toBe(true)
  expect(await a.scan({ type: 'x/fixture/bound/note', toSeq: a.lastSeq })).toEqual([])
  expect(rows.map((row) => row.payload)).toEqual([{ text: 'sync', level: 'info' }])
})
