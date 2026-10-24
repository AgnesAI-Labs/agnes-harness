import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { openDaemonScheduleDb } from '@agnes/base/schedule'
import { JobsRepo } from '@agnes/daemon-foundation/jobs/repo'
import { Scheduler } from '@agnes/daemon-foundation/jobs/scheduler'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { NoticeSink } from '@agnes/daemon-foundation/local/notice'
import { createTestHost } from '@agnes/host/testkit'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import * as sdk from '@agnes/sdk'
import { handleServiceCommand } from '@agnes/worker-runtime'
import { describe, expect, it, vi } from 'vitest'
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
  it.each(['check', 'initialize', 'create'] as const)(
    'cancels preparation during %s without continuing session setup',
    async (phase) => {
      const tables = sqliteTables()
      const repo = new JobsRepo(tables.table('jobs'), () => 10_000)
      let release!: () => void
      let entered!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const wait = async () => {
        entered()
        await gate
      }
      let preparing = false
      let closed = false
      const operations: string[] = []
      const client = vi.spyOn(sdk, 'createClient').mockImplementation(
        () =>
          ({
            initialize: async () => {
              operations.push('initialize')
              if (phase === 'initialize') await wait()
            },
            createSession: async () => {
              operations.push('create')
              if (phase === 'create') await wait()
              return { id: 'created-session' }
            },
            call: async () => {
              operations.push('configure')
            },
            close: async () => {
              closed = true
              release()
            },
          }) as unknown as sdk.NodeClient,
      )
      const tasks = scheduledTasks({
        db: openDaemonScheduleDb(tables.table('schedules')),
        jobs: repo.scheduleJobs(),
        clock: () => 10_000,
        socketPath: '/synthetic-unused',
        serverIdentity: { pid: 1, processStartId: 'synthetic' },
        sources: {
          normalize: async (path) => {
            if (preparing && phase === 'check') await wait()
            return path
          },
          workspaces: async () => [{ path: '/synthetic', available: true }],
          catalog: async () => ({ loops: [], modelAdapters: [] }),
          presets: () => [],
        },
      })
      try {
        const saved = await tasks.upsert({
          title: 'Synthetic',
          prompt: 'Synthetic',
          selector: { every_seconds: 60 },
          target: { kind: 'new-session', cwd: '/synthetic' },
        })
        if (!('id' in saved)) throw new Error('schedule missing')
        const job = repo.get(`schedule:${saved.id}:1`)
        if (!job) throw new Error('job missing')
        const controller = new AbortController()
        preparing = true
        const result = tasks.hooks.prepare(job, controller.signal)
        await ready
        controller.abort()
        release()
        await expect(result).rejects.toThrow()
        expect(operations).toEqual(
          phase === 'check' ? [] : phase === 'initialize' ? ['initialize'] : ['initialize', 'create'],
        )
        expect(closed).toBe(phase !== 'check')
      } finally {
        release()
        await tasks.close()
        client.mockRestore()
        await tables.close()
      }
    },
  )

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
  const repo = new JobsRepo(tables.table('jobs'), () => now)
  const tasks = scheduledTasks({
    db: openDaemonScheduleDb(tables.table('schedules')),
    jobs: repo.scheduleJobs(),
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
  let seq = 0
  const event = (type: string, data: unknown) =>
    ({ type, data, seq: ++seq, ts: new Date(now).toISOString() }) as import('@agnes/protocol').EventEnvelope
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
        return ++seq
      },
      run: async () => {
        automation.observe('s', event('turn/start', { turn: 1, trigger: 'prompt' }))
        automation.observe('s', event('decision/state', decision))
        automation.observe('s', event('turn/end', { reason: 'parked' }))
        return { reason: 'parked', lastSeq: 4 }
      },
    },
  }
  const scheduler = new Scheduler({
    repo,
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
    automation.observe('s', event('turn/end', { reason: 'completed' }))
    expect(await read()).toMatchObject({ outcome: 'ran' })
  } finally {
    await scheduler.stop()
    await tasks.close()
    await tables.close()
  }
})

