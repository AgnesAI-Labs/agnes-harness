/** @vitest-environment happy-dom */
import { Context } from '@agnes/cordis'
import type { DecisionSnapshot, UINode, UITimeline } from '@agnes/protocol'
import { SlotRegistry } from '@agnes/web-client'
import { createLiveProjection } from '@agnes/web-conversation/live-projection'
import { enT, zhT } from '@agnes/web-foundation/testkit/locale'
import { unmountApplication } from '@agnes/web-ui'
import { afterEach, expect, it, vi } from 'vitest'
import { approvalExpiry } from '../src/app/pending-approval.js'
import { createTurnController } from '../src/app/turn-controller.js'
import { mountApprovalRegion } from '../src/regions/approval.js'

const ref = { sessionId: 's', id: 'pending', revision: 1 }
const expiresAt = '2099-01-01T00:00:00Z'
const approval: Extract<UINode, { kind: 'approval' }> = {
  kind: 'approval',
  id: 'approval',
  seq: 1,
  state: 'pending',
  summary: 'Review command',
  decisionRef: ref,
  risk: 'destructive',
  options: ['allow_once', 'reject_once'],
  expiresAt,
}
const snapshot = {
  handle: { sessionId: 's', id: 'pending' },
  revision: 1,
  request: {
    spec: {
      prompt: 'Review command',
      subject: { call: { name: 'execute', args: { command: 'pwd' } }, risk: 'destructive' },
      options: ['allowed-once', 'rejected'],
      responseSchema: { type: 'null' },
    },
    expiresAt,
  },
  result: null,
  consumption: null,
  invalidation: null,
} as unknown as DecisionSnapshot
const timeline = (nodes: UINode[] = []): UITimeline => ({
  sessionId: 's',
  generation: 1,
  upto: 1101,
  nodes,
  turns: [],
  opState: { turn: 1, step: 1, phase: 'tools', parked: { decisionRef: ref, expiresAt } },
})
let runtime: ReturnType<typeof mountApprovalRegion> | undefined
let owner: Context | undefined
let stop: (() => Promise<void>) | undefined

afterEach(async () => {
  await stop?.()
  stop = undefined
  await runtime?.dispose()
  runtime = undefined
  await owner?.fiber.dispose()
  owner = undefined
  unmountApplication(document)
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

async function harness() {
  owner = new Context()
  await owner.plugin(SlotRegistry)
  const registry = (owner as unknown as { slots: SlotRegistry }).slots
  const host = document.createElement('section')
  document.body.append(host)
  runtime = mountApprovalRegion(registry, host)
  const list = vi.fn(async (): Promise<{ decisions: DecisionSnapshot[] }> => ({ decisions: [] }))
  const decide = vi.fn(async () => undefined)
  const showError = vi.fn()
  const context = {
    projection: timeline(),
    current: { id: 's' },
    live: { hasEarlier: () => false, loadEarlier: async () => false, refresh: vi.fn() },
    approvalRuntime: runtime,
    approvalSearch: 'idle',
    approvalSearchTicket: undefined,
    approvalBusy: false,
    connected: true,
    stopping: false,
    client: { approval: { list, decide } },
    conversationRuntime: { isTranscriptNearBottom: () => false },
    renderer: { pinToBottom: vi.fn() },
    t: zhT,
    showError,
    run: (action: () => Promise<void>) => {
      void action().catch(showError)
    },
  } as unknown as Parameters<typeof createTurnController>[0]
  const controller = createTurnController(context)
  return { context, controller, list, decide, showError }
}

it('locates a pending approval beyond the opening window and automatic search, then scrolls and focuses it', async () => {
  const { context, controller } = await harness()
  const nodes: UINode[] = [
    approval,
    ...Array.from(
      { length: 1100 },
      (_, index): UINode => ({
        kind: 'user',
        id: `message-${index}`,
        seq: index + 2,
        content: [{ type: 'text', text: `message ${index}` }],
      }),
    ),
  ]
  const historyPages: number[] = []
  const session = {
    projectUIOpening: async () => ({
      timeline: timeline(nodes.slice(-500)),
      history: { hasEarlier: true, startIndex: 601, totalNodes: nodes.length, cursor: '601' },
    }),
    projectUIHistory: async (cursor: string) => {
      const end = Number(cursor)
      const start = Math.max(0, end - 100)
      historyPages.push(start)
      return {
        sessionId: 's',
        generation: 1,
        cut: 1101,
        nodes: nodes.slice(start, end),
        turns: [],
        startIndex: start,
        totalNodes: nodes.length,
        hasEarlier: start > 0,
        ...(start ? { cursor: String(start) } : {}),
      }
    },
    onPreview: () => () => {},
    events: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
        return: async () => ({ done: true }),
      }),
    }),
  }
  const live = createLiveProjection(
    session as never,
    { connectionState: 'connected', on: () => () => {} } as never,
    {
      timeline: (value) => {
        context.projection = value
      },
      stream: () => {},
      event: () => {},
      error: (error) => {
        throw error
      },
    },
  )
  context.live = live
  stop = () => live.stop()
  await live.start()
  controller.searchApproval(3)
  await vi.waitFor(() => expect(context.approvalSearch).toBe('not-found'))
  expect(context.projection?.nodes).toHaveLength(800)
  expect(document.body.textContent).not.toContain(expiresAt)
  await vi.waitFor(() => expect(document.querySelector('[data-approval-action="locate"]')).toBeTruthy())
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
  document.querySelector<HTMLButtonElement>('[data-approval-action="locate"]')?.click()
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute('data-approval-action')).toBe('durable:allowed-once'),
  )
  expect(context.projection?.nodes[0]).toEqual(approval)
  expect(historyPages).toEqual([501, 401, 301, 201, 101, 1, 0])
  expect(scroll.mock.contexts.at(-1)).toBe(document.querySelector('[data-approval-key="pending"]'))
})

