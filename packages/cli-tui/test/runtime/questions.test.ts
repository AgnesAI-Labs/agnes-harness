import { jcs } from '@agnes/protocol'
import {
  type ApprovalRequest,
  type ApprovalRespondRequest,
  canonicalJsonDigest,
  computeApprovalIntentDigest,
  type InteractionClientRespondRequest,
  type InteractionFormLink,
  type InteractionRecord,
  type InteractionResponseStatus,
  type JsonValue,
  type QuestionField,
  type QuestionRequest,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { PendingCommand } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeCallResult } from '../../src/runtime/ports.js'
import { QuestionController, type QuestionPorts } from '../../src/runtime/question-controller.js'

type Status = RuntimeCallResult<InteractionResponseStatus>
/** A reply to the request, or the status query, that carries `responseId`. */
type Reply = (responseId: string) => Status

const schema = { typeId: 'acme.survey/answer@1', revision: 1, digest: 'c'.repeat(64) }
const inline = (value: JsonValue) => ({
  kind: 'inline' as const,
  schema,
  value,
  digest: canonicalJsonDigest(value),
  bytes: new TextEncoder().encode(jcs(value)).length,
})
const name: QuestionField = {
  id: 'name',
  kind: 'text',
  label: 'Name',
  required: true,
  multiline: false,
  maxLength: 5,
}
const size: QuestionField = {
  id: 'size',
  kind: 'singleChoice',
  label: 'Size',
  required: true,
  options: [
    { id: 's', label: 'Small' },
    { id: 'l', label: 'Large' },
  ],
}
const tags: QuestionField = {
  id: 'tags',
  kind: 'multiChoice',
  label: 'Tags',
  required: true,
  options: [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Gamma' },
  ],
  minItems: 1,
  maxItems: 2,
}
const agree: QuestionField = {
  id: 'agree',
  kind: 'confirm',
  label: 'Agree',
  required: true,
  statement: 'I agree',
}

function question(fields: QuestionField[], extra: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    kind: 'question',
    title: 'Survey',
    body: 'Tell us',
    answerSchema: schema,
    fields,
    allowedResponders: ['user-1'],
    expiresAt: '2099-01-01T00:00:00Z',
    idempotencyKey: 'q-key',
    ...extra,
  }
}

function approval(allowedGrantScopes?: ApprovalRequest['allowedGrantScopes']): ApprovalRequest {
  const request: ApprovalRequest = {
    kind: 'approval',
    title: 'Delete files',
    body: 'rm -rf build',
    actionRef: 'tools.shell/run',
    inputDigest: 'd'.repeat(64),
    policyDecisionRef: 'policy-1',
    scope: { kind: 'session', installationId: 'i-1', runtimeId: 'r-1', workspaceId: 'w-1', sessionId: 's-1' },
    allowedResponders: ['user-1'],
    expiresAt: '2099-01-01T00:00:00Z',
    idempotencyKey: 'a-key',
    risk: 'destructive',
    intentDigest: '0'.repeat(64),
    ...(allowedGrantScopes && { allowedGrantScopes }),
  }
  const digest = computeApprovalIntentDigest(request)
  if (!digest.ok) throw new Error('invalid approval fixture')
  return { ...request, intentDigest: digest.value }
}

function pending(request: QuestionRequest | ApprovalRequest): InteractionRecord {
  const value: InteractionRecord = {
    interactionId: 'ix-1',
    owner: { runId: 'run-1', actionId: 'act-1' },
    request,
    version: 3,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    status: 'pending',
    terminationReason: null,
    resolution: null,
  }
  expect(validateRuntime('InteractionRecord', value).ok).toBe(true)
  return value
}

function answered(request: QuestionRequest, value: JsonValue): InteractionRecord {
  return {
    ...pending(request),
    version: 4,
    status: 'answered',
    resolution: {
      responseId: 'winner',
      actorRef: 'user-2',
      answer: inline(value),
      committedAt: '2026-10-01T00:01:00Z',
      evidence: { kind: 'human', authenticationRef: inline({ session: 'web' }) },
    },
  } as InteractionRecord
}

const ok = <T>(value: T) => ({ state: 'ok' as const, value })
const status =
  (value: InteractionResponseStatus['status']): Reply =>
  (responseId) =>
    ok(
      value === 'not-accepted'
        ? { responseId, status: value, interactionId: null, version: null, result: null, error: null }
        : { responseId, status: value, interactionId: 'ix-1', version: 4, result: null, error: null },
    )
const failure =
  (code: 'invalid_input' | 'conflict' | 'timeout', detailCode: string): Reply =>
  () => ({
    state: 'failed',
    error: {
      code,
      detailCode,
      message: `${detailCode}\u202e!`,
      retryAdvice: { kind: 'never' },
      diagnosticId: 'd-1',
    },
  })
