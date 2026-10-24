/** @vitest-environment happy-dom */

import { Context } from '@agnes/cordis'
import type { UITimeline } from '@agnes/protocol'
import type { LedgerEvent, Session } from '@agnes/sdk/browser'
import { SessionService } from '@agnes/web-client'
import { createLiveProjection, type LiveProjectionSink } from '@agnes/web-conversation/live-projection'
import { expect, it, vi } from 'vitest'
import { createReadOnlyController } from '../src/app/read-only-controller.js'
import { createSessionController } from '../src/app/session-controller.js'
import { SessionBindingOwner } from '../src/app/session-owner.js'

vi.mock('@agnes/web-conversation/live-projection', () => ({ createLiveProjection: vi.fn() }))
vi.mock('../src/app-notices.js', () => ({ appReadOnly: { show: vi.fn(), clear: vi.fn() } }))

it.each(['before', 'after'])(
  'hands the preview to the formal opening when it finishes %s admission',
  async (timing) => {
    const binding = new SessionBindingOwner()
    const session = { id: 'A' } as Session
    let admit!: (session: Session) => void
    let showPreview!: (view: unknown) => void
    let finishOpening!: () => void
    let finishControls!: () => void
    let sink: LiveProjectionSink | undefined
    const opening = new Promise<void>((resolve) => {
      finishOpening = resolve
    })
    const controls = new Promise<void>((resolve) => {
      finishControls = resolve
    })
    vi.mocked(createLiveProjection).mockImplementation((_session, _client, target) => {
      sink = target
      return { start: () => opening } as ReturnType<typeof createLiveProjection>
    })
    const context = {
      sessionBinding: binding,
      get current(): Session | undefined {
        return binding.session
      },
      moduleSessionId: undefined as string | undefined,
      clientModules: {
        session: new SessionService(new Context()),
        reconciler: { reconcileNow: async () => {} },
      },
      client: {
        session: {
          open: () =>
            new Promise<Session>((resolve) => {
              admit = resolve
            }),
          view: () =>
            new Promise((resolve) => {
              showPreview = resolve
            }),
          list: async () => ({ items: [] }),
          runtime: async () => ({}),
          integrity: async () => ({ state: 'verified' }),
        },
      },
      sessionRows: [{ sessionId: 'A' }],
      sessionTitles: new Map(),
      receipts: new Map(),
      submissions: {},
      references: { clear() {} },
      selectComposerDraft() {},
      topbarRuntime: { setStatus() {} },
      approvalRuntime: { render: vi.fn() },
      render: vi.fn(),
      renderControls() {},
      renderer: { reset() {} },
      refreshSessionControls: () => controls,
      readSessionControls: () => controls.then(() => async () => {}),
      clearSessionRecovery() {},
      list: async () => {},
      projection: undefined as unknown,
      readOnly: undefined as { id: string; maxNodes: number; hasEarlier: boolean } | undefined,
      t: (key: string) => key,
      windowAtStart: false,
      readOnlyController: undefined as unknown as ReturnType<typeof createReadOnlyController>,
    }
    context.readOnlyController = createReadOnlyController(context as never, {
      open: async () => {},
      beginNewDraft: async () => {},
    })
    const controller = createSessionController(context as never, binding)
    const work = controller.open('A')
    expect(context.approvalRuntime.render).toHaveBeenCalledWith(undefined)
    await vi.waitFor(() => expect(showPreview).toBeTypeOf('function'))
    const preview = { sessionId: 'A', upto: 1, nodes: [], turns: [] }
    const publishPreview = async () => {
      showPreview({ timeline: preview, history: { hasEarlier: false } })
      await vi.waitFor(() => expect(context.render).toHaveBeenCalled())
      expect(context.projection).toBe(preview)
      expect(context.readOnly?.id).toBe('A')
    }
    if (timing === 'before') {
      await publishPreview()
      expect(context.clientModules.session.readiness.getSnapshot().status).toBe('history-only')
    }
    admit(session)
    await vi.waitFor(() => expect(sink).toBeDefined())
    const admittedReadiness = context.clientModules.session.readiness.getSnapshot()
    if (timing === 'after') await publishPreview()
    expect(context.projection).toBe(preview)
    expect(context.readOnly?.id).toBe('A')
    expect(context.clientModules.session.getSnapshot()).toBe('A')
    expect(context.moduleSessionId).toBe('A')
    expect(context.clientModules.session.readiness.getSnapshot()).toBe(admittedReadiness)
    expect(context.clientModules.session.readiness.getSnapshot().status).toBe('connecting')
    const formal: UITimeline = { ...preview, upto: 2, generation: 1, opState: null }
    sink?.timeline(formal, { reason: 'opening', startIndex: 0, totalNodes: 0, hasEarlier: false })
    expect(context.projection).toBe(formal)
    expect(context.readOnly).toBeUndefined()
    // An opening grants no send readiness until controls have also completed.
    finishOpening()
    await Promise.resolve()
    expect(context.clientModules.session.readiness.getSnapshot().status).toBe('connecting')
    finishControls()
    await work
    expect(context.clientModules.session.readiness.getSnapshot().status).toBe('ready')
  },
)

