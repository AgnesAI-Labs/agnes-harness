import { describe, expect, it } from 'vitest'
import { brandString } from '../src/brand.js'
import { progressOf, readFeedback, repeatedIntent } from '../src/progress.js'
import type {
  EnvironmentEpoch,
  FrozenIntent,
  IntentId,
  JsonValue,
  RecordId,
  RuntimeRecord,
  StepId,
  TurnId,
} from '../src/types.js'

const turn = brandString<TurnId>('turn')
const rid = (value: string): RecordId => brandString<RecordId>(value)
const header = (id: string) => ({
  version: 1 as const,
  id: rid(id),
  turn,
  step: brandString<StepId>(`step-${id}`),
})
const intent = (id: string, path = 'a'): FrozenIntent => ({
  id: brandString<IntentId>(`intent-${id}`),
  tool: 'read',
  toolRevision: 'v1',
  arguments: { path },
  effectClass: 'read_only',
  environmentEpoch: brandString<EnvironmentEpoch>('epoch'),
})

function action(
  id: string,
  path = 'a',
  value: JsonValue = 'same',
  kind: 'success' | 'error' = 'success',
  effect: 'none' | 'not_applied' | 'unknown' = 'none',
): RuntimeRecord[] {
  const frozen = intent(id, path)
  return [
    { ...header(`intended-${id}`), kind: 'action.intended', intent: frozen, decision: rid('decision') },
    {
      ...header(`dispatch-${id}`),
      kind: 'action.dispatching',
      intentId: frozen.id,
      epoch: frozen.environmentEpoch,
    },
    {
      ...header(id),
      kind: 'action.settled',
      intentId: frozen.id,
      effect,
      observations: [],
      outcome: {
        kind,
        value,
        content: [],
        directive: { conclude: false, additions: [] },
        ...(kind === 'error' ? { error: { code: 'FAILED', message: 'retry' } } : {}),
      },
    },
  ]
}

function user(id: string, text: string, source = 'user'): RuntimeRecord {
  return { ...header(id), kind: 'input.admitted', input: { id, source, content: [{ kind: 'text', text }] } }
}

