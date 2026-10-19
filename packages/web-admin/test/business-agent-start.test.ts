import type {
  AgentPlan,
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PackageOperation,
  PackagePreview,
} from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  businessAgentState,
  businessAgentView,
  isBusinessAgent,
  readBusinessAgents,
  samplePromptOf,
  suggestedBusinessAgents,
} from '../src/agents/catalog.js'
import { startGuarantees } from '../src/agents/start-dialog.js'
import {
  planBlocked,
  planBusinessAgentStart,
  runBusinessAgentStart,
  runBusinessPackageInstall,
  type StartApi,
  StartError,
  type StartProgress,
} from '../src/agents/start-flow.js'

const ID = '@agnes-fde/data-report'
const entry = (extra: Record<string, unknown> = {}, id = ID) =>
  ({
    id,
    version: '1.1.0',
    source: { type: 'file', ref: `file:./bundled-examples/showcase/${id.split('/').at(-1)}` },
    integrity: 'sha512-a',
    license: 'Apache-2.0',
    contributions: [],
    compatibility: 'supported',
    sourceId: 'official-examples',
    retrievedAt: '2026-10-14T00:00:00.000Z',
    provides: ['bundle', 'loop', 'tool'],
    agents: [
      {
        ref: `${id}#data-report`,
        launch: {
          title: { en: 'Data report example', 'zh-CN': '数据报告示例' },
          description: { en: 'Turns a sample CSV into a report.', 'zh-CN': '把样例 CSV 转成报告。' },
          preset: 'safe',
        },
      },
    ],
    metadata: {
      displayName: 'Data report example',
      summary: 'Turns a sample CSV into a report.',
      description: '',
      locales: { 'zh-CN': { displayName: '数据报告示例', summary: '把样例 CSV 转成报告。' } },
    },
    ...extra,
  }) as unknown as PackageCatalogDescriptor
const installed = (extra: Partial<PackageInstalledDescriptor> = {}) =>
  ({
    id: ID,
    version: '1.1.0',
    source: entry().source,
    integrity: 'sha512-a',
    trusted: false,
    desired: 'installed-disabled',
    actual: 'not-running',
    contributions: [],
    blockers: [],
    capabilityHash: 'cap-1',
    ...extra,
  }) as PackageInstalledDescriptor
const preview = (extra: Partial<PackagePreview> = {}) =>
  ({
    id: ID,
    version: '1.1.0',
    source: entry().source,
    integrity: 'sha512-a',
    capabilityHash: 'cap-1',
    blockers: [],
    ...extra,
  }) as PackagePreview

