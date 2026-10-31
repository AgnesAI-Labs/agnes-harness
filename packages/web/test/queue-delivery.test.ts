import type { Session } from '@agnes/sdk/browser'
import { SessionBindingOwner } from '../src/app/session-owner.js'
import { SubmissionOwner } from '../src/app/submission-owner.js'
/** @vitest-environment happy-dom */

import { createClient, type JsonRpcMessage, memoryJournal, type PendingCommand } from '@agnes/sdk'
import { localStorageJournal } from '@agnes/sdk/browser'
import { expect, it, vi } from 'vitest'
import { createCommandController } from '../src/app/command-controller.js'
import { showCommandFeedback } from '../src/app/command-feedback.js'
import { createSubmissionController } from '../src/app/submission-controller.js'
import { enT, zhT } from './helpers/locale.js'

// While the agent runs, Enter queues a follow-up (sent when the turn ends) and ⌘/Ctrl+Enter sends
// guidance (a steer, joining when the current step ends). A queued follow-up can be promoted to
// guidance, and interrupting stays available.

function runningSession() {
  return {
    id: 'session',
    steer: vi.fn(async () => 2),
    followUp: vi.fn(async () => 2),
    prompt: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => 2),
    promoteQueued: vi.fn(async () => 2),
    pendingCommands: vi.fn(async (): Promise<PendingCommand[]> => []),
    checkCommand: vi.fn(async (_commandId: string) => {}),
    removeQueued: vi.fn(async () => 2),
    controls: vi.fn(async () => ({
      facts: [],
      factsThrough: 1,
      controls: { steer: true, interrupt: true, pause: true, cancel: true },
      paused: false,
      pending: [
        {
          itemId: 'q1',
          target: 'next-turn',
          kind: 'follow_up',
          content: [
            { type: 'text', text: '主色换成深蓝' },
            { type: 'image', mimeType: 'image/png', data: 'AA==' },
          ],
        },
      ],
    })),
  }
}

function submission(
  session: ReturnType<typeof runningSession>,
  draft = '补充一条',
  references: readonly { source: string; id: string; label: string }[] = [],
) {
  const sessionBinding = new SessionBindingOwner()
  const context = {
    current: session,
    projection: { sessionId: session.id, opState: { phase: 'model' }, pendingInputs: [] },
    sessionControls: {
      sessionId: session.id,
      value: { controls: { steer: true, interrupt: true, pause: true, cancel: true } },
    },
    composerRuntime: {
      getDraft: () => draft,
      setDraft: vi.fn((value: string) => {
        draft = value
      }),
      restoreAttachmentBlocks: vi.fn(),
      getAttachmentBlocks: () => [],
      clearImageBlocks: vi.fn(),
      hasPendingImages: () => false,
    },
    references: { getSnapshot: () => references, clear: vi.fn(), restore: vi.fn() },
    configured: true,
    connected: true,
    selectedModelAvailable: () => true,
    permissionChangePending: false,
    permissionRefreshPending: false,
    sessionYoloEnabled: false,
    stopping: false,
    sessionPending: false,
    runtimeModels: [],
    recoveredReturns: new Set<string>(),
    permissionConnectionEpoch: 0,
    sessionBinding,
    submissions: new SubmissionOwner(sessionBinding),
    notice: {
      setText: vi.fn(),
      setKind: vi.fn(),
      offer: vi.fn<(action: { label: string; run(): void }) => void>(),
    },
    renderer: { pinToBottom: vi.fn() },
    renderControls: vi.fn(),
    render: vi.fn(),
    showError: vi.fn(),
    sessionTitles: new Map(),
    titleRefresh: { start: vi.fn() },
    live: { refresh: vi.fn() },
    clientModules: { locale: { getSnapshot: () => 'zh-CN' } },
    composerDraftKey: 'draft',
    t: enT,
  }
  context.sessionBinding.attach(context.sessionBinding.capture(), { session: session as unknown as Session })
  return {
    ...createSubmissionController(context as unknown as Parameters<typeof createSubmissionController>[0]),
    context,
  }
}

it('queues Enter as a follow-up while the agent runs', async () => {
  const session = runningSession()
  submission(session).submitComposer()
  await vi.waitFor(() => expect(session.followUp).toHaveBeenCalledTimes(1))
  expect(session.followUp).toHaveBeenCalledWith([{ type: 'text', text: '补充一条' }], { references: [] })
  expect(session.steer).not.toHaveBeenCalled()
  expect(session.prompt).not.toHaveBeenCalled()
})

it('sends ⌘/Ctrl+Enter as guidance (a steer) while the agent runs', async () => {
  const session = runningSession()
  submission(session).submitComposer({ steer: true })
  await vi.waitFor(() => expect(session.steer).toHaveBeenCalledTimes(1))
  expect(session.steer).toHaveBeenCalledWith([{ type: 'text', text: '补充一条' }], { references: [] })
  expect(session.followUp).not.toHaveBeenCalled()
})

