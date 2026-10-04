import { describe, expect, it } from 'vitest'
import { brandString } from '../src/brand.js'
import { pendingRecovery, responseCheckpoint, responseReviewState } from '../src/response-review.js'
import type {
  DecisionContextPort,
  EnvironmentEpoch,
  IntentId,
  JsonValue,
  RecordId,
  RuntimeRecord,
  ToolOutcome,
  TurnId,
} from '../src/types.js'

const turn = brandString<TurnId>('review-turn')
const priorTurn = brandString<TurnId>('prior-turn')
const rid = (value: string): RecordId => brandString<RecordId>(value)
const header = (id: string, owner = turn) => ({ version: 1 as const, id: rid(id), turn: owner })
const state: { [key: string]: JsonValue } = {
  task: { requests: ['Inspect the current file'] },
  rules: [{ source: 'host', scope: 'session', text: 'Use the admitted workspace.' }],
  environment: { cwd: '/workspace' },
  workspace: {
    root: '/workspace',
    entries: [{ path: 'main.py', kind: 'file', size: 4 }],
    coverage: {
      depth: 1,
      complete: true,
      contentRead: false,
      observedAt: 'observation:1',
      laterChanges: 'unknown',
    },
  },
  resources: {
    attachments: {
      items: [
        {
          ref: 'attachment:1',
          inputRef: 'request:1',
          reference: { id: 'digest-1', size: 4, mediaType: 'image/png' },
        },
      ],
      coverage: { complete: true },
    },
  },
  history: [],
  pending: [],
}
const success: ToolOutcome = {
  kind: 'success',
  value: { contents: 'same' },
  content: [],
  directive: { conclude: false, additions: [] },
}

function action(
  id: string,
  outcome: ToolOutcome = success,
  effect: 'none' | 'not_applied' | 'unknown' = 'none',
): RuntimeRecord[] {
  const intentId = brandString<IntentId>(`intent-${id}`)
  return [
    {
      ...header(`intended-${id}`),
      kind: 'action.intended',
      decision: rid('decision'),
      intent: {
        id: intentId,
        tool: 'read',
        arguments: { path: 'main.py' },
        toolRevision: 'v1',
        effectClass: 'read_only',
        environmentEpoch: brandString<EnvironmentEpoch>('environment'),
      },
    },
    { ...header(`settled-${id}`), kind: 'action.settled', intentId, outcome, effect, observations: [] },
  ]
}

function observedAction(
  id: string,
  value: JsonValue,
  codec = 'dsh-native-tool-observation-v1',
  complete = true,
): RuntimeRecord[] {
  return action(id).map((record): RuntimeRecord => {
    if (record.kind === 'action.intended')
      return {
        ...record,
        intent: { ...record.intent, environmentEpoch: brandString<EnvironmentEpoch>(`epoch-${id}`) },
      }
    return record.kind === 'action.settled'
      ? {
          ...record,
          observations: [
            {
              kind: 'native-file',
              source: 'read',
              data: {
                codec,
                value,
                producer: {
                  tool: 'read',
                  toolRevision: 'v1',
                  intentId: record.intentId,
                  environmentEpoch: `epoch-${id}`,
                },
              },
              coverage: { complete, environmentEpoch: `epoch-${id}` },
            },
          ],
        }
      : record
  })
}

const describeFixtureObservation: NonNullable<DecisionContextPort['describeObservation']> = (observation) => {
  const data = observation.data as Record<string, JsonValue>
  const coverage = observation.coverage as Record<string, JsonValue>
  if (data.codec !== 'dsh-native-tool-observation-v1') return { data: observation.data, coverage }
  const { environmentEpoch: _epoch, ...semanticCoverage } = coverage
  return { data: data.value!, coverage: semanticCoverage }
}

function resource(id: string, value: JsonValue, owner = turn): RuntimeRecord {
  return { ...header(id, owner), kind: 'resource.observed', resource: value }
}