/** A daemon double: every effect completes at once and moves the package one state forward. */
function daemon(
  start: PackageInstalledDescriptor | undefined,
  fail: Partial<Record<string, PackageOperation['error']>> = {},
) {
  let state = start
  const calls: string[] = []
  const operations = new Map<string, PackageOperation>()
  const effect = (name: string, apply: () => void, extra: Partial<PackageOperation> = {}) => {
    calls.push(name)
    const error = fail[name]
    if (!error) apply()
    operations.set(name, {
      operationId: name,
      profile: 'default',
      operation: name as PackageOperation['operation'],
      state: error ? 'failed' : 'completed',
      progress: 1,
      startedAt: '',
      updatedAt: '',
      ...(error ? { error } : extra),
    })
    return Promise.resolve({ operationId: name, profile: 'default' })
  }
  const api = {
    resolveAgent: async (ref: string) => {
      if (
        state?.actual === 'failed' ||
        state?.actual === 'unavailable' ||
        state?.actual === 'restart-required'
      )
        throw new Error('launch unavailable')
      return (await api.prepareAgent(ref)).presentation
    },
    prepareAgent: async (ref: string) => ({
      launchTicket: 'ticket',
      presentation: {
        ref,
        launch: entry().agents![0]!.launch,
        loop: { id: 'fde.data-report', version: '5.0.0' },
        bundles: [ref],
        preset: 'safe',
        model: { route: 'demo', model: 'm' },
        models: {},
        pages: [],
        digest: 'digest',
        compositionHash: 'tree',
        presetHash: 'preset',
        effectivePresetHash: 'effective',
        permission: { readOnly: false, tools: [], allow: [], deny: [] },
        sources: [],
      } as AgentPlan,
    }),
    list: async () => ({ packages: state ? [state] : [] }),
    inspect: () => effect('inspect', () => {}, { preview: preview() }),
    install: () => effect('install', () => (state = installed())),
    trust: () => effect('trust', () => (state = { ...(state as PackageInstalledDescriptor), trusted: true })),
    enable: () =>
      effect(
        'enable',
        () => (state = { ...(state as PackageInstalledDescriptor), desired: 'enabled', actual: 'running' }),
      ),
    enableChecked: () =>
      effect(
        'enableChecked',
        () => (state = { ...(state as PackageInstalledDescriptor), desired: 'enabled', actual: 'running' }),
      ),
    operation: async (id: string) => operations.get(id) as PackageOperation,
    loops: async () => ({
      revision: 0,
      defaults: {},
      loops: [{ id: 'fde.data-report', version: '5.0.0', capabilities: [], sourcePackage: ID }],
    }),
    runtime: async () => ({
      bundles: [
        { id: `${ID}#data-report`, sourcePackage: ID },
        { id: 'other', sourcePackage: 'x' },
      ],
    }),
  } as unknown as StartApi
  return { api, calls, set: (next: PackageInstalledDescriptor | undefined) => (state = next) }
}
const options = { pollMs: 0, sleep: async () => {} }
const record = () => {
  const seen: StartProgress[] = []
  return { seen, push: (value: StartProgress) => seen.push(value), last: () => seen.at(-1) }
}

