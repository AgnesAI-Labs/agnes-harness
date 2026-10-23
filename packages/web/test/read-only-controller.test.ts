import { Context } from '@agnes/cordis'
import { SESSION_VERSION_CODES } from '@agnes/protocol'
import type { Session } from '@agnes/sdk/browser'
import { SessionService } from '@agnes/web-client'
import { expect, it, vi } from 'vitest'
import { createReadOnlyController } from '../src/app/read-only-controller.js'
import { SessionBindingOwner } from '../src/app/session-owner.js'
import { appReadOnly } from '../src/app-notices.js'
import { createReconciler } from '../src/client-modules/reconcile.js'

vi.mock('../src/app-notices.js', () => ({ appReadOnly: { show: vi.fn(), clear: vi.fn() } }))

const refusal = { data: { code: SESSION_VERSION_CODES.older } }
const isolationRefusal = {
  data: {
    code: 'E_SANDBOX_WORKSPACE',
    reason: 'session-execution-record-invalid',
    messageKey: 'appServer.errors.sessionSandbox',
  },
}
const view = (id: string, hasEarlier = true, scan?: { fromSeq: number; throughSeq: number }) => ({
  timeline: { sessionId: id },
  history: { hasEarlier, ...(scan ? { scan: { reason: 'events', ...scan } } : {}) },
})

