/** @vitest-environment happy-dom */
import { type ContentBlock, USER_MESSAGE_ATTACHMENT_LIMITS } from '@agnes/protocol'
import type { Session } from '@agnes/sdk/browser'
import { attachmentErrorMessage } from '@agnes/web-units'
import { describe, expect, it, vi } from 'vitest'
import { SessionBindingOwner } from '../src/app/session-owner.js'
import { createSubmissionController } from '../src/app/submission-controller.js'
import { Submission, SubmissionOwner } from '../src/app/submission-owner.js'
import { ComposerDrafts } from '../src/composer-drafts.js'
import { type DraftPermissionInput, newSessionRequest } from '../src/session-permission.js'
import { enT, zhT } from './helpers/locale.js'

describe('composer submission validation', () => {
  it.each([
    [enT, 'A message can hold at most 50 attachments.'],
    [zhT, '一条消息最多添加 50 个附件。'],
  ] as const)(
    'keeps the draft and reports a real validator refusal in the interface language',
    (t, message) => {
      const attachments: ContentBlock[] = Array.from(
        { length: USER_MESSAGE_ATTACHMENT_LIMITS.maxCount + 1 },
        () => ({ type: 'file', name: 'fixture.txt', mimeType: 'text/plain', data: 'eA==' }),
      )
      let draft = 'keep this draft'
      let sent = false
      let refusal: string | undefined
      const context = {
        current: {
          id: 'fixture-session',
          prompt: async () => {
            sent = true
          },
        },
        composerRuntime: {
          getDraft: () => draft,
          setDraft: (value: string) => {
            draft = value
          },
          getAttachmentBlocks: () => attachments,
          hasPendingImages: () => false,
          clearImageBlocks: () => {
            attachments.length = 0
          },
        },
        references: { getSnapshot: () => [] },
        configured: true,
        connected: true,
        submissions: new SubmissionOwner(new SessionBindingOwner()),
        stopping: false,
        sessionPending: false,
        sessionYoloEnabled: false,
        selectedModelAvailable: () => true,
        runtimeModels: [],
        t,
        showError: (error: unknown) => {
          refusal = attachmentErrorMessage(error, t)
        },
      } as unknown as Parameters<typeof createSubmissionController>[0]
      createSubmissionController(context).submitComposer()
      expect(sent).toBe(false)
      expect(draft).toBe('keep this draft')
      expect(attachments).toHaveLength(USER_MESSAGE_ATTACHMENT_LIMITS.maxCount + 1)
      expect(refusal).toBe(message)
    },
  )
})