describe('substantive progress checkpoints', () => {
  it('keeps earlier batch success as progress after a later failure and counts no-progress once per step', () => {
    const batch = (id: string): RuntimeRecord[] =>
      [...action(`${id}-success`, 'a'), ...action(`${id}-failure`, 'b', 'failed', 'error')].map((record) => ({
        ...record,
        step: brandString<StepId>(`batch-${id}`),
      }))
    const first = batch('one')
    expect(progressOf(first, turn)).toEqual({ noProgress: 0, repeatedFailures: 1, invalidDecisions: 0 })
    const repeated = [...first, ...batch('two')]
    expect(progressOf(repeated, turn)).toEqual({ noProgress: 1, repeatedFailures: 2, invalidDecisions: 0 })
    expect(progressOf([...repeated, ...batch('three')], turn).noProgress).toBe(2)
    expect(progressOf(JSON.parse(JSON.stringify(repeated)) as RuntimeRecord[], turn)).toEqual(
      progressOf(repeated, turn),
    )
    const fresh = [
      ...action('fresh-success', 'c', 'new evidence'),
      ...action('same-old-success', 'a'),
      ...action('same-old-failure', 'b', 'failed', 'error'),
    ].map((record) => ({ ...record, step: brandString<StepId>('fresh-batch') }))
    expect(progressOf([...repeated, ...fresh], turn)).toEqual({
      noProgress: 0,
      repeatedFailures: 3,
      invalidDecisions: 0,
    })
  })

  it('refuses a third equal dispatch until a new successful invocation result advances the checkpoint', () => {
    const twice = [...action('one'), ...action('two')]
    expect(repeatedIntent(twice, turn, intent('next'))).toBe(true)
    const advanced = [...twice, ...action('different', 'b')]
    expect(repeatedIntent(advanced, turn, intent('next'))).toBe(false)
    expect(progressOf(advanced, turn).noProgress).toBe(0)
    const reread = [...advanced, ...action('reread')]
    expect(repeatedIntent(reread, turn, intent('next'))).toBe(false)
    expect(progressOf(reread, turn).noProgress).toBe(1)
    expect(repeatedIntent([...reread, ...action('reread-again')], turn, intent('next'))).toBe(true)
  })

  it('counts unchanged A/B alternation as no progress after both results have been observed', () => {
    const records = [...action('a1'), ...action('b1', 'b'), ...action('a2'), ...action('b2', 'b')]
    expect(progressOf(records, turn).noProgress).toBe(2)
    expect(repeatedIntent([...records, ...action('a3')], turn, intent('next'))).toBe(true)
    expect(progressOf([...records, ...action('a3')], turn).noProgress).toBe(3)
  })

  it('recognizes a changed canonical result of the same invocation as new successful evidence', () => {
    const records = [...action('one'), ...action('two'), ...action('changed', 'a', 'new content')]
    expect(repeatedIntent(records, turn, intent('next'))).toBe(false)
    expect(progressOf(records, turn).noProgress).toBe(0)
    expect(
      repeatedIntent([...records, ...action('same-new', 'a', 'new content')], turn, intent('next')),
    ).toBe(true)
  })

  it.each([
    ['error', 'none'],
    ['success', 'unknown'],
    ['success', 'not_applied'],
  ] as const)('does not advance for a %s result with %s disposition', (kind, effect) => {
    const records = [...action('one'), ...action('two'), ...action('failed', 'b', 'different', kind, effect)]
    expect(repeatedIntent(records, turn, intent('next'))).toBe(true)
    expect(progressOf(records, turn).noProgress).toBe(2)
  })

  it('starts a new task-content checkpoint only for distinct nonempty admitted user content', () => {
    const twice = [user('task', 'Read a'), ...action('one'), ...action('two')]
    for (const extra of [
      user('same-new-id', 'Read a'),
      user('blank', ' \n '),
      user('tool-context', 'New instructions', 'tool'),
    ]) {
      expect(repeatedIntent([...twice, extra], turn, intent('next'))).toBe(true)
      expect(progressOf([...twice, extra], turn).noProgress).toBe(1)
    }
    const newTask = [...twice, user('new-task', 'Recheck the result')]
    expect(repeatedIntent(newTask, turn, intent('next'))).toBe(false)
    expect(progressOf(newTask, turn).noProgress).toBe(0)
    expect(progressOf([...newTask, ...action('first-for-new-task')], turn).noProgress).toBe(0)
  })

  it('uses attachment content identity without treating transport ids as new task input', () => {
    const attachment = (id: string, digest: string): RuntimeRecord => ({
      ...header(id),
      kind: 'input.admitted',
      input: {
        id,
        source: 'user',
        content: [{ kind: 'artifact', artifact: { id, digest, size: 4, mediaType: 'image/png' } }],
      },
    })
    const twice = [attachment('file-1', 'digest-1'), ...action('one'), ...action('two')]
    expect(repeatedIntent([...twice, attachment('file-2', 'digest-1')], turn, intent('next'))).toBe(true)
    expect(repeatedIntent([...twice, attachment('file-3', 'digest-2')], turn, intent('next'))).toBe(false)
  })

  it('does not reset for diagnostic resources, model output, epoch changes or record numbering', () => {
    const records: RuntimeRecord[] = [
      ...action('one'),
      ...action('two'),
      { ...header('empty'), kind: 'resource.observed', resource: {} },
      {
        ...header('diagnostic'),
        kind: 'resource.observed',
        resource: { kind: 'jev.candidate.route.v1', sequence: 100 },
      },
      {
        ...header('environment'),
        kind: 'environment.observed',
        epoch: brandString<EnvironmentEpoch>('different'),
        facts: {},
        catalog: [],
      },
      {
        ...header('requested'),
        kind: 'model.requested',
        call: {
          purpose: 'decision',
          backend: 'jev',
          endpoint: 'local',
          requestedModel: 'test',
          codec: 'json',
          input: {},
          inputCursor: null,
        },
      },
      {
        ...header('model-output'),
        kind: 'model.settled',
        requested: rid('requested'),
        settlement: { output: { fresh: true } },
      },
    ]
    expect(repeatedIntent(records, turn, intent('next'))).toBe(true)
    expect(progressOf(records, turn).noProgress).toBe(1)
    const reopened = JSON.parse(JSON.stringify(records)) as RuntimeRecord[]
    expect(repeatedIntent(reopened, turn, intent('next'))).toBe(true)
    expect(progressOf(reopened, turn)).toEqual(progressOf(records, turn))
  })

  it('preserves task-content reset ordering when an admitted follow-up shares the settled step', () => {
    const records = [...action('one'), ...action('two')]
    const after = { ...user('followup', 'Inspect again'), step: header('two').step }
    expect(progressOf([...records, after, ...action('new-task-read')], turn).noProgress).toBe(0)
    expect(repeatedIntent([...records, after, ...action('new-task-read')], turn, intent('next'))).toBe(false)
  })

  it.each([undefined, false] as const)(
    'retains turn-wide failure budgets with language visibility %s',
    (languageVisible) => {
      const records: RuntimeRecord[] = [user('task', 'Read a')]
      for (const id of ['one', 'two']) {
        records.push(
          {
            ...header(`request-${id}`),
            kind: 'model.requested',
            call: {
              purpose: 'decision',
              backend: 'jev',
              endpoint: 'local',
              requestedModel: 'test',
              codec: 'json',
              input: {},
              inputCursor: null,
            },
          },
          {
            ...header(`feedback-${id}`),
            kind: 'resource.observed',
            resource: {
              kind: 'jev.runtime.feedback.v1',
              code: 'INVALID_DECISION',
              stage: 'decision',
              sourceRecordId: `request-${id}`,
              operation: null,
              message: 'Selected path missing',
              ...(languageVisible === false ? { languageVisible } : {}),
            },
          },
        )
      }
      expect(progressOf(records, turn)).toEqual({ noProgress: 2, repeatedFailures: 2, invalidDecisions: 2 })
      expect(progressOf([...records, user('new-task', 'Inspect a different result')], turn)).toEqual({
        noProgress: 0,
        repeatedFailures: 2,
        invalidDecisions: 2,
      })
    },
  )

  it('rejects malformed language visibility in durable feedback', () => {
    expect(() =>
      readFeedback({
        kind: 'jev.runtime.feedback.v1',
        code: 'INVALID_DECISION',
        stage: 'decision',
        sourceRecordId: 'request',
        operation: null,
        message: 'Missing selection',
        languageVisible: true,
      }),
    ).toThrow('Invalid Jev runtime feedback record')
  })
})
