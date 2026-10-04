import { describe, expect, it } from 'vitest'
import {
  type QuestionAnswer,
  type QuestionRequest,
  validateEvent,
  validateMethod,
  validateQuestionAnswer,
  validateQuestionRequest,
} from '../src/index.js'

const strict = { allowSkip: false }
const generic = { allowSkip: true }
const request: QuestionRequest = {
  questions: [
    { id: '单选', question: '选哪一个？', options: [{ label: '甲' }, { label: '乙' }] },
    {
      id: '多选',
      question: '选哪些？',
      multiSelect: true,
      options: [{ label: '红', description: '红色' }, { label: '蓝' }],
    },
    { id: '自由输入', question: '补充说明？' },
  ],
}
const answer: QuestionAnswer = {
  answers: [
    { id: '自由输入', selected: [], custom: '  原始文字👩🏽‍💻\n下一行  ' },
    { id: '多选', selected: ['蓝', '红'], custom: '  另外保留  ' },
    { id: '单选', selected: ['乙'] },
  ],
}

const requested = {
  interactionId: 'interaction-1',
  writerRunId: 'writer-1',
  generation: 1,
  toolUseId: 'call-1',
  turn: 1,
  callSeq: 4,
  request,
  policy: strict,
}
const interaction = { ...requested, sessionId: 'session-1', requestedSeq: 5 }
const resolution = {
  sessionId: 'session-1',
  interactionId: 'interaction-1',
  status: 'answered',
  settledSeq: 6,
}

describe('question RPC and durable event contracts', () => {
  it('reads pending interaction bindings without requiring a live writer action', () => {
    const method = '_agnes/v1/questions.pending'
    expect(validateMethod(method, 'params', { sessionId: 'session-1' }).ok).toBe(true)
    expect(validateMethod(method, 'result', { sessionId: 'session-1', interactions: [interaction] }).ok).toBe(
      true,
    )
    expect(validateMethod(method, 'result', { sessionId: 'session-1', interactions: [] }).ok).toBe(true)
    for (const bad of [{}, { sessionId: '' }, { sessionId: 'session-1', generation: 1 }])
      expect(validateMethod(method, 'params', bad).ok).toBe(false)
    for (const bad of [
      { ...interaction, generation: 0 },
      { ...interaction, requestedSeq: 0 },
      { ...interaction, writerRunId: '' },
    ])
      expect(validateMethod(method, 'result', { sessionId: 'session-1', interactions: [bad] }).ok).toBe(false)
  })

  it('answers with exact structured fields and returns a durable resolution sequence', () => {
    const method = '_agnes/v1/questions.answer'
    const params = { sessionId: 'session-1', interactionId: 'interaction-1', answer }
    const checked = validateMethod(method, 'params', params)
    expect(checked.ok && checked.value).toEqual(params)
    expect(validateMethod(method, 'result', resolution).ok).toBe(true)
    for (const bad of [
      { ...params, interactionId: '' },
      { ...params, answer: { answers: [{ id: '单选', selected: '乙' }] } },
      { ...params, answer: { ...answer, verdict: 'allowed-once' } },
      { ...params, answer: { answers: [{ id: '单选', selected: ['乙'], approved: true }] } },
    ])
      expect(validateMethod(method, 'params', bad).ok).toBe(false)
    expect(validateMethod(method, 'result', { ...resolution, settledSeq: 0 }).ok).toBe(false)
  })

  it('cancels by interaction identity and accepts the immutable winning resolution', () => {
    const method = '_agnes/v1/questions.cancel'
    const params = { sessionId: 'session-1', interactionId: 'interaction-1' }
    expect(validateMethod(method, 'params', params).ok).toBe(true)
    for (const status of ['answered', 'cancelled', 'aborted'])
      expect(validateMethod(method, 'result', { ...resolution, status }).ok).toBe(true)
    expect(validateMethod(method, 'params', { ...params, answer }).ok).toBe(false)
    expect(validateMethod(method, 'params', { ...params, sessionId: '' }).ok).toBe(false)
    expect(validateMethod(method, 'result', { ...resolution, status: 'pending' }).ok).toBe(false)
  })

  const event = (type: string, data: unknown) => ({
    seq: 6,
    ts: '2026-10-03T00:00:00Z',
    id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
    type,
    data,
    actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    origin: 'system',
    trust: 'trusted',
  })
  it('validates question/requested ownership, source call and question shape', () => {
    expect(validateEvent(event('question/requested', requested)).ok).toBe(true)
    for (const bad of [
      { ...requested, callSeq: 0 },
      { ...requested, generation: 0 },
      { ...requested, policy: { allowSkip: 'yes' } },
      { ...requested, request: { questions: [{ id: 'q' }] } },
    ])
      expect(validateEvent(event('question/requested', bad)).ok).toBe(false)
  })

  it('requires an answer only for answered question/settled and refuses permission fields', () => {
    const settled = {
      interactionId: 'interaction-1',
      requestedSeq: 5,
      callSeq: 4,
      toolUseId: 'call-1',
      status: 'answered',
      answer,
    }
    expect(validateEvent(event('question/settled', settled)).ok).toBe(true)
    const { answer: _answer, ...withoutAnswer } = settled
    for (const status of ['cancelled', 'aborted'])
      expect(validateEvent(event('question/settled', { ...withoutAnswer, status })).ok).toBe(true)
    for (const bad of [
      withoutAnswer,
      { ...settled, status: 'cancelled' },
      { ...settled, requestedSeq: 0 },
      { ...settled, verdict: 'allowed-once' },
    ])
      expect(validateEvent(event('question/settled', bad)).ok).toBe(false)
  })
})