const unknown: Reply = () => ({ state: 'unknown', reason: 'no reply' })
const refused =
  (reason: string): Reply =>
  () => ({ state: 'refused', reason })

/** Reads return the records in turn, the last one from then on; replies are used in order. */
function harness(records: InteractionRecord[], journal: PendingCommand[] = []) {
  let reads = 0
  const replies: Reply[] = []
  const reply = async (responseId: string) => (replies.shift() ?? unknown)(responseId)
  const ports = {
    read: vi.fn(async (_id: string) =>
      ok(records[Math.min(reads++, records.length - 1)] as InteractionRecord),
    ),
    respond: vi.fn(async (input: InteractionClientRespondRequest) => reply(input.responseId)),
    respondApproval: vi.fn(async (input: ApprovalRespondRequest) => reply(input.responseId)),
    responseStatus: vi.fn(async (responseId: string) => reply(responseId)),
    formLink: vi.fn(
      async (): Promise<RuntimeCallResult<InteractionFormLink>> => ({
        state: 'refused',
        reason: 'not-negotiated',
      }),
    ),
    pendingJournal: vi.fn(async () => journal),
  } satisfies QuestionPorts
  const controller = new QuestionController(ports, { locale: 'en', baseUrl: 'https://agnes.test/mount/' })
  const sent = () =>
    [...ports.respond.mock.calls, ...ports.respondApproval.mock.calls].map(([input]) => input)
  return { controller, ports, replies, sent }
}

async function type(controller: QuestionController, ...inputs: string[]): Promise<string[]> {
  let out: string[] = []
  for (const input of inputs) out = await controller.input(input)
  return out
}

const UNKNOWN = 'The result is unknown. Check its status, or send the same answer again.'
const ANSWERED_ELSEWHERE = ['Already handled elsewhere.', 'Answered.', '  Size: Small']

