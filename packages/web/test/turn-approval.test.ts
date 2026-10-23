/** @vitest-environment happy-dom */
import { Context } from '@agnes/cordis'
import type { DecisionSnapshot, UINode, UITimeline } from '@agnes/protocol'
import { SlotRegistry } from '@agnes/web-client'
import { liveApprovalCard } from '@agnes/web-conversation/approval-card'
import { createLiveProjection } from '@agnes/web-conversation/live-projection'
import { enT, zhT } from '@agnes/web-foundation/testkit/locale'
import { unmountApplication } from '@agnes/web-ui'
import { afterEach, expect, it, vi } from 'vitest'
import { approvalExpiry } from '../src/app/pending-approval.js'
import { SessionBindingOwner } from '../src/app/session-owner.js'
import { SubmissionOwner } from '../src/app/submission-owner.js'
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
  const binding = new SessionBindingOwner()
  const context = {
    sessionBinding: binding,
    submissions: new SubmissionOwner(binding),
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
    renderer: { pinToBottom: vi.fn(), render: vi.fn() },
    topbarRuntime: { setStatus: vi.fn(), setTaskTitle: vi.fn() },
    clientModules: {},
    sessionRows: [],
    sessionTitles: new Map(),
    receipts: new Map(),
    renderControls: vi.fn(),
    tracePanel: { render: vi.fn() },
    TRACE_THROTTLE_MS: 0,
    tracePaintedAt: 0,
    t: zhT,
    showError,
    run: (action: () => Promise<void>) => {
      void action().catch(showError)
    },
  } as unknown as {
    -readonly [K in keyof Parameters<typeof createTurnController>[0]]: Parameters<
      typeof createTurnController
    >[0][K]
  }
  const controller = createTurnController(context)
  return { context, controller, list, decide, showError, binding }
}

it.each(['preview', 'pending', 'full-access', 'full-plan', 'legacy-yolo'])(
  'keeps %s approval display from authorizing an answer',
  async (mode) => {
    const { context, controller, decide } = await harness()
    context.projection = timeline([approval])
    if (mode === 'preview') context.readOnly = { id: 's', maxNodes: 200, hasEarlier: false }
    else if (mode === 'pending') context.sessionPending = true
    else context.permissionMode = 'full'
    context.sessionRows = [
      {
        sessionId: 's',
        createdAt: '2026-10-20T00:00:00Z',
        lastSeq: 1,
        generation: 1,
        preset: 'standard',
        permission: mode === 'legacy-yolo' ? 'workspace-write' : 'full-access',
      },
    ]
    if (mode === 'full-access') context.projection = timeline([{ ...approval, category: 'permission' }])
    if (mode === 'full-plan') context.projection = timeline([{ ...approval, purpose: 'plan.exit' }])
    controller.renderApproval()
    if (mode === 'full-plan' || mode === 'legacy-yolo')
      await vi.waitFor(() => expect(document.querySelector('[data-testid="approval-card"]')).not.toBeNull())
    else expect(document.querySelector('[data-testid="approval-card"]')).toBeNull()
    expect(decide).not.toHaveBeenCalled()
  },
)

it.each(['live', 'durable'])(
  'budget permission uses its backend %s category without authorizing from the browser',
  async (source) => {
    const { context, controller, decide } = await harness()
    context.sessionRows = [
      {
        sessionId: 's',
        createdAt: '2026-10-20T00:00:00Z',
        lastSeq: 1,
        generation: 1,
        preset: 'workspace-write',
      },
    ]
    context.projection = timeline(
      source === 'durable' ? [{ ...approval, category: 'permission', purpose: 'budget' }] : [],
    )
    if (source === 'live')
      context.liveApproval = {
        request: {
          sessionId: 's',
          toolCall: {
            toolCallId: 'budget',
            title: 'Budget quote',
            kind: 'other',
            status: 'pending',
            _meta: { 'ai.agnes.harness': { category: 'permission', purpose: 'budget' } },
          },
          options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow' }],
        },
        finish: vi.fn(),
        afterSeq: 1,
      } as unknown as typeof context.liveApproval
    controller.renderApproval()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="approval-card"]')).not.toBeNull())
    context.sessionRows = context.sessionRows.map((row) => ({
      ...row,
      preset: 'standard',
      permission: 'full-access',
    }))
    controller.renderApproval()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="approval-card"]')).toBeNull())
    expect(decide).not.toHaveBeenCalled()
  },
)