describe('new session request', () => {
  const runtime: DraftPermissionInput['runtime'] = {
    providers: [],
    presets: ['standard', 'minimal', 'ptc'].map((id) => ({ id, isDefault: id === 'standard' })),
    permissions: [
      { id: 'read-only', isDefault: false },
      { id: 'workspace-write', isDefault: true },
    ],
    localPluginFolders: { home: '/synthetic/plugins', workspace: '/synthetic/workspace/plugins' },
  }
  it.each([
    ['a chosen level', { explicit: 'view' }, { preset: 'standard', permission: 'read-only' }],
    ['a recipe alone', { preset: 'ptc' }, { preset: 'ptc', permission: 'default' }],
    [
      'both',
      { preset: 'minimal', explicit: 'workspace' },
      { preset: 'minimal', permission: 'workspace-write' },
    ],
    ['nothing chosen', {}, { preset: 'standard', permission: 'default' }],
    ['an application default agent', { agent: 'devboard.coordinator' }, { agent: 'devboard.coordinator' }],
    [
      'a chosen recipe over the application agent',
      { agent: 'devboard.coordinator', preset: 'ptc' },
      { preset: 'ptc', permission: 'default' },
    ],
  ] as const)('sends %s from every creation path', async (_case, choice, expected) => {
    const binding = new SessionBindingOwner()
    const loop = { id: 'synthetic-loop', version: '1' }
    const created = vi.fn(async () => {
      throw new Error('stop after the request')
    })
    const context = {
      current: undefined,
      draftingNew: true,
      selectedWorkspace: { path: '/synthetic/work', available: true },
      sessionPending: false,
      sessionBinding: binding,
      renderControls() {},
      draftLoopAvailable: () => true,
      loopCatalogPending: false,
      draftBundles: [],
      draftLoop: loop,
      runtimeCatalog: runtime,
      draftSessionRequest: () =>
        newSessionRequest({
          remembered: undefined,
          defaults: undefined,
          runtime,
          explicit: undefined,
          preset: undefined,
          ...(choice as Partial<DraftPermissionInput>),
        }),
      client: { session: { new: created } },
      t: (key: string) => key,
      settingsText: (key: string) => key,
    } as unknown as Parameters<typeof createSubmissionController>[0]
    const controller = createSubmissionController(context)
    await expect(controller.prepareComposerSession()).rejects.toThrow('stop after the request')
    await expect(controller.prepareAttachmentSession()).rejects.toThrow('stop after the request')
    for (const [request] of created.mock.calls as unknown as [Record<string, unknown>][])
      expect(request).toEqual({
        cwd: '/synthetic/work',
        sessionKey: expect.any(String),
        ...('agent' in expected ? {} : { loop }),
        ...expected,
      })
    expect(created).toHaveBeenCalledTimes(2)
  })

  it.each(['prepareComposerSession', 'prepareAttachmentSession'] as const)(
    'keeps a skill prompt and edits made during %s creation',
    async (method) => {
      const binding = new SessionBindingOwner()
      const drafts = new ComposerDrafts(sessionStorage, location.origin)
      let text = drafts.select('fixture', undefined, '')
      text = 'Use $fixture-skill to review the attachment'
      let created!: (session: Session) => void
      const session = { id: 'upload-session' } as Session
      const context = {
        current: undefined as Session | undefined,
        draftingNew: true,
        selectedWorkspace: { path: '/synthetic/work', available: true },
        sessionPending: false,
        sessionBinding: binding,
        renderControls() {},
        draftLoopAvailable: () => true,
        loopCatalogPending: false,
        draftBundles: [],
        draftSessionRequest: () => ({ preset: 'standard', permission: 'default' }),
        client: {
          session: {
            new: () =>
              new Promise<Session>((resolve) => {
                created = resolve
              }),
          },
        },
        // The session controller selects the new session's draft as it opens it.
        open: async (id: string, options: { preserveSending?: boolean; carryDraft?: boolean }) => {
          text = drafts.select('fixture', id, text, {
            ...(options.preserveSending ? { preserve: true } : {}),
            ...(options.carryDraft ? { carry: true } : {}),
          })
          const { binding: next } = binding.begin(id)
          binding.attach(next, { session })
          context.current = session
        },
        t: (key: string) => key,
        settingsText: (key: string) => key,
      }
      const controller = createSubmissionController(
        context as unknown as Parameters<typeof createSubmissionController>[0],
      )
      const opening = controller[method]()
      text += '\nKeep my latest edit too.'
      const visible = text
      created(session)
      await opening
      expect(text).toBe(visible)
      expect(context.current?.id).toBe('upload-session')
      sessionStorage.clear()
    },
  )

  it('creates nothing when the deployment refuses the chosen level', async () => {
    const created = vi.fn()
    const context = {
      current: undefined,
      draftingNew: true,
      selectedWorkspace: { path: '/synthetic/work', available: true },
      sessionPending: false,
      sessionBinding: new SessionBindingOwner(),
      renderControls() {},
      draftLoopAvailable: () => true,
      loopCatalogPending: false,
      draftBundles: [],
      draftSessionRequest: () =>
        newSessionRequest({
          explicit: 'full',
          remembered: undefined,
          preset: undefined,
          defaults: undefined,
          runtime,
        }),
      client: { session: { new: created } },
      t: (key: string) => key,
      settingsText: (key: string) => key,
    } as unknown as Parameters<typeof createSubmissionController>[0]
    await expect(createSubmissionController(context).prepareComposerSession()).rejects.toThrow('notAllowed')
    expect(created).not.toHaveBeenCalled()
  })
})

