import { Context } from '@agnes/cordis'
import { SESSION_VERSION_CODES } from '@agnes/protocol'
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
        view: (id: string, options: { maxNodes: number }) =>
          new Promise<ReturnType<typeof view>>((resolve) =>
            pending.set(`${id}:${options.maxNodes}`, resolve),
          ),
      },
    },
    projection: undefined as unknown,
    readOnly: undefined as { id: string; maxNodes: number; hasEarlier: boolean } | undefined,
    render: vi.fn(),
    renderControls: vi.fn(),
    run: vi.fn(),
    sessionBinding: new SessionBindingOwner(),
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

it('shows isolation-refused history with only a new-session action, including earlier messages', async () => {
  const { context, controller, pending } = setup()
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
  const notice = vi.mocked(appReadOnly.show).mock.lastCall?.[0]
  expect(notice?.actions.map((action) => action.id)).toEqual(['new'])
  expect(notice?.message.en).toContain('read')
  expect(notice?.message['zh-CN']).toContain('查看')
  const earlier = controller.loadEarlier()
  await tick()
  pending.get('A:400')?.(view('A', false))
  await earlier
  expect(context.readOnly).toEqual({ id: 'A', maxNodes: 400, hasEarlier: false })
  expect(context.windowAtStart).toBe(true)
})

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
  expect(appReadOnly.show).toHaveBeenLastCalledWith(
    expect.objectContaining({ scan: expect.objectContaining({ fromSeq: 901, throughSeq: 1500 }) }),
  )
})

it('labels opening history as unverified and ignores a preview that finishes after live admission', async () => {
  const { context, controller, pending } = setup()
  const preview = controller.preview('A', context.sessionBinding.capture())
  await tick()
  pending.get('A:200')?.(view('A'))
  await preview
  expect(context.readOnly?.id).toBe('A')
  controller.clear()
  expect(context.readOnly).toBeUndefined()
  const late = controller.preview('B', context.sessionBinding.capture())
  await tick()
  controller.clear()
  context.projection = { sessionId: 'live' }
  pending.get('B:200')?.(view('B'))
  await late
  expect(context.projection).toEqual({ sessionId: 'live' })
})

it('commits the current profile presentation after a refused cold opening supersedes the startup roster', async () => {
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
    const shown = controller.show('history', refusal, context.sessionBinding.capture())
    await tick()
    pending.get('history:200')?.(view('history', false))
    expect(await shown).toBe(true)
    expect(reconciler.snapshot().get('@agnes/conversation-ui')?.phase).toBe('active')
    expect(context.clientModules.session.getSnapshot()).toBe('history')
  } finally {
    await ctx.fiber.dispose()
  }
})