describe('business agent catalog', () => {
  it('recognises only declared launchable Bundles independently from a package name', () => {
    expect(isBusinessAgent(entry())).toBe(true)
    expect(isBusinessAgent(entry({ metadata: { ...entry().metadata, exampleOf: 'acme/host' } }))).toBe(true)
    expect(isBusinessAgent(entry({ agents: undefined }, '@agnes-fde/legacy'))).toBe(false)
    expect(isBusinessAgent(entry({}, '@acme/billing'))).toBe(true)
  })

  it('shows a sample line only when the package carries one, in the reader’s language', () => {
    expect(samplePromptOf(entry(), 'zh-CN')).toBeUndefined()
    const both = {
      ...entry().metadata,
      samplePrompt: { en: 'Summarise the CSV.', 'zh-CN': '汇总这份 CSV。' },
    }
    expect(samplePromptOf(entry({ metadata: both }), 'zh-CN')).toBe('汇总这份 CSV。')
    const english = { ...entry().metadata, samplePrompt: { en: 'Summarise the CSV.' } }
    expect(samplePromptOf(entry({ metadata: english }), 'zh-CN')).toBe('Summarise the CSV.')
    const withLaunch = entry({ metadata: both })
    withLaunch.agents![0]!.launch.prompt = { mode: 'draft', text: { en: 'Reviewed draft' } }
    expect(businessAgentView(withLaunch, 'en').samplePrompt).toBe('Reviewed draft')
  })

  it('names the card from localized package metadata with a stable tile', () => {
    const zh = businessAgentView(entry(), 'zh-CN')
    expect([zh.name, zh.summary, zh.slug, zh.glyph]).toEqual([
      '数据报告示例',
      '把样例 CSV 转成报告。',
      'data-report',
      '数',
    ])
    const en = businessAgentView(entry(), 'en')
    expect([en.name, en.glyph]).toEqual(['Data report example', 'DR'])
    expect(en.tint).toBe(zh.tint)
    expect(en.tint).toBeGreaterThanOrEqual(0)
    expect(en.tint).toBeLessThan(8)
  })

  it('uses backend readiness for declarative agents and requires trust for running fallback', () => {
    expect(businessAgentState(undefined)).toBe('available')
    expect(businessAgentState(installed())).toBe('installed')
    expect(businessAgentState(installed({ desired: 'enabled', actual: 'starting' }))).toBe('installed')
    expect(businessAgentState(installed({ trusted: true, desired: 'enabled', actual: 'running' }))).toBe(
      'ready',
    )
    expect(businessAgentState(installed({ desired: 'enabled', actual: 'failed' }))).toBe('attention')
    expect(businessAgentState(installed({ desired: 'enabled', actual: 'running' }))).toBe('installed')
    expect(
      businessAgentState(
        installed({
          trusted: true,
          desired: 'enabled',
          actual: 'not-running',
          primaryStatus: {
            state: 'ready',
            reason: { en: 'Declarative agent ready', 'zh-CN': '声明智能体已就绪' },
            reasonCode: 'ready',
            nextAction: 'none',
          },
        }),
      ),
    ).toBe('ready')
    expect(
      businessAgentState(
        installed({
          trusted: true,
          desired: 'enabled',
          actual: 'running',
          primaryStatus: {
            state: 'blocked',
            reason: { en: 'Missing dependency', 'zh-CN': '缺少依赖' },
            reasonCode: 'dependency-missing',
            nextAction: 'install-dependency',
          },
        }),
      ),
    ).toBe('attention')
    expect(businessAgentState(installed(), true)).toBe('starting')
  })

  it('reads every catalog page once and suggests ready agents first', async () => {
    const pages = [
      {
        items: [entry({}, '@agnes-fde/a'), entry({ agents: undefined }, '@agnes-example/x')],
        nextCursor: 'next',
      },
      { items: [entry({}, '@agnes-fde/b'), entry({}, '@agnes-fde/a')], nextCursor: null },
    ]
    const cursors: (string | undefined)[] = []
    const rows = await readBusinessAgents({
      catalog: async (_query, cursor) => {
        cursors.push(cursor)
        return pages[cursors.length - 1] as never
      },
    })
    expect(rows.map((row) => row.id)).toEqual(['@agnes-fde/a', '@agnes-fde/b'])
    expect(cursors).toEqual([undefined, 'next'])
    const agents = rows.map((row) => ({ entry: row }))
    const ready = installed({ id: '@agnes-fde/b', trusted: true, desired: 'enabled', actual: 'running' })
    expect(suggestedBusinessAgents(agents, [ready], 1).map((agent) => agent.entry.id)).toEqual([
      '@agnes-fde/b',
    ])
  })
})

