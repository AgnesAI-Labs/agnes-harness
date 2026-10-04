import {
  createWorkspaceInvocationPort,
  Kernel,
  MemoryStorage,
  presetDefaults,
  type SessionImpl,
} from '@agnes/core'
import {
  actor,
  fakeProvider,
  fakeSeams,
  fencedFs,
  noTimers,
  shellTool,
  testFsPolicy,
  textTurn,
  toolTurn,
} from '@agnes/core/testkit'
import type { ToolContext, ToolDef } from '@agnes/extension-api'
import { type QuestionAnswer, type QuestionInteraction, validateEvent } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { HostQuestions, type QuestionProvider } from '../src/questions.js'

const request = {
  questions: [{ id: 'choice', question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }],
}
const answer: QuestionAnswer = { answers: [{ id: 'choice', selected: ['甲'], custom: '  保留原文👩🏽‍💻  ' }] }
const kernels: Kernel[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const kernel of kernels.splice(0)) await kernel.close().catch(() => undefined)
})

async function fixture(
  options: { provider?: QuestionProvider | null; timeoutMs?: number; nested?: boolean } = {},
) {
  let liveKernel: Kernel | undefined
  const questions = new HostQuestions(
    (key) => liveKernel?.sessions.get(key),
    options.provider === null ? undefined : (options.provider ?? (async () => ({ allowSkip: false }))),
  )
  const storage = new MemoryStorage()
  const preset = presetDefaults()
  preset.tools.timeoutMs = options.timeoutMs ?? 30_000
  const seams = fakeSeams()
  const fsOps = fencedFs(
    {
      read: async () => new Uint8Array(),
      write: async () => {},
      list: async () => [],
      stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
    },
    testFsPolicy('/w'),
  )
  const workspaceInvocation = createWorkspaceInvocationPort(() => ({
    source: {
      root: '/w',
      fs: fsOps,
      ready: async () => ({ confine: async (argv) => [...argv] }),
      hookSnapshot: async () => ({ workspaceDigest: 'test', policyRevision: 'test', hooks: [] }),
      hookSandbox: seams.sandbox,
      approval: seams.approval,
      checkpoint: seams.checkpoint,
    },
    release: () => undefined,
  }))
  const kernel = Kernel.create({
    storage,
    preset,
    seams: fakeSeams(),
    provider: fakeProvider([
      toolTurn(options.nested ? 'outer_question' : 'question_tool', {}),
      textTurn('continued'),
      toolTurn('question_tool', {}),
      textTurn('fork continued'),
    ]),
    fsOps: fencedFs(
      {
        read: async () => new Uint8Array(),
        write: async () => {},
        list: async () => [],
        stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
      },
      testFsPolicy('/w'),
    ),
    netFetch: async () => new Response(''),
    contract: { contract_id: null, parser_version: '1' },
    timers: noTimers,
    toolQuestions: (session, invocation) => questions.ask(session, invocation),
    toolQuestionsDrain: (session) => questions.drain(session),
  })
  liveKernel = kernel
  kernels.push(kernel)
  let captured: ToolContext | undefined
  const definition = shellTool() as ToolDef
  kernel.tools.add(
    {
      ...definition,
      name: 'question_tool',
      meta: { ...definition.meta, isDestructive: false, isConcurrencySafe: true, requiresApproval: 'never' },
      execute: async (_args, context) => {
        captured = context
        const value = await context.questions?.ask(request)
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structured: value }
      },
    },
    { source: 'test', trust: 'builtin' },
  )
  if (options.nested)
    kernel.tools.add(
      {
        ...definition,
        name: 'outer_question',
        meta: {
          ...definition.meta,
          isDestructive: false,
          isConcurrencySafe: true,
          requiresApproval: 'never',
        },
        execute: async (_args, context) => context.tools.invoke('question_tool', {}),
      },
      { source: 'test', trust: 'builtin' },
    )
  const session = await kernel.session('questions-root', {
    actor,
    cwd: '/w',
    writerRunId: 'writer-one',
    resolvedProfileHash: null,
    workspaceInvocation,
  })
  await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'ask and continue' }] })
  const controller = new AbortController()
  const running = session.run({ until: 'turn-end', signal: controller.signal })
  return {
    kernel,
    session,
    questions,
    storage,
    running,
    controller,
    workspaceInvocation,
    context: () => captured,
  }
}

async function pending(questions: HostQuestions, session: SessionImpl): Promise<QuestionInteraction> {
  await vi.waitFor(() => expect(questions.pending(session.key)).toHaveLength(1))
  return questions.pending(session.key)[0] as QuestionInteraction
}