function feedback(id: string, owner = turn): RuntimeRecord {
  return resource(
    id,
    {
      kind: 'jev.runtime.feedback.v1',
      code: 'INVALID_PARAMETERS',
      stage: 'parameters',
      sourceRecordId: 'model-result',
      operation: 'read',
      message: 'Missing required path',
    },
    owner,
  )
}

function review(
  id: string,
  checkpoint: string,
  stage: string,
  verdict?: string,
  owner = turn,
): RuntimeRecord {
  return resource(
    id,
    { kind: 'jev.response-review.v1', checkpoint, stage, ...(verdict === undefined ? {} : { verdict }) },
    owner,
  )
}

function modelHistory(): RuntimeRecord[] {
  const request: RuntimeRecord = {
    ...header('request'),
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
  }
  return [
    request,
    {
      ...header('result'),
      kind: 'model.settled',
      requested: request.id,
      settlement: { output: { confidence: 0.2 } },
    },
    {
      ...header('decision'),
      kind: 'decision.selected',
      requested: request.id,
      source: 'jev',
      phase: 'ACT',
      operation: 'read',
      confidence: 0.2,
    },
    resource('diagnostic', { kind: 'jev.candidate.policy.v1', maxPerTool: 4 }),
    resource('review-diagnostic', {
      kind: 'jev.response-review.v1',
      checkpoint: 'checkpoint',
      stage: 'requested',
    }),
  ]
}

