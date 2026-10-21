// WC10 对账状态机测试：ready 挂载、幂等、名册移除级联卸载、失败隔离与重试、换版先卸后挂、epoch 失效丢弃、
// 慢包不占住全局临界区。

import { Context } from '@agnes/cordis'
import {
  AgnesClientService,
  type ClientContext,
  CommandService,
  homeEntries,
  homeNavigation,
  SessionService,
  SlotRegistry,
  ThemeService,
} from '@agnes/web-client'
import { Window } from 'happy-dom'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { readyRosterModules } from '../src/client-modules/reconcile/roster.js'
import { prepareDocumentStyles } from '../src/client-modules/reconcile/styles.js'
import {
  type ClientRoster,
  createReconciler,
  type ReadyClientModule,
} from '../src/client-modules/reconcile.js'
import { zhLocaleService } from './helpers/locale.js'

function roster(mods: ReadyClientModule[]): ClientRoster {
  return {
    revision: `r-${mods.map((m) => m.revision).join(',')}`,
    modules: mods,
    statuses: [],
  }
}

function mod(packageId: string, revision: string): ReadyClientModule {
  return {
    packageId,
    revision,
    entryUrl: `/${packageId}/${revision}/index.js`,
    styleUrls: [],
    slots: [],
    extIds: [],
  }
}

function styledMod(packageId: string, revision: string): ReadyClientModule {
  return { ...mod(packageId, revision), styleUrls: [`/${packageId}/${revision}/index.css`] }
}

async function harness() {
  const ctx = new Context()
  // 直接构造：不依赖 SlotRegistry（对账机只管 import/plugin 生命周期）
  const loaded: string[] = []
  const disposed: string[] = []
  const plugins: { dispose(): Promise<void>; id: string }[] = []
  const importer = (url: string) => {
    loaded.push(url)
    if (url.includes('broken')) return Promise.reject(new Error('eval failed'))
    return Promise.resolve({ inject: [], apply: () => {} })
  }
  return { ctx, loaded, disposed, plugins, importer }
}

// 把 ctx.plugin 换成记录型桩：真实挂载语义已由 web-client 测试覆盖，这里聚焦状态机。
function stubPlugin(ctx: Context, log: { loaded: string[]; disposed: string[] }) {
  const original = ctx.plugin.bind(ctx)
  const pluginStub = (modLike: unknown, config?: unknown) => {
    void modLike
    const id = (config as { packageId: string }).packageId
    log.loaded.push(`apply:${id}`)
    const fiber = {
      async dispose() {
        log.disposed.push(`dispose:${id}`)
      },
    }
    return Object.assign(Promise.resolve(fiber), fiber)
  }
  ;(ctx as unknown as { plugin: unknown }).plugin = pluginStub
  void original
}

