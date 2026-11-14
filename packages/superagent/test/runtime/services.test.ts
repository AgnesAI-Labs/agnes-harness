// Adapted from dsh-superagent (MIT)
/**
 * The settings and panel services, one test row per route they replace: every name exists with the frozen kind and
 * input fields, the manifest declares exactly what the code answers, results keep the original route's shape, and every
 * failure keeps the status and body the HTTP route answered with.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonValue } from '@agnes/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { PromptConflict } from '../../src/app/prompts.js'
import { Settings, SettingsConflict } from '../../src/app/settings.js'
import { Store } from '../../src/app/store.js'
import { UserError } from '../../src/core/index.js'
import { HealthBoard } from '../../src/infra/health.js'
import { SettingsSchema } from '../../src/policy.js'
import { createPanelWiring } from '../../src/runtime/panel-host.js'
import type { PanelHost } from '../../src/runtime/panel-views.js'
import {
  createPanelServices,
  PANEL_SERVICES,
  type PanelService,
  registerPanelServices,
} from '../../src/runtime/services.js'
import { SetupError } from '../../src/setup.js'
import { githubKind } from '../../src/sources/github.js'
import { SourceRegistry } from '../../src/sources/registry.js'
import { testDeployment, testMachine } from '../fixtures/deployment.js'

/** The frozen table: service, kind and input fields. */
const TABLE: readonly [string, 'query' | 'effect', readonly string[]][] = [
  ['superagent.state', 'query', []],
  ['superagent.overview', 'query', []],
  ['superagent.search', 'query', ['q']],
  ['superagent.sources.list', 'query', []],
  ['superagent.sources.refreshlabels', 'effect', ['id']],
  ['superagent.settings.get', 'query', []],
  ['superagent.settings.save', 'effect', ['block', 'value', 'revision']],
  ['superagent.threads.list', 'query', ['filter', 'offset', 'limit']],
  ['superagent.threads.get', 'query', ['key', 'limit', 'before', 'around']],
  ['superagent.threads.unsubscribe', 'effect', ['key']],
  ['superagent.triggers.requeue', 'effect', ['id']],
  ['superagent.decisions.list', 'query', ['kind', 'window', 'offset', 'limit']],
  ['superagent.decisions.dismiss', 'effect', ['id']],
  ['superagent.tickets.list', 'query', ['state', 'offset', 'limit']],
  ['superagent.tickets.get', 'query', ['id']],
  ['superagent.tickets.retry', 'effect', ['id']],
  ['superagent.tickets.stop', 'effect', ['id']],
  ['superagent.executor.pause', 'effect', ['paused']],
  ['superagent.policy.history', 'query', []],
  ['superagent.policy.sync', 'effect', ['id']],
  ['superagent.setup.check', 'effect', []],
  ['superagent.models.list', 'query', []],
  ['superagent.prompts.get', 'query', ['revision', 'offset']],
  ['superagent.prompts.save', 'effect', ['config', 'baseRevision']],
  ['superagent.prompts.preview', 'effect', ['config']],
]
const signal = new AbortController().signal
const run = (services: PanelService, name: string, input: Record<string, unknown> = {}) =>
  services.call(name, input as JsonValue, signal)
const failureOf = async (result: Promise<JsonValue>) => (await result) as { failure: Record<string, unknown> }

describe('the service table', () => {
  it('has every route of the original API once, with its kind and input fields', () => {
    expect(
      PANEL_SERVICES.map((service) => [
        service.name,
        service.kind,
        Object.keys((service.inputSchema as { properties: object }).properties),
      ]),
    ).toEqual(TABLE.map(([name, kind, fields]) => [name, kind, fields]))
    // Rejects a bad input: every input schema is closed.
    for (const service of PANEL_SERVICES)
      expect(
        (service.inputSchema as { additionalProperties: unknown }).additionalProperties,
        service.name,
      ).toBe(false)
  })

  it('is what the manifest declares, so the Host accepts the registration', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      agnes: { plugins: { capabilities: { services: { name: string }[] } }[] }
    }
    const declared = manifest.agnes.plugins[0]?.capabilities.services.filter((service) =>
      TABLE.some(([name]) => name === service.name),
    )
    expect(PANEL_SERVICES.map(({ handler: _handler, ...capability }) => capability)).toEqual(declared)
  })

  it('registers each service on the plugin, answered by the running service and refused without one', async () => {
    const registered: {
      name: string
      handler: (input: JsonValue, context: unknown) => Promise<JsonValue>
    }[] = []
    const plugin = {
      services: {
        register(definition: (typeof registered)[number]) {
          registered.push(definition)
          return () => {}
        },
      },
    }
    const call = vi.fn(async (name: string) => ({ name }))
    const dispose = registerPanelServices(plugin as never, async () => ({ callService: call }) as never)
    expect(registered.map((definition) => definition.name)).toEqual(TABLE.map(([name]) => name))
    await expect(registered[3]?.handler({}, { signal })).resolves.toEqual({ name: 'superagent.sources.list' })
    expect(typeof dispose).toBe('function')
    const refused = registerPanelServices(plugin as never, () => Promise.reject(new Error('not ready')))
    await expect(registered.at(-1)?.handler({}, { signal })).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
    })
    refused()
  })
})