describe('substantive response-review checkpoints', () => {
  it('ignores model calls, decisions, diagnostics and history display cropping', async () => {
    const initial = await responseCheckpoint([], turn, state)
    const observed = await responseCheckpoint(modelHistory(), turn, {
      ...state,
      history: [{ kind: 'observation', name: 'diagnostic', data: { confidence: 0.01 } }],
      coverage: { history: { omitted: 100 } },
    })
    expect(observed).toBe(initial)
  })

  it('deduplicates repeated equal action results despite new identities and transport metadata', async () => {
    const once = action('one')
    const twice = [...once, ...action('two', { ...success, meta: { latencyMs: 200, callId: 'different' } })]
    expect(await responseCheckpoint(twice, turn, state)).toBe(await responseCheckpoint(once, turn, state))
    expect(await responseCheckpoint(once, turn, state)).not.toBe(await responseCheckpoint([], turn, state))
  })

  it.each([{ contents: 'same' }, null])(
    'uses host projection to ignore recognized producer identities for %j',
    async (value) => {
      const once = observedAction('one', value)
      const twice = [...once, ...observedAction('two', value)]
      const seen: RecordId[] = []
      const describe: NonNullable<DecisionContextPort['describeObservation']> = (observation) => {
        seen.push(observation.sourceRecordId)
        return describeFixtureObservation(observation)
      }
      const checkpoint = await responseCheckpoint(once, turn, state, describe)
      expect(await responseCheckpoint(twice, turn, state, describe)).toBe(checkpoint)
      expect(seen).toEqual([rid('settled-one'), rid('settled-one'), rid('settled-two')])
      expect(await responseCheckpoint(twice, turn, state)).not.toBe(
        await responseCheckpoint(once, turn, state),
      )
    },
  )

  it('preserves changes to host-projected data and coverage', async () => {
    const once = observedAction('one', { contents: 'same' })
    const checkpoint = await responseCheckpoint(once, turn, state, describeFixtureObservation)
    for (const changed of [
      observedAction('two', { contents: 'changed' }),
      observedAction('two', { contents: 'same' }, 'dsh-native-tool-observation-v1', false),
    ])
      expect(await responseCheckpoint(changed, turn, state, describeFixtureObservation)).not.toBe(checkpoint)
  })

  it('retains explicit null projected coverage rather than restoring transport fields', async () => {
    const once = observedAction('one', { contents: 'same' })
    const twice = [...once, ...observedAction('two', { contents: 'same' })]
    const describe: NonNullable<DecisionContextPort['describeObservation']> = (observation) => ({
      data: describeFixtureObservation(observation).data,
      coverage: null,
    })
    expect(await responseCheckpoint(twice, turn, state, describe)).toBe(
      await responseCheckpoint(once, turn, state, describe),
    )
  })

  it('retains unknown-codec fields when the host projection cannot classify their meaning', async () => {
    const once = observedAction('one', { contents: 'same' }, 'unknown-v1')
    const changed = observedAction('two', { contents: 'same' }, 'unknown-v1')
    const checkpoint = await responseCheckpoint(once, turn, state, describeFixtureObservation)
    expect(checkpoint).toBe(await responseCheckpoint(once, turn, state))
    expect(await responseCheckpoint(changed, turn, state, describeFixtureObservation)).not.toBe(checkpoint)
    expect(await responseCheckpoint(changed, turn, state, describeFixtureObservation)).toBe(
      await responseCheckpoint(changed, turn, state),
    )
  })

  it('does not treat workspace observation numbering as fresh evidence', async () => {
    const workspace = state.workspace as Record<string, JsonValue>
    const coverage = workspace.coverage as Record<string, JsonValue>
    const renumbered = {
      ...state,
      workspace: { ...workspace, coverage: { ...coverage, observedAt: 'observation:47' } },
    }
    expect(await responseCheckpoint([], turn, renumbered)).toBe(await responseCheckpoint([], turn, state))
  })

  it('ignores local attachment and input aliases while preserving attachment content identity', async () => {
    const resources = {
      attachments: {
        items: [
          {
            ref: 'attachment:9',
            inputRef: 'user:7',
            reference: { id: 'digest-1', size: 4, mediaType: 'image/png' },
          },
        ],
        coverage: { complete: true },
      },
    }
    expect(await responseCheckpoint([], turn, { ...state, resources })).toBe(
      await responseCheckpoint([], turn, state),
    )
    resources.attachments.items[0]!.reference.id = 'digest-2'
    expect(await responseCheckpoint([], turn, { ...state, resources })).not.toBe(
      await responseCheckpoint([], turn, state),
    )
  })

  it('changes on actual task, rule, resource or pending changes', async () => {
    const initial = await responseCheckpoint([], turn, state)
    for (const changed of [
      { ...state, task: { requests: ['Inspect another file'] } },
      { ...state, rules: [{ source: 'host', scope: 'session', text: 'Do not read files.' }] },
      { ...state, workspace: { root: '/workspace', entries: [], coverage: { complete: false } } },
      { ...state, pending: [{ kind: 'action', ref: 'step:1', status: 'dispatched' }] },
    ])
      expect(await responseCheckpoint([], turn, changed)).not.toBe(initial)
    expect(await responseCheckpoint([], priorTurn, state)).not.toBe(initial)
  })

  it('changes when structured execution observations or their coverage change', async () => {
    const base = action('one')
    const observed = base.map(
      (record): RuntimeRecord =>
        record.kind === 'action.settled'
          ? {
              ...record,
              observations: [
                {
                  kind: 'directory',
                  source: 'host',
                  data: { entries: ['a'] },
                  coverage: { complete: false },
                },
              ],
            }
          : record,
    )
    const wider = observed.map(
      (record): RuntimeRecord =>
        record.kind === 'action.settled'
          ? {
              ...record,
              observations: [
                { kind: 'directory', source: 'host', data: { entries: ['a'] }, coverage: { complete: true } },
              ],
            }
          : record,
    )
    const changed = observed.map(
      (record): RuntimeRecord =>
        record.kind === 'action.settled'
          ? {
              ...record,
              observations: [
                {
                  kind: 'directory',
                  source: 'host',
                  data: { entries: ['a', 'b'] },
                  coverage: { complete: false },
                },
              ],
            }
          : record,
    )
    const checkpoint = await responseCheckpoint(observed, turn, state)
    expect(await responseCheckpoint(wider, turn, state)).not.toBe(checkpoint)
    expect(await responseCheckpoint(changed, turn, state)).not.toBe(checkpoint)
  })

  it('ignores prior-turn results and JSON key ordering', async () => {
    const records = action('old').map((record) => ({ ...record, turn: priorTurn }))
    const reverse = Object.fromEntries(Object.entries(state).reverse())
    expect(await responseCheckpoint(records, turn, reverse)).toBe(await responseCheckpoint([], turn, state))
  })
})

