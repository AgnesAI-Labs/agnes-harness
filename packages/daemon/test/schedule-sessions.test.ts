import { openDaemonScheduleDb } from '@agnes/base/schedule'
import { JobsRepo } from '@agnes/daemon-foundation/jobs/repo'
import { Scheduler } from '@agnes/daemon-foundation/jobs/scheduler'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { NoticeSink } from '@agnes/daemon-foundation/local/notice'
import { describe, expect, it } from 'vitest'
import { sqliteTables } from '../../daemon-foundation/test/sqlite-tables.js'
import {
  failureOf,
  runTitle,
  scheduledTasks,
  scheduleTargetCheck,
} from '../src/supervisor/schedule-sessions.js'
import { createAutomationEvents } from '../src/supervisor/worker-events.js'

const check = scheduleTargetCheck({
  workspaces: async () => [
    { path: '/work/app', available: true },
    { path: '/work/gone', available: false },
  ],
  normalize: async (path) => path.replace(/\/$/, ''),
  catalog: async () => ({
    loops: [{ id: 'data-report', version: '1.0.0' }],
    bundles: [{ id: 'report#bundle' }],
    modelAdapters: [{ models: [{ id: 'agnes-1', route: 'agnes' }] }],
  }),
  presets: () => ['default', 'review'],
})

describe('new-session schedule targets', () => {
  it('accepts a registered workspace with an available loop, bundle, preset and model', async () => {
    expect(await check({ kind: 'new-session', cwd: '/work/app/' })).toBeUndefined()
    expect(
      await check({
        kind: 'new-session',
        cwd: '/work/app',
        loop: { id: 'data-report', version: '1.0.0' },
        bundles: ['report#bundle'],
        preset: 'whatever-the-bundle-brings',
        model: { route: 'agnes', model: 'agnes-1' },
      }),
    ).toBeUndefined()
  })

  it('names what is missing', async () => {
    expect(await check({ kind: 'new-session', cwd: '/elsewhere' })).toBe('workspace_missing')
    expect(await check({ kind: 'new-session', cwd: '/work/gone' })).toBe('workspace_missing')
    expect(await check({ kind: 'new-session', cwd: '/work/app', preset: 'root' })).toBe('preset_not_allowed')
    expect(
      await check({ kind: 'new-session', cwd: '/work/app', loop: { id: 'data-report', version: '2.0.0' } }),
    ).toBe('loop_missing')
    expect(await check({ kind: 'new-session', cwd: '/work/app', bundles: ['other#bundle'] })).toBe(
      'bundle_unavailable',
    )
    expect(
      await check({ kind: 'new-session', cwd: '/work/app', model: { route: 'agnes', model: 'gone' } }),
    ).toBe('model_missing')
  })

  it('titles each run with the task and its local start time, within the session title limit', () => {
    const at = new Date(2026, 9, 15, 9, 5).getTime()
    expect(runTitle('Daily report', at)).toBe('Daily report · 2026-10-15 09:05')
    expect(runTitle('x'.repeat(200), at)).toHaveLength(80)
  })

  it('words a failure by where it stopped', () => {
    expect(failureOf('workspace_missing', { newSession: true })).toEqual({ reason: 'workspace_missing' })
    expect(failureOf('connect ECONNREFUSED', { newSession: true })).toEqual({
      reason: 'start_failed',
      detail: 'connect ECONNREFUSED',
    })
    expect(failureOf('boom', { newSession: true, sessionKey: 's' })).toEqual({
      reason: 'turn_error',
      detail: 'boom',
    })
    expect(failureOf('session owner unavailable for s', { newSession: false })).toMatchObject({
      reason: 'session_unavailable',
    })
  })
})