describe('one-click start', () => {
  it('inspects a package that is not installed and changes nothing while planning', async () => {
    const d = daemon(undefined)
    const plan = await planBusinessAgentStart(d.api, entry(), options)
    expect(d.calls).toEqual(['inspect'])
    expect(plan.preview?.integrity).toBe('sha512-a')
    expect(plan.needed).toEqual({ install: true, trust: true, enable: true, session: true })
    expect(planBlocked(plan)).toBe(false)
  })

  it('runs install, trust, enable and then names the loop and session bundles of the package', async () => {
    const d = daemon(undefined)
    const plan = await planBusinessAgentStart(d.api, entry(), options)
    const progress = record()
    const target = await runBusinessAgentStart(d.api, plan, progress.push, options)
    expect(d.calls).toEqual(['inspect', 'install', 'trust', 'enable'])
    expect(target).toMatchObject({
      preset: 'safe',
      launchTicket: 'ticket',
      loop: { id: 'fde.data-report', version: '5.0.0' },
      bundles: [`${ID}#data-report`],
    })
    expect(progress.last()).toEqual({ install: 'done', trust: 'done', enable: 'done', session: 'done' })
    // Steps report in order: nothing later starts before the earlier one is done.
    expect(progress.seen.find((value) => value.trust === 'running')?.install).toBe('done')
  })

  it('refuses an unavailable or ambiguous agent rather than starting a plain loop', async () => {
    const d = daemon(installed({ trusted: true, desired: 'enabled', actual: 'running' }))
    const api = {
      ...d.api,
      prepareAgent: async () => {
        throw new Error('unknown agent')
      },
    }
    const plan = await planBusinessAgentStart(api, entry(), options)
    await expect(runBusinessAgentStart(api, plan, () => {}, options)).rejects.toMatchObject({
      failure: { step: 'session' },
    })
    const ambiguous = {
      ...plan,
      entry: { ...plan.entry, agents: [...plan.entry.agents!, ...plan.entry.agents!] },
    }
    await expect(runBusinessAgentStart(d.api, ambiguous, () => {}, options)).rejects.toMatchObject({
      failure: { code: 'blocked' },
    })
  })

  it('skips the steps a package already satisfies', async () => {
    const d = daemon(installed({ trusted: true }))
    const plan = await planBusinessAgentStart(d.api, entry(), options)
    expect(d.calls).toEqual([])
    const progress = record()
    await runBusinessAgentStart(d.api, plan, progress.push, options)
    expect(d.calls).toEqual(['enable'])
    expect(progress.last()).toEqual({ install: 'skipped', trust: 'skipped', enable: 'done', session: 'done' })

    const ready = daemon(installed({ trusted: true, desired: 'enabled', actual: 'running' }))
    const readyProgress = record()
    await runBusinessAgentStart(
      ready.api,
      await planBusinessAgentStart(ready.api, entry(), options),
      readyProgress.push,
      options,
    )
    expect(ready.calls).toEqual([])
    expect(readyProgress.last()).toEqual({
      install: 'skipped',
      trust: 'skipped',
      enable: 'skipped',
      session: 'done',
    })
  })

  it('stops at the failing step with the daemon’s reason and keeps what was done', async () => {
    const d = daemon(undefined, {
      enable: {
        code: 'E_PACKAGE_BLOCKED',
        safeMessage: 'Not compatible with the current format.',
        blockers: [{ code: 'incompatible', references: [] }],
        fixHint: 'Reinstall it.',
      },
    })
    const plan = await planBusinessAgentStart(d.api, entry(), options)
    const progress = record()
    const error = await runBusinessAgentStart(d.api, plan, progress.push, options).catch((value) => value)
    expect(error).toBeInstanceOf(StartError)
    expect((error as StartError).failure).toEqual({
      step: 'enable',
      code: 'blocked',
      detail: 'Not compatible with the current format.',
      hint: 'Reinstall it.',
    })
    expect(progress.last()).toEqual({ install: 'done', trust: 'done', enable: 'failed', session: 'pending' })

    // A retry plans again and resumes from the step that stopped.
    const retry = daemon(installed({ trusted: true }))
    const again = record()
    await runBusinessAgentStart(
      retry.api,
      await planBusinessAgentStart(retry.api, entry(), options),
      again.push,
      options,
    )
    expect(retry.calls).toEqual(['enable'])
  })

  it('refuses to trust a version or capability scope other than the one reviewed', async () => {
    const d = daemon(installed())
    const plan = await planBusinessAgentStart(d.api, entry(), options)
    d.set(installed({ integrity: 'sha512-b' }))
    const error = await runBusinessAgentStart(d.api, plan, () => {}, options).catch((value) => value)
    expect((error as StartError).failure).toMatchObject({ step: 'trust', code: 'changed' })
    expect(d.calls).toEqual([])
    // Another administrator can replace the installed version while the trust operation settles.
    for (const changed of [{ integrity: 'sha512-b' }, { capabilityHash: 'cap-2' }, { version: '2.0.0' }]) {
      const concurrent = daemon(installed())
      const reviewed = await planBusinessAgentStart(concurrent.api, entry(), options)
      const api = {
        ...concurrent.api,
        trust: async (...args: Parameters<StartApi['trust']>) => {
          const result = await concurrent.api.trust(...args)
          concurrent.set(installed({ trusted: true, ...changed }))
          return result
        },
      }
      await expect(runBusinessAgentStart(api, reviewed, () => {}, options)).rejects.toMatchObject({
        failure: { step: 'trust', code: 'changed' },
      })
      expect(concurrent.calls).toEqual(['trust'])
    }
  })

  it('does not continue an effect chain after a pending inventory read is cancelled', async () => {
    const d = daemon(installed())
    const plan = await planBusinessAgentStart(d.api, entry(), options)
    const abort = new AbortController()
    const api = {
      ...d.api,
      list: async () => {
        abort.abort(new Error('page left'))
        return d.api.list()
      },
    }
    await expect(
      runBusinessAgentStart(api, plan, () => {}, { ...options, signal: abort.signal }),
    ).rejects.toThrow('page left')
    expect(d.calls).toEqual([])
  })

  it('does not install over a blocker, and says when an enabled plugin does not start', async () => {
    const blocked = daemon(undefined)
    const plan = await planBusinessAgentStart(blocked.api, entry(), options)
    const withBlocker = { ...plan, preview: preview({ blockers: [{ code: 'policy', references: [] }] }) }
    expect(planBlocked(withBlocker)).toBe(true)
    const refused = await runBusinessAgentStart(blocked.api, withBlocker, () => {}, options).catch(
      (value) => value,
    )
    expect((refused as StartError).failure).toMatchObject({ step: 'install', code: 'blocked' })
    expect(blocked.calls).toEqual(['inspect'])

    const stuck = daemon(
      installed({ trusted: true, desired: 'enabled', actual: 'failed', failureHint: 'Port in use.' }),
    )
    const failure = await runBusinessAgentStart(
      stuck.api,
      await planBusinessAgentStart(stuck.api, entry(), options),
      () => {},
      options,
    ).catch((value) => value)
    expect((failure as StartError).failure).toEqual({
      step: 'enable',
      code: 'not-running',
      detail: 'Port in use.',
    })
  })
})