describe('durable response review state', () => {
  it('retains every consumed attempt and the accepted verdict after reconstructing the prefix', () => {
    for (const verdict of ['allow_response', 'continue_call']) {
      const records = [
        review('request-one', 'checkpoint', 'requested'),
        feedback('invalid-review'),
        review('request-two', 'checkpoint', 'requested'),
        review('accepted', 'checkpoint', 'accepted', verdict),
      ]
      expect(responseReviewState(records.slice(0, 2), turn, 'checkpoint')).toEqual({ attempts: 1 })
      const reopened = JSON.parse(JSON.stringify(records)) as RuntimeRecord[]
      expect(responseReviewState(reopened, turn, 'checkpoint')).toEqual({ attempts: 2, accepted: verdict })
      expect(responseReviewState([...reopened, ...modelHistory()], turn, 'checkpoint')).toEqual({
        attempts: 3,
        accepted: verdict,
      })
    }
  })

  it('isolates attempts by task turn and evidence checkpoint', () => {
    const records = [
      review('prior', 'checkpoint', 'requested', undefined, priorTurn),
      review('other', 'other-checkpoint', 'requested'),
      review('request', 'checkpoint', 'requested'),
      review('accepted-other', 'other-checkpoint', 'accepted', 'allow_response'),
      resource('unrelated', { kind: 'diagnostic', checkpoint: 'checkpoint', stage: 'requested' }),
    ]
    expect(responseReviewState(records, turn, 'checkpoint')).toEqual({ attempts: 1 })
    expect(responseReviewState(records, turn, 'other-checkpoint')).toEqual({
      attempts: 1,
      accepted: 'allow_response',
    })
  })
})

describe('pending recovery', () => {
  it('does not mistake repeated successful reads for a recoverable failure', () => {
    expect(pendingRecovery([...action('one'), ...action('two')], turn)).toBeUndefined()
    expect(pendingRecovery([feedback('prior', priorTurn), ...action('one')], turn)).toBeUndefined()
  })

  it('retains typed current-turn feedback through unrelated model and diagnostic records', () => {
    expect(pendingRecovery([feedback('failure'), ...modelHistory()], turn)).toBe(rid('failure'))
    expect(pendingRecovery([feedback('prior', priorTurn)], turn)).toBeUndefined()
  })

  it('clears recovery after success or accepted arbitration, and recognizes a newer failure', () => {
    expect(pendingRecovery([feedback('failure'), ...action('success')], turn)).toBeUndefined()
    const accepted: RuntimeRecord = {
      ...header('arbitrated'),
      kind: 'decision.selected',
      requested: rid('request'),
      source: 'llm_arbitration',
      phase: 'ACT',
      operation: 'read',
    }
    expect(pendingRecovery([feedback('failure'), accepted], turn)).toBeUndefined()
    const failed = action(
      'failed',
      { ...success, kind: 'error', error: { code: 'READ_FAILED', message: 'Unavailable' } },
      'not_applied',
    )
    expect(pendingRecovery([feedback('failure'), accepted, ...failed], turn)).toBe(rid('settled-failed'))
    expect(pendingRecovery(action('unknown', { ...success, kind: 'error' }, 'unknown'), turn)).toBeUndefined()
  })
})