describe('question request validation', () => {
  it('preserves canonical fields, Unicode identities and DSH-compatible open request fields', () => {
    const value = {
      questions: [
        {
          id: 'é',
          question: '',
          header: '',
          detail: '',
          options: [{ label: '', description: '', extra: 'preserved' }],
          intent: { kind: 'plan-review', approve: '', callId: '原调用' },
          extra: 'preserved',
        },
        { id: 'e\u0301', question: 'different exact identity' },
        { id: '', question: 'empty but unambiguous ID', options: [] },
      ],
    }
    expect(validateQuestionRequest(value)).toEqual({ ok: true, value })
    const result = validateQuestionRequest(value)
    expect(result.ok && result.value).toBe(value)
  })

  it.each([
    [{ questions: [] }, 'EMPTY_QUESTIONS', '/questions'],
    [
      {
        questions: [
          { id: 'x', question: 'one' },
          { id: 'x', question: 'two' },
        ],
      },
      'DUPLICATE_QUESTION_ID',
      '/questions/1/id',
    ],
    [
      { questions: [{ id: 'x', question: '?', options: [{ label: 'A' }, { label: 'A' }] }] },
      'DUPLICATE_OPTION_LABEL',
      '/questions/0/options/1/label',
    ],
    [
      {
        questions: [
          { id: 'x', question: '?', detail: 'plan', intent: { kind: 'plan-review', approve: 'A' } },
        ],
      },
      'INTENT_OPTION_MISSING',
      '/questions/0/intent/approve',
    ],
    [
      {
        questions: [
          {
            id: 'x',
            question: '?',
            options: [{ label: 'A' }],
            intent: { kind: 'plan-review', approve: 'A' },
          },
        ],
      },
      'INTENT_DETAIL_MISSING',
      '/questions/0/detail',
    ],
    [
      { questions: [{ id: 'x', question: '?', multiSelect: 'yes' }] },
      'INVALID_SHAPE',
      '/questions/0/multiSelect',
    ],
    [
      { questions: [{ id: 'x', question: '?', options: [{ description: 'missing label' }] }] },
      'INVALID_SHAPE',
      '/questions/0/options/0/label',
    ],
  ])('rejects ambiguous or malformed request with %s', (value, code, path) => {
    expect(validateQuestionRequest(value)).toEqual({
      ok: false,
      errors: [{ target: 'request', code, path }],
    })
  })
})

