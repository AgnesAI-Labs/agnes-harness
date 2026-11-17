// Adapted from dsh-superagent (MIT)
/** Concurrency, retry, and validation tests for settings saves, pause toggling, and policy synchronization. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Settings, SettingsConflict, type SettingsHost } from '../src/app/settings.js'
import { Store } from '../src/app/store.js'
import { UserError } from '../src/core/index.js'
import { HealthBoard } from '../src/infra/health.js'
import { feishuKind } from '../src/sources/feishu.js'
import { githubKind } from '../src/sources/github.js'
import type { SourceKind } from '../src/sources/kind.js'
import { SourceRegistry } from '../src/sources/registry.js'
import { deferred } from './fixtures/async.js'

const model = { provider: 'worker-provider', model: 'worker-model' }
const ALICE = { id: 'u_alice', name: 'Alice' }

let directory: string
let store: Store
let board: HealthBoard
let sync: ReturnType<typeof vi.fn<() => Promise<{ allowed: { id: string; name?: string }[] }>>>
let configured: boolean
let host: {
  resolveModel: ReturnType<typeof vi.fn<SettingsHost['resolveModel']>>
  setup: { [K in keyof SettingsHost['setup']]: ReturnType<typeof vi.fn<SettingsHost['setup'][K]>> }
  notify: ReturnType<typeof vi.fn<SettingsHost['sessions']['notify']>>
}
let settings: Settings

/**
 * A Source with its own people list that it can refresh from an outside roster, as a chat Source does. The Feishu Source
 * syncs its list from a chat; the settings logic does not depend on which Source it is.
 */