describe('submission owners', () => {
  it('owns draft, submitting and accepted transitions and dispatches a single intent once', async () => {
    const binding = new SessionBindingOwner()
    const submission = new Submission(binding.capture())
    expect(submission.snapshot.phase).toBe('draft')
    const sent: string[] = []
    let accept!: () => void
    const receipt = new Promise<void>((resolve) => {
      accept = resolve
    })
    const work = submission.run(async () => {
      sent.push('original command')
      await receipt
    })
    const duplicate = submission.run(async () => {
      sent.push('duplicate command')
    })
    expect(submission.snapshot.phase).toBe('submitting')
    expect(duplicate).toBe(work)
    await Promise.resolve()
    expect(sent).toEqual(['original command'])
    accept()
    await work
    expect(submission.snapshot.phase).toBe('accepted')
    expect(submission.pending).toBe(false)
  })

  it.each(['failed', 'refused', 'needs-confirmation'] as const)('retains the %s outcome', async (phase) => {
    const binding = new SessionBindingOwner()
    const submission = new Submission(binding.capture())
    const error = Object.assign(
      new Error('fixture refusal'),
      phase === 'refused'
        ? { data: { code: 'LOOP_CONTROL_UNSUPPORTED' } }
        : phase === 'needs-confirmation'
          ? { submission: { sessionId: 'session', commandId: 'original', state: 'needs-confirmation' } }
          : {},
    )
    await expect(
      submission.run(async () => {
        throw error
      }),
    ).rejects.toBe(error)
    expect(submission.snapshot.phase).toBe(phase)
    if (phase === 'needs-confirmation') expect(submission.snapshot.command?.commandId).toBe('original')
  })

  it('scopes pending composer and queue work to the binding and preserves only an explicit draft handoff', () => {
    const binding = new SessionBindingOwner()
    const owner = new SubmissionOwner(binding)
    const composer = owner.beginComposer(true)
    const queue = owner.beginQueue({ itemId: 'q', kind: 'promote' })
    if (!composer || !queue) throw new Error('missing submission')
    expect(owner.beginComposer(true)).toBeUndefined()
    expect(owner.beginQueue({ itemId: 'q', kind: 'promote' })).toBeUndefined()
    const next = binding.begin()
    expect(owner.sending).toBe(false)
    expect(owner.queueAction).toBeUndefined()
    composer.adopt(next.binding)
    expect(owner.sending).toBe(true)
    owner.promptStarted()
    expect(composer.snapshot.phase).toBe('accepted')
    expect(owner.sending).toBe(false)
    expect(owner.isCurrent(queue)).toBe(false)
  })
})

it('recovers journaled identity after reload and shares concurrent checks of the original command', async () => {
  const binding = new SessionBindingOwner()
  let commands: import('@agnes/sdk/browser').PendingCommand[] = [
    { commandId: 'original', method: '_agnes/v1/submit', params: {}, state: 'needs-confirmation' },
  ]
  const checked: string[] = []
  let release!: () => void
  const receipt = new Promise<void>((resolve) => {
    release = resolve
  })
  const session = {
    id: 'session',
    pendingCommands: async () => commands,
    checkCommand: async (id: string) => {
      checked.push(id)
      await receipt
      commands = []
    },
  } as unknown as import('@agnes/sdk/browser').Session
  binding.attach(binding.capture(), { session })
  const reopened = new SubmissionOwner(binding)
  const [submission] = (await reopened.recover(session)) ?? []
  if (!submission) throw new Error('missing recovered submission')
  expect(submission.snapshot).toMatchObject({
    phase: 'needs-confirmation',
    command: { commandId: 'original' },
  })
  const duplicate: string[] = []
  await expect(
    submission.run(async () => {
      duplicate.push('fresh send')
    }),
  ).rejects.toThrow('requires confirmation')
  expect(duplicate).toEqual([])
  const first = submission.check(session)
  const second = submission.check(session)
  expect(first).toBe(second)
  release()
  await first
  expect(checked).toEqual(['original'])
  expect(submission.snapshot.phase).toBe('accepted')
  expect(await reopened.recover(session)).toEqual([])
})

it('rejects a late recovery read after reloading the same SDK session', async () => {
  const binding = new SessionBindingOwner()
  let finish!: (commands: import('@agnes/sdk/browser').PendingCommand[]) => void
  const pending = new Promise<import('@agnes/sdk/browser').PendingCommand[]>((resolve) => {
    finish = resolve
  })
  const session = {
    id: 'session',
    pendingCommands: () => pending,
  } as unknown as import('@agnes/sdk/browser').Session
  binding.attach(binding.capture(), { session })
  const owner = new SubmissionOwner(binding)
  const work = owner.recover(session)
  binding.begin()
  binding.attach(binding.capture(), { session })
  finish([{ commandId: 'old', method: '_agnes/v1/submit', params: {}, state: 'needs-confirmation' }])
  expect(await work).toBeUndefined()
})

