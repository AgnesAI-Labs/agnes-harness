import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLiveCompositionSessions } from '@agnes/host-providers/profile/composition-state'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as sessionCapabilityView from '../../src/runtime/profile/session-capability-view.js'
import { createTestHost } from '../../testkit/index.js'

vi.mock('@agnes/host-infrastructure/adapters/process-identity-default', () => ({
  defaultProcessIdentity: async () => ({ state: 'alive', startId: 'composition-tracking-test-worker' }),
}))

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agnes-composition-tracking-'))
  // Only the interval the tracker used to run on; Host internals keep their real timers.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

it('publishes on open, preset change and close, and never on a timer', async () => {
  const { host: tracked } = await createTestHost({
    dataDir: root,
    allowed: ['standard', 'reader'],
    presets: { reader: { name: 'reader', extends: 'standard' } },
  })
  const profileDir = join(root, 'profiles', 'local-dev')
  const spy = vi.spyOn(sessionCapabilityView, 'describeCapabilitySession')
  const s = await tracked.createSession({ key: 'k', cwd: root })
  expect(await readLiveCompositionSessions(profileDir)).toHaveLength(1)
  const n = spy.mock.calls.length
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(spy.mock.calls.length).toBe(n)
  await tracked.setSessionPreset('k', 'reader')
  expect(spy.mock.calls.length).toBe(n + 1)
  expect((await readLiveCompositionSessions(profileDir))[0]?.preset).toBe('reader')
  await s.close()
  expect(await readLiveCompositionSessions(profileDir)).toHaveLength(0)
  await tracked.close()
})

it('publishes a session opened on a generation built after tracking started', async () => {
  const delivered = buildCompleteRuntimeTarget({ rows: [], resources: { mcp: [], skills: {} } }).target
  const { host } = await createTestHost({ dataDir: root, disableSessionTitle: true })
  const profileDir = join(root, 'profiles', 'local-dev')
  try {
    const boot = host.runtimeTargetSnapshot?.()
    if (!boot) throw new Error('test host has no runtime target')
    await host.applyRuntimeTarget(delivered)
    const old = await host.createSession({ key: 'old', cwd: root })
    // A code change with a bound session forks a container; new sessions open on the new one.
    await host.applyRuntimeTarget(boot)
    expect(host.lastChange?.()).toMatchObject({ outcome: 'forked' })
    const fresh = await host.createSession({ key: 'fresh', cwd: root })
    expect(fresh.pluginGenerationId).not.toBe(old.pluginGenerationId)
    expect((await readLiveCompositionSessions(profileDir)).map((s) => s.sessionKey).sort()).toEqual([
      'fresh',
      'old',
    ])
    await fresh.close()
    await old.close()
  } finally {
    await host.close()
  }
})