it('sends a reference-only follow-up without duplicating its internal locator as message text', async () => {
  const session = runningSession()
  submission(session, '', [
    { source: 'session', id: 'agent:prior-turn', label: 'Earlier discussion' },
  ]).submitComposer()
  await vi.waitFor(() => expect(session.followUp).toHaveBeenCalledTimes(1))
  expect(session.followUp).toHaveBeenCalledWith([], {
    references: [{ source: 'session', id: 'agent:prior-turn' }],
  })
})

function commands(session: ReturnType<typeof runningSession>) {
  const sessionBinding = new SessionBindingOwner()
  const context = {
    current: session,
    connected: true,
    configured: true,
    selectedModelAvailable: () => true,
    sessionPending: false,
    stopping: false,
    permissionChangePending: false,
    permissionRefreshPending: false,
    sessionYoloEnabled: false,
    sessionBinding,
    submissions: new SubmissionOwner(sessionBinding),
    projection: { sessionId: session.id, pendingInputs: [{ itemId: 'q1', preview: '主色换成深蓝' }] },
    controlsHistory: new Map(),
    live: { refresh: vi.fn() },
    renderControls: vi.fn(),
    render: vi.fn(),
    showError: vi.fn(),
    notice: {
      setText: vi.fn(),
      setKind: vi.fn(),
      offer: vi.fn<(action: { label: string; run(): void }) => void>(),
    },
    t: enT,
  }
  context.sessionBinding.attach(context.sessionBinding.capture(), { session: session as unknown as Session })
  const controller = createCommandController(
    context as unknown as Parameters<typeof createCommandController>[0],
  )
  return { context, controller }
}

it('promotes a queued follow-up to guidance with its full content, attachments included', async () => {
  const session = runningSession()
  const { context, controller } = commands(session)
  controller.handleQueuedAction('q1', 'promote')
  expect(context.submissions.queueAction).toMatchObject({ kind: 'promote', itemId: 'q1', pending: true })
  await vi.waitFor(() => expect(context.submissions.queueAction?.pending).toBe(false))
  expect(session.promoteQueued).toHaveBeenCalledWith('q1')
  expect(session.removeQueued).not.toHaveBeenCalled()
  expect(session.steer).not.toHaveBeenCalled()
  expect(session.followUp).not.toHaveBeenCalled()
  expect(session.interrupt).not.toHaveBeenCalled()
})

it('leaves a refused promotion to the backend without client compensation', async () => {
  const session = runningSession()
  session.promoteQueued.mockRejectedValueOnce(new Error('steer refused'))
  const { context, controller } = commands(session)
  controller.handleQueuedAction('q1', 'promote')
  await vi.waitFor(() => expect(context.submissions.queueAction?.error).toBe('steer refused'))
  expect(session.removeQueued).not.toHaveBeenCalled()
  expect(session.steer).not.toHaveBeenCalled()
  expect(session.followUp).not.toHaveBeenCalled()
})

it('still interrupts with a queued message', async () => {
  const session = runningSession()
  const { context, controller } = commands(session)
  controller.handleQueuedAction('q1', 'sendNow')
  await vi.waitFor(() => expect(context.submissions.queueAction?.pending).toBe(false))
  expect(session.interrupt).toHaveBeenCalledWith('q1')
  expect(session.removeQueued).not.toHaveBeenCalled()
})

// Real public SDK plus real controllers, with an in-process synthetic server.
async function auditSession(outcome: 'overloaded' | 'uncertain' = 'overloaded') {
  let known = false
  const accepted: Array<{ commandId: string; kind: string; payload: unknown }> = []
  const attempts: unknown[] = []
  let end!: () => void
  const closed = new Promise<void>((resolve) => {
    end = resolve
  })
  const journal = memoryJournal('audit')
  const client = createClient({
    journal,
    transport: {
      kind: 'inproc',
      endpoint: {
        notifications: {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                await closed
                return { done: true as const, value: undefined }
              },
            }
          },
        },
        async close() {
          end()
        },
        async handle(message: JsonRpcMessage) {
          if (!('id' in message) || !('method' in message) || message.id === undefined) return undefined
          const result = (value: unknown) => ({ jsonrpc: '2.0' as const, id: message.id, result: value })
          if (message.method === 'initialize')
            return result({
              protocolVersion: 1,
              agentCapabilities: {},
              _meta: { agnes: { agnesVersion: 'test' } },
            })
          if (message.method === 'session/new') return result({ sessionId: 'session' })
          if (message.method === '_agnes/v1/workspace.add')
            return result({
              workspace: {
                path: '/synthetic',
                name: 'test',
                available: true,
                lastUsedAt: null,
                sessionCount: 0,
              },
            })
          if (message.method === '_agnes/v1/submit.ack') return result({})
          if (message.method === '_agnes/v1/submit') {
            attempts.push(message.params)
            if (!known)
              return outcome === 'uncertain'
                ? result({ replayed: false, status: 'uncertain' })
                : {
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: -32001, message: 'OVERLOADED', data: { code: 'OVERLOADED' } },
                  }
            accepted.push(message.params as (typeof accepted)[number])
            return result({ seq: 9, replayed: false })
          }
          throw new Error(`unexpected test method ${message.method}`)
        },
      },
    },
  })
  return {
    client,
    session: await client.session.new({ cwd: '/synthetic' }),
    journal,
    accepted,
    attempts,
    settle: () => {
      known = true
    },
  }
}