it('records a definitive refusal when checking clears the SDK journal', async () => {
  const binding = new SessionBindingOwner()
  const submission = new Submission(binding.capture())
  submission.restore('session', {
    commandId: 'original',
    method: '_agnes/v1/submit',
    params: {},
    state: 'needs-confirmation',
  })
  const refusal = Object.assign(new Error('not running'), { data: { code: 'SESSION_NOT_RUNNING' } })
  const session = {
    id: 'session',
    checkCommand: async () => {
      throw refusal
    },
    pendingCommands: async () => [],
  } as unknown as import('@agnes/sdk/browser').Session
  await submission.check(session)
  expect(submission.snapshot).toEqual({ phase: 'refused', error: refusal })
})

describe('retry of a failed turn', () => {
  const userContent: ContentBlock[] = [{ type: 'text', text: 'hello again' }]
  const failedTurn = {
    id: 'turn:9',
    turn: 9,
    startSeq: 1,
    endSeq: 2,
    startedAt: '2026-10-21T00:00:00.000Z',
    endedAt: '2026-10-21T00:00:01.000Z',
    status: 'failed',
    reason: 'error',
    error: { code: 'TRANSPORT', message: 'status=500' },
    nodeIds: ['user:1', 'assistant:1'],
    inherited: false,
    forkable: false,
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: false,
      billingComplete: false,
      calls: [],
    },
  } as import('@agnes/protocol').UITurn

  function retryContext(options: { connected?: boolean } = {}) {
    const prompt = vi.fn(async () => ({ reason: 'completed' }))
    const shown: unknown[] = []
    const binding = new SessionBindingOwner()
    const session = { id: 'fixture-session', prompt, pendingCommands: async () => [] }
    binding.attach(binding.capture(), {
      session: session as unknown as import('@agnes/sdk/browser').Session,
    })
    const context = {
      current: session,
      sessionBinding: binding,
      projection: {
        nodes: [
          { kind: 'user', id: 'user:1', seq: 1, content: userContent },
          { kind: 'assistant', id: 'assistant:1', seq: 2, text: 'partial' },
        ],
        opState: null,
      },
      configured: true,
      connected: options.connected ?? true,
      stopping: false,
      sessionPending: false,
      sessionYoloEnabled: false,
      permissionChangePending: false,
      permissionRefreshPending: false,
      permissionConnectionEpoch: 0,
      sessionControls: undefined,
      sessionTitles: new Map<string, string>(),
      titleRefresh: { start: vi.fn() },
      submissions: new SubmissionOwner(binding),
      notice: { setText: vi.fn(), setKind: vi.fn() },
      recoveredReturns: new Set<string>(),
      renderer: { pinToBottom: vi.fn() },
      renderControls: vi.fn(),
      render: vi.fn(),
      live: undefined,
      intentionalClose: false,
      composerRuntime: { getDraft: () => '', getAttachmentBlocks: () => [], hasPendingImages: () => false },
      references: { getSnapshot: () => [], restore: vi.fn() },
      clientModules: { locale: { getSnapshot: () => 'en' } },
      selectedModelAvailable: () => true,
      t: (key: string) => key,
      showError: (error: unknown) => shown.push(error),
    } as unknown as Parameters<typeof createSubmissionController>[0]
    return { controller: createSubmissionController(context), prompt, shown }
  }

  it('sends the turn user content again through the shared submission path', async () => {
    const { controller, prompt, shown } = retryContext()
    await controller.retryTurn(failedTurn)
    expect(shown).toEqual([])
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith(userContent, { references: [], titleLocale: 'en' })
  })

  it('refuses while the connection is down', async () => {
    const { controller, prompt } = retryContext({ connected: false })
    await controller.retryTurn(failedTurn)
    expect(prompt).not.toHaveBeenCalled()
  })

  it('refuses when the failed turn has no principal user node in the window', async () => {
    const { controller, prompt } = retryContext()
    await controller.retryTurn({ ...failedTurn, nodeIds: ['assistant:1'], startSeq: 0, endSeq: 0 })
    expect(prompt).not.toHaveBeenCalled()
  })
})