describe('answers from the host', () => {
  it('answers each kind of failure with the status and body the route had', async () => {
    const saves: unknown[] = []
    const host = {
      store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
      sources: { instances: () => [{ id: 'github' }] },
      links: () => () => ({ url: '', label: { zh: '', en: '' } }),
      settings: {
        save: async (...args: unknown[]) => {
          saves.push(args)
          if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
          if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
          if (args[1] === 'refused') throw new SetupError('agentCliUnset')
          if (args[1] === 'broken') throw new Error('disk full')
          return { saved: true, revision: 1, restarting: false }
        },
      },
    } as unknown as PanelHost
    const services = createPanelServices(host)
    const save = (block: string, value: unknown) =>
      failureOf(run(services, 'superagent.settings.save', { block, value, revision: 0 }))
    expect(await save('executor', 'stale')).toEqual({
      failure: { status: 409, error: 'Settings changed. Reload before saving.' },
    })
    expect(await save('executor', 'invalid')).toMatchObject({
      failure: { status: 400, issues: [{ path: 'maxWorkers' }] },
    })
    expect(await save('source:github', 'refused')).toMatchObject({
      failure: { status: 400, setup: { code: 'agentCliUnset', place: 'github' } },
    })
    expect(await save('executor', 'broken')).toEqual({ failure: { status: 500, error: 'disk full' } })
    // Block names are checked before saving: an unknown block, or a Source that does not exist, never reaches it.
    expect(await save('pause', {})).toMatchObject({ failure: { status: 400 } })
    expect(await save('source:feishu', {})).toEqual({ failure: { status: 404, error: 'Source not found' } })
    expect(saves).toHaveLength(4)
    expect(await failureOf(run(services, 'superagent.tickets.retry', { id: 't9' }))).toEqual({
      failure: { status: 404, error: 'Ticket not found' },
    })
    expect(await failureOf(run(services, 'superagent.tickets.get', { id: 't9' }))).toEqual({
      failure: { status: 404, error: 'Ticket not found' },
    })
    expect(await failureOf(run(services, 'superagent.nothing.here'))).toEqual({
      failure: { status: 404, error: 'Unknown operation' },
    })
  })

  it('answers a user error with its code and values, and a lost race with 409', async () => {
    const host = {
      machine: testMachine(),
      store: {
        tickets: { get: () => ({ id: 't1' }) },
        atomic: (work: () => unknown) => work(),
        blockRevision: () => 0,
      },
      prompts: {
        save: () => {
          throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving')
        },
      },
      sessions: { notify: () => {}, delivery: async () => 'injected' },
      engine: {
        stopTicket: () => {
          throw new UserError('unknownPromptRevision', { revision: '7' })
        },
        retryTicket: () => {
          throw new UserError('ticketEnded')
        },
      },
    } as unknown as PanelHost
    const services = createPanelServices(host)
    expect(
      await failureOf(run(services, 'superagent.prompts.save', { config: {}, baseRevision: 2 })),
    ).toEqual({
      failure: {
        status: 409,
        error: 'Prompt version changed to 3; compare the latest version before saving',
      },
    })
    expect(await failureOf(run(services, 'superagent.tickets.stop', { id: 't1' }))).toEqual({
      failure: {
        status: 404,
        error: 'Unknown prompt revision 7',
        code: 'unknownPromptRevision',
        values: { revision: '7' },
      },
    })
    expect(await failureOf(run(services, 'superagent.tickets.retry', { id: 't1' }))).toMatchObject({
      failure: { status: 400, code: 'ticketEnded' },
    })
  })

  it('refuses a settings value or a prompt over its size limit before anything is saved', async () => {
    const saves: unknown[] = []
    const host = {
      machine: testMachine(),
      store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
      prompts: { save: () => saves.push('prompt') },
      sessions: { notify: () => {}, delivery: async () => 'injected' },
      settings: {
        save: async (...args: unknown[]) => {
          saves.push(args)
          return { saved: true, revision: 1, restarting: false }
        },
      },
    } as unknown as PanelHost
    const services = createPanelServices(host)
    const value = { prepare: 'x'.repeat(128 * 1024) }
    expect(
      await failureOf(run(services, 'superagent.settings.save', { block: 'executor', value, revision: 0 })),
    ).toEqual({ failure: { status: 400, error: `Request exceeds ${128 * 1024} bytes` } })
    const config = { text: 'x'.repeat(4 * 100_000 + 4096) }
    expect(
      await failureOf(run(services, 'superagent.prompts.save', { config, baseRevision: 0 })),
    ).toMatchObject({
      failure: { status: 400 },
    })
    expect(await failureOf(run(services, 'superagent.prompts.preview', { config }))).toMatchObject({
      failure: { status: 400 },
    })
    expect(saves).toEqual([])
  })

  it('passes each input through and clamps limits as the routes did', async () => {
    const seen: unknown[] = []
    const host = {
      store: {
        settings: () => SettingsSchema.parse({}),
        read: {
          decisions: (filter: unknown, offset: number, limit: number) => {
            seen.push({ filter, offset, limit })
            return { items: [], more: false }
          },
        },
      },
      links: () => () => ({ url: '', label: { zh: '', en: '' } }),
      engine: {
        unsubscribe: (key: string) => {
          seen.push(key)
          return true
        },
        dismiss: (id: string) => seen.push(`dismiss ${id}`),
        reevaluate: (id: string) => {
          seen.push(`requeue ${id}`)
          return true
        },
      },
      sessions: { delivery: async () => 'injected' },
      requestPass: () => seen.push('pass'),
    } as unknown as PanelHost
    const services = createPanelServices(host)
    // The key arrives as the plain string: nothing decodes a path any more.
    expect(
      await run(services, 'superagent.threads.unsubscribe', { key: 'feishu:oc_1:om/root' }),
    ).toMatchObject({
      removed: true,
      thread: 'feishu:oc_1:om/root',
      context_delivery: 'injected',
    })
    expect(
      await run(services, 'superagent.decisions.list', { kind: 'accept,reopen', limit: 500, window: '24h' }),
    ).toEqual({ items: [], next_offset: null })
    expect(await run(services, 'superagent.decisions.dismiss', { id: 'd1' })).toEqual({ dismissed: true })
    expect(await run(services, 'superagent.triggers.requeue', { id: 'tr1' })).toEqual({ queued: true })
    expect(seen).toEqual([
      'feishu:oc_1:om/root',
      { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 },
      'dismiss d1',
      'requeue tr1',
      'pass',
    ])
  })

  it('runs the Executor pause, the setup check and the label refresh as effects of the panel', async () => {
    const calls: unknown[] = []
    const host = {
      settings: {
        pause: async (...args: unknown[]) => {
          calls.push(['pause', ...args])
          return { paused: true }
        },
        refreshLabels: async (id: string) => ({ added: [id] }),
        sync: async (id: string) => ({ allowed: [id] }),
      },
      checkSetup: () => calls.push('check'),
    } as unknown as PanelHost
    const services = createPanelServices(host)
    expect(await run(services, 'superagent.executor.pause', { paused: true })).toEqual({ paused: true })
    expect(await run(services, 'superagent.setup.check')).toEqual({ restarting: true })
    expect(await run(services, 'superagent.sources.refreshlabels', { id: 'github' })).toEqual({
      added: ['github'],
    })
    expect(await run(services, 'superagent.policy.sync', { id: 'github' })).toEqual({
      policy: { allowed: ['github'] },
    })
    expect(calls).toEqual([['pause', true, 'panel'], 'check'])
  })

  it('answers the model list from the host', async () => {
    const catalog = { groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }] }
    const services = createPanelServices({ models: async () => catalog } as unknown as PanelHost)
    expect(await run(services, 'superagent.models.list')).toEqual(catalog)
  })
})

