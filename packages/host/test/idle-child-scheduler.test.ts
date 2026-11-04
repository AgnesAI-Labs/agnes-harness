import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryAudit } from '@agnes/host-infrastructure/audit'
import { afterEach, expect, it, vi } from 'vitest'
import {
  idleChildRetireMs,
  registerRetirementOwner,
  scheduleIdleChildMaintenance,
} from '../src/runtime/children/idle-child-maintenance.js'

afterEach(() => vi.useRealTimers())

it('serializes ticks, reports individual and sweep failures, and drains an aborted sweep on close', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  let active = false
  let overlap = false
  let count = 0
  let signal!: AbortSignal
  const audit = createMemoryAudit()
  const scheduler = scheduleIdleChildMaintenance({
    idleMs: 3_600_000,
    clock: () => 42,
    audit,
    run: async (input) => {
      expect(input).toMatchObject({ now: 42, idleMs: 3_600_000, limit: 50 })
      signal = input.signal
      if (active) overlap = true
      active = true
      count++
      if (count === 1) {
        active = false
        throw new Error('private exception detail')
      }
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      active = false
      return [{ childKey: 'failed-child', status: 'failed', error: 'close-failed' }]
    },
  })
  await vi.advanceTimersByTimeAsync(120_000)
  expect(audit.events.map((event) => event.detail)).toEqual([{ error: 'retirement-sweep-failed' }])
  await vi.advanceTimersByTimeAsync(180_000)
  expect(count).toBe(2)
  expect(overlap).toBe(false)
  let closed = false
  const closing = scheduler.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(signal.aborted).toBe(true)
  expect(closed).toBe(false)
  finish()
  await closing
  expect(audit.events.map((event) => event.detail)).toEqual([
    { error: 'retirement-sweep-failed' },
    { childKey: 'failed-child', error: 'close-failed' },
  ])
  await vi.advanceTimersByTimeAsync(120_000)
  expect(count).toBe(2)
})

it('disables the timer at zero and defaults invalid idle policies without accepting coercions', async () => {
  vi.useFakeTimers()
  for (const value of [undefined, -1, 0.5, Infinity, '1'])
    expect(idleChildRetireMs({ 'subagent.idle_retire_ms': value })).toBe(3_600_000)
  const disabled = scheduleIdleChildMaintenance({
    idleMs: idleChildRetireMs({ 'subagent.idle_retire_ms': 0 }),
    clock: Date.now,
    run: async () => {
      throw new Error('disabled scheduler ran')
    },
    audit: createMemoryAudit(),
  })
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(7_200_000)
  await disabled.close()
})

it('finds a role workspace in the same canonical deployment and refuses ambiguous or busy ownership', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-retirement-owner-'))
  const alias = `${directory}-alias`
  symlinkSync(directory, alias, 'dir')
  let state: 'idle' | 'busy' = 'idle'
  const parent = registerRetirementOwner(directory, { retirementStatus: () => undefined })
  const role = registerRetirementOwner(alias, {
    retirementStatus: (key) => (key === 'role-child' ? state : undefined),
  })
  let duplicate: ReturnType<typeof registerRetirementOwner> | undefined
  try {
    expect(parent.canRetireSession('unknown')).toBe(false)
    expect(parent.canRetireSession('role-child')).toBe(true)
    state = 'busy'
    expect(parent.canRetireSession('role-child')).toBe(false)
    state = 'idle'
    duplicate = registerRetirementOwner(directory, { retirementStatus: () => 'idle' })
    expect(parent.canRetireSession('role-child')).toBe(false)
    duplicate.close()
    expect(parent.canRetireSession('role-child')).toBe(true)
    role.close()
    expect(parent.canRetireSession('role-child')).toBe(false)
  } finally {
    duplicate?.close()
    role.close()
    parent.close()
    rmSync(alias)
    rmSync(directory, { recursive: true, force: true })
  }
})