describe('runtime question controller', () => {
  it('answers a question only through interaction respond, as option ids in an inline answer', async () => {
    const { controller, ports, replies, sent } = harness([pending(question([name, size, tags, agree]))])
    expect(await controller.open('ix-1')).toEqual([
      'Survey',
      'Tell us',
      'Name',
      'Type your answer, at most 5 characters.',
    ])
    expect(await type(controller, 'Ada', '2', '1, 3', 'no')).toEqual([
      'Will submit:',
      '  Name: Ada',
      '  Size: Large',
      '  Tags: Alpha, Gamma',
      '  Agree: no',
      'Type yes to submit, or no to start over.',
    ])
    expect(sent()).toEqual([])
    replies.push(status('applied'))
    expect(await controller.input('yes')).toEqual(['Answered.'])
    const [input] = sent()
    const value = { name: 'Ada', size: 'l', tags: ['a', 'c'], agree: false }
    expect(input).toEqual({
      interactionId: 'ix-1',
      responseId: expect.any(String),
      expectedVersion: 3,
      answer: inline(value),
    })
    expect(validateRuntime('InteractionClientRespondRequest', input).ok).toBe(true)
    // A confirm field answered "no" is a business answer; nothing went to approval respond.
    expect(ports.respondApproval).not.toHaveBeenCalled()
  })

  it.each<[string, QuestionField, string[], string]>([
    ['a choice outside the list', size, ['0', '3', '1.0', ' ', 'b'], 'Enter a number from 1 to 2.'],
    ['a repeated choice', tags, ['1,1'], 'Each number may appear only once.'],
    ['too many or too few choices', tags, ['1,2,3', ''], 'Choose from 1 to 2 options.'],
    ['a choice that is not a number', tags, ['1,x', '1,'], 'Enter numbers from 1 to 3, separated by commas.'],
    ['a line break in a single-line answer', name, ['a\nb', 'a\rb'], 'This answer must be a single line.'],
    ['an answer over the limit', name, ['abcdef'], 'This answer may have at most 5 characters.'],
    ['anything but yes or no', agree, ['', 'y', 'true'], 'Type yes or no.'],
  ])('refuses %s and keeps asking', async (_name, field, inputs, error) => {
    const { controller, sent } = harness([pending(question([field]))])
    await controller.open('ix-1')
    for (const input of inputs) expect(await controller.input(input)).toEqual([error])
    expect(controller.phase).toBe('editing')
    expect(sent()).toEqual([])
  })

  it('sends only after an explicit yes, and starts over on no', async () => {
    const { controller, sent } = harness([pending(question([size]))])
    await controller.open('ix-1')
    await controller.input('1')
    expect(await controller.input('')).toEqual(['Type yes or no.'])
    expect(await controller.input('no')).toEqual([
      'Size',
      '[1] Small',
      '[2] Large',
      'Enter a number from 1 to 2.',
    ])
    expect(sent()).toEqual([])
  })

  it.each<[string, QuestionField[]]>([
    [
      'a custom field',
      [
        name,
        { id: 'c', kind: 'custom', label: 'Map', required: true, fieldSchema: schema, rendererKey: 'map' },
      ],
    ],
    ['a field of an unknown kind', [{ ...name, kind: 'slider' } as unknown as QuestionField]],
    ['an optional field', [{ ...size, required: false }]],
  ])('sends a question with %s to a form as a whole', async (_name, fields) => {
    const { controller, ports, sent } = harness([{ ...pending(question([])), request: question(fields) }])
    expect((await controller.open('ix-1')).at(-1)).toBe(
      'This question needs a form; answer it in the Web client.',
    )
    expect(controller.phase).toBe('form-required')
    expect(await controller.input('1')).toEqual([])
    // The link is refused for now; a granted one is joined to the deployment base; another origin is never shown.
    expect(await controller.requestFormLink()).toEqual(['Finish this in the Web client.'])
    const link = { expiresAt: '2026-10-01T00:15:00Z', interactionId: 'ix-1', version: 3 }
    ports.formLink.mockResolvedValueOnce(ok({ ...link, url: '/forms/f-1?nonce=n' }))
    expect(await controller.requestFormLink()).toEqual([
      'Form (expires 2026-10-01T00:15:00Z): https://agnes.test/mount/forms/f-1?nonce=n',
    ])
    ports.formLink.mockResolvedValueOnce(ok({ ...link, url: 'https://elsewhere.test/f' }))
    expect(await controller.requestFormLink()).toEqual(['Finish this in the Web client.'])
    expect(ports.formLink).toHaveBeenCalledWith({ interactionId: 'ix-1', expectedVersion: 3 })
    expect(sent()).toEqual([])
    expect(controller.phase).toBe('form-required')
  })

  it('shows every approval binding and offers only the default grant scope when none is listed', async () => {
    const request = approval()
    const { controller, ports, replies, sent } = harness([pending(request)])
    expect(await controller.open('ix-1')).toEqual([
      'Delete files',
      'rm -rf build',
      'Action: tools.shell/run',
      `Input digest: ${'d'.repeat(64)}`,
      `Intent digest: ${request.intentDigest}`,
      'Scope: session (installationId=i-1, runtimeId=r-1, workspaceId=w-1, sessionId=s-1)',
      'Risk: destructive',
      '[1] Allow once',
      '[2] Reject',
      'Enter a number from 1 to 2.',
    ])
    replies.push(status('applied'))
    await controller.input('2')
    const [deny] = sent()
    // A denial carries the request's own intent digest and no grant scope.
    expect(deny).toEqual({
      interactionId: 'ix-1',
      responseId: expect.any(String),
      expectedVersion: 3,
      decision: 'deny',
      intentDigest: request.intentDigest,
    })
    expect(deny).not.toHaveProperty('grantScope')
    expect(validateRuntime('ApprovalRespondRequest', deny).ok).toBe(true)
    expect(ports.respond).not.toHaveBeenCalled()
  })

  it('offers only the listed grant scopes and asks again before a permanent grant', async () => {
    const request = approval(['session', 'permanent'])
    const { controller, replies, sent } = harness([pending(request)])
    expect((await controller.open('ix-1')).slice(-4)).toEqual([
      '[1] Allow for this session',
      '[2] Always allow for this profile',
      '[3] Reject',
      'Enter a number from 1 to 3.',
    ])
    expect(await controller.input('2')).toEqual([
      'Will submit:',
      '  Always allow for this profile',
      'This keeps allowing the action for this profile, not just this once.',
      'Type yes to submit, or no to start over.',
    ])
    expect(sent()).toEqual([])
    replies.push(status('accepted'))
    expect(await controller.input('yes')).toEqual(['Answer received; it takes effect shortly.'])
    expect(sent()).toEqual([
      expect.objectContaining({
        decision: 'approve',
        grantScope: 'permanent',
        intentDigest: request.intentDigest,
      }),
    ])
  })

  it.each<[string, Reply, string, string[], 'the same id' | 'a new id' | 'nothing']>([
    ['applied', status('applied'), 'applied', ['Answered.'], 'nothing'],
    ['accepted', status('accepted'), 'accepted', ['Answer received; it takes effect shortly.'], 'nothing'],
    ['rejected', status('rejected'), 'handled-elsewhere', ANSWERED_ELSEWHERE, 'nothing'],
    [
      'a stale version',
      failure('conflict', 'revision_conflict'),
      'handled-elsewhere',
      ANSWERED_ELSEWHERE,
      'nothing',
    ],
    [
      'not accepted',
      status('not-accepted'),
      'confirming',
      ['Not accepted; the question is still pending.'],
      'the same id',
    ],
    [
      'a typed refusal',
      failure('invalid_input', 'invalid_request'),
      'confirming',
      ['Refused: invalid_request!'],
      'a new id',
    ],
    ['a local refusal', refused('disconnected'), 'confirming', ['Not sent (disconnected).'], 'the same id'],
    [
      'a reload refusal',
      refused('reload-required'),
      'read-only',
      ['This client must reload before answering; the question is still pending.'],
      'nothing',
    ],
    ['a failure that may hide an effect', failure('timeout', 'timeout'), 'unknown', [UNKNOWN], 'nothing'],
  ])('settles %s and decides what a second yes sends', async (_name, reply, phase, head, resend) => {
    const winner = answered(question([size]), { size: 's' })
    const { controller, replies, sent } = harness([pending(question([size])), winner])
    await controller.open('ix-1')
    await controller.input('2')
    replies.push(reply)
    expect((await controller.input('yes')).slice(0, head.length)).toEqual(head)
    expect(controller.phase).toBe(phase)
    await controller.input('yes')
    const [first, second] = sent() as InteractionClientRespondRequest[]
    if (resend === 'nothing') return expect(second).toBeUndefined()
    expect(second?.answer).toEqual(first?.answer)
    expect(second?.responseId === first?.responseId).toBe(resend === 'the same id')
  })

  it('keeps the id while the outcome is unknown and refuses a new answer', async () => {
    const { controller, ports, replies, sent } = harness([pending(question([size]))])
    await controller.open('ix-1')
    expect(await type(controller, '1', 'yes')).toEqual([UNKNOWN])
    expect(await controller.input('2')).toEqual([
      'An earlier answer has an unknown result; settle it before answering again.',
    ])
    const [first] = sent() as InteractionClientRespondRequest[]
    replies.push(unknown)
    expect(await controller.checkStatus()).toEqual([UNKNOWN])
    expect(ports.responseStatus).toHaveBeenCalledWith(first?.responseId)
    replies.push(status('applied'))
    await controller.resubmit()
    expect(sent()).toEqual([first, first])
    expect(controller.phase).toBe('applied')
  })

  it('after a restart shows a journaled answer as unknown and sends it again unchanged', async () => {
    const params = {
      interactionId: 'ix-1',
      responseId: 'r-1',
      expectedVersion: 3,
      answer: inline({ size: 'l' }),
    }
    const journal = [{ commandId: 'r-1', method: 'interaction.respond', params }]
    const { controller, ports, replies, sent } = harness([pending(question([size]))], journal)
    expect((await controller.open('ix-1')).at(-1)).toBe(UNKNOWN)
    replies.push(status('not-accepted'))
    expect(await controller.checkStatus()).toEqual([
      'Not accepted; the question is still pending.',
      'Will submit:',
      '  Size: Large',
      'Type yes to submit, or no to start over.',
    ])
    expect(ports.responseStatus).toHaveBeenCalledWith('r-1')
    replies.push(status('applied'))
    await controller.input('yes')
    expect(sent()).toEqual([params])
  })

  it.each<[string, InteractionRecord, string[]]>([
    [
      'expired',
      { ...pending(question([size])), status: 'expired', terminationReason: 'deadline' } as InteractionRecord,
      ['This question has expired.'],
    ],
    [
      'cancelled',
      {
        ...pending(question([size])),
        status: 'cancelled',
        terminationReason: 'run ended',
      } as InteractionRecord,
      ['This question was cancelled.'],
    ],
    ['answered', answered(question([size]), { size: 'l' }), ['Answered.', '  Size: Large']],
  ])('shows only the final state of a question that is %s', async (_name, record, final) => {
    const { controller, ports, sent } = harness([record])
    expect(await controller.open('ix-1')).toEqual(['Survey', 'Tell us', ...final])
    expect(controller.phase).toBe('closed')
    expect(await controller.input('1')).toEqual([])
    expect(ports.pendingJournal).not.toHaveBeenCalled()
    expect(sent()).toEqual([])
  })

  it('strips control and format characters from question text', async () => {
    const field = { ...size, label: 'Si\u202eze', options: [{ id: 's', label: 'S\x1b[2Jmall\nnow' }] }
    const request = question([field], { title: 'Sur\u2066vey\x07', body: 'Line\x1b]0;x\x07\r\nTwo' })
    const { controller } = harness([pending(request)])
    expect(await controller.open('ix-1')).toEqual([
      'Survey',
      'Line]0;x',
      'Two',
      'Size',
      '[1] S[2Jmall now',
      'Enter a number from 1 to 1.',
    ])
  })
})
