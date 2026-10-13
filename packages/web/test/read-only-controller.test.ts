import { SESSION_VERSION_CODES } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { createReadOnlyController } from '../src/app/read-only-controller.js'
import { appReadOnly } from '../src/app-notices.js'

vi.mock('../src/app-notices.js', () => ({ appReadOnly: { show: vi.fn(), clear: vi.fn() } }))

const refusal = { data: { code: SESSION_VERSION_CODES.older } }
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

it('does not let a late response resurrect read-only state after the selection was cleared', async () => {
  const { context, controller, pending } = setup()
  const a = controller.show('A', refusal, 1)
  await tick()
  context.selection = 2
  controller.clear()
  pending.get('A:200')?.(view('A'))
  await a
  expect(context.readOnly).toBeUndefined()
  expect(context.projection).toBeUndefined()
})

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
