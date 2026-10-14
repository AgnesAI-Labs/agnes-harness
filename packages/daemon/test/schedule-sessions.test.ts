import { describe, expect, it } from 'vitest'
import { failureOf, runTitle, scheduleTargetCheck } from '../src/supervisor/schedule-sessions.js'

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
    expect(runTitle('Daily report', at, 'en-GB')).toBe('Daily report · 15/10/2026, 09:05')
    expect(runTitle('x'.repeat(200), at, 'en-GB')).toHaveLength(80)
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
