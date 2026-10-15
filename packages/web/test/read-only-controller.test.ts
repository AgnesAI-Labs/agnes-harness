import { SESSION_VERSION_CODES } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { createReadOnlyController } from '../src/app/read-only-controller.js'
import { appReadOnly } from '../src/app-notices.js'

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
    selection: 1,
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
  const a = controller.show('A', refusal, 1)
  await tick()
  pending.get('A:200')?.(view('A'))
  await a
  const earlier = controller.loadEarlier()
  await tick()
  context.selection = 2
  const b = controller.show('B', refusal, 2)
  await tick()
  pending.get('B:200')?.(view('B'))
  await b
  pending.get('A:400')?.(view('A'))
  await earlier
  expect(context.readOnly?.id).toBe('B')
  expect(context.projection).toEqual({ sessionId: 'B' })
})

it.each([refusal, isolationRefusal])(
  'does not let a late response resurrect read-only state after the selection was cleared (%j)',
  async (error) => {
    const { context, controller, pending } = setup()
    const a = controller.show('A', error, 1)
    await tick()
    context.selection = 2
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
    1,
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
  expect(await controller.show('A', error, 1)).toBe(false)
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
    const shown = controller.show('A', isolationRefusal, 1)
    if (selection === 'changed') context.selection = 2
    if (selection === 'cleared') controller.clear()
    expect(await shown).toBe(selection !== 'current')
    expect(context.readOnly).toBeUndefined()
    expect(context.projection).toBeUndefined()
  },
)

it('states which rows a truncated record shows', async () => {
  const { controller, pending } = setup()
  const shown = controller.show('A', refusal, 1)
  await tick()
  pending.get('A:200')?.(view('A', true, { fromSeq: 901, throughSeq: 1500 }))
  await shown
  expect(appReadOnly.show).toHaveBeenLastCalledWith(
    expect.objectContaining({ scan: expect.objectContaining({ fromSeq: 901, throughSeq: 1500 }) }),
  )
})

it('labels opening history as unverified and ignores a preview that finishes after live admission', async () => {
  const { context, controller, pending } = setup()
  const preview = controller.preview('A', 1)
  await tick()
  pending.get('A:200')?.(view('A'))
  await preview
  expect(context.readOnly?.id).toBe('A')
  controller.clear()
  expect(context.readOnly).toBeUndefined()
  const late = controller.preview('B', 1)
  await tick()
  controller.clear()
  context.projection = { sessionId: 'live' }
  pending.get('B:200')?.(view('B'))
  await late
  expect(context.projection).toEqual({ sessionId: 'live' })
})