it('records a scheduled park and notifies the owner and bound channel through the normal notice path', async () => {
  let now = 10_000
  const tables = sqliteTables()
  const owner = new LocalEndpoint({ clock: () => now, principalId: 'owner', profile: 'p' })
  const channel = new LocalEndpoint({ clock: () => now, principalId: 'channel', profile: 'p' })
  for (const ep of [owner, channel]) {
    ep.conn.initialized = true
    ep.conn.authKind = 'local'
    ep.conn.credentialKind = 'local'
  }
  channel.conn.attached.set('s', {
    cursor: { fromSeq: 1, generation: 1 },
    filter: { preview: false, acpUpdates: false },
  })
  const notices = new NoticeSink({
    clock: () => now,
    endpoints: () => [owner, channel].map((ep) => ({ ep, conn: ep.conn })),
  })
  const tasks = scheduledTasks({
    db: openDaemonScheduleDb(tables.table('schedules')),
    clock: () => now,
    socketPath: '/synthetic-unused',
    serverIdentity: { pid: 1, processStartId: 'synthetic' },
    sources: {
      workspaces: async () => [],
      normalize: async (path) => path,
      catalog: async () => ({ loops: [], modelAdapters: [] }),
      presets: () => ['standard'],
    },
  })
  const task = await tasks.upsert({
    title: 'Report',
    prompt: 'Run report',
    selector: { every_seconds: 60 },
    target: { kind: 'session', sessionKey: 's' },
  })
  if (!('id' in task)) throw new Error('schedule admission failed')
  const automation = createAutomationEvents(
    { resolve: () => ({ active: true, principalId: 'owner' }) },
    notices,
    'p',
  )
  automation.schedules = tasks
  const event = (type: string, data: unknown) =>
    ({ type, data, seq: 1, ts: new Date(now).toISOString() }) as import('@agnes/protocol').EventEnvelope
  const decision = {
    handle: { id: 'd', sessionId: 's' },
    request: { expiresAt: new Date(now + 86400_000).toISOString() },
    result: null,
    consumption: null,
    invalidation: null,
  }
  const entry = {
    key: 's',
    inflight: null,
    session: {
      cwd: '/workspace',
      enqueue: async (_target: unknown, message: unknown) => {
        expect(message).toMatchObject({
          origin: 'system',
          actor: { attrs: { unattendedApproval: 'notify' } },
        })
        return 1
      },
      run: async () => {
        automation.observe('s', event('turn/start', { turn: 1, trigger: 'prompt' }))
        automation.observe('s', event('decision/state', decision))
        automation.observe('s', event('turn/end', { turn: 1, reason: 'parked' }))
        return { reason: 'parked', lastSeq: 4 }
      },
    },
  }
  const scheduler = new Scheduler({
    repo: new JobsRepo(tables.table('jobs'), () => now),
    registry: { open: async () => entry, get: () => entry, keys: () => ['s'] },
    notices,
    clock: () => now,
    owner: 'daemon',
    limits: { tickMs: 1000, lockMs: 1000, maxStalled: 2 },
    ownership: { resolve: () => ({ active: true, principalId: 'owner' }) },
    activationBarrier: {
      enqueue: () => ({
        start: async () => ({ run: async (operation: () => Promise<unknown>) => operation() }),
        cancel() {},
      }),
    } as never,
    workspaces: {
      restoreBinding: async () =>
        ({
          version: 1,
          sessionKey: 's',
          workspaceId: 'a'.repeat(64),
          revision: 1,
          canonicalRoot: '/workspace',
        }) as never,
    },
    ...tasks.hooks,
  })
  try {
    now += 60_000
    await scheduler.tick()
    const read = async () => (await tasks.list({ scope: 'all' })).schedules[0]?.runs[0]
    expect(await read()).toMatchObject({ outcome: 'waiting_approval', needsAttention: true })
    expect([owner, channel].map((ep) => ep.pending().events)).toEqual([1, 2]) // owner gets attention; the bound channel also gets job delivery
    automation.observe(
      's',
      event('decision/state', {
        ...decision,
        result: { reason: 'answered', response: { option: 'allowed-once' } },
      }),
    )
    automation.observe('s', event('turn/start', { turn: 2, trigger: 'approval-resume' }))
    automation.observe('s', event('turn/end', { turn: 2, reason: 'completed' }))
    expect(await read()).toMatchObject({ outcome: 'ran' })
  } finally {
    await scheduler.stop()
    await tasks.close()
    await tables.close()
  }
})