it('projects the current turn start and distinguishes running, approval, stopping and read-only status', async () => {
  const { context, controller } = await harness()
  const startedAt = '2026-10-15T00:00:00Z'
  const turn = (number: number) => ({
    id: `turn-${number}`,
    turn: number,
    startSeq: 1,
    startedAt: number === 1 ? startedAt : '2026-10-14T00:00:00Z',
    status: 'running' as const,
    nodeIds: [],
    inherited: false,
    forkable: false,
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: true,
      calls: [],
    },
  })
  context.projection = {
    ...timeline(),
    turns: [turn(8), turn(1)],
    opState: { turn: 1, step: 1, phase: 'inference' },
  }
  controller.render()
  expect(context.topbarRuntime.setStatus).toHaveBeenLastCalledWith('生成回复', 'running', {
    sessionId: 's',
    startedAt,
    accessibleLabel: '正在执行：生成回复',
  })
  context.projection.nodes = [approval]
  controller.render()
  expect(context.topbarRuntime.setStatus).toHaveBeenLastCalledWith('等待你审批', 'approval', {
    sessionId: 's',
    startedAt,
    accessibleLabel: undefined,
  })
  context.projection.nodes = []
  context.projection.opState = null
  context.receipts.set('s', { startSeq: 1, endSeq: 3, reason: 'parked' })
  controller.render()
  expect(context.topbarRuntime.setStatus).toHaveBeenLastCalledWith('等待你审批', 'approval', {
    sessionId: 's',
    startedAt,
    accessibleLabel: undefined,
  })
  context.stopping = true
  controller.render()
  expect(context.topbarRuntime.setStatus).toHaveBeenLastCalledWith('正在停止…', 'stopping', {
    sessionId: 's',
    startedAt,
    accessibleLabel: undefined,
  })
  context.readOnly = { id: 's', hasEarlier: false } as NonNullable<typeof context.readOnly>
  controller.render()
  expect(context.topbarRuntime.setStatus).toHaveBeenLastCalledWith(zhT('app.readOnly.label'), 'idle')
  context.projection = undefined
  controller.render()
  expect(context.topbarRuntime.setStatus).toHaveBeenLastCalledWith(zhT('app.status.newTask'), 'idle')
})

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

it('rejects a durable approval with a trimmed reason, or plainly when it is empty', async () => {
  const { controller, list, decide } = await harness()
  list.mockResolvedValue({ decisions: [snapshot] })
  controller.searchApproval(3)
  const open = () => document.querySelector<HTMLButtonElement>('[data-testid="approval-reject-reason-open"]')
  await vi.waitFor(() => expect(open()).toBeTruthy())
  expect(open()?.textContent).toBe('附理由拒绝')
  expect(document.querySelector('[data-testid="approval-reason-input"]')).toBeNull()
  open()?.click()
  const input = () => document.querySelector<HTMLInputElement>('[data-testid="approval-reason-input"]')
  await vi.waitFor(() => expect(document.activeElement).toBe(input()))
  expect(input()?.maxLength).toBe(500)
  expect(input()?.getAttribute('aria-label')).toBe('告诉模型拒绝的理由')
  // Esc goes back to the button and drops the draft.
  input()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await vi.waitFor(() => expect(document.activeElement).toBe(open()))
  expect(input()).toBeNull()
  expect(decide).not.toHaveBeenCalled()
  const type = (value: string) => {
    const field = input()
    if (!field) throw new Error('reason input missing')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }
  open()?.click()
  await vi.waitFor(() => expect(input()).toBeTruthy())
  type('  too risky  ')
  // Enter that finishes an IME composition does not submit.
  input()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
  expect(decide).not.toHaveBeenCalled()
  input()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await vi.waitFor(() =>
    expect(decide).toHaveBeenCalledWith({
      ...ref,
      commandId: 'pending:1:rejected',
      response: { option: 'rejected', value: 'too risky' },
    }),
  )
})

it('offers no reason field on a live approval, which has no channel for it', async () => {
  const { context, controller } = await harness()
  context.liveApproval = {
    request: {
      sessionId: 's',
      toolCall: { toolCallId: 'live-1', title: 'Run it', kind: 'other', status: 'pending' },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'allow_once' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'reject_once' },
      ],
    },
    finish: vi.fn(),
    afterSeq: 1,
  } as unknown as typeof context.liveApproval
  controller.renderApproval()
  await vi.waitFor(() => expect(document.querySelectorAll('[data-approval-action]')).toHaveLength(2))
  expect(document.querySelector('[data-testid="approval-reject-reason-open"]')).toBeNull()
})