const roster: SourceKind<Record<string, never>> = {
  kind: 'roster',
  title: { zh: '名册', en: 'Roster' },
  description: { zh: '', en: '' },
  health: [],
  schema: z.object({}).strict(),
  fields: [],
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string(), name: z.string().optional() }).strict()).default([]),
    }),
    fields: [],
    explicit: { zh: '', en: '' },
    sync: {
      label: { zh: '同步', en: 'Sync' },
      ready: () => true,
      run: async () => ({ ...(await sync()) }),
    },
  },
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'settings-'))
  store = new Store(join(directory, 'db.sqlite'))
  board = new HealthBoard()
  configured = true
  sync = vi.fn(async () => ({ allowed: [ALICE] }))
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(githubKind)
  sources.register(roster)
  sources.register(feishuKind)
  host = {
    resolveModel: vi.fn(async () => ({})),
    setup: {
      configured: vi.fn(() => configured),
      checkAccounts: vi.fn(async () => {}),
      blockCommands: vi.fn(async () => {}),
      restart: vi.fn(),
    },
    notify: vi.fn(),
  }
  settings = new Settings({
    store,
    sources,
    engine: { policyChanged: vi.fn() },
    health: board,
    resolveModel: host.resolveModel,
    lifetime: new AbortController().signal,
    sessions: { notify: host.notify, delivery: async () => 'injected' },
    sourceHost: { sources, context: () => ({}) as never },
    setup: host.setup,
    requestPass: vi.fn(),
  })
})
afterEach(() => {
  vi.useRealTimers()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

it('refuses a save of a block that another save changed during its model or account check, and saves nothing of it', async () => {
  const check = deferred<unknown>()
  host.resolveModel.mockImplementationOnce(() => check.promise)
  const executor = store.settings().executor
  const revision = store.blockRevision('executor')
  const slow = settings.save('executor', { ...executor, model, maxWorkers: 5 }, revision, 'panel')
  await settings.save('executor', { ...executor, maxWorkers: 2 }, revision, 'panel')
  check.resolve(model)
  await expect(slow).rejects.toThrow(SettingsConflict)
  expect(store.settings().executor).toMatchObject({ maxWorkers: 2, model: executor.model })
  // An account check that a save of the same Source outruns is refused the same way.
  const accounts = deferred<void>()
  host.setup.checkAccounts.mockImplementationOnce(() => accounts.promise)
  const github = settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const moved = settings.save(
    'source:github',
    { ...value, config: { ...value.config, cli: '/opt/bin/gh-other' } },
    github.revision,
    'panel',
  )
  await settings.save(
    'source:github',
    { ...value, config: { ...value.config, pollSeconds: 90 } },
    github.revision,
    'panel',
  )
  accounts.resolve()
  await expect(moved).rejects.toThrow(SettingsConflict)
  expect(store.settings().sources.github?.config).toMatchObject({ cli: value.config.cli, pollSeconds: 90 })
})

it('refuses a Policy sync that a Policy save outran, reports it on sync:<id>, and keeps the save', async () => {
  const policy = store.settings().policy
  await settings.save(
    'policy',
    { ...policy, sources: { ...policy.sources, roster: { allowed: [ALICE] } } },
    store.blockRevision('policy'),
    'panel',
  )
  const members = deferred<{ allowed: { id: string; name?: string }[] }>()
  sync.mockImplementationOnce(() => members.promise)
  const syncing = settings.sync('roster')
  const current = store.settings().policy
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs' }]
  await settings.save('policy', { ...current, rules }, store.blockRevision('policy'), 'panel')
  members.resolve({ allowed: [ALICE, { id: 'u_new', name: 'New' }] })
  await expect(syncing).rejects.toThrow(SettingsConflict)
  expect(board.all['sync:roster']).toMatchObject({
    state: 'error',
    detail: expect.stringContaining('Policy changed during synchronization'),
  })
  expect(store.settings().policy).toMatchObject({ rules, sources: { roster: { allowed: [ALICE] } } })
})

it('syncs a Policy part again after a failed sync, a minute later and then after a wait that doubles, until it succeeds', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  sync.mockRejectedValueOnce(new Error('network down')).mockRejectedValueOnce(new Error('network down'))
  await expect(settings.sync('roster')).rejects.toThrow('network down')
  expect(board.all['sync:roster']).toMatchObject({
    state: 'error',
    detail: expect.stringContaining('network down'),
  })
  const before = sync.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  // The first retry fails too, so the next waits two minutes.
  expect(sync.mock.calls.length).toBe(before + 1)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(sync.mock.calls.length).toBe(before + 1)
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.waitFor(() => expect(board.all['sync:roster']).toMatchObject({ state: 'ready' }))
  expect(sync.mock.calls.length).toBe(before + 2)
  // A success ends the retries.
  await vi.advanceTimersByTimeAsync(3_600_000)
  expect(sync.mock.calls.length).toBe(before + 2)
})

it('records nothing for a pause that changes nothing, refuses a sync while setup waits, and names an unknown block', async () => {
  const revision = store.blockRevision('pause')
  expect(await settings.pause(false, 'panel')).toEqual({ paused: false })
  expect([store.blockRevision('pause'), host.notify.mock.calls.length]).toEqual([revision, 0])
  configured = false
  await expect(settings.sync('roster')).rejects.toThrow(new UserError('nothingToSync', { source: 'roster' }))
  configured = true
  expect(() => settings.block('source:x')).toThrow(new UserError('unknownBlock', { block: 'source:x' }))
})

it('tells the main session of a pause once, and of nothing that a tool saved itself', async () => {
  await settings.pause(true, 'panel')
  expect(host.notify).toHaveBeenCalledTimes(1)
  await settings.pause(false, 'tool')
  expect(host.notify).toHaveBeenCalledTimes(1)
  expect(store.settings().paused).toBe(false)
})

it('validates a bot CLI before saving, preserves old chat policy and restricts account changes to the panel', async () => {
  const saved = store.settings()
  store.saveSettings({
    ...saved,
    sources: {
      ...saved.sources,
      feishu: {
        enabled: true,
        config: {
          instance: 'old-channel',
          claim: 'groups',
          chats: [{ chatId: 'oc_team', listen: 'mentions' }],
          directMessages: false,
        },
      },
    },
  })
  const old = settings.block('source:feishu')
  expect(old.value).toMatchObject({
    config: { cli: '', chats: [{ chatId: 'oc_team', listen: 'mentions' }], directMessages: false },
  })
  const value = {
    enabled: true,
    config: { ...(old.value as { config: object }).config, cli: '/synthetic/bot' },
  }
  await expect(settings.save('source:feishu', value, old.revision, 'tool')).rejects.toThrow('only')
  host.setup.checkAccounts.mockRejectedValueOnce(new Error('invalid bot'))
  await expect(settings.save('source:feishu', value, old.revision, 'panel')).rejects.toThrow('invalid bot')
  expect(store.settings().sources.feishu?.config).not.toHaveProperty('cli')
  expect(await settings.save('source:feishu', value, old.revision, 'panel')).toMatchObject({
    restarting: true,
  })
  expect(store.settings().sources.feishu?.config).toMatchObject({
    cli: '/synthetic/bot',
    directMessages: false,
  })
  const same = settings.block('source:feishu')
  expect(await settings.save('source:feishu', same.value, same.revision, 'panel')).toMatchObject({
    revision: same.revision,
    restarting: true,
  })
})
