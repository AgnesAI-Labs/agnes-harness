import type { Actor, QuestionInteraction, QuestionResolution } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { CommandQueue } from '../src/local/command-queue.js'
import { LocalEndpoint } from '../src/local/endpoint.js'
import type { AgnesContext } from '../src/local/methods/agnes.js'
import { registerQuestions } from '../src/local/methods/questions.js'

const actor: Actor = { id: 'authenticated-human', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const interaction: QuestionInteraction = {
  sessionId: 'session',
  interactionId: 'question',
  writerRunId: 'writer',
  generation: 1,
  toolUseId: 'call',
  turn: 1,
  callSeq: 3,
  requestedSeq: 4,
  request: { questions: [{ id: 'choice', question: 'Choose', options: [{ label: 'A' }] }] },
  policy: { allowSkip: false },
}
const resolution: QuestionResolution = {
  sessionId: 'session',
  interactionId: 'question',
  status: 'answered',
  settledSeq: 5,
}
const answer = { answers: [{ id: 'choice', selected: ['A'] }] }
function fixture() {
  const endpoint = new LocalEndpoint({ clock: () => 1, principalId: 'owner' })
  endpoint.conn.initialized = true
  endpoint.conn.credential = { kind: 'local' }
  let owner = 'owner'
  let live = true
  const control = {
    pending: vi.fn(async () => [interaction]),
    answer: vi.fn(async () => resolution),
    cancel: vi.fn(async () => ({ ...resolution, status: 'cancelled' as const })),
  }
  const resolveActor = vi.fn(async () => actor)
  const open = vi.fn()
  const commandQueue = new CommandQueue()
  registerQuestions(endpoint, {
    commandQueue,
    host: {},
    questionControl: control,
    resolveActor,
    registry: { get: () => (live ? {} : undefined), open },
    sessionOwnership: { resolve: () => ({ principalId: owner, active: true }) },
  } as unknown as AgnesContext)
  return {
    commandQueue,
    control,
    resolveActor,
    open,
    owner: (value: string) => {
      owner = value
    },
    live: (value: boolean) => {
      live = value
    },
    call: (method: string, params: unknown = { sessionId: 'session' }) =>
      endpoint.handle({ jsonrpc: '2.0', id: 1, method: `_agnes/v1/questions.${method}`, params }),
  }
}

it('routes answers outside the prompt queue, using authenticated actors and durable receipts', async () => {
  const f = fixture()
  expect(await f.call('pending')).toMatchObject({
    result: { sessionId: 'session', interactions: [interaction] },
  })
  let commit!: () => void
  f.control.answer.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        commit = () => resolve(resolution)
      }),
  )
  let acknowledged = false
  const answering = f
    .call('answer', { sessionId: 'session', interactionId: 'question', answer })
    .then((reply) => {
      acknowledged = true
      return reply
    })
  await vi.waitFor(() => expect(f.control.answer).toHaveBeenCalled())
  expect(acknowledged).toBe(false)
  expect(f.control.answer).toHaveBeenCalledWith('session', 'question', answer, actor)
  commit()
  expect(await answering).toMatchObject({ result: resolution })
  expect(await f.call('cancel', { sessionId: 'session', interactionId: 'question' })).toMatchObject({
    result: { status: 'cancelled' },
  })
  expect(f.open).not.toHaveBeenCalled()
})

it('refuses foreign owners before lookup and never reopens historical questions', async () => {
  const f = fixture()
  f.owner('another')
  expect(await f.call('pending')).toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
  expect(f.control.pending).not.toHaveBeenCalled()
  f.owner('owner')
  f.live(false)
  expect(await f.call('pending')).toMatchObject({ result: { interactions: [] } })
  expect(await f.call('answer', { sessionId: 'session', interactionId: 'question', answer })).toMatchObject({
    error: { data: { code: 'QUESTION_NOT_LIVE' } },
  })
  expect(f.control.answer).not.toHaveBeenCalled()
  expect(f.open).not.toHaveBeenCalled()
})