it('uses real Native tool execution and adopts only persisted, exact-source answers; retries are idempotent', async () => {
  const f = await fixture()
  const interaction = await pending(f.questions, f.session)
  const rows = await f.session.scan({ toSeq: f.session.lastSeq })
  const requested = rows.find((row) => row.type === 'question/requested')
  expect(requested).toMatchObject({
    seq: interaction.requestedSeq,
    origin: 'system',
    trust: 'trusted',
    lane: 'main',
    sourceEventSeqs: [interaction.callSeq],
  })
  expect(validateEvent(requested).ok).toBe(true)
  expect(interaction).toMatchObject({
    writerRunId: 'writer-one',
    generation: 1,
    turn: 1,
    request,
    policy: { allowSkip: false },
  })
  await expect(
    f.questions.answer(
      f.session.key,
      interaction.interactionId,
      { answers: [{ id: 'wrong', selected: [] }] },
      actor,
    ),
  ).rejects.toMatchObject({ code: 'INVALID_QUESTION_ANSWER' })
  expect(f.questions.pending(f.session.key)).toHaveLength(1)
  const result = await f.questions.answer(f.session.key, interaction.interactionId, answer, actor)
  expect(result.status).toBe('answered')
  expect(f.questions.pending(f.session.key)).toEqual([])
  expect(await f.questions.answer(f.session.key, interaction.interactionId, answer, actor)).toEqual(result)
  await expect(f.questions.cancel(f.session.key, interaction.interactionId, actor)).rejects.toMatchObject({
    code: 'QUESTION_CONFLICT',
  })
  await expect(
    f.questions.answer(
      f.session.key,
      interaction.interactionId,
      { answers: [{ id: 'choice', selected: ['乙'] }] },
      actor,
    ),
  ).rejects.toMatchObject({ code: 'QUESTION_CONFLICT' })
  await f.running
  const final = await f.session.scan({ toSeq: f.session.lastSeq })
  const settled = final.filter((row) => row.type === 'question/settled')
  expect(settled).toHaveLength(1)
  expect(settled[0]).toMatchObject({
    seq: result.settledSeq,
    actor,
    sourceEventSeqs: [interaction.callSeq, interaction.requestedSeq],
    data: { answer, status: 'answered' },
  })
  expect(
    final.some((row) => row.type === 'tool/result' && JSON.stringify(row.data).includes('保留原文')),
  ).toBe(true)
  expect(
    final.some((row) => row.type === 'assistant/message' && JSON.stringify(row.data).includes('continued')),
  ).toBe(true)
  await expect(f.context()?.questions?.ask(request)).rejects.toMatchObject({ code: 'CALLER_NOT_LIVE' })
})

it.each(['cancel', 'abort', 'close'] as const)(
  'drains %s with one durable terminal event and rejects late answers',
  async (operation) => {
    const f = await fixture()
    const interaction = await pending(f.questions, f.session)
    if (operation === 'cancel') await f.questions.cancel(f.session.key, interaction.interactionId, actor)
    else if (operation === 'abort') f.controller.abort()
    else await f.session.close()
    await f.running.catch(() => undefined)
    expect(f.questions.pending(f.session.key)).toEqual([])
    const rows = await f.storage.scan(f.session.key, { toSeq: f.session.lastSeq })
    expect(rows.filter((row) => row.type === 'question/settled')).toHaveLength(1)
    expect(rows.find((row) => row.type === 'question/settled')?.data).toMatchObject({
      status: operation === 'cancel' ? 'cancelled' : 'aborted',
    })
    await expect(
      f.questions.answer(f.session.key, interaction.interactionId, answer, actor),
    ).rejects.toMatchObject({ code: operation === 'close' ? 'CALLER_NOT_LIVE' : 'QUESTION_CONFLICT' })
  },
)

it('never acknowledges a failed settlement append', async () => {
  const f = await fixture()
  const interaction = await pending(f.questions, f.session)
  const commit = f.storage.commit.bind(f.storage)
  vi.spyOn(f.storage, 'commit').mockImplementation((key, input) => {
    if (input.events.some((row) => row.type === 'question/settled'))
      throw new Error('private storage details')
    return commit(key, input)
  })
  await expect(
    f.questions.answer(f.session.key, interaction.interactionId, answer, actor),
  ).rejects.toMatchObject({ code: 'E_STORAGE_FAULT', message: 'E_STORAGE_FAULT' })
  await f.running.catch(() => undefined)
  expect(
    (await f.storage.scan(f.session.key, { toSeq: f.session.lastSeq })).some(
      (row) => row.type === 'question/settled',
    ),
  ).toBe(false)
  await expect(f.questions.drain(f.session)).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
})