it('shows who asked and what an always-allow stores, as plain text, folding past three scopes', async () => {
  const { context, controller } = await harness()
  const show = async (extra: Partial<typeof approval>) => {
    context.projection = timeline([
      { ...approval, options: ['allow_once', 'allow_always', 'reject_once'], ...extra },
    ])
    controller.renderApproval()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="approval-card"]')).not.toBeNull())
  }
  const origin = () => document.querySelector('[data-testid="approval-origin"]')
  const stores = () => document.querySelector('[data-testid="approval-stores"]')
  await show({})
  expect(origin()).toBeNull()
  expect(stores()).toBeNull()
  expect(document.body.textContent).not.toContain('这也会运行项目定义的脚本')
  await show({
    prefixGrant: { tokens: ['pnpm', 'test'], scope: 'shell:prefix:["pnpm","test"]', runsProjectCode: true },
  })
  await vi.waitFor(() => expect(document.body.textContent).toContain('这也会运行项目定义的脚本'))
  await show({ prefixGrant: { tokens: ['echo'], scope: 'shell:prefix:["echo"]' } })
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('这也会运行项目定义的脚本'))
  await show({
    grantScopes: ['a', 'b'],
    origin: { package: '@agnes/browser', role: 'reviewer', mcpServer: '<b>github</b>' },
  })
  await vi.waitFor(() =>
    expect(origin()?.textContent).toBe('来自 @agnes/browser · 角色 reviewer · MCP <b>github</b>'),
  )
  expect(origin()?.querySelector('b')).toBeNull()
  await vi.waitFor(() => expect(stores()?.textContent).toBe('「始终允许」会保存：a, b'))
  expect(stores()?.getAttribute('title')).toBeNull()
  await show({ grantScopes: ['a', 'b', 'c', 'd', 'e'] })
  await vi.waitFor(() => expect(stores()?.textContent).toBe('「始终允许」会保存：a, b, c +2'))
  expect(stores()?.getAttribute('title')).toBe('a, b, c, d, e')
})

it('submits an empty reason as a plain rejection', async () => {
  const { controller, list, decide } = await harness()
  list.mockResolvedValue({ decisions: [snapshot] })
  controller.searchApproval(3)
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="approval-reject-reason-open"]')).toBeTruthy(),
  )
  document.querySelector<HTMLButtonElement>('[data-testid="approval-reject-reason-open"]')?.click()
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="approval-reason-submit"]')).toBeTruthy(),
  )
  document.querySelector<HTMLButtonElement>('[data-testid="approval-reason-submit"]')?.click()
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
  document
    .querySelector<HTMLButtonElement>('[data-testid="approval-preview"]')
    ?.closest('[data-open]')
    ?.querySelector<HTMLButtonElement>('button')
    ?.click()
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

it.each(['different', 'returned'] as const)(
  'ignores lookup and history completion after a %s session switch',
  async (mode) => {
    const { context, controller, list, binding } = await harness()
    const original = { live: context.live, projection: context.projection }
    let resolve: ((value: { decisions: DecisionSnapshot[] }) => void) | undefined
    list.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    controller.searchApproval()
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    binding.begin('other')
    context.live = undefined
    context.projection = undefined
    if (mode === 'returned') {
      binding.begin('s')
      context.live = original.live
      context.projection = original.projection
    }
    controller.renderApproval()
    resolve?.({ decisions: [snapshot] })
    await new Promise((done) => setTimeout(done, 0))
    expect(document.querySelector('[data-approval-action^="durable:"]')).toBeNull()
  },
)

it('formats expiry in the UI language as a relative duration instead of ISO', () => {
  const now = Date.parse('2026-10-14T02:49:50.221Z')
  const expiry = '2026-10-15T02:49:50.221Z'
  expect(approvalExpiry(expiry, zhT, now)).toBe('24 小时后过期')
  expect(approvalExpiry(expiry, enT, now)).toBe('Expires in 24 hours')
  expect(approvalExpiry(expiry, zhT, now + 86400000)).toBe('已过期')
})

const reconcileSnapshot = {
  ...snapshot,
  request: {
    ...snapshot.request,
    owner: 'core/unknown-outcome',
    spec: {
      ...snapshot.request.spec,
      prompt: 'did mcp_manage happen? allowed = it happened, rejected = it did not',
      subject: { toolUseId: 't1', name: 'mcp_manage', turn: 1, step: 2, risk: 'unknown' },
    },
  },
} as unknown as DecisionSnapshot