it('renders authoritative actions and full details without loading old transcript pages', async () => {
  const { controller, list, decide } = await harness()
  list.mockResolvedValue({ decisions: [snapshot] })
  controller.searchApproval(3)
  await vi.waitFor(() => expect(document.querySelectorAll('[data-approval-action]')).toHaveLength(2))
  expect(document.querySelector('[data-testid="approval-preview"]')?.textContent).toContain('pwd')
  expect(document.querySelector('[data-approval-action="durable:allowed-session"]')).toBeNull()
  expect(decide).not.toHaveBeenCalled()
  expect(document.activeElement?.getAttribute('data-approval-action')).toBeNull()
  document.querySelector<HTMLButtonElement>('[data-approval-action="durable:rejected"]')?.click()
  await vi.waitFor(() =>
    expect(decide).toHaveBeenCalledWith({
      ...ref,
      commandId: 'pending:1:rejected',
      response: { option: 'rejected', value: null },
    }),
  )
})

it('keeps focus on details when an explicit lookup succeeds before history finishes', async () => {
  const { context, controller, list } = await harness()
  list.mockResolvedValue({ decisions: [snapshot] })
  let finishHistory: ((loaded: boolean) => void) | undefined
  if (!context.live) throw new Error('fixture live projection missing')
  context.live.hasEarlier = () => true
  context.live.loadEarlier = () =>
    new Promise((resolve) => {
      finishHistory = resolve
    })
  controller.searchApproval()
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute('data-approval-action')).toBe('durable:allowed-once'),
  )
  const details = document.querySelector<HTMLElement>('[data-testid="approval-preview"]')
  details?.focus()
  finishHistory?.(false)
  await vi.waitFor(() => expect(context.approvalSearch).toBe('not-found'))
  expect(document.activeElement).toBe(details)
})

it.each(['revision', 'session', 'answered', 'invalidated', 'consumed', 'options'])(
  'does not offer verdicts for a mismatched or settled decision (%s)',
  async (mismatch) => {
    const { context, controller, list } = await harness()
    const value = structuredClone(snapshot)
    if (mismatch === 'revision') value.revision++
    if (mismatch === 'session') value.handle.sessionId = 'other'
    if (mismatch === 'answered') value.result = { reason: 'answered' } as never
    if (mismatch === 'invalidated') value.invalidation = { at: expiresAt, code: 'cancelled' }
    if (mismatch === 'consumed') value.consumption = {} as never
    if (mismatch === 'options') value.request.spec.options = ['custom']
    list.mockResolvedValue({ decisions: [value] })
    controller.searchApproval()
    await vi.waitFor(() => expect(context.approvalSearch).toBe('not-found'))
    expect(document.querySelector('[data-approval-action^="durable:"]')).toBeNull()
  },
)

it('settles failed loads and lets locate retry successfully', async () => {
  const { context, controller, list, showError } = await harness()
  list.mockRejectedValueOnce(new Error('offline'))
  if (!context.live) throw new Error('fixture live projection missing')
  context.live.loadEarlier = async () => {
    throw new Error('history unavailable')
  }
  context.live.hasEarlier = () => true
  controller.searchApproval(3)
  await vi.waitFor(() => expect(context.approvalSearch).toBe('not-found'))
  expect(showError).toHaveBeenCalled()
  list.mockResolvedValue({ decisions: [snapshot] })
  context.live.hasEarlier = () => false
  controller.searchApproval()
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute('data-approval-action')).toBe('durable:allowed-once'),
  )
})

it('ignores lookup and history completion after a session switch', async () => {
  const { context, controller, list } = await harness()
  let resolve: ((value: { decisions: DecisionSnapshot[] }) => void) | undefined
  list.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  controller.searchApproval()
  context.live = undefined
  context.projection = undefined
  controller.renderApproval()
  resolve?.({ decisions: [snapshot] })
  await new Promise((done) => setTimeout(done, 0))
  expect(document.querySelector('[data-approval-action^="durable:"]')).toBeNull()
})

it('formats expiry in the UI language as a relative duration instead of ISO', () => {
  const now = Date.parse('2026-10-14T02:49:50.221Z')
  const expiry = '2026-10-15T02:49:50.221Z'
  expect(approvalExpiry(expiry, zhT, now)).toBe('24 小时后过期')
  expect(approvalExpiry(expiry, enT, now)).toBe('Expires in 24 hours')
  expect(approvalExpiry(expiry, zhT, now + 86400000)).toBe('已过期')
})