describe('question answer validation', () => {
  it('accepts single/multiple selections and free text, preserving exact content and answer order', () => {
    const result = validateQuestionAnswer(request, answer, strict)
    expect(result).toEqual({ ok: true, value: answer })
    expect(result.ok && result.value).toBe(answer)
  })

  it('distinguishes generic skip from strict comparison answers without trimming the returned text', () => {
    const value = { answers: request.questions.map(({ id }) => ({ id, selected: [] })) }
    expect(validateQuestionAnswer(request, value, generic)).toEqual({ ok: true, value })
    expect(validateQuestionAnswer(request, value, strict)).toEqual({
      ok: false,
      errors: [{ target: 'answer', code: 'ANSWER_REQUIRED', path: '/answers/0' }],
    })
    const free = { questions: [{ id: 'x', question: '?' }] }
    for (const custom of ['', ' \n\t ', '\u00a0']) {
      const value = { answers: [{ id: 'x', selected: [], custom }] }
      expect(validateQuestionAnswer(free, value, strict).ok).toBe(false)
      expect(validateQuestionAnswer(free, value, generic)).toEqual({ ok: true, value })
    }
  })

  it.each([
    [{ answers: [] }, 'INCOMPLETE_ANSWERS', '/answers'],
    [{ answers: [{ id: 'missing', selected: [] }] }, 'UNKNOWN_QUESTION_ID', '/answers/0/id'],
    [
      {
        answers: [
          { id: '单选', selected: ['甲'] },
          { id: '单选', selected: ['乙'] },
        ],
      },
      'DUPLICATE_ANSWER_ID',
      '/answers/1/id',
    ],
    [{ answers: [{ id: '单选', selected: ['甲', '甲'] }] }, 'DUPLICATE_SELECTION', '/answers/0/selected/1'],
    [{ answers: [{ id: '单选', selected: ['丙'] }] }, 'OPTION_NOT_ALLOWED', '/answers/0/selected/0'],
    [{ answers: [{ id: '单选', selected: ['甲', '乙'] }] }, 'SINGLE_SELECT_LIMIT', '/answers/0/selected'],
    [{ answers: [{ id: '自由输入', selected: ['made up'] }] }, 'OPTION_NOT_ALLOWED', '/answers/0/selected/0'],
    [{ answers: [{ id: '单选', selected: '甲' }] }, 'INVALID_SHAPE', '/answers/0/selected'],
    [{ answers: [{ id: '单选', selected: ['甲'], custom: 1 }] }, 'INVALID_SHAPE', '/answers/0/custom'],
    [{ answers: [{ id: '单选', selected: ['甲'], extra: true }] }, 'INVALID_SHAPE', '/answers/0'],
  ])('rejects invalid answer with %s', (value, code, path) => {
    expect(validateQuestionAnswer(request, value, strict)).toEqual({
      ok: false,
      errors: [{ target: 'answer', code, path }],
    })
  })

  it('requires an explicit valid caller policy and revalidates the request', () => {
    expect(validateQuestionAnswer(request, answer, {} as typeof strict)).toEqual({
      ok: false,
      errors: [{ target: 'policy', code: 'INVALID_SHAPE', path: '/allowSkip' }],
    })
    expect(validateQuestionAnswer(request, answer, { allowSkip: 'yes' } as unknown as typeof strict).ok).toBe(
      false,
    )
    expect(validateQuestionAnswer({ questions: [] }, answer, strict)).toEqual({
      ok: false,
      errors: [{ target: 'request', code: 'EMPTY_QUESTIONS', path: '/questions' }],
    })
  })

  it('rejects without mutating or consuming anything so a later valid answer remains valid', () => {
    const before = JSON.stringify(request)
    const rejected = { answers: [{ id: '单选', selected: ['not offered'] }] }
    const rejectedBefore = JSON.stringify(rejected)
    expect(validateQuestionAnswer(request, rejected, strict).ok).toBe(false)
    expect(validateQuestionAnswer(request, answer, strict)).toEqual({ ok: true, value: answer })
    expect(JSON.stringify(request)).toBe(before)
    expect(JSON.stringify(rejected)).toBe(rejectedBefore)
  })

  it('does not echo attacker-controlled unknown field names or content in diagnostics', () => {
    const value = { answers: [{ id: '单选', selected: ['甲'], ['sensitive/'.repeat(1_000)]: 'secret' }] }
    expect(validateQuestionAnswer(request, value, strict)).toEqual({
      ok: false,
      errors: [{ target: 'answer', code: 'INVALID_SHAPE', path: '/answers/0' }],
    })
  })

  it('treats plan-review solely as presentation and retains DSH worker accepted selection plus custom', () => {
    const request = {
      questions: [
        {
          id: 'plan',
          question: 'review',
          detail: '# Plan',
          options: [{ label: 'approve' }],
          intent: { kind: 'plan-review', approve: 'approve' },
        },
      ],
    }
    const value = { answers: [{ id: 'plan', selected: ['approve'], custom: 'feedback' }] }
    expect(validateQuestionAnswer(request, value, strict)).toEqual({ ok: true, value })
  })
})
