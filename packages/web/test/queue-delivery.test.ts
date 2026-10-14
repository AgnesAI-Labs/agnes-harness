/** @vitest-environment happy-dom */

import { expect, it, vi } from 'vitest'
import { createCommandController } from '../src/app/command-controller.js'
import { createSubmissionController } from '../src/app/submission-controller.js'
import { enT } from './helpers/locale.js'

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

function submission(session: ReturnType<typeof runningSession>, draft = '补充一条') {
  const context = {
    current: session,
    projection: { sessionId: session.id, opState: { phase: 'model' }, pendingInputs: [] },
    sessionControls: {
      sessionId: session.id,
      value: { controls: { steer: true, interrupt: true, pause: true, cancel: true } },
    },
    composerRuntime: {
      getDraft: () => draft,
      setDraft: vi.fn(),
      getAttachmentBlocks: () => [],
      clearImageBlocks: vi.fn(),
      hasPendingImages: () => false,
    },
    references: { getSnapshot: () => [], clear: vi.fn() },
    configured: true,
    connected: true,
    selectedModelAvailable: () => true,
    permissionChangePending: false,
    permissionRefreshPending: false,
    sessionYoloEnabled: false,
    sending: false,
    stopping: false,
    sessionPending: false,
    runtimeModels: [],
    recoveredReturns: new Set<string>(),
    submissionGeneration: 0,
    permissionConnectionEpoch: 0,
    selection: 1,
    notice: { setText: vi.fn(), setKind: vi.fn() },
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
  return createSubmissionController(context as unknown as Parameters<typeof createSubmissionController>[0])
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

function commands(session: ReturnType<typeof runningSession>) {
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
    selection: 1,
    queueAction: undefined as
      | undefined
      | {
          kind: string
          itemId: string
          pending: boolean
          error?: string
          sessionId: string
          selection: number
        },
    projection: { sessionId: session.id, pendingInputs: [{ itemId: 'q1', preview: '主色换成深蓝' }] },
    controlsHistory: new Map(),
    controlsRefresh: 0,
    live: { refresh: vi.fn() },
    renderControls: vi.fn(),
    render: vi.fn(),
    showError: vi.fn(),
    t: enT,
  }
  const controller = createCommandController(
    context as unknown as Parameters<typeof createCommandController>[0],
  )
  return { context, controller }
}

it('promotes a queued follow-up to guidance with its full content, attachments included', async () => {
  const session = runningSession()
  const { context, controller } = commands(session)
  controller.handleQueuedAction('q1', 'promote')
  expect(context.queueAction).toMatchObject({ kind: 'promote', itemId: 'q1', pending: true })
  await vi.waitFor(() => expect(context.queueAction?.pending).toBe(false))
  expect(session.removeQueued).toHaveBeenCalledWith('q1')
  expect(session.steer).toHaveBeenCalledWith([
    { type: 'text', text: '主色换成深蓝' },
    { type: 'image', mimeType: 'image/png', data: 'AA==' },
  ])
  expect(session.removeQueued.mock.invocationCallOrder[0]).toBeLessThan(
    session.steer.mock.invocationCallOrder[0] ?? 0,
  )
  expect(session.followUp).not.toHaveBeenCalled()
  expect(session.interrupt).not.toHaveBeenCalled()
})

it('puts the message back in the queue when the guidance is refused after its removal', async () => {
  const session = runningSession()
  session.steer.mockRejectedValueOnce(new Error('steer refused'))
  const { context, controller } = commands(session)
  controller.handleQueuedAction('q1', 'promote')
  await vi.waitFor(() => expect(context.queueAction?.error).toBe('steer refused'))
  expect(session.followUp).toHaveBeenCalledWith([
    { type: 'text', text: '主色换成深蓝' },
    { type: 'image', mimeType: 'image/png', data: 'AA==' },
  ])
})

it('still interrupts with a queued message', async () => {
  const session = runningSession()
  const { context, controller } = commands(session)
  controller.handleQueuedAction('q1', 'sendNow')
  await vi.waitFor(() => expect(context.queueAction?.pending).toBe(false))
  expect(session.interrupt).toHaveBeenCalledWith('q1')
  expect(session.removeQueued).not.toHaveBeenCalled()
})