it.each(['empty', 'stale-permission', 'stale-automatic'])(
  'review: full-access retains a live factual reconciliation with %s projection',
  async (projection) => {
    const { context, controller, decide } = await harness()
    context.sessionRows = [
      {
        sessionId: 's',
        createdAt: '2026-10-20T00:00:00Z',
        lastSeq: 1,
        generation: 1,
        preset: 'standard',
        permission: 'full-access',
      },
    ]
    context.projection = timeline(
      projection === 'empty'
        ? []
        : [
            {
              ...approval,
              category: 'permission',
              ...(projection === 'stale-automatic'
                ? {
                    state: 'decided' as const,
                    decision: { verdict: 'allowed-once', via: 'policy', reason: 'full-access' },
                  }
                : {}),
            },
          ],
    )
    context.liveApproval = {
      request: {
        sessionId: 's',
        toolCall: {
          toolCallId: 'unknown-effect',
          title: 'Did the operation happen?',
          kind: 'other',
          status: 'pending',
        },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Executed' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Not executed' },
        ],
      },
      finish: vi.fn(),
      afterSeq: 1,
    } as unknown as typeof context.liveApproval
    controller.renderApproval()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="approval-card"]')).not.toBeNull())
    expect(decide).not.toHaveBeenCalled()
  },
)

it('asks whether a call that lost its result ran, in plain words, with «执行了 / 没执行»', async () => {
  const { controller, list, decide } = await harness()
  list.mockResolvedValue({ decisions: [reconcileSnapshot] })
  controller.searchApproval(3)
  await vi.waitFor(() => expect(document.querySelectorAll('[data-approval-action]')).toHaveLength(2))
  const card = document.querySelector('[data-testid="approval-card"]')
  expect(card?.getAttribute('data-kind')).toBe('reconcile')
  expect(card?.querySelector('h2')?.textContent).toBe('这个操作执行了吗？')
  expect(card?.textContent).toContain('mcp_manage 已经发出，但没收到结果')
  // Neither the raw English prompt nor the bookkeeping subject is shown.
  expect(card?.textContent).not.toContain('did mcp_manage happen')
  expect(document.querySelector('[data-testid="approval-preview"]')).toBeNull()
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-approval-action]')]
  expect(buttons.map((button) => [button.dataset.approvalAction, button.textContent])).toEqual([
    ['durable:allowed-once', '执行了'],
    ['durable:rejected', '没执行'],
  ])
  buttons[1]?.click()
  await vi.waitFor(() =>
    expect(decide).toHaveBeenCalledWith({
      ...ref,
      commandId: 'pending:1:rejected',
      response: { option: 'rejected', value: null },
    }),
  )
})

it('says an answered, not yet consumed decision is waiting for the Agent, never that it failed to load', async () => {
  const { controller, list, showError } = await harness()
  const answered = {
    ...reconcileSnapshot,
    result: {
      reason: 'answered',
      response: { option: 'allowed-once', value: null },
      answeredBy: { id: 'me' },
    },
  } as unknown as DecisionSnapshot
  list.mockResolvedValue({ decisions: [answered] })
  controller.searchApproval()
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="approval-card"]')?.getAttribute('data-kind')).toBe(
      'answered',
    ),
  )
  const card = document.querySelector('[data-testid="approval-card"]')
  expect(card?.querySelector('h2')?.textContent).toBe('已回答，等待 Agent 继续')
  expect(card?.textContent).toContain('你确认：执行了')
  expect(card?.textContent).not.toContain('暂时无法加载审批')
  // No backend action resumes it yet: a status, not a button.
  expect(document.querySelectorAll('[data-approval-action]')).toHaveLength(0)
  expect(showError).not.toHaveBeenCalled()
})

it('reads the answered state straight from the transcript while the turn is still parked', async () => {
  const { context, controller, list } = await harness()
  context.projection = timeline([
    {
      ...approval,
      state: 'decided',
      reconcile: { tool: 'mcp_manage' },
      decision: { verdict: 'rejected', via: 'human', reason: 'user-rejected' },
    },
  ])
  controller.renderApproval()
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="approval-card"]')?.getAttribute('data-kind')).toBe(
      'answered',
    ),
  )
  const card = document.querySelector('[data-testid="approval-card"]')
  expect(card?.textContent).toContain('你确认：没执行')
  expect(list).not.toHaveBeenCalled()
})