it.each(['overloaded', 'uncertain'] as const)(
  'does not restore an SDK-owned %s send and checks its original identity without duplicates',
  async (outcome) => {
    const s = await auditSession(outcome)
    try {
      const controller = submission(s.session as unknown as ReturnType<typeof runningSession>, 'run once')
      controller.submitComposer()
      await vi.waitFor(() => expect(controller.context.submissions.sending).toBe(false))
      expect(controller.context.composerRuntime.getDraft()).toBe('')
      expect(await s.journal.pending('session')).toHaveLength(1)
      expect(controller.context.notice.setText).toHaveBeenCalledWith(
        enT(outcome === 'uncertain' ? 'app.command.unconfirmed' : 'app.command.pending'),
      )
      // Even explicitly retyping cannot create a second command while the SDK owns the first.
      controller.context.composerRuntime.setDraft('run once')
      controller.submitComposer()
      await vi.waitFor(() => expect(controller.context.submissions.sending).toBe(false))
      expect(s.attempts).toHaveLength(1)
      s.settle()
      expect(controller.context.notice.offer.mock.calls.length).toBeGreaterThanOrEqual(2)
      const action = controller.context.notice.offer.mock.calls.at(-1)?.[0]
      if (!action) throw new Error('missing check action')
      action.run()
      await vi.waitFor(() => expect(s.accepted).toHaveLength(1))
      expect(s.attempts[1]).toEqual(s.attempts[0])
      expect(await s.journal.pending('session')).toEqual([])
    } finally {
      await s.client.close()
    }
  },
)

it.each(['overloaded', 'uncertain'] as const)(
  'promotes with one SDK command under %s, never a compensating follow-up or steer',
  async (outcome) => {
    const s = await auditSession(outcome)
    try {
      const live = runningSession()
      live.promoteQueued = s.session.promoteQueued.bind(s.session) as typeof live.promoteQueued
      live.pendingCommands = s.session.pendingCommands.bind(s.session) as typeof live.pendingCommands
      live.checkCommand = s.session.checkCommand.bind(s.session) as typeof live.checkCommand
      const { context, controller } = commands(live)
      controller.handleQueuedAction('q1', 'promote')
      await vi.waitFor(() => expect(context.submissions.queueAction?.pending).toBe(false))
      expect(s.accepted).toEqual([])
      expect(await s.journal.pending('session')).toHaveLength(1)
      expect(live.removeQueued).not.toHaveBeenCalled()
      expect(live.steer).not.toHaveBeenCalled()
      expect(live.followUp).not.toHaveBeenCalled()
      controller.handleQueuedAction('q1', 'promote')
      await vi.waitFor(() => expect(context.submissions.queueAction?.pending).toBe(false))
      expect(s.attempts).toHaveLength(1)
      s.settle()
      const [pending] = await s.journal.pending('session')
      if (!pending) throw new Error('missing pending command')
      await s.session.checkCommand(pending.commandId)
      expect(s.accepted).toHaveLength(1)
      expect(s.accepted[0]).toMatchObject({ kind: 'control', payload: { action: 'promote', itemId: 'q1' } })
      expect(s.attempts[1]).toEqual(s.attempts[0])
    } finally {
      await s.client.close()
    }
  },
)

it('reconstructs unconfirmed feedback after journal reopen and keeps it scoped to its session', async () => {
  const key = 'synthetic-command-feedback'
  sessionStorage.removeItem(key)
  const journal = localStorageJournal(sessionStorage, key)
  await journal.markPending('session', {
    commandId: 'unknown',
    method: '_agnes/v1/submit',
    params: {
      clientId: await journal.clientId(),
      commandId: 'unknown',
      kind: 'steer',
      payload: { sessionId: 'session', content: [{ type: 'text', text: 'once' }] },
    },
    state: 'needs-confirmation',
  })
  const reopened = localStorageJournal(sessionStorage, key)
  const session = { ...runningSession(), pendingCommands: () => reopened.pending('session') }
  const { context } = commands(session as ReturnType<typeof runningSession>)
  context.t = zhT
  await showCommandFeedback(
    context as unknown as Parameters<typeof showCommandFeedback>[0],
    session as unknown as Parameters<typeof showCommandFeedback>[1],
  )
  expect(context.notice.setText).toHaveBeenLastCalledWith('结果未确认，请核对')
  expect(context.notice.offer).toHaveBeenLastCalledWith(expect.objectContaining({ label: '核对' }))
  context.current = runningSession()
  context.sessionBinding.begin()
  context.sessionBinding.attach(context.sessionBinding.capture(), {
    session: context.current as unknown as Session,
  })
  context.notice.setText.mockClear()
  await showCommandFeedback(
    context as unknown as Parameters<typeof showCommandFeedback>[0],
    session as unknown as Parameters<typeof showCommandFeedback>[1],
  )
  expect(context.notice.setText).not.toHaveBeenCalled()
  sessionStorage.removeItem(key)
})