it.each(['x/core/control', 'user/message'])(
  'keeps late %s refresh errors scoped to the selection that requested them',
  async (type) => {
    for (const selection of ['current', 'other', 'returned']) {
      let reject!: (error: Error) => void
      const failure = new Promise<never>((_, no) => {
        reject = no
      })
      const session = { id: 'a' } as Session
      let shown = 'ready'
      const context = {
        current: session,
        sessionRows: [],
        sessionBinding: new SessionBindingOwner(),
        refreshSessionControls: () => failure,
        list: () => failure,
        showError: (error: unknown) => {
          shown = (error as Error).message
        },
        titleRefresh: { start() {}, stop() {} },
        sessionTitles: new Map(),
        receipts: new Map(),
      }
      context.sessionBinding.attach(context.sessionBinding.capture(), { session })
      const controller = createSessionController(
        context as unknown as Parameters<typeof createSessionController>[0],
        context.sessionBinding,
      )
      const work = controller.followEvent(session, {
        seq: 1,
        ts: '2026-10-15T00:00:00Z',
        type,
        data: {},
      } as LedgerEvent)
      if (selection !== 'current') {
        context.current = { id: 'b' } as Session
        context.sessionBinding.begin()
        context.sessionBinding.attach(context.sessionBinding.capture(), { session: context.current })
        if (selection === 'returned') {
          context.current = session
          context.sessionBinding.begin()
          context.sessionBinding.attach(context.sessionBinding.capture(), { session: context.current })
        }
      }
      reject(new Error('earlier refresh failed'))
      await work
      await Promise.resolve()
      expect(shown).toBe(selection === 'current' ? 'earlier refresh failed' : 'ready')
    }
  },
)

it('invalidates the attention inbox after completed, parked and cancelled turns', async () => {
  const session = { id: 'reminder' } as Session
  const binding = new SessionBindingOwner()
  const context = {
    sessionBinding: binding,
    refreshSessionControls: async () => {},
    sessionTitles: new Map([['reminder', 'Reminder']]),
    receipts: new Map(),
  }
  const controller = createSessionController(context as never, binding)
  const changed = vi.fn()
  window.addEventListener('agnes:automation-invalidated', changed)
  try {
    for (const [seq, reason] of ['completed', 'parked', 'cancelled'].entries()) {
      await controller.followEvent(session, {
        seq: seq + 1,
        ts: '2026-10-24T00:00:00Z',
        type: 'turn/end',
        data: { reason, lastAssistantSeq: null },
      } as unknown as LedgerEvent)
      expect(changed).toHaveBeenCalledTimes(seq + 1)
    }
    await controller.followEvent(session, {
      seq: 4,
      ts: '2026-10-24T00:00:00Z',
      type: 'assistant/usage',
      data: {},
    } as LedgerEvent)
    expect(changed).toHaveBeenCalledTimes(3)
  } finally {
    window.removeEventListener('agnes:automation-invalidated', changed)
  }
})