it('rechecks ownership after principal resolution and sanitizes failed settlements', async () => {
  const f = fixture()
  f.resolveActor.mockImplementationOnce(async () => {
    f.owner('another')
    return actor
  })
  await f.call('answer', { sessionId: 'session', interactionId: 'question', answer })
  expect(f.control.answer).not.toHaveBeenCalled()
  f.owner('owner')
  f.control.answer.mockRejectedValueOnce(
    Object.assign(new Error('private answer'), { code: 'INVALID_QUESTION_ANSWER' }),
  )
  const result = await f.call('answer', { sessionId: 'session', interactionId: 'question', answer })
  expect(result).toMatchObject({ error: { data: { code: 'INVALID_QUESTION_ANSWER' } } })
  expect(JSON.stringify(result)).not.toContain('private answer')
  expect(
    await f.call('answer', {
      sessionId: 'session',
      interactionId: 'question',
      answer,
      actor: { id: 'forged' },
    }),
  ).toMatchObject({ error: { code: -32602 } })
})

it('refuses stale answers through daemon actor routing without waking a real hibernated writer', async () => {
  const { realHosted } = await import('../../worker-runtime/test/real-hosted.js')
  const { RemoteSession } = await import('../src/supervisor/remote-session.js')
  let now = 1000
  let created = 0
  const t = await realHosted({
    idleCloseMs: 100,
    clock: () => now,
    wrapHost: (host) => ({
      ...host,
      createSession: async (options) => {
        created++
        return host.createSession(options)
      },
    }),
  })
  try {
    await t.hosted.open(t.openFrame('session'))
    now += 200
    await t.hosted.sweep()
    expect(t.host.kernel.get('session')).toBeUndefined()
    const before = created
    const remote = new RemoteSession(
      'session',
      'old-writer',
      1,
      {
        command: (method: import('@agnes/worker-runtime').SessionMethod, params: Record<string, unknown>) =>
          t.hosted.dispatch(t.command('session', method, params)),
      } as never,
      t.root,
    )
    const endpoint = new LocalEndpoint({ clock: () => now, principalId: 'owner' })
    endpoint.conn.initialized = true
    registerQuestions(endpoint, {
      host: t.host,
      registry: { get: () => ({ session: remote }) },
      sessionOwnership: { resolve: () => ({ principalId: 'owner', active: true }) },
      resolveActor: () => {
        throw new Error('Ordinary resolver can wake; questions must not use it')
      },
      questionControl: {
        pending: () => remote.questionsPending(),
        resolveActor: (credential: unknown) => remote.resolveQuestionActor(credential),
        answer: (_key: string, id: string, value: unknown, by: Actor) => remote.answerQuestion(id, value, by),
        cancel: (_key: string, id: string, by: Actor) => remote.cancelQuestion(id, by),
      },
    } as unknown as AgnesContext)
    for (const method of ['answer', 'cancel']) {
      const reply = await endpoint.handle({
        jsonrpc: '2.0',
        id: 1,
        method: `_agnes/v1/questions.${method}`,
        params: {
          sessionId: 'session',
          interactionId: 'old-question',
          ...(method === 'answer' ? { answer } : {}),
        },
      })
      expect(reply).toMatchObject({ error: { data: { code: 'QUESTION_NOT_LIVE' } } })
    }
    expect(created).toBe(before)
    expect(t.host.kernel.get('session')).toBeUndefined()
  } finally {
    await t.close()
  }
})

