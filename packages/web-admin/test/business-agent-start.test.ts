import type {
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
import {
  planBlocked,
  planBusinessAgentStart,
  runBusinessAgentStart,
  type StartApi,
  StartError,
  type StartProgress,
} from '../src/agents/start-flow.js'

const ID = '@agnes-fde/data-report'
const entry = (extra: Record<string, unknown> = {}, id = ID) =>
  ({
    id,
    version: '1.1.0',
    source: { type: 'file', ref: `file:./bundled-examples/${id}` },
    integrity: 'sha512-a',
    license: 'Apache-2.0',
    contributions: [],
    compatibility: 'supported',
    sourceId: 'official-examples',
    retrievedAt: '2026-10-14T00:00:00.000Z',
    kinds: ['bundle', 'loop', 'tool'],
    metadata: {
      displayName: 'Data report example',
      summary: 'Turns a sample CSV into a report.',
      description: '',
      category: 'tools',
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
  it('recognises a business agent by its package marker, and by the FDE scope until daemons send one', () => {
    expect(isBusinessAgent(entry())).toBe(true)
    expect(isBusinessAgent(entry({}, '@agnes-example/react-loop'))).toBe(false)
    expect(isBusinessAgent(entry({ category: 'business-agent' }, '@acme/billing'))).toBe(true)
    expect(isBusinessAgent(entry({ agnes: { category: 'business-agent' } }, '@acme/billing'))).toBe(true)
    // An explicit other category wins over the scope fallback.
    expect(isBusinessAgent(entry({ category: 'developer' }))).toBe(false)
  })

  it('shows a sample line only when the package carries one, in the reader’s language', () => {
    expect(samplePromptOf(entry(), 'zh-CN')).toBeUndefined()
    const row = entry({ samplePrompt: { en: 'Summarise the CSV.', 'zh-CN': '汇总这份 CSV。' } })
    expect(samplePromptOf(row, 'zh-CN')).toBe('汇总这份 CSV。')
    expect(samplePromptOf(entry({ samplePrompt: { en: 'Summarise the CSV.' } }), 'zh-CN')).toBe(
      'Summarise the CSV.',
    )
    expect(samplePromptOf(entry({ agnes: { samplePrompt: { en: ' ' } } }), 'en')).toBeUndefined()
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

  it('calls an agent ready only when its plugin is enabled and running', () => {
    expect(businessAgentState(undefined)).toBe('available')
    expect(businessAgentState(installed())).toBe('installed')
    expect(businessAgentState(installed({ desired: 'enabled', actual: 'starting' }))).toBe('installed')
    expect(businessAgentState(installed({ desired: 'enabled', actual: 'running' }))).toBe('ready')
    expect(businessAgentState(installed({ desired: 'enabled', actual: 'failed' }))).toBe('attention')
    expect(businessAgentState(installed(), true)).toBe('starting')
  })

  it('reads every catalog page once and suggests ready agents first', async () => {
    const pages = [
      { items: [entry({}, '@agnes-fde/a'), entry({}, '@agnes-example/x')], nextCursor: 'next' },
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
    const ready = installed({ id: '@agnes-fde/b', desired: 'enabled', actual: 'running' })
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
    expect(target).toEqual({
      loop: { id: 'fde.data-report', version: '5.0.0' },
      bundles: [`${ID}#data-report`],
    })
    expect(progress.last()).toEqual({ install: 'done', trust: 'done', enable: 'done', session: 'done' })
    // Steps report in order: nothing later starts before the earlier one is done.
    expect(progress.seen.find((value) => value.trust === 'running')?.install).toBe('done')
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
