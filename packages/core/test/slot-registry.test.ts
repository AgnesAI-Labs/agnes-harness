import { afterEach, expect, it, vi } from 'vitest'
import { projectUI } from '../src/project/ui.js'
import { SlotRegistry } from '../src/registry/slots.js'

const meta = { source: 'fixture/slot', trust: 'trusted' as const }
const session = { key: 'session', lane: 'main', workspaceRoot: '/workspace' }
const tick = { kind: 'tick' as const }
afterEach(() => vi.useRealTimers())

it('filters by actual surface and trigger and orders by the protocol slot order', async () => {
  const registry = new SlotRegistry(),
    calls: string[] = []
  registry.register(
    'status.line',
    () => {
      calls.push('status')
      return { text: 's', level: 'info' }
    },
    meta,
  )
  registry.register(
    'notification',
    () => {
      calls.push('notification')
      return { title: 'n', body: 'b' }
    },
    meta,
  )
  registry.register(
    'sidebar.action',
    () => {
      calls.push('sidebar')
      return { id: 'a', label: 'a' }
    },
    meta,
  )
  registry.register(
    'tool.card.inline',
    () => {
      calls.push('tool')
      return { title: 't' }
    },
    meta,
  )
  const run = registry.snapshot(session, { remainingMs: () => 100 })
  expect((await run('tui', tick)).map((r) => r.slot)).toEqual(['sidebar.action', 'status.line'])
  expect(calls.splice(0)).toEqual(['sidebar', 'status'])
  expect((await run('channel', { kind: 'turn_end' })).map((r) => r.slot)).toEqual(['notification'])
  expect(calls.splice(0)).toEqual(['notification'])
  expect((await run('web', { kind: 'tool_result', toolUseId: 't' })).map((r) => r.slot)).toEqual([
    'tool.card.inline',
  ])
  expect(calls).toEqual(['tool'])
})

it('retains a membership snapshot while registration and disposal affect subsequent snapshots', async () => {
  const registry = new SlotRegistry()
  const off = registry.register('status.line', () => ({ text: 'old', level: 'info' }), meta)
  const before = registry.snapshot(session, { remainingMs: () => 100 })
  off()
  off()
  registry.register('status.line', () => ({ text: 'new', level: 'info' }), meta)
  expect((await before('tui', tick))[0]?.payload).toMatchObject({ text: 'old' })
  expect(
    (await registry.snapshot(session, { remainingMs: () => 100 })('tui', tick))[0]?.payload,
  ).toMatchObject({ text: 'new' })
  expect(registry.registrations(meta.source)).toEqual(['slot:status.line'])
  expect(registry.registrations('fixture/other')).toEqual([])
})

it('keeps duplicate multi-slot fills in registration order and captures identity', async () => {
  const registry = new SlotRegistry(),
    source = { ...meta },
    identity = { ...session }
  registry.register(
    'status.line',
    (ctx) => {
      expect(Object.isFrozen(ctx)).toBe(true)
      expect(Object.isFrozen(ctx.session)).toBe(true)
      expect(Object.isFrozen(ctx.trigger)).toBe(true)
      return { text: ctx.session.key, level: 'info' }
    },
    source,
  )
  registry.register('status.line', () => ({ text: 'second', level: 'info' }), source)
  const run = registry.snapshot(identity, { remainingMs: () => 100 })
  identity.key = 'changed'
  source.source = 'fixture/changed'
  const rows = await run('tui', tick)
  expect(rows.map((r) => r.extId)).toEqual([meta.source, meta.source])
  expect(rows.map((r) => r.payload)).toEqual([
    { text: 'session', level: 'info' },
    { text: 'second', level: 'info' },
  ])
})

it('leaves failed, null, oversized and malformed fills blank while keeping successful siblings', async () => {
  const registry = new SlotRegistry()
  registry.register(
    'status.line',
    () => {
      throw new Error('failure')
    },
    meta,
  )
  registry.register('status.line', () => null, meta)
  // @ts-expect-error exercise a malformed JavaScript extension return at the runtime boundary
  registry.register('status.line', () => ({ text: 'bad' }), meta)
  registry.register('status.line', () => ({ text: 'x'.repeat(70000), level: 'info' }), meta)
  registry.register('status.line', () => ({ text: 'ok', level: 'info' }), meta)
  expect(
    (await registry.snapshot(session, { remainingMs: () => 100 })('tui', tick)).map((r) => r.payload),
  ).toEqual([{ text: 'ok', level: 'info' }])
})