it('hides settling requests and waits for the same durable receipt on concurrent retries', async () => {
  const f = await fixture()
  const interaction = await pending(f.questions, f.session)
  const commit = f.storage.commit.bind(f.storage)
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered = false
  vi.spyOn(f.storage, 'commit').mockImplementation(async (key, input) => {
    if (input.events.some((row) => row.type === 'question/settled')) {
      entered = true
      await blocked
    }
    return commit(key, input)
  })
  let acknowledged = false
  const first = f.questions.answer(f.session.key, interaction.interactionId, answer, actor).then((value) => {
    acknowledged = true
    return value
  })
  const retry = f.questions.answer(f.session.key, interaction.interactionId, answer, actor)
  await vi.waitFor(() => expect(entered).toBe(true))
  expect(f.questions.pending(f.session.key)).toEqual([])
  expect(acknowledged).toBe(false)
  expect(
    (await f.storage.scan(f.session.key, { toSeq: f.session.lastSeq })).some(
      (row) => row.type === 'question/settled',
    ),
  ).toBe(false)
  release()
  expect(await retry).toEqual(await first)
  await f.running
  expect(
    (await f.session.scan({ toSeq: f.session.lastSeq })).filter((row) => row.type === 'question/settled'),
  ).toHaveLength(1)
})

it('does not publish when no provider is available or preparation fails', async () => {
  for (const provider of [
    null,
    async () => {
      throw new Error('private transport details')
    },
  ]) {
    const f = await fixture({ provider })
    await f.running
    expect(f.questions.pending(f.session.key)).toEqual([])
    expect(
      (await f.session.scan({ toSeq: f.session.lastSeq })).some((row) => row.type === 'question/requested'),
    ).toBe(false)
    expect(JSON.stringify(await f.session.scan({ toSeq: f.session.lastSeq }))).not.toContain(
      'private transport details',
    )
  }
})

it('keeps the preparation deadline live, even when its provider ignores cancellation', async () => {
  vi.useFakeTimers()
  let release: ((value: { allowSkip: boolean }) => void) | undefined
  let entered = false
  const f = await fixture({
    timeoutMs: 20,
    provider: async () => {
      entered = true
      return new Promise((resolve) => {
        release = resolve
      })
    },
  })
  for (let i = 0; i < 30 && !entered; i++) await vi.advanceTimersByTimeAsync(0)
  expect(entered).toBe(true)
  await vi.advanceTimersByTimeAsync(21)
  release?.({ allowSkip: true })
  await f.running
  expect(f.questions.pending(f.session.key)).toEqual([])
  expect(
    (await f.session.scan({ toSeq: f.session.lastSeq })).some((row) => row.type === 'question/requested'),
  ).toBe(false)
})

it('rejects live owned children but permits historical fork lineage reopened as a new root', async () => {
  const f = await fixture()
  const interaction = await pending(f.questions, f.session)
  const child = await f.kernel.session('owned-child', {
    actor,
    cwd: '/w',
    writerRunId: 'child-writer',
    resolvedProfileHash: null,
    runtimeOwnerSessionKey: f.session.key,
  })
  await expect(Promise.resolve().then(() => f.questions.ask(child, {} as never))).rejects.toMatchObject({
    code: 'DELEGATED_CALLER',
  })
  await expect(
    f.kernel.session('owned-child', {
      actor,
      cwd: '/w',
      writerRunId: 'child-writer',
      resolvedProfileHash: null,
    }),
  ).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
  await f.questions.answer(f.session.key, interaction.interactionId, answer, actor)
  await f.running
  const boundary = f.session.lastSeq
  const fork = await f.kernel.session('historical-fork', {
    actor,
    cwd: '/w',
    writerRunId: 'fork-writer',
    resolvedProfileHash: null,
    parent: { key: f.session.key, boundarySeq: boundary },
    workspaceInvocation: f.workspaceInvocation,
  })
  expect(fork.d.log.parent?.key).toBe(f.session.key)
  expect(fork.d.runtimeOwnerSessionKey).toBeUndefined()
  await fork.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'ask from reopened fork root' }] })
  const running = fork.run({ until: 'turn-end', signal: new AbortController().signal })
  const forkQuestion = await pending(f.questions, fork)
  await f.questions.answer(fork.key, forkQuestion.interactionId, answer, actor)
  await running
})

it('passes the trusted nested parent scope through real Core invokeTool', async () => {
  const f = await fixture({ nested: true })
  const interaction = await pending(f.questions, f.session)
  await f.questions.answer(f.session.key, interaction.interactionId, answer, actor)
  await f.running
  expect(
    (await f.session.scan({ toSeq: f.session.lastSeq })).filter((row) => row.type === 'question/settled'),
  ).toHaveLength(1)
})