describe('settings saved through the panel', () => {
  let directory: string
  let store: Store
  let services: PanelService
  let settings: Settings
  const executor = () => SettingsSchema.parse({}).executor

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'panel-services-'))
    store = new Store(join(directory, 'db.sqlite'))
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board)
    sources.register(githubKind)
    const notices: unknown[] = []
    settings = new Settings({
      store,
      sources,
      engine: { policyChanged: vi.fn() },
      health: board,
      resolveModel: vi.fn(async () => ({})),
      lifetime: new AbortController().signal,
      sessions: { notify: (...notice: unknown[]) => notices.push(notice), delivery: async () => 'injected' },
      sourceHost: { sources, context: () => ({}) as never },
      setup: {
        configured: () => true,
        checkAccounts: async () => {},
        blockCommands: async () => {},
        restart: () => {},
      },
      requestPass: () => {},
    })
    services = createPanelServices({
      store,
      sources,
      settings,
      machine: testMachine(),
      deployment: testDeployment(),
      configured: () => true,
      health: {},
      links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    } as unknown as PanelHost)
  })
  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('keeps a version for the save, shown by the policy history and the settings view', async () => {
    const before = (await run(services, 'superagent.settings.get')) as {
      blocks: { executor: { revision: number; value: ReturnType<typeof executor> } }
    }
    const saved = await run(services, 'superagent.settings.save', {
      block: 'executor',
      value: { ...before.blocks.executor.value, prepare: 'git clone {repository} repo' },
      revision: before.blocks.executor.revision,
    })
    expect(saved).toMatchObject({ revision: before.blocks.executor.revision + 1 })
    const history = (await run(services, 'superagent.policy.history')) as {
      items: { block: string; source: string; revision: number }[]
    }
    expect(history.items[0]).toMatchObject({ block: 'executor', source: 'panel' })
    const after = (await run(services, 'superagent.settings.get')) as typeof before
    expect(after.blocks.executor.value.prepare).toBe('git clone {repository} repo')
  })

  it('takes the account and execution environment fields from the panel only', async () => {
    const current = (await run(services, 'superagent.settings.get')) as {
      blocks: { executor: { revision: number; value: ReturnType<typeof executor> } }
    }
    const request = {
      block: 'executor',
      value: { ...current.blocks.executor.value, prepare: 'rm -rf /' },
      revision: current.blocks.executor.revision,
    }
    // The same save under any other origin is refused; the service always saves as the panel.
    await expect(settings.save('executor', request.value, request.revision, 'tool')).rejects.toMatchObject({
      code: 'panelOnlyEnvironment',
    })
    expect(await run(services, 'superagent.settings.save', request)).toMatchObject({
      revision: expect.any(Number),
    })
  })
})