describe('client reconciler（WC10 前端状态机）', () => {
  it.each(['en', 'zh-CN'] as const)(
    'publishes primary roster navigation before importing and revokes failed/disabled rows in %s',
    async (language) => {
      const h = await harness()
      stubPlugin(h.ctx, h)
      const row: ReadyClientModule = {
        ...mod('declared-page', 'v1'),
        rowId: 'web:declared-page',
        binding: {
          owner: 'web:declared-page',
          lifetime: 'profile',
          availability: 'active',
          packageId: 'declared-page',
          integrity: 'v1',
          profileId: 'test',
          activationId: 'current',
        },
        homeEntries: [
          {
            id: 'declared-page',
            placement: 'primary',
            navigation: {
              title: 'Device console',
              titles: { 'zh-CN': '设备控制台' },
              icon: 'cpu',
              order: 40,
            },
          },
        ],
      }
      let rows = [row]
      const locale = zhLocaleService()
      // LocaleService exposes the active UI language independently of module execution.
      locale.setLocale(language)
      const reconciler = createReconciler({
        ctx: h.ctx,
        source: { list: async () => roster(rows) },
        importer: h.importer,
        locale,
      })
      try {
        await reconciler.reconcileNow()
        expect(h.loaded).toEqual([])
        expect(
          readyRosterModules([
            { rowId: 'web:disabled', enabled: false, phase: 'ready', moduleName: 'page' },
            { rowId: 'web:failed', enabled: true, phase: 'blocked', moduleName: 'page' },
          ]),
        ).toEqual([])
        const entry = homeEntries.get('declared-page')!
        expect(entry).toMatchObject({ placement: 'primary', icon: 'cpu', order: 40 })
        expect(locale.t(entry.titleKey)).toBe(language === 'zh-CN' ? '设备控制台' : 'Device console')
        homeNavigation.open('declared-page')
        await reconciler.reconcileNow()
        expect(h.loaded).toContain(row.entryUrl)
        // A declaration alone cannot substitute for the module's actual component registration.
        expect(homeEntries.get('declared-page')).toBeUndefined()
        rows = []
        await reconciler.reconcileNow()
        expect(homeEntries.get('declared-page')).toBeUndefined()
        homeNavigation.close()
        rows = [row]
        await reconciler.reconcileNow()
        expect(homeEntries.get('declared-page')).toBeDefined()
        rows = [{ ...row, revision: 'broken', entryUrl: '/broken/index.js' }]
        await reconciler.reconcileNow()
        homeNavigation.open('declared-page')
        await reconciler.reconcileNow()
        expect(reconciler.snapshot().get('web:declared-page')?.phase).toBe('failed')
        expect(homeEntries.get('declared-page')).toBeUndefined()
        homeNavigation.close()
        await reconciler.invalidate()
        expect(homeEntries.get('declared-page')).toBeUndefined()
      } finally {
        homeNavigation.close()
        rows = []
        await reconciler.reconcileNow()
        await h.ctx.fiber.dispose()
      }
    },
  )
  it.each([true, false])(
    'keeps primary navigation (metadata: %s) through a generation gap and an overlapping replacement',
    async (metadata) => {
      const ctx = new Context()
      await ctx.plugin(SlotRegistry)
      new AgnesClientService(ctx, { sessions: { get: () => undefined } } as never)
      new CommandService(ctx, async () => true)
      new SessionService(ctx)
      new ThemeService(ctx, 'light')
      const locale = zhLocaleService()
      ctx.provide('locale', locale)
      const row: ReadyClientModule = {
        ...mod('generation-page', 'v1'),
        rowId: 'web:generation-page',
        binding: {
          owner: 'web:generation-page',
          lifetime: 'profile',
          availability: 'active',
          packageId: 'generation-page',
          integrity: 'v1',
          profileId: 'test',
          activationId: 'one',
        },
        homeEntries: [
          {
            id: 'generation-page',
            placement: 'primary',
            ...(metadata
              ? {
                  navigation: {
                    title: 'Generation page',
                    icon: 'cpu',
                    order: 40,
                  },
                }
              : {}),
          },
        ],
      }
      let current = roster([row])
      let release: (() => void) | undefined
      let mounted: ClientContext | undefined
      const reconciler = createReconciler({
        ctx,
        locale,
        source: { list: async () => current },
        importer: async () => {
          if (release)
            await new Promise<void>((resolve) => {
              release = resolve
            })
          return {
            apply(context: ClientContext) {
              mounted = context
              context.homeEntries.register({
                id: 'generation-page',
                placement: 'primary',
                titleKey: 'Generation page',
                icon: 'cpu',
                order: 40,
                component: () => null,
              })
            },
          }
        },
      })
      try {
        await reconciler.reconcileNow()
        homeNavigation.open('generation-page')
        await reconciler.reconcileNow()
        const previous = homeEntries.get('generation-page')
        expect(previous).toBeDefined()
        current = {
          ...roster([]),
          statuses: [
            {
              packageId: row.packageId,
              installedRevision: 'v1',
              backendRevision: null,
              state: 'blocked',
              reason: 'backend-revision-unavailable',
            },
          ],
        }
        await reconciler.invalidate()
        expect(homeEntries.get('generation-page')).toBeDefined()
        expect(mounted?.availability.getSnapshot()?.availability).toBe('disabled')
        await reconciler.invalidate()
        expect(homeEntries.get('generation-page')).toBeDefined()
        current = roster([{ ...row, binding: { ...row.binding!, activationId: 'two' } }])
        await reconciler.invalidate()
        expect(homeEntries.get('generation-page')).toBeDefined()
        expect(homeEntries.get('generation-page')).not.toBe(previous)
        expect(mounted?.availability.getSnapshot()?.activationId).toBe('two')
        release = () => {}
        current = roster([{ ...row, binding: { ...row.binding!, activationId: 'three' } }])
        const pending = reconciler.invalidate()
        await vi.waitFor(() => expect(reconciler.snapshot().get(row.rowId!)?.phase).toBe('loading'))
        expect(homeEntries.get('generation-page')).toBeDefined()
        const overlap = reconciler.invalidate()
        release?.()
        release = undefined
        await Promise.all([pending, overlap])
        expect(homeEntries.get('generation-page')).toBeDefined()
        expect(mounted?.availability.getSnapshot()?.availability).toBe('active')
        expect(mounted?.availability.getSnapshot()?.activationId).toBe('three')
        current = {
          ...roster([]),
          statuses: [
            {
              packageId: row.packageId,
              installedRevision: 'v1',
              backendRevision: null,
              state: 'blocked',
              reason: 'resources-invalid',
            },
          ],
        }
        await reconciler.invalidate()
        expect(homeEntries.get('generation-page')).toBeUndefined()
      } finally {
        release?.()
        homeNavigation.close()
        current = roster([])
        await reconciler.invalidate()
        await ctx.fiber.dispose()
      }
    },
  )
  it('leaves custom renderer modules in their isolated host on initial load and hot reload', async () => {
    const h = await harness()
    const custom = {
      ...mod('finance', 'v1'),
      intelligentComponents: [
        {
          kind: 'finance/reconcile/diff@1',
          propsSchema: true,
          maxPropsBytes: 256,
          fallback: 'Use table.',
          accessibility: { label: 'Differences', keyboard: true as const },
        },
      ],
    }
    const reconciler = createReconciler({
      ctx: h.ctx,
      importer: h.importer,
      source: { list: async () => roster([custom]) },
    })
    try {
      await reconciler.reconcileNow()
      await reconciler.reload('finance', 'v1')
      expect(h.loaded).toEqual([])
      expect(reconciler.snapshot()).toEqual(new Map())
    } finally {
      await h.ctx.fiber.dispose()
    }
  })
  it('真实 clientModule 以低 priority 替换已迁移区域，撤销名册后不会被下一次对账复活', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry)
    new AgnesClientService(ctx, { sessions: { get: () => undefined } } as never)
    new CommandService(ctx, async () => true)
    new SessionService(ctx)
    new ThemeService(ctx, 'light')
    const locale = zhLocaleService(ctx)
    const slots = (ctx as unknown as { slots: SlotRegistry }).slots
    slots.declare('ui:sidebar', { kind: 'single', scope: 'root' }, 'fixture')
    slots.register(
      { name: 'ui:sidebar', id: 'builtin-sidebar', owner: '@agnes/web-sidebar', priority: 0 },
      () => createElement('div', {}, 'builtin sidebar'),
    )
    const clientPanel = {
      ...mod('@agnes-examples/client-panel', 'v1'),
      slots: ['ui:sidebar'],
      slotCatalogVersion: 'dsh-client-slots/v1',
      contentDigest: 'sha256-digest',
      publicConfig: { label: 'Public label' },
    }
    let current = roster([clientPanel])
    let receivedConfig: unknown
    const reconciler = createReconciler({
      ctx,
      locale,
      source: { list: async () => current },
      importer: async () => ({
        apply(pluginCtx: { slots: SlotRegistry }, config: unknown) {
          receivedConfig = config
          pluginCtx.slots.register('ui:sidebar' as never, () => createElement('div', {}, 'plugin sidebar'), {
            priority: -1,
          })
        },
      }),
    })

    await reconciler.reconcileNow()
    expect(receivedConfig).toMatchObject({
      contentDigest: 'sha256-digest',
      publicConfig: { label: 'Public label' },
      slotCatalogVersion: 'dsh-client-slots/v1',
    })
    expect(slots.entriesOfSlot('ui:sidebar')[0]?.owner).toBe('@agnes-examples/client-panel')
    expect(slots.entriesByOwner('@agnes-examples/client-panel').map((entry) => entry.name)).toEqual([
      'ui:sidebar',
    ])

    // Disable/delete/untrust all project to a roster withdrawal. A stale SSE event must re-read
    // that authoritative empty roster and cannot revive the withdrawn module.
    current = roster([])
    await reconciler.invalidate()
    await reconciler.reload('@agnes-examples/client-panel', 'v1')
    expect(slots.entriesOfSlot('ui:sidebar')[0]?.owner).toBe('@agnes/web-sidebar')
    expect(slots.entriesByOwner('@agnes-examples/client-panel')).toEqual([])
    await ctx.fiber.dispose()
  })

  it('ready 模块被装载；同 revision 的下一次对账不重挂', async () => {
    const h = await harness()
    const log = { loaded: [] as string[], disposed: [] as string[] }
    stubPlugin(h.ctx, log)
    let module = mod('a', 'v1')
    const source = { list: async () => roster([module]) }
    const reconciler = createReconciler({ ctx: h.ctx, source, importer: h.importer })
    await reconciler.reconcileNow()
    await reconciler.reconcileNow()
    expect(log.loaded.filter((x) => x === 'apply:a')).toHaveLength(1)
    expect(h.loaded).toEqual(['/a/v1/index.js'])
    module = { ...module, entryUrl: '/plugins/generations/next/a/v1/index.js' }
    await reconciler.reconcileNow()
    expect(h.loaded).toEqual(['/a/v1/index.js', '/plugins/generations/next/a/v1/index.js'])
  })

  it('rejects a DSH slot before import when the catalog version is missing', async () => {
    const h = await harness()
    const log = { loaded: [] as string[], disposed: [] as string[] }
    stubPlugin(h.ctx, log)
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: { list: async () => roster([{ ...mod('dsh-package', 'v1'), slots: ['sidebar'] }]) },
      importer: h.importer,
    })

    await reconciler.reconcileNow()

    expect(h.loaded).toEqual([])
    expect(reconciler.snapshot().get('dsh-package')?.phase).toBe('failed')
  })

  it('rejects the host-only root slot even with the current catalog version', async () => {
    const h = await harness()
    const log = { loaded: [] as string[], disposed: [] as string[] }
    stubPlugin(h.ctx, log)
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: {
        list: async () =>
          roster([
            {
              ...mod('dsh-package', 'v1'),
              slots: ['root'],
              slotCatalogVersion: 'dsh-client-slots/v1',
            },
          ]),
      },
      importer: h.importer,
    })

    await reconciler.reconcileNow()

    expect(h.loaded).toEqual([])
    expect(reconciler.snapshot().get('dsh-package')?.phase).toBe('failed')
  })

  it('rejects an actual registration outside the manifest-declared browser slots without harming siblings', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry)
    new AgnesClientService(ctx, { sessions: { get: () => undefined } } as never)
    new CommandService(ctx, async () => true)
    const slots = (ctx as unknown as { slots: SlotRegistry }).slots
    slots.declare('ui:sidebar', { kind: 'single', scope: 'root' }, 'fixture')
    const current = roster([{ ...mod('pkg-bad', 'v1'), slots: ['ui:sidebar'] }])
    const reconciler = createReconciler({
      ctx,
      source: { list: async () => current },
      importer: async () => ({
        apply(pluginCtx: { slots: SlotRegistry }) {
          pluginCtx.slots.register('workbench.panel', () => null)
        },
      }),
    })
    await reconciler.reconcileNow()
    expect(reconciler.snapshot().get('pkg-bad')).toMatchObject({ phase: 'failed' })
    expect(slots.entries('workbench.panel')).toEqual([])
    await ctx.fiber.dispose()
  })

  it('名册移除包 → fiber 被 dispose（级联撤销注册项）；再出现 → 重新挂载', async () => {
    const h = await harness()
    const log = { loaded: [] as string[], disposed: [] as string[] }
    stubPlugin(h.ctx, log)
    let current = roster([mod('a', 'v1')])
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: { list: async () => current },
      importer: h.importer,
    })
    await reconciler.reconcileNow()
    expect(log.loaded).toEqual(['apply:a'])
    current = roster([])
    await reconciler.invalidate()
    expect(log.disposed).toEqual(['dispose:a'])
    current = roster([mod('a', 'v1')])
    await reconciler.invalidate()
    expect(log.loaded).toEqual(['apply:a', 'apply:a'])
  })

  it('换版：新入口预加载成功后才 dispose 旧 fiber、挂新模块', async () => {
    const h = await harness()
    const log = { loaded: [], disposed: [] }
    stubPlugin(h.ctx, log)
    let current = roster([mod('a', 'v1')])
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: { list: async () => current },
      importer: h.importer,
    })
    await reconciler.reconcileNow()
    current = roster([mod('a', 'v2')])
    await reconciler.invalidate()
    // 顺序：import v2 → dispose:a → apply:a(v2)
    expect(h.loaded).toEqual(['/a/v1/index.js', '/a/v2/index.js'])
    expect(log.loaded).toEqual(['apply:a', 'apply:a'])
    expect(log.disposed).toEqual(['dispose:a'])
  })

  it('样式先准备后提交，换版和禁用都会回收对应 link', async () => {
    const h = await harness()
    const log = { loaded: [] as string[], disposed: [] as string[] }
    stubPlugin(h.ctx, log)
    const styles: string[] = []
    let current = roster([styledMod('a', 'v1')])
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: { list: async () => current },
      importer: h.importer,
      prepareStyles: async (target) => {
        styles.push(`prepare:${target.revision}`)
        return {
          activate: () => styles.push(`activate:${target.revision}`),
          dispose: () => styles.push(`dispose:${target.revision}`),
        }
      },
    })
    await reconciler.reconcileNow()
    current = roster([styledMod('a', 'v2')])
    await reconciler.invalidate()
    current = roster([])
    await reconciler.invalidate()
    expect(styles).toEqual([
      'prepare:v1',
      'activate:v1',
      'prepare:v2',
      'dispose:v1',
      'activate:v2',
      'dispose:v2',
    ])
  })

  it.each(
    [false, true].flatMap((nonce) =>
      [
        'success',
        'script-first-fails',
        'script-last-fails',
        'styles-first-fail',
        'styles-last-fail',
        'revoked',
      ].map((kind) => ({ nonce, kind })),
    ),
  )(
    'prepares one module concurrently and settles both resources: $kind, nonce=$nonce',
    async ({ kind, nonce }) => {
      const h = await harness()
      const log = { loaded: [] as string[], disposed: [] as string[] }
      stubPlugin(h.ctx, log)
      const fixture = new Window({ settings: { disableCSSFileLoading: true } })
      if (nonce) {
        const meta = fixture.document.createElement('meta')
        meta.name = 'agnes-csp-nonce'
        meta.content = 'page-nonce'
        fixture.document.head.append(meta)
      }
      vi.stubGlobal('document', fixture.document)
      let scriptDone!: () => void
      const script = new Promise<void>((done) => {
        scriptDone = done
      })
      let scriptStarted = false
      let current = roster([styledMod('a', 'v1')])
      const link = () => fixture.document.querySelector('[data-plugin="a"]')
      const stylesDone = () =>
        link()?.dispatchEvent(new fixture.Event(kind.startsWith('styles-') ? 'error' : 'load'))
      const reconciler = createReconciler({
        ctx: h.ctx,
        source: { list: async () => current },
        importer: async () => {
          scriptStarted = true
          await script
          if (kind.startsWith('script-')) throw new Error('script unavailable')
          return { inject: [], apply() {} }
        },
        prepareStyles: prepareDocumentStyles,
      })
      const loading = reconciler.reconcileNow()
      try {
        await vi.waitFor(() => {
          expect(scriptStarted).toBe(true)
          expect(link()).not.toBeNull()
          if (nonce) {
            expect(link()?.tagName).toBe('STYLE')
            expect(link()?.getAttribute('nonce')).toBe('page-nonce')
            expect(link()?.textContent).toContain('layer(app)')
            expect(link()?.textContent).not.toContain('agnes_css_layer')
          } else expect(link()?.getAttribute('href')).toContain('agnes_css_layer=app')
        })
        expect(link()?.getAttribute('media')).not.toBe('all')
        let removed: Promise<void> | undefined
        if (kind === 'revoked') {
          current = roster([])
          removed = reconciler.invalidate()
          await vi.waitFor(() => expect(reconciler.snapshot().get('a')?.phase).toBe('idle'))
        }
        const scriptFirst = kind === 'script-first-fails' || kind === 'styles-last-fail'
        if (scriptFirst) scriptDone()
        else stylesDone()
        await Promise.resolve()
        expect(log.loaded).toEqual([])
        expect(link()?.getAttribute('media')).not.toBe('all')
        scriptDone()
        stylesDone()
        await loading
        await removed
        if (kind === 'success') {
          expect(reconciler.snapshot().get('a')?.phase).toBe('active')
          expect(log.loaded).toEqual(['apply:a'])
          expect(link()?.getAttribute('media')).toBe('all')
          current = roster([])
          await reconciler.invalidate()
        } else {
          expect(reconciler.snapshot().get('a')).toMatchObject({
            phase: kind === 'revoked' ? 'idle' : 'failed',
            revision: undefined,
            ...(kind === 'revoked'
              ? {}
              : {
                  error: {
                    code: kind.startsWith('script-')
                      ? 'CLIENT_MODULE_IMPORT_FAILED'
                      : 'CLIENT_MODULE_STYLES_FAILED',
                  },
                }),
          })
          expect(log.loaded).toEqual([])
        }
        expect(link()?.getAttribute('media')).not.toBe('all')
        expect(fixture.document.querySelectorAll('[data-plugin]')).toHaveLength(0)
      } finally {
        scriptDone()
        stylesDone()
        await loading
        await h.ctx.fiber.dispose()
        await fixture.happyDOM.abort()
        vi.unstubAllGlobals()
      }
    },
  )

  it('样式加载失败保留旧版，并允许同 revision 再次触发时重试', async () => {
    const h = await harness()
    const log = { loaded: [] as string[], disposed: [] as string[] }
    stubPlugin(h.ctx, log)
    let current = roster([styledMod('a', 'v1')])
    let failV2 = true
    const styleDisposals: string[] = []
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: { list: async () => current },
      importer: h.importer,
      prepareStyles: async (target) => {
        if (target.revision === 'v2' && failV2) throw new Error('temporary stylesheet error')
        return {
          activate() {},
          dispose: () => styleDisposals.push(target.revision),
        }
      },
    })
    await reconciler.reconcileNow()
    current = roster([styledMod('a', 'v2')])
    await reconciler.invalidate()
    expect(log.disposed).toEqual([])
    expect(reconciler.snapshot().get('a')).toMatchObject({ phase: 'failed', revision: 'v1' })
    failV2 = false
    await reconciler.invalidate()
    expect(log.disposed).toEqual(['dispose:a'])
    expect(styleDisposals).toContain('v1')
    expect(reconciler.snapshot().get('a')).toMatchObject({ phase: 'active', revision: 'v2' })
  })

  it('求值失败只隔离该包；后续名册失效可以重试而不影响其他包', async () => {
    const h = await harness()
    const log = { loaded: [], disposed: [] }
    stubPlugin(h.ctx, log)
    const source = { list: async () => roster([mod('broken', 'v1'), mod('ok', 'v1')]) }
    const reconciler = createReconciler({ ctx: h.ctx, source, importer: h.importer })
    await reconciler.reconcileNow()
    await reconciler.reconcileNow()
    expect(h.loaded).toEqual(['/broken/v1/index.js', '/ok/v1/index.js', '/broken/v1/index.js'])
    expect(log.loaded).toEqual(['apply:ok'])
    expect(reconciler.snapshot().get('broken')?.phase).toBe('failed')
    expect(reconciler.snapshot().get('ok')?.phase).toBe('active')
  })

  it('runtime status 订阅发布 loading、failed 和 active，并保留安全错误', async () => {
    const h = await harness()
    stubPlugin(h.ctx, { loaded: [], disposed: [] })
    const updates: Array<{ packageId: string; phase: string; error?: { code: string; message: string } }> = []
    let fail = true
    const reconciler = createReconciler({
      ctx: h.ctx,
      locale: zhLocaleService(h.ctx),
      source: { list: async () => roster([mod('a', 'v1')]) },
      importer: async () => {
        if (fail) throw new Error('file:///private/secret/index.js')
        return { inject: [], apply: () => {} }
      },
    })
    const off = reconciler.subscribe((state) => updates.push(state))

    await reconciler.reconcileNow()
    expect(reconciler.snapshot().get('a')).toEqual({
      packageId: 'a',
      revision: undefined,
      phase: 'failed',
      error: {
        code: 'CLIENT_MODULE_IMPORT_FAILED',
        phase: 'import',
        message: '插件 UI 入口加载失败，可重试',
      },
    })
    expect(updates.map((state) => state.phase)).toContain('loading')
    expect(updates.at(-1)?.phase).toBe('failed')

    fail = false
    await reconciler.invalidate()
    expect(reconciler.snapshot().get('a')).toEqual({
      packageId: 'a',
      revision: 'v1',
      phase: 'active',
    })
    expect(updates.at(-1)?.phase).toBe('active')
    off()
  })

  it('旧快照声明宿主未实现的槽位时在 import 前失败且不执行插件', async () => {
    const h = await harness()
    await h.ctx.plugin(SlotRegistry)
    const log = { loaded: [] as string[], disposed: [] as string[] }
    stubPlugin(h.ctx, log)
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: { list: async () => roster([{ ...mod('unsupported-slot', 'v1'), slots: ['sidebar.action'] }]) },
      importer: h.importer,
    })

    await reconciler.reconcileNow()

    expect(log.loaded).toEqual([])
    expect(reconciler.snapshot().get('unsupported-slot')).toMatchObject({
      phase: 'failed',
      error: { code: 'CLIENT_MODULE_SLOT_UNSUPPORTED' },
    })
  })

  it('同一安装包的两个 browser row 独立隔离，不以 packageId 互相覆盖', async () => {
    const h = await harness()
    const log = { loaded: [] as string[], disposed: [] as string[] }
    stubPlugin(h.ctx, log)
    const first = {
      ...mod('acme/panel', 'v1'),
      rowId: 'web:acme/panel:acme/primary',
      entryUrl: '/acme/panel/v1/broken.js',
    }
    const second = {
      ...mod('acme/panel', 'v1'),
      rowId: 'web:acme/panel:acme/secondary',
      entryUrl: '/acme/panel/v1/secondary.js',
    }
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: { list: async () => roster([first, second]) },
      importer: h.importer,
    })
    await reconciler.reconcileNow()
    expect(reconciler.snapshot().get(first.rowId)).toMatchObject({ phase: 'failed', revision: undefined })
    expect(reconciler.snapshot().get(second.rowId)).toMatchObject({ phase: 'active', revision: 'v1' })
  })

  it('名册提供 legacy row alias 时迁移生命周期并清理旧 owner', async () => {
    const h = await harness()
    const appliedRows: string[] = []
    const removedOwners: string[] = []
    ;(h.ctx as unknown as { plugin: unknown }).plugin = (modLike: unknown, config?: unknown) => {
      void modLike
      const rowId = (config as { rowId: string }).rowId
      appliedRows.push(rowId)
      const fiber = { dispose: async () => undefined }
      return Object.assign(Promise.resolve(fiber), fiber)
    }
    let current = roster([mod('acme/panel', 'v1')])
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: { list: async () => current },
      importer: h.importer,
      removeOwner: (rowId) => removedOwners.push(rowId),
    })

    await reconciler.reconcileNow()
    current = {
      ...roster([{ ...mod('acme/panel', 'v2'), rowId: 'web:acme/panel:acme/primary' }]),
      rowAliases: { 'web:acme/panel': 'web:acme/panel:acme/primary' },
    }
    await reconciler.invalidate()

    expect(appliedRows).toEqual(['acme/panel', 'web:acme/panel:acme/primary'])
    expect(removedOwners).toContain('acme/panel')
    expect(reconciler.snapshot().get('web:acme/panel:acme/primary')).toMatchObject({
      packageId: 'acme/panel',
      revision: 'v2',
      phase: 'active',
    })
    expect(reconciler.snapshot().has('web:acme/panel')).toBe(false)
  })

  it('多个旧 row 指向同一个 canonical row 时停止激活并报告身份歧义', async () => {
    const h = await harness()
    const appliedRows: string[] = []
    ;(h.ctx as unknown as { plugin: unknown }).plugin = (modLike: unknown, config?: unknown) => {
      void modLike
      appliedRows.push((config as { rowId: string }).rowId)
      const fiber = { dispose: async () => undefined }
      return Object.assign(Promise.resolve(fiber), fiber)
    }
    let current = roster([
      { ...mod('acme/panel', 'v1'), rowId: 'web:acme/panel:old-a' },
      { ...mod('acme/panel', 'v1'), rowId: 'web:acme/panel:old-b' },
    ])
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: { list: async () => current },
      importer: h.importer,
    })
    await reconciler.reconcileNow()
    current = {
      ...roster([{ ...mod('acme/panel', 'v2'), rowId: 'web:acme/panel:canonical' }]),
      rowAliases: {
        'web:acme/panel:old-a': 'web:acme/panel:canonical',
        'web:acme/panel:old-b': 'web:acme/panel:canonical',
      },
    }

    await reconciler.invalidate()

    expect(appliedRows).toEqual(['web:acme/panel:old-a', 'web:acme/panel:old-b'])
    expect(reconciler.snapshot().get('web:acme/panel:canonical')).toMatchObject({
      phase: 'failed',
      error: { code: 'CLIENT_MODULE_ROW_ALIAS_INVALID' },
    })
  })

  it.each([
    ['dynamic import 404', new TypeError('Failed to fetch dynamically imported module: 404')],
    ['dynamic import syntax error', new SyntaxError('Unexpected token')],
  ])('%s 在下一帧可重试，且不影响另一包', async (_label, failure) => {
    const h = await harness()
    const log = { loaded: [], disposed: [] }
    stubPlugin(h.ctx, log)
    let fail = true
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: { list: async () => roster([mod('broken', 'v1'), mod('ok', 'v1')]) },
      importer: async (url) => {
        if (url.includes('/broken/') && fail) throw failure
        return { inject: [], apply: () => {} }
      },
    })

    await reconciler.reconcileNow()
    expect(reconciler.snapshot().get('broken')).toMatchObject({ phase: 'failed', revision: undefined })
    expect(reconciler.snapshot().get('ok')).toMatchObject({ phase: 'active', revision: 'v1' })
    expect(log.loaded).toEqual(['apply:ok'])

    fail = false
    await reconciler.invalidate()
    expect(reconciler.snapshot().get('broken')).toMatchObject({ phase: 'active', revision: 'v1' })
    expect(reconciler.snapshot().get('ok')).toMatchObject({ phase: 'active', revision: 'v1' })
    expect(log.loaded).toEqual(['apply:ok', 'apply:broken'])
  })

  it('apply 抛错会回收已经注册的 slot，隔离 sibling，并在下一帧成功重试', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry)
    new AgnesClientService(ctx, { sessions: { get: () => undefined } } as never)
    new CommandService(ctx, async () => true)
    new SessionService(ctx)
    new ThemeService(ctx, 'light')
    const locale = zhLocaleService(ctx)
    const slots = (ctx as unknown as { slots: SlotRegistry }).slots
    slots.declare('ui:sidebar', { kind: 'single', scope: 'root' }, 'fixture')
    slots.declare('ui:topbar', { kind: 'single', scope: 'root' }, 'fixture')
    slots.register(
      { name: 'ui:sidebar', id: 'builtin-sidebar', owner: '@agnes/web-sidebar', priority: 0 },
      () => createElement('div', {}, 'builtin sidebar'),
    )
    slots.register({ name: 'ui:topbar', id: 'builtin-topbar', owner: '@agnes/web-topbar', priority: 0 }, () =>
      createElement('div', {}, 'builtin topbar'),
    )
    let fail = true
    const reconciler = createReconciler({
      ctx,
      source: {
        list: async () =>
          roster([
            { ...mod('bad', 'v1'), slots: ['ui:sidebar'], presentationRoles: ['deliverables'] },
            { ...mod('good', 'v1'), slots: ['ui:topbar'] },
          ]),
      },
      importer: async (url) => ({
        apply(pluginCtx: { slots: SlotRegistry }) {
          const slot = url.includes('/bad/') ? 'ui:sidebar' : 'ui:topbar'
          pluginCtx.slots.register(slot as never, () => createElement('div', {}, url), { priority: -1 })
          if (url.includes('/bad/') && fail)
            throw new Error('file:///private/token=secret/fixture apply failure')
        },
      }),
    })

    await reconciler.reconcileNow()
    expect(reconciler.snapshot().get('bad')).toMatchObject({
      packageId: 'bad',
      phase: 'failed',
      revision: undefined,
      error: { code: 'CLIENT_MODULE_APPLY_FAILED', phase: 'apply', roles: ['deliverables'] },
    })
    expect(JSON.stringify(reconciler.snapshot().get('bad'))).not.toMatch(/secret|private|file:/)
    expect(reconciler.snapshot().get('good')).toMatchObject({ phase: 'active', revision: 'v1' })
    expect(slots.entriesOfSlot('ui:sidebar').map((entry) => entry.owner)).toEqual(['@agnes/web-sidebar'])
    expect(slots.entriesOfSlot('ui:topbar').map((entry) => entry.owner)).toEqual(['good'])

    fail = false
    await reconciler.invalidate()
    expect(reconciler.snapshot().get('bad')).toMatchObject({ phase: 'active', revision: 'v1' })
    expect(slots.entriesOfSlot('ui:sidebar').map((entry) => entry.owner)).toEqual(['bad'])
    expect(slots.entriesOfSlot('ui:topbar').map((entry) => entry.owner)).toEqual(['good'])
    await ctx.fiber.dispose()
  })

  it('slot render failure enters the owning browser row failed state and remains retryable', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry)
    new AgnesClientService(ctx, { sessions: { get: () => undefined } } as never)
    new CommandService(ctx, async () => true)
    new SessionService(ctx)
    new ThemeService(ctx, 'light')
    const locale = zhLocaleService(ctx)
    const slots = (ctx as unknown as { slots: SlotRegistry }).slots
    slots.declare('ui:sidebar', { kind: 'single', scope: 'root' }, 'fixture')
    let current = roster([{ ...mod('render-failure', 'v1'), slots: ['ui:sidebar'] }])
    let applyCount = 0
    const reconciler = createReconciler({
      ctx,
      locale,
      source: { list: async () => current },
      importer: async () => ({
        apply(pluginCtx: { slots: SlotRegistry }) {
          applyCount += 1
          pluginCtx.slots.register('ui:sidebar' as never, () => createElement('div', {}, 'render fixture'))
        },
      }),
    })

    await reconciler.reconcileNow()
    const entry = slots.entriesByOwner('render-failure')[0]
    if (!entry) throw new Error('missing render fixture entry')
    slots.reportEntryError('ui:sidebar', entry, new Error('render failed'), { abdicate: true })
    expect(reconciler.snapshot().get('render-failure')).toMatchObject({
      packageId: 'render-failure',
      revision: 'v1',
      phase: 'failed',
      error: { code: 'CLIENT_MODULE_RENDER_FAILED' },
    })

    await reconciler.invalidate()
    expect(applyCount).toBe(2)
    expect(reconciler.snapshot().get('render-failure')).toMatchObject({ phase: 'active', revision: 'v1' })
    current = roster([])
  })

  it('SSE 指定的同 revision 重建会重新应用，失败后下一次仍可重试', async () => {
    const h = await harness()
    const log = { loaded: [], disposed: [] }
    stubPlugin(h.ctx, log)
    let fail = false
    const source = { list: async () => roster([mod('a', 'v1')]) }
    const reconciler = createReconciler({
      ctx: h.ctx,
      source,
      importer: async (url) => (fail ? Promise.reject(new Error('temporary')) : h.importer(url)),
    })
    await reconciler.reconcileNow()
    fail = true
    await reconciler.reload('a', 'v1')
    // Prefetch fails before the old fiber is touched: the old UI remains active while the next
    // rebuilt frame retries the same revision.
    expect(reconciler.snapshot().get('a')).toMatchObject({ phase: 'failed', revision: 'v1' })
    fail = false
    await reconciler.reload('a', 'v1')
    expect(log.loaded.filter((item) => item === 'apply:a')).toHaveLength(2)
    expect(reconciler.snapshot().get('a')).toMatchObject({ phase: 'active', revision: 'v1' })
  })

  it('同 revision 重建按 invalidate→prefetch→registry/cache→drain→styles→refresh→await 顺序提交', async () => {
    const h = await harness()
    const log = { loaded: [] as string[], disposed: [] as string[] }
    stubPlugin(h.ctx, log)
    let current = roster([styledMod('a', 'v1')])
    const steps: string[] = []
    const cacheDeletes: string[] = []
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: { list: async () => current },
      importer: h.importer,
      moduleCache: {
        delete: (url) => {
          cacheDeletes.push(url)
        },
      },
      onLifecycleStep: (step, packageId) => {
        steps.push(`${step}:${packageId}`)
      },
      prepareStyles: async (target) => ({
        activate: () => {
          steps.push(`activate-styles:${target.revision}`)
        },
        dispose: () => {
          steps.push(`dispose-styles:${target.revision}`)
        },
      }),
    })
    await reconciler.reconcileNow()
    steps.length = 0
    current = roster([styledMod('a', 'v1')])
    await reconciler.reload('a', 'v1')
    expect(steps).toEqual([
      'invalidate:a',
      'prefetch:a',
      'cache-registry-delete:a',
      'drain:a',
      'remove-styles:a',
      'dispose-styles:v1',
      'refresh:a',
      'activate-styles:v1',
      'await:a',
    ])
    expect(cacheDeletes).toEqual(['/a/v1/index.js'])
    expect(log.disposed).toEqual(['dispose:a'])
    expect(reconciler.snapshot().get('a')).toMatchObject({ phase: 'active', revision: 'v1' })
  })

  it('更新旧 fiber dispose 失败后重试仍能清理旧实例并挂载新 revision', async () => {
    const h = await harness()
    const disposed: string[] = []
    const applied: string[] = []
    let failOldDispose = true
    ;(h.ctx as unknown as { plugin: unknown }).plugin = (modLike: unknown, config?: unknown) => {
      void modLike
      const revision = (config as { revision: string }).revision
      applied.push(revision)
      const fiber = {
        async dispose() {
          disposed.push(revision)
          if (revision === 'v1' && failOldDispose) throw new Error('old dispose failed')
        },
      }
      return Object.assign(Promise.resolve(fiber), fiber)
    }
    let current = roster([mod('update-cleanup', 'v1')])
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: { list: async () => current },
      importer: h.importer,
    })

    await reconciler.reconcileNow()
    current = roster([mod('update-cleanup', 'v2')])
    await reconciler.invalidate()
    expect(disposed).toEqual(['v1'])
    expect(reconciler.snapshot().get('update-cleanup')).toMatchObject({ phase: 'active', revision: 'v2' })

    failOldDispose = false
    await reconciler.invalidate()
    expect(disposed).toEqual(['v1'])
    expect(applied).toEqual(['v1', 'v2'])
    expect(reconciler.snapshot().get('update-cleanup')).toMatchObject({ phase: 'active', revision: 'v2' })
  })

  it('名册撤回立即 removeOwner；dispose 失败也不会让旧注册项复活', async () => {
    const h = await harness()
    const log = { loaded: [] as string[], disposed: [] as string[] }
    let disposeCount = 0
    ;(h.ctx as unknown as { plugin: unknown }).plugin = (modLike: unknown, config?: unknown) => {
      void modLike
      const id = (config as { packageId: string }).packageId
      log.loaded.push(`apply:${id}`)
      const fiber = {
        async dispose() {
          log.disposed.push(`dispose:${id}`)
          disposeCount += 1
          if (disposeCount === 1) throw new Error('dispose failed')
        },
      }
      return Object.assign(Promise.resolve(fiber), fiber)
    }
    const removed: string[] = []
    let current = roster([mod('a', 'v1')])
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: { list: async () => current },
      importer: h.importer,
      removeOwner: (packageId) => removed.push(packageId),
    })
    await reconciler.reconcileNow()
    current = roster([])
    await reconciler.invalidate()
    expect(removed).toContain('a')
    expect(reconciler.snapshot().get('a')).toMatchObject({
      packageId: 'a',
      phase: 'failed',
      revision: 'v1',
    })
    current = roster([mod('a', 'v1')])
    await reconciler.invalidate()
    expect(log.loaded).toEqual(['apply:a', 'apply:a'])
  })

  it.each(['throws', 'times-out'] as const)(
    'quarantines a disposer that %s and remounts the same id before the old promise settles',
    async (mode) => {
      const h = await harness()
      let release!: () => void
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      const applied: string[] = []
      ;(h.ctx as unknown as { plugin: unknown }).plugin = (_: unknown, config: { revision: string }) => {
        applied.push(config.revision)
        const fiber = {
          async dispose() {
            if (config.revision === 'v1') {
              if (mode === 'throws') throw new Error('dispose failed')
              await pending
            }
          },
        }
        return Object.assign(Promise.resolve(fiber), fiber)
      }
      let current = roster([mod('cleanup', 'v1')])
      const reconciler = createReconciler({
        ctx: h.ctx,
        source: { list: async () => current },
        importer: h.importer,
        timeouts: { dispose: 10 },
      })
      await reconciler.reconcileNow()
      current = roster([])
      await reconciler.invalidate()
      expect(reconciler.snapshot().get('cleanup')).toMatchObject({ phase: 'failed' })
      current = roster([mod('cleanup', 'v2')])
      await reconciler.invalidate()
      expect(applied).toEqual(['v1', 'v2'])
      expect(reconciler.snapshot().get('cleanup')).toMatchObject({ phase: 'active', revision: 'v2' })
      release()
      await Promise.resolve()
      expect(reconciler.snapshot().get('cleanup')).toMatchObject({ phase: 'active', revision: 'v2' })
    },
  )

  it.each(['withdrawal', 'profile', 'session'] as const)(
    'disposes an obsolete mount after %s without committing it',
    async (superseded) => {
      const h = await harness()
      const log = { loaded: [] as string[], disposed: [] as string[] }
      let releaseApply!: () => void
      const gate = new Promise<void>((resolve) => {
        releaseApply = resolve
      })
      ;(h.ctx as unknown as { plugin: unknown }).plugin = (modLike: unknown, config?: unknown) => {
        void modLike
        const id = (config as { packageId: string }).packageId
        log.loaded.push(`apply:${id}`)
        const fiber = {
          async dispose() {
            log.disposed.push(`dispose:${id}`)
          },
        }
        return Object.assign(
          gate.then(() => fiber),
          fiber,
        )
      }
      let identity = 'profile-a:session-a:1'
      let current = roster([mod('a', 'v1')])
      const reconciler = createReconciler({
        ctx: h.ctx,
        source: { identity: () => identity, list: async () => current },
        importer: h.importer,
      })
      const first = reconciler.reconcileNow()
      while (log.loaded.length === 0) await new Promise((resolve) => setTimeout(resolve, 0))
      current = roster([])
      const removed = superseded === 'withdrawal' ? reconciler.invalidate() : undefined
      if (superseded !== 'withdrawal') identity = `${superseded}-changed:2`
      releaseApply()
      await first
      if (superseded !== 'withdrawal') {
        expect(reconciler.snapshot().get('a')?.phase).not.toBe('active')
        await reconciler.invalidate()
      }
      await removed
      expect(log.disposed).toEqual(['dispose:a'])
      expect(reconciler.snapshot().get('a')?.phase).toBe('idle')
    },
  )

  it('名册源抛错：保持现状不崩，下次触发继续对账', async () => {
    const h = await harness()
    const log = { loaded: [], disposed: [] }
    stubPlugin(h.ctx, log)
    let shouldFail = true
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: {
        list: async () => {
          if (shouldFail) throw new Error('roster down')
          return roster([mod('a', 'v1')])
        },
      },
      importer: h.importer,
    })
    await reconciler.reconcileNow()
    expect(log.loaded).toEqual([])
    shouldFail = false
    await reconciler.invalidate()
    expect(log.loaded).toEqual(['apply:a'])
  })

  it('apply 超时：未提交给 state 的 fiber 主动 dispose，不泄漏', async () => {
    const h = await harness()
    const disposed: string[] = []
    // apply 永不 settle 的 fiber：超时路径上 state.fiber 从未见过它，对账机必须就地回收。
    ;(h.ctx as unknown as { plugin: unknown }).plugin = (modLike: unknown, config?: unknown) => {
      void modLike
      const id = (config as { packageId: string }).packageId
      const fiber = {
        async dispose() {
          disposed.push(`dispose:${id}`)
        },
      }
      return Object.assign(new Promise(() => {}), fiber)
    }
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: { list: async () => roster([mod('a', 'v1')]) },
      importer: h.importer,
      timeouts: { import: 50, apply: 20, dispose: 50 },
    })
    await reconciler.reconcileNow()
    expect(disposed).toEqual(['dispose:a'])
    expect(reconciler.snapshot().get('a')?.phase).toBe('failed')
  })

  it('插件清理异常实际触发安全日志，且不写入异常或 row 数据', async () => {
    const h = await harness()
    const secret = 'fixture-secret-must-not-reach-browser-log'
    const warnings: unknown[][] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => warnings.push(args))
    stubPlugin(h.ctx, { loaded: [], disposed: [] })
    let current = roster([mod('a', 'v1')])
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: { list: async () => current },
      importer: h.importer,
      removeOwner: () => {
        throw new Error(secret)
      },
    })
    await reconciler.reconcileNow()
    current = roster([])
    await reconciler.invalidate()
    expect(warnings).toContainEqual(['[client-modules] 名册撤回时回收模块注册项失败'])
    expect(warnings.flat().some((item) => item === secret || item instanceof Error)).toBe(false)
    warn.mockRestore()
  })

  it('loading 中被移出名册：in-flight 挂载完成后 fiber 被 dispose，恰好一次', async () => {
    const h = await harness()
    const disposed: string[] = []
    let pluginCalls = 0
    let releaseApply!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseApply = resolve
    })
    // apply 完成时机由测试控制，制造「loading 中」的窗口。
    ;(h.ctx as unknown as { plugin: unknown }).plugin = (modLike: unknown, config?: unknown) => {
      void modLike
      pluginCalls += 1
      const id = (config as { packageId: string }).packageId
      const fiber = {
        async dispose() {
          disposed.push(`dispose:${id}`)
        },
      }
      return Object.assign(
        gate.then(() => fiber),
        fiber,
      )
    }
    let current = roster([mod('a', 'v1')])
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: { list: async () => current },
      importer: h.importer,
    })
    const first = reconciler.reconcileNow()
    while (pluginCalls === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    current = roster([])
    const removed = reconciler.invalidate()
    releaseApply()
    await first
    await removed
    expect(disposed).toEqual(['dispose:a'])
    expect(reconciler.snapshot().get('a')?.phase).toBe('idle')
  })

  it('一个包的慢导入不占住全局临界区：另一个包的卸载立即生效', async () => {
    const h = await harness()
    const log = { loaded: [] as string[], disposed: [] as string[] }
    stubPlugin(h.ctx, log)
    let current = roster([mod('b', 'v1')])
    const reconciler = createReconciler({
      ctx: h.ctx,
      source: { list: async () => current },
      importer: (url: string) =>
        url.startsWith('/a/')
          ? new Promise((resolve) => setTimeout(() => resolve({ inject: [], apply: () => {} }), 200))
          : h.importer(url),
    })
    await reconciler.reconcileNow()
    current = roster([mod('a', 'v1'), mod('b', 'v1')])
    const slow = reconciler.invalidate()
    await new Promise((resolve) => setTimeout(resolve, 20))
    // b 的禁用不能排在 a 那 200ms 导入之后：WC10 不许在全局临界区里等 import。
    current = roster([mod('a', 'v1')])
    const started = performance.now()
    await reconciler.invalidate()
    expect(log.disposed).toEqual(['dispose:b'])
    expect(performance.now() - started).toBeLessThan(120)
    await slow
  })
})