it('bounds a hung fill, removes its timer and never appends its late result', async () => {
  vi.useFakeTimers()
  const registry = new SlotRegistry()
  let resolve: (value: { text: string; level: 'info' }) => void = () => {}
  registry.register(
    'status.line',
    () =>
      new Promise((done) => {
        resolve = done
      }),
    meta,
  )
  const pending = registry.snapshot(session, { remainingMs: () => 10 })('tui', tick)
  await vi.advanceTimersByTimeAsync(10)
  const result = await pending
  expect(result).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
  resolve({ text: 'late', level: 'info' })
  await Promise.resolve()
  expect(result).toEqual([])
})

it('does not invoke fills when the caller budget is exhausted or the request is cancelled', async () => {
  const registry = new SlotRegistry(),
    fill = vi.fn(() => ({ text: 'x', level: 'info' as const }))
  registry.register('status.line', fill, meta)
  expect(await registry.snapshot(session, { remainingMs: () => 0 })('tui', tick)).toEqual([])
  expect(
    await registry.snapshot(session, { remainingMs: () => 100, signal: AbortSignal.abort() })('tui', tick),
  ).toEqual([])
  expect(fill).not.toHaveBeenCalled()
})

it('produces real projectUI slot nodes and no ledger writes', async () => {
  const registry = new SlotRegistry()
  registry.register('status.line', () => ({ text: 'registered', level: 'info' }), meta)
  const ui = await projectUI([], {
    sessionKey: 'session',
    surface: 'tui',
    fills: registry.snapshot(session, { remainingMs: () => 100 }),
  })
  expect(ui.nodes).toContainEqual(
    expect.objectContaining({
      kind: 'slot',
      fill: {
        slot: 'status.line',
        extId: meta.source,
        payload: { text: 'registered', level: 'info' },
      },
    }),
  )
  expect(ui.upto).toBe(0)
})

it('rechecks cancellation and budget before a queued callback actually starts', async () => {
  const registry = new SlotRegistry(),
    calls: string[] = []
  let remaining = 10
  registry.register(
    'status.line',
    () => {
      calls.push('first')
      remaining = 0
      return null
    },
    meta,
  )
  registry.register(
    'status.line',
    () => {
      calls.push('second')
      return null
    },
    meta,
  )
  await registry.snapshot(session, { remainingMs: () => remaining })('tui', tick)
  expect(calls).toEqual(['first'])
  calls.length = 0
  remaining = 10
  const controller = new AbortController()
  const pending = registry.snapshot(session, { remainingMs: () => remaining, signal: controller.signal })(
    'tui',
    tick,
  )
  controller.abort()
  expect(await pending).toEqual([])
  expect(calls).toEqual([])
})

it('ends internal slot authority at the timeout and caller cancellation while a fill remains pending', async () => {
  vi.useFakeTimers()
  const registry = new SlotRegistry()
  let active: AbortSignal | undefined
  registry.register(
    'status.line',
    (_context, signal) => {
      active = signal
      return new Promise(() => {})
    },
    meta,
  )
  const pending = registry.snapshot(session, { remainingMs: () => 10 })('tui', tick)
  await Promise.resolve()
  expect(active?.aborted).toBe(false)
  vi.advanceTimersByTime(10)
  // No await: write authority must already be gone inside this timer turn.
  expect(active?.aborted).toBe(true)
  expect(await pending).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
  const parent = new AbortController()
  const cancelled = registry.snapshot(session, { remainingMs: () => 10, signal: parent.signal })('tui', tick)
  await Promise.resolve()
  expect(active?.aborted).toBe(false)
  parent.abort()
  expect(active?.aborted).toBe(true)
  expect(await cancelled).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})

it('closes internal slot authority on successful and failed callback settlement', async () => {
  const registry = new SlotRegistry(),
    signals: AbortSignal[] = []
  registry.register(
    'status.line',
    (_context, signal) => {
      signals.push(signal)
      return { text: 'ok', level: 'info' }
    },
    meta,
  )
  registry.register(
    'status.line',
    (_context, signal) => {
      signals.push(signal)
      throw new Error('failed fill')
    },
    meta,
  )
  const rows = await registry.snapshot(session, { remainingMs: () => 100 })('tui', tick)
  expect(rows.map((row) => row.payload)).toEqual([{ text: 'ok', level: 'info' }])
  expect(signals).toHaveLength(2)
  expect(signals.every((signal) => signal.aborted)).toBe(true)
})