function setup() {
  const pending = new Map<string, (value: ReturnType<typeof view>) => void>()
  const context = {
    clientModules: {
      session: new SessionService(new Context()),
      reconciler: { reconcileNow: async () => {} },
    },
    client: {
      session: {
        integrity: vi.fn(async () => ({ state: 'verified' })),
        list: vi.fn(async (query: { q: { prefix: string }; limit: number }) => ({
          items: [
            { sessionId: 'AA', title: 'A different session sharing the prefix' },
            { sessionId: 'A', title: 'Renamed investigation 017' },
          ]
            .filter((row) => row.sessionId.startsWith(query.q.prefix))
            .slice(0, query.limit),
        })),
        view: (id: string, options: { maxNodes: number }) =>
          new Promise<ReturnType<typeof view>>((resolve) =>
            pending.set(`${id}:${options.maxNodes}`, resolve),
          ),
      },
    },
    sessionTitles: new Map<string, string>(),
    projection: undefined as unknown,
    readOnly: undefined as { id: string; maxNodes: number; hasEarlier: boolean } | undefined,
    render: vi.fn(),
    renderControls: vi.fn(),
    run: vi.fn(),
    sessionBinding: new SessionBindingOwner(),
    get current(): Session | undefined {
      return this.sessionBinding.session
    },
    t: (key: string) => key,
    windowAtStart: false,
  }
  const controller = createReadOnlyController(context as never, {
    open: async () => {},
    beginNewDraft: async () => {},
  })
  return { context, controller, pending }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

it('keeps the newest selection when a late loadEarlier response of the previous record arrives', async () => {
  const { context, controller, pending } = setup()
  const a = controller.show('A', refusal, context.sessionBinding.capture())
  await tick()
  pending.get('A:200')?.(view('A'))
  await a
  const earlier = controller.loadEarlier()
  await tick()
  context.sessionBinding.begin()
  const b = controller.show('B', refusal, context.sessionBinding.capture())
  await tick()
  pending.get('B:200')?.(view('B'))
  await b
  pending.get('A:400')?.(view('A'))
  await earlier
  expect(context.sessionTitles.get('A')).toBe('Renamed investigation 017')
  expect(context.readOnly?.id).toBe('B')
  expect(context.projection).toEqual({ sessionId: 'B' })
  expect(context.clientModules.session.getSnapshot()).toBe('B')
  expect(context.clientModules.session.readiness.getSnapshot()).toMatchObject({
    status: 'history-only',
    sessionId: 'B',
  })
})

it.each([refusal, isolationRefusal])(
  'does not let a late response resurrect read-only state after the selection was cleared (%j)',
  async (error) => {
    const { context, controller, pending } = setup()
    const a = controller.show('A', error, context.sessionBinding.capture())
    await tick()
    context.sessionBinding.begin()
    controller.clear()
    pending.get('A:200')?.(view('A'))
    await a
    expect(context.readOnly).toBeUndefined()
    expect(context.projection).toBeUndefined()
  },
)

it.each([false, true])(
  'shows isolation-refused history even when title lookup fails (%s)',
  async (metadataMissing) => {
    const { context, controller, pending } = setup()
    if (metadataMissing) {
      context.sessionTitles.set('A', 'Cached renamed title')
      context.client.session.list.mockRejectedValue(new Error('Metadata unavailable'))
    }
    const shown = controller.show(
      'A',
      {
        data: {
          ...isolationRefusal.data,
          actions: ['upgrade', 'repin'],
          localized: { en: 'unsafe', 'zh-CN': 'unsafe' },
        },
      },
      context.sessionBinding.capture(),
    )
    await tick()
    pending.get('A:200')?.(view('A'))
    expect(await shown).toBe(true)
    expect(context.readOnly).toEqual({ id: 'A', maxNodes: 200, hasEarlier: true })
    expect(context.projection).toEqual({ sessionId: 'A' })
    expect(context.sessionTitles.get('A')).toBe(
      metadataMissing ? 'Cached renamed title' : 'Renamed investigation 017',
    )
    const notice = vi.mocked(appReadOnly.show).mock.lastCall?.[0]
    expect(notice?.actions.map((action) => action.id)).toEqual(['new'])
    expect(notice?.message.en).toMatch(/read/i)
    expect(notice?.message['zh-CN']).toContain('查看')
    const earlier = controller.loadEarlier()
    await tick()
    pending.get('A:400')?.(view('A', false))
    await earlier
    expect(context.readOnly).toEqual({ id: 'A', maxNodes: 400, hasEarlier: false })
    expect(context.windowAtStart).toBe(true)
  },
)

it.each([
  { data: { code: 'E_SANDBOX_WORKSPACE', reason: 'probe-failed' } },
  { data: { code: 'E_SANDBOX_WORKSPACE' } },
  { data: { code: 'E_FORBIDDEN', reason: 'session-execution-record-invalid' } },
])('does not treat unrelated refusals as readable history (%j)', async (error) => {
  const { context, controller, pending } = setup()
  expect(await controller.show('A', error, context.sessionBinding.capture())).toBe(false)
  expect(pending.size).toBe(0)
  expect(context.readOnly).toBeUndefined()
})

it.each(['current', 'changed', 'cleared'])(
  'offers recovery for unreadable history only while the request is current (%s)',
  async (selection) => {
    const { context, controller } = setup()
    context.client.session.view = async () => {
      throw new Error('unreadable history')
    }
    const shown = controller.show('A', isolationRefusal, context.sessionBinding.capture())
    if (selection === 'changed') context.sessionBinding.begin()
    if (selection === 'cleared') controller.clear()
    expect(await shown).toBe(selection !== 'current')
    expect(context.readOnly).toBeUndefined()
    expect(context.projection).toBeUndefined()
  },
)

it('states which rows a truncated record shows', async () => {
  const { context, controller, pending } = setup()
  const shown = controller.show('A', refusal, context.sessionBinding.capture())
  await tick()
  pending.get('A:200')?.(view('A', true, { fromSeq: 901, throughSeq: 1500 }))
  await shown
  expect(vi.mocked(appReadOnly.show).mock.lastCall?.[0].sessionId).toBe('A')
  expect(vi.mocked(appReadOnly.show).mock.lastCall?.[0].message.en).not.toContain('Session: A.')
  expect(appReadOnly.show).toHaveBeenLastCalledWith(
    expect.objectContaining({ scan: expect.objectContaining({ fromSeq: 901, throughSeq: 1500 }) }),
  )
})

it('labels unverified history compactly and ignores a preview that finishes after the formal projection', async () => {
  const { context, controller, pending } = setup()
  vi.mocked(appReadOnly.show).mockClear()
  const preview = controller.preview('A', context.sessionBinding.capture())
  await tick()
  pending.get('A:50')?.(view('A'))
  await preview
  expect(context.readOnly?.id).toBe('A')
  expect(appReadOnly.show).toHaveBeenLastCalledWith(
    expect.objectContaining({
      preview: true,
      message: { en: 'History preview (not yet verified)', 'zh-CN': '历史预览（尚未验证）' },
    }),
  )
  let verified!: (result: { state: string }) => void
  context.client.session.integrity.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        verified = resolve
      }) as never,
  )
  controller.clearPreview()
  controller.verify('A', context.sessionBinding.capture())
  vi.mocked(appReadOnly.clear).mockClear()
  await tick()
  expect(appReadOnly.clear).not.toHaveBeenCalled()
  verified({ state: 'verified' })
  await tick()
  expect(appReadOnly.clear).toHaveBeenCalled()
  const again = controller.preview('A', context.sessionBinding.capture())
  await tick()
  pending.get('A:50')?.(view('A'))
  await again
  context.sessionBinding.attach(context.sessionBinding.capture(), { session: { id: 'A' } as Session })
  context.clientModules.session.setSession('A', 'connecting')
  expect(context.readOnly?.id).toBe('A')
  expect(context.projection).toEqual({ sessionId: 'A' })
  controller.clear()
  expect(context.readOnly).toBeUndefined()
  context.sessionBinding.begin('B')
  const late = controller.preview('B', context.sessionBinding.capture())
  await tick()
  context.sessionBinding.attach(context.sessionBinding.capture(), { session: { id: 'B' } as Session })
  context.clientModules.session.setSession('B', 'connecting')
  pending.get('B:50')?.(view('B'))
  await late
  expect(context.projection).toEqual({ sessionId: 'B' })
  expect(context.readOnly?.id).toBe('B')
  expect(context.clientModules.session.readiness.getSnapshot()).toMatchObject({
    sessionId: 'B',
    status: 'connecting',
  })
  const lateAfterOpening = controller.preview('B', context.sessionBinding.capture())
  await tick()
  controller.clear()
  context.projection = { sessionId: 'live' }
  context.clientModules.session.setReadiness('ready', 'B')
  pending.get('B:50')?.(view('B'))
  await lateAfterOpening
  expect(context.projection).toEqual({ sessionId: 'live' })
  expect(context.readOnly).toBeUndefined()
  expect(context.clientModules.session.readiness.getSnapshot().status).toBe('ready')
  // Even another read for the same id cannot survive a switch away and back.
  const obsolete = controller.preview('B', context.sessionBinding.capture())
  await tick()
  context.sessionBinding.begin('A')
  context.sessionBinding.begin('B')
  pending.get('B:50')?.(view('B'))
  await obsolete
  expect(context.projection).toEqual({ sessionId: 'live' })
})