it('does not revive a withdrawn plugin from a late hot reload roster query', async () => {
  const h = await harness()
  stubPlugin(h.ctx, h)
  const plugin = mod('withdrawn', 'v1')
  let release!: (value: ClientRoster) => void
  let reading!: () => void
  const started = new Promise<void>((resolve) => {
    reading = resolve
  })
  let reads = 0
  const reconciler = createReconciler({
    ctx: h.ctx,
    importer: h.importer,
    source: {
      list: async () => {
        if (++reads === 1) return roster([plugin])
        if (reads === 2) {
          reading()
          return new Promise<ClientRoster>((resolve) => {
            release = resolve
          })
        }
        return roster([])
      },
    },
  })
  await reconciler.reconcileNow()
  const reload = reconciler.reload('withdrawn', 'v1')
  await started
  const withdrawn = reconciler.invalidate()
  // The fresh query must be able to withdraw while the obsolete query is parked.
  await withdrawn
  expect(reconciler.snapshot().get('withdrawn')?.phase).toBe('idle')
  release(roster([plugin]))
  await reload
  expect(reconciler.snapshot().get('withdrawn')?.phase).toBe('idle')
  expect(h.disposed).toContain('dispose:withdrawn')
})

it('reuses an unchanged module URL and advances it only for explicit hot reload', async () => {
  const { createModuleImportUrls } = await import('../src/client-modules/reconcile.js')
  const urls = createModuleImportUrls()
  const url = '/plugins/example/sha256-revision/src/client.js'
  expect(urls.resolve(url)).toBe(url)
  expect(urls.resolve(url)).toBe(url)
  urls.invalidate(url)
  expect(urls.resolve(url)).toBe(`${url}?agnes_hmr=1`)
  expect(urls.resolve(url)).toBe(`${url}?agnes_hmr=1`)
  urls.invalidate(url)
  expect(urls.resolve(url)).toBe(`${url}?agnes_hmr=2`)
  expect(urls.resolve(`${url}?source=local`)).toBe(`${url}?source=local`)
})