it('settles the search and offers «定位审批» again when the decision lookup throws at once', async () => {
  const { controller, list, showError } = await harness()
  list.mockImplementation(() => {
    throw new Error('not connected')
  })
  controller.searchApproval()
  await vi.waitFor(() => expect(document.querySelector('[data-approval-action="locate"]')).not.toBeNull())
  expect(document.querySelector('[data-testid="approval-card"]')?.textContent).toContain('有一项审批等待处理')
  expect(showError).toHaveBeenCalledWith(expect.objectContaining({ message: 'not connected' }))
})

// Candidate tests use the same live approval surface as other tool calls.
it.each([
  [zhT, '在本机运行候选的 Node 作者测试', '不会发布、信任或启用', '设置 → 插件 → 候选'],
  [
    enT,
    'Node author tests on this machine',
    'does not publish, trust or enable',
    'Settings → Plugins → Candidates',
  ],
] as const)('localizes candidate test approval with %s', async (t, execution, boundary, review) => {
  const { context, controller } = await harness()
  context.t = t
  context.liveApproval = {
    request: {
      sessionId: 's',
      toolCall: {
        toolCallId: 'test',
        title: 'synthetic fallback',
        rawInput: { packageId: 'agh-skill-math-teacher', candidateHash: `sha256-${'a'.repeat(64)}` },
        _meta: { 'ai.agnes.harness': { tool: 'plugin_candidate_test' } },
      },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'allow_once' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'reject_once' },
      ],
    },
    finish: vi.fn(),
  } as unknown as typeof context.liveApproval
  controller.renderApproval()
  await vi.waitFor(() => {
    const text = document.querySelector('[data-testid="approval-card"]')?.textContent ?? ''
    for (const phrase of [execution, boundary, review, 'agh-skill-math-teacher', 'aaaaaaaaaaaa'])
      expect(text).toContain(phrase)
    expect(text).not.toContain('synthetic fallback')
  })
})

it.each(['zh-CN', 'en', 'en-GB'])(
  'renders the %s decision fields and submits exactly the displayed bound meaning',
  async (locale) => {
    document.documentElement.lang = locale
    const { controller, list, decide } = await harness()
    const meaning = locale === 'zh-CN' ? '我批准本次质量决策。' : 'I approve this quality decision.'
    const presentation = Object.fromEntries(
      ['zh-CN', 'en'].map((language) => [
        language,
        {
          title: language === 'zh-CN' ? '人工质量签署' : 'Human quality signature',
          fields: [
            {
              label: language === 'zh-CN' ? '签名含义' : 'Signature meaning',
              value: language === 'zh-CN' ? '我批准本次质量决策。' : 'I approve this quality decision.',
            },
            { label: 'Evidence', value: 'NCR-018', href: '/?session=s' },
          ],
          responseValue: language === 'zh-CN' ? '我批准本次质量决策。' : 'I approve this quality decision.',
        },
      ]),
    )
    list.mockResolvedValue({
      decisions: [
        { ...snapshot, request: { ...snapshot.request, spec: { ...snapshot.request.spec, presentation } } },
      ],
    })
    controller.searchApproval(3)
    await vi.waitFor(() =>
      expect(document.querySelector('.agh-decision-fields dd')?.textContent).toBe(meaning),
    )
    expect(document.querySelector('.agh-decision-fields a')?.getAttribute('href')).toBe('/?session=s')
    expect(document.querySelector('.approval-summary-text')?.textContent).toBe(
      locale === 'zh-CN' ? '人工质量签署' : 'Human quality signature',
    )
    document.querySelector<HTMLButtonElement>('[data-approval-action="durable:allowed-once"]')?.click()
    await vi.waitFor(() =>
      expect(decide).toHaveBeenCalledWith({
        ...ref,
        commandId: 'pending:1:allowed-once',
        response: { option: 'allowed-once', value: meaning },
      }),
    )
    document.documentElement.lang = ''
  },
)