it('accepts persisted Native/Jev browser smoke receipts and preserves answers beyond the tool timeout', async () => {
  const { readFileSync } = await import('node:fs')
  const { validateEvent, validateQuestionAnswer } = await import('@agnes/protocol')
  const capture = JSON.parse(
    readFileSync(new URL('./fixtures/question-real.json', import.meta.url), 'utf8'),
  ) as {
    cancelledAndResumed: { questionCount: number; events: import('@agnes/protocol').EventEnvelope[] }
    lanes: Array<{
      runtime: string
      call: import('@agnes/protocol').EventEnvelope & { data: { toolUseId: string } }
      requested: import('@agnes/protocol').EventEnvelope & {
        data: import('@agnes/protocol').QuestionRequestedData
      }
      settled: import('@agnes/protocol').EventEnvelope & {
        data: import('@agnes/protocol').QuestionSettledData
      }
      result: import('@agnes/protocol').EventEnvelope & {
        data: { content: Array<{ type: string; text?: string }>; isError: boolean }
      }
      finalText: string
    }>
  }
  expect(capture.lanes.map((lane) => lane.runtime)).toEqual(['native', 'jevloop'])
  for (const lane of capture.lanes) {
    const { call, requested, settled, result } = lane
    for (const event of [call, requested, settled, result]) expect(validateEvent(event).ok).toBe(true)
    expect(requested.data.callSeq).toBe(call.seq)
    expect(requested.data.toolUseId).toBe(call.data.toolUseId)
    expect(settled.data.requestedSeq).toBe(requested.seq)
    expect(settled.sourceEventSeqs).toEqual([call.seq, requested.seq])
    expect(Date.parse(settled.ts) - Date.parse(requested.ts)).toBeGreaterThan(120_000)
    expect(requested.data.policy.allowSkip).toBe(false)
    expect(settled.data.status).toBe('answered')
    if (settled.data.status !== 'answered') throw new Error('Capture has no accepted answer')
    expect(
      validateQuestionAnswer(requested.data.request, settled.data.answer, requested.data.policy).ok,
    ).toBe(true)
    expect(result.data.isError).toBe(false)
    expect(result.seq).toBeGreaterThan(settled.seq)
    const output = JSON.parse(result.data.content.find((block) => block.type === 'text')?.text ?? '')
    expect(output).toEqual(settled.data.answer)
    expect(lane.finalText).toBe(settled.data.answer.answers[0]?.selected[0])
  }
  const resumed = capture.cancelledAndResumed
  expect(resumed.questionCount).toBe(1)
  for (const event of resumed.events) expect(validateEvent(event).ok).toBe(true)
  expect(resumed.events.find((event) => event.type === 'question/settled')?.data).toMatchObject({
    status: 'cancelled',
  })
  expect(resumed.events.find((event) => event.type === 'tool/result')?.data).toMatchObject({
    code: 'ASK_CANCELLED',
    isError: true,
  })
  const runtime = resumed.events
    .filter((event) => event.type === 'runtime/record')
    .map((event) => (event.data as { record: { kind: string; [key: string]: unknown } }).record)
  expect(runtime.find((record) => record.kind === 'action.settled')).toMatchObject({
    effect: 'not_applied',
    outcome: {
      kind: 'cancelled',
      effectEvidence: { questionCancellation: { requestedSeq: 32, settledSeq: 33 } },
    },
  })
  expect(runtime.filter((record) => record.kind === 'run.stopped')).toHaveLength(2)
  for (const record of runtime.filter((record) => record.kind === 'run.stopped'))
    expect(record).toMatchObject({ reason: 'completed', unresolved: [] })
  expect(resumed.events.filter((event) => event.type === 'assistant/message').at(-1)?.data).toMatchObject({
    content: [{ type: 'text', text: 'RESTORED' }],
  })
})

it('refuses answers after retirement but keeps live pending reads and cancellation available', async () => {
  const f = fixture()
  f.commandQueue.setAdmissionGuard(() => {
    throw new Error('retired')
  })
  expect(await f.call('pending')).toMatchObject({ result: { interactions: [interaction] } })
  expect(await f.call('answer', { sessionId: 'session', interactionId: 'question', answer })).toHaveProperty(
    'error',
  )
  expect(f.control.answer).not.toHaveBeenCalled()
  expect(await f.call('cancel', { sessionId: 'session', interactionId: 'question' })).toMatchObject({
    result: { status: 'cancelled' },
  })
})