describe('start confirmation guarantees', () => {
  const key = (name: string) => name
  const preset = (extra: Record<string, string> = {}) => ({
    bundle: '@agnes-fde/x#x',
    id: 'x',
    toolPolicy: 'fde.x',
    readOnly: 'unknown' as const,
    confirmBeforeActions: 'unknown' as const,
    network: 'none' as const,
    ...extra,
  })
  const titles = (presets: Parameters<typeof startGuarantees>[0]) =>
    startGuarantees(presets, key).map((row) => row.title)

  it('states only what the daemon derived outright', () => {
    expect(titles([preset()])).toEqual(['promise.offline'])
    expect(
      titles([preset({ readOnly: 'yes', confirmBeforeActions: 'yes', network: 'allowed' })] as never),
    ).toEqual(['promise.readOnly', 'promise.confirm'])
    expect(titles([preset({ readOnly: 'no', network: 'unknown' })] as never)).toEqual([])
  })

  it('promises nothing without presets, or when one bundle of the package differs', () => {
    expect(titles(undefined)).toEqual([])
    expect(titles([])).toEqual([])
    expect(titles([preset({ readOnly: 'yes' }), preset({ network: 'allowed' })] as never)).toEqual([])
  })
})

it('admits an application package without preparing or starting an agent', async () => {
  const { api, calls } = daemon(undefined)
  api.prepareAgent = async () => {
    throw new Error('Application adoption must not prepare a session')
  }
  const plan = await planBusinessAgentStart(api, entry(), options)
  await runBusinessPackageInstall(api, plan, () => {}, options)
  expect(calls).toEqual(['inspect', 'install', 'trust', 'enable'])
})