it.each(['saved', 'failed'] as const)(
  'keeps an old approval %s out of a new binding of the same session handle',
  async (outcome) => {
    const { context, controller, list, decide, showError, binding } = await harness()
    list.mockResolvedValue({ decisions: [snapshot] })
    let finish!: () => void
    let fail!: (error: Error) => void
    const previous = new Promise<undefined>((resolve, reject) => {
      finish = () => resolve(undefined)
      fail = reject
    })
    decide
      .mockImplementationOnce(() => previous)
      .mockImplementationOnce(() => new Promise<undefined>(() => {}))
    const action = () =>
      document.querySelector<HTMLButtonElement>('[data-approval-action="durable:rejected"]')
    controller.searchApproval(3)
    await vi.waitFor(() => expect(action()).not.toBeNull())
    action()?.click()
    await vi.waitFor(() => expect(context.approvalBusy).toBe(true))
    binding.begin('other')
    binding.begin('s')
    // The new binding owns a separate answer and busy state.
    context.approvalBusy = false
    controller.renderApproval()
    controller.searchApproval(3)
    await vi.waitFor(() => expect(action()?.disabled).toBe(false))
    action()?.click()
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(2))
    if (outcome === 'saved') finish()
    else fail(new Error('old approval failed'))
    await previous.catch(() => {})
    await Promise.resolve()
    await Promise.resolve()
    expect(context.approvalBusy).toBe(true)
    expect(showError).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(action()?.disabled).toBe(true))
  },
)

it.each([
  [
    'shell python3 script.py cwd="private"',
    'Count words in brief.md to verify the script',
    '运行命令 · Count words in brief.md to verify the script',
  ],
  ['Review the chosen report', undefined, 'Review the chosen report'],
  ['running', undefined, 'running'],
  ['continuable', undefined, 'continuable'],
  ['shell python3 script.py cwd="private"', undefined, '运行命令'],
])(
  'keeps human intent in live approval headers and raw commands in details (%s)',
  (title, description, expected) => {
    const card = liveApprovalCard(
      {
        title,
        kind: 'execute',
        rawInput: { command: 'python3 script.py', cwd: 'private', ...(description ? { description } : {}) },
        _meta: { 'ai.agnes.harness': { tool: 'shell' } },
      },
      zhT,
    )
    expect(card.summary).toBe(expected)
    expect(card.summary).not.toContain('python3')
    expect(card.sessionLabel).toBe('本会话内允许此工具的所有调用')
    expect(card.preview).toContain('python3 script.py')
    expect(card.preview).toContain('private')
  },
)

it.each([enT, zhT])(
  'retains the backend role, child and reason when tool arguments suggest a different title',
  (t) => {
    const title =
      'Role @fixture/app#requirements · child parent/child · Edit file · docs/SRS.md · Untrusted evidence (taint)'
    const card = liveApprovalCard(
      {
        title,
        kind: 'edit',
        rawInput: { path: 'docs/SRS.md', content: 'Requirements', description: 'Hide the role context' },
        _meta: {
          'ai.agnes.harness': {
            tool: 'edit',
            delegation: {
              role: '@fixture/app#requirements',
              childSessionKey: 'parent/child',
              reason: 'Untrusted evidence (taint)',
            },
          },
        },
      },
      t,
    )
    expect(card.summary).toBe(
      t === zhT
        ? '角色 @fixture/app#requirements · 子会话 parent/child · 编辑 · docs/SRS.md · 不可信证据（污染）'
        : title.replace('Edit file', 'Edit'),
    )
    expect(card.preview).toContain('docs/SRS.md')
    expect(card.preview).toContain('Requirements')
    expect(card.sessionLabel).toBeUndefined()
  },
)

it.each([false, true])(
  'uses the owning question lifetime after a parent turn ends (delegated=%s)',
  async (delegated) => {
    const { context, controller } = await harness()
    context.projection = { ...timeline([]), opState: null }
    context.receipts.set('s', { startSeq: 1, endSeq: 3, reason: 'completed' })
    const finish = vi.fn()
    context.liveApproval = {
      afterSeq: 1,
      finish,
      request: {
        sessionId: 's',
        toolCall: {
          toolCallId: 'child-write',
          title: 'Role requirements · child child · write SRS · taint',
          _meta: {
            'ai.agnes.harness': {
              tool: 'write',
              ...(delegated ? { delegation: { childSessionKey: 'child' } } : {}),
            },
          },
        },
        options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'allow_once' }],
      },
    } as unknown as typeof context.liveApproval
    controller.render()
    if (delegated) {
      expect(finish).not.toHaveBeenCalled()
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="approval-card"]')?.textContent).toContain(
          'Role requirements',
        ),
      )
    } else expect(finish).toHaveBeenCalledWith({ unanswered: 'detached' })
  },
)