it('saves and runs a hot-installed agent through the current worker catalog, refusing revocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-hot-schedule-'))
  const directory = join(root, 'package')
  mkdirSync(directory)
  const file = join(directory, 'package.json')
  const manifest = {
    name: '@acme/hot',
    version: '1.0.0',
    agnes: {
      bundles: {
        work: {
          profile: { tools: ['read'] },
          presets: { safe: { name: 'safe', extends: 'standard' } },
          launch: { title: { en: 'Hot' }, description: { en: 'Synthetic' }, preset: 'safe' } as
            | object
            | undefined,
        },
      },
    },
  }
  writeFileSync(file, JSON.stringify(manifest))
  const source: RuntimePluginSnapshot = {
    trusted: true,
    enabled: true,
    generation: 1,
    snapshot: {
      packageId: manifest.name,
      version: '1.0.0',
      profile: 'local-dev',
      snapshotId: 'synthetic',
      integrity: 'synthetic-integrity',
      capabilityHash: 'synthetic-capability',
      contributions: [],
      directory,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
    },
  }
  let sources: readonly RuntimePluginSnapshot[] = []
  const { host } = await createTestHost({
    dataDir: root,
    script: [],
    disableSessionTitle: true,
    provider: (profile) =>
      new ScriptedProvider({
        scripts: [],
        models: (profile.provider.routes ?? []).flatMap((route) => route.models ?? []),
      }),
    packageDirs: Object.fromEntries(
      ['base', 'code', 'ai'].map((id) => [
        `@agnes/${id}`,
        fileURLToPath(new URL(`../../${id}`, import.meta.url)),
      ]),
    ),
    runtimePluginSources: async () => sources,
    extensionLoader: {
      import: async () => {
        throw new Error('declarative source must not execute')
      },
    },
  })
  const publishSources = async () => {
    const target = host.runtimeTargetSnapshot?.()
    if (!target || !host.applyRuntimeTarget) throw new Error('runtime publication unavailable')
    // Installer changes publish before the worker's descriptive catalog is read.
    const result = await host.applyRuntimeTarget(target)
    expect(result.publication?.ok).toBe(true)
  }
  const opened: Awaited<ReturnType<typeof host.createSession>>[] = []
  const client = vi.spyOn(sdk, 'createClient').mockImplementation(
    () =>
      ({
        initialize: async () => ({}),
        close: async () => {},
        call: async () => ({}),
        createSession: async (input: Parameters<sdk.NodeClient['createSession']>[0]) => {
          const { sessionKey, ...selection } = input
          const session = await host.createSession({
            ...selection,
            ...(sessionKey ? { key: sessionKey } : {}),
          })
          opened.push(session)
          return { id: session.key }
        },
      }) as unknown as sdk.NodeClient,
  )
  const catalog = async () =>
    (await handleServiceCommand(
      host,
      { kind: 'command', requestId: 'catalog', method: 'session.catalog', params: {} },
      new Map(),
    )) as import('../src/supervisor/schedule-sessions.js').ScheduleCatalog
  const tables = sqliteTables()
  let now = 10_000
  const repo = new JobsRepo(tables.table('jobs'), () => now)
  const tasks = scheduledTasks({
    db: openDaemonScheduleDb(tables.table('schedules')),
    jobs: repo.scheduleJobs(),
    clock: () => now,
    socketPath: '/synthetic-unused',
    serverIdentity: { pid: 1, processStartId: 'synthetic' },
    sources: {
      workspaces: async () => [{ path: root, available: true }],
      normalize: async (path) => path,
      catalog,
      presets: () => host.profile.presets.allowed,
    },
  })
  try {
    expect((await catalog()).bundles).toEqual([])
    sources = [source]
    await publishSources()
    const plan = await host.resolveAgent!('@acme/hot#work')
    expect((await catalog()).bundles).toContainEqual({ id: plan.ref, sourcePackage: manifest.name })
    const input = {
      title: 'Hot',
      prompt: 'Read',
      selector: { every_seconds: 60 },
      target: {
        kind: 'new-session' as const,
        cwd: root,
        loop: plan.loop,
        bundles: plan.bundles,
        preset: plan.preset,
        model: plan.model,
      },
    }
    const saved = await tasks.upsert(input)
    if (!('id' in saved)) throw new Error('hot schedule rejected')
    // After save, running must depend on the saved selection rather than any launch declaration.
    manifest.agnes.bundles.work.launch = undefined
    writeFileSync(file, JSON.stringify(manifest))
    const changed = {
      ...source,
      snapshot: { ...source.snapshot, treeIntegrity: hashDirectory(directory, { exclude: [] }) },
    }
    sources = [changed]
    await publishSources()
    await expect(host.resolveAgent!(plan.ref)).rejects.toThrow('unknown agent')
    now += 60_000
    const job = repo.claimDue(now, 'synthetic', 1000, 1)[0]
    if (!job) throw new Error('schedule job missing')
    expect(await tasks.hooks.prepare(job)).toEqual({ sessionKey: opened[0]!.key })
    expect(opened[0]!.preset.name).toBe('safe')
    expect(opened[0]!.currentTools().resolve('read')).toBeDefined()
    for (const revoked of [[{ ...changed, enabled: false }], [{ ...changed, trusted: false }], []]) {
      sources = revoked
      await publishSources()
      expect((await catalog()).bundles).toEqual([])
      await expect(tasks.upsert(input)).rejects.toMatchObject({ code: 'bundle_unavailable' })
      await expect(tasks.hooks.prepare(job)).rejects.toThrow('bundle_unavailable')
    }
    expect(opened).toHaveLength(1)
  } finally {
    client.mockRestore()
    await tasks.close()
    for (const session of opened) await session.close()
    await host.close()
    await tables.close()
    rmSync(root, { recursive: true, force: true })
  }
})
