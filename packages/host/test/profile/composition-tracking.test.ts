import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDef } from '@agnes/extension-api'
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
  // Every timer is faked, so a setInterval or setTimeout polling loop would show in the counts.
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const readerOptions = {
  allowed: ['standard', 'reader'],
  presets: { reader: { name: 'reader', extends: 'standard' } },
}
const meta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe' as const,
  costHint: undefined,
  deferLoading: undefined,
  requiresApproval: undefined,
}
const tool = (name: string) =>
  ({
    name,
    description: 'd',
    parameters: { type: 'object', properties: {} },
    meta,
    execute: async () => ({ content: [] }),
  }) as unknown as ToolDef

it('publishes on open, preset change and close, and never on a timer', async () => {
  const { host: tracked } = await createTestHost({ dataDir: root, ...readerOptions })
  const profileDir = join(root, 'profiles', 'local-dev')
  try {
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
  } finally {
    await tracked.close()
  }
})

it('republishes when a tool is added to an open session, without any settings change', async () => {
  const { host } = await createTestHost({ dataDir: root })
  const profileDir = join(root, 'profiles', 'local-dev')
  try {
    const s = await host.createSession({ key: 'k', cwd: root })
    const groups = async () =>
      (await readLiveCompositionSessions(profileDir))[0]?.toolGroups?.map((group) => group.packageId) ?? []
    expect(await groups()).not.toContain('fixture/added')
    const remove = s
      .currentTools()
      .add(tool('added_tool'), { source: 'fixture/added', trust: 'builtin' } as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(await groups()).toContain('fixture/added')
    remove()
    await vi.advanceTimersByTimeAsync(0)
    expect(await groups()).not.toContain('fixture/added')
    await s.close()
  } finally {
    await host.close()
  }
})

it('describes the session again when a resource is registered on it', async () => {
  const { host } = await createTestHost({ dataDir: root })
  try {
    const s = await host.createSession({ key: 'k', cwd: root })
    await vi.advanceTimersByTimeAsync(0)
    const spy = vi.spyOn(sessionCapabilityView, 'describeCapabilitySession')
    const remove = s
      .currentResources()
      .register(
        { id: 'r', kind: 'skill', name: 'Skill', description: 'Description' },
        { source: 'fixture/resources', trust: 'builtin' },
      )
    await vi.advanceTimersByTimeAsync(0)
    expect(spy).toHaveBeenCalledTimes(1)
    remove()
    await vi.advanceTimersByTimeAsync(0)
    expect(spy).toHaveBeenCalledTimes(2)
    await s.close()
  } finally {
    await host.close()
  }
})

it('marks the session dirty even when a preset switch fails', async () => {
  const { host } = await createTestHost({ dataDir: root, ...readerOptions })
  try {
    const s = await host.createSession({ key: 'k', cwd: root })
    await vi.advanceTimersByTimeAsync(0)
    const spy = vi.spyOn(sessionCapabilityView, 'describeCapabilitySession')
    // A switch that fails part-way may have assigned the preset without announcing it.
    vi.spyOn(s, 'setPreset').mockRejectedValue(new Error('revocation failed'))
    await expect(host.setSessionPreset('k', 'reader')).rejects.toThrow('revocation failed')
    expect(spy).toHaveBeenCalledTimes(1)
    await s.close()
  } finally {
    await host.close()
  }
})

it('retries a session whose description failed on the next event', async () => {
  const { host } = await createTestHost({ dataDir: root })
  const profileDir = join(root, 'profiles', 'local-dev')
  try {
    // Fails the description at announcement and again after the Host finished opening the session.
    const failing = vi.spyOn(sessionCapabilityView, 'describeCapabilitySession')
    for (let attempt = 0; attempt < 2; attempt++)
      failing.mockImplementationOnce(() => {
        throw new Error('transient')
      })
    const a = await host.createSession({ key: 'a', cwd: root })
    expect(await readLiveCompositionSessions(profileDir)).toHaveLength(0)
    const b = await host.createSession({ key: 'b', cwd: root })
    expect((await readLiveCompositionSessions(profileDir)).map((s) => s.sessionKey).sort()).toEqual([
      'a',
      'b',
    ])
    await a.close()
    await b.close()
  } finally {
    await host.close()
  }
})

it('resolves a preset once per catalog and again after the catalog is rebuilt', async () => {
  const delivered = buildCompleteRuntimeTarget({ rows: [], resources: { mcp: [], skills: {} } }).target
  const { host } = await createTestHost({ dataDir: root, disableSessionTitle: true })
  try {
    const boot = host.runtimeTargetSnapshot?.()
    if (!boot) throw new Error('test host has no runtime target')
    await host.applyRuntimeTarget(delivered)
    const spy = vi.spyOn(sessionCapabilityView, 'describeCapabilitySession')
    const treeOf = (key: string) => spy.mock.calls.findLast((call) => call[1].key === key)?.[2]
    const first = await host.createSession({ key: 'first', cwd: root })
    const second = await host.createSession({ key: 'second', cwd: root })
    await vi.advanceTimersByTimeAsync(0)
    expect(treeOf('first')).toBeDefined()
    // Same catalog: one resolution serves both sessions.
    expect(treeOf('second')).toBe(treeOf('first'))
    // A code change with a bound session forks a container, which rebuilds the preset catalog.
    await host.applyRuntimeTarget(boot)
    expect(host.lastChange?.()).toMatchObject({ outcome: 'forked' })
    const third = await host.createSession({ key: 'third', cwd: root })
    await vi.advanceTimersByTimeAsync(0)
    expect(treeOf('third')).toBeDefined()
    expect(treeOf('third')).not.toBe(treeOf('first'))
    for (const session of [first, second, third]) await session.close()
  } finally {
    await host.close()
  }
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