it('keeps the preview through background verification and ignores a late result after switching', async () => {
  const { context, controller } = setup()
  vi.useFakeTimers()
  try {
    context.client.session.integrity.mockResolvedValueOnce({ state: 'verifying' })
    controller.verify('A', context.sessionBinding.capture())
    await vi.advanceTimersByTimeAsync(0)
    vi.mocked(appReadOnly.clear).mockClear()
    expect(appReadOnly.clear).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(appReadOnly.clear).toHaveBeenCalled()
    let finish!: (value: { state: string }) => void
    context.client.session.integrity.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }) as never,
    )
    controller.verify('A', context.sessionBinding.capture())
    context.sessionBinding.begin('B')
    controller.clear()
    controller.progress(
      { sessionId: 'B', phase: 'verifying', verifiedSeq: 0, lastSeq: 10 },
      context.sessionBinding.capture(),
    )
    vi.mocked(appReadOnly.clear).mockClear()
    finish({ state: 'verified' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(appReadOnly.clear).not.toHaveBeenCalled()
    expect(appReadOnly.show).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'B', preview: true }),
    )
  } finally {
    controller.clear()
    vi.useRealTimers()
  }
})

it.each(['refused', 'preview'])(
  'commits the current profile presentation for a cold %s opening after the startup roster',
  async (mode) => {
    const { context, controller, pending } = setup()
    const ctx = new Context()
    let release!: () => void
    const startup = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const reconciler = createReconciler({
      ctx,
      source: {
        identity: () => String(context.sessionBinding.generation),
        async list() {
          if (first) {
            first = false
            await startup
          }
          return {
            revision: 'current',
            statuses: [],
            modules: [
              {
                packageId: '@agnes/conversation-ui',
                revision: 'current',
                entryUrl: '/conversation.js',
                styleUrls: [],
                slots: [],
                extIds: [],
              },
            ],
          }
        },
      },
      importer: async () => ({ apply() {} }),
      prepareStyles: async () => ({ activate() {}, dispose() {} }),
    })
    // Use an inert real fiber; this test covers roster selection, not renderer services.
    const mount = ctx.plugin.bind(ctx)
    ctx.plugin = () => mount({ apply() {} })
    context.clientModules.reconciler = reconciler
    try {
      const initial = reconciler.reconcileNow()
      await tick()
      context.sessionBinding.begin()
      release()
      await initial
      expect(reconciler.snapshot().get('@agnes/conversation-ui')?.phase).not.toBe('active')
      const shown =
        mode === 'refused'
          ? controller.show('history', refusal, context.sessionBinding.capture())
          : controller.preview('history', context.sessionBinding.capture())
      await tick()
      pending.get(mode === 'refused' ? 'history:200' : 'history:50')?.(view('history', false))
      const result = await shown
      if (mode === 'refused') expect(result).toBe(true)
      expect(reconciler.snapshot().get('@agnes/conversation-ui')?.phase).toBe('active')
      expect(context.clientModules.session.getSnapshot()).toBe('history')
      expect(context.clientModules.session.readiness.getSnapshot().status).toBe('history-only')
    } finally {
      await ctx.fiber.dispose()
    }
  },
)