describe('the host while the other parts start', () => {
  let directory: string
  let store: Store
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'panel-wiring-'))
    store = new Store(join(directory, 'db.sqlite'))
  })
  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('answers from the store at once, and answers "not ready" for what needs a part that is not wired, until it is', async () => {
    const wiring = createPanelWiring(store, directory)
    const services = createPanelServices(wiring.host)
    expect(await run(services, 'superagent.overview')).toMatchObject({ person: [], executor: { running: 0 } })
    expect(await run(services, 'superagent.policy.history')).toMatchObject({ items: [] })
    store.tickets.save({
      id: 't1',
      title: 'T',
      decisionId: 'd',
      channels: [],
      undelivered: [],
      createdAt: '',
      updatedAt: '',
      mandate: {
        strength: 'explicit',
        policyVersion: 'v',
        basis: { via: 'listed' },
        actor: { source: 'github', id: 'a' },
        scope: '',
      },
      origin: { triggerId: 'e', triggerIds: ['e'] },
      assignments: [{ id: 'a1', state: 'running', createdAt: '', startedAt: '2026-01-01T00:00:00Z' }],
      inputs: [],
    })
    const stop = vi.fn()
    expect(await failureOf(run(services, 'superagent.tickets.stop', { id: 't1' }))).toMatchObject({
      failure: { status: 503, error: expect.stringContaining('engine') },
    })
    wiring.wire({ engine: { stopTicket: stop } as never })
    expect(await run(services, 'superagent.tickets.stop', { id: 't1' })).toEqual({ stopped: true })
    expect(stop).toHaveBeenCalledWith('t1')
    // The worker's key is no use to the panel: its session page needs the id the platform gave it, when there is one.
    const ref = async () =>
      ((await run(services, 'superagent.tickets.get', { id: 't1' })) as { assignments: { ref?: string }[] })
        .assignments[0]?.ref
    expect(await ref()).toBeUndefined()
    wiring.wire({ workerSessionId: () => '01HSESSION' })
    expect(await ref()).toBe('01HSESSION')
    wiring.unwire()
    expect(await failureOf(run(services, 'superagent.tickets.stop', { id: 't1' }))).toMatchObject({
      failure: { status: 503 },
    })
  })
})
