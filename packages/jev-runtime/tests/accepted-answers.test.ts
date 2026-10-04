import { describe, expect, it } from 'vitest'
import { AcceptedAnswers } from '../src/accepted-answers.js'
import { brandString } from '../src/brand.js'
import type { JsonValue, RecordId, RuntimeRecord, TurnId } from '../src/types.js'

const base = { version: 1 as const, turn: brandString<TurnId>('turn') }
const request: RuntimeRecord & { kind: 'model.requested' } = {
  ...base,
  kind: 'model.requested',
  id: brandString<RecordId>('request'),
  call: {
    purpose: 'arbitration',
    backend: 'fixture',
    endpoint: 'fixture',
    requestedModel: 'fixture',
    codec: 'fixture',
    input: {},
    inputCursor: null,
  },
}
const settled: RuntimeRecord & { kind: 'model.settled' } = {
  ...base,
  kind: 'model.settled',
  id: brandString<RecordId>('settled'),
  requested: request.id,
  settlement: { output: { kind: 'answer', content: [{ kind: 'text', text: 'Grounded answer' }] } },
}
const selected: RuntimeRecord & { kind: 'decision.selected' } = {
  ...base,
  kind: 'decision.selected',
  id: brandString<RecordId>('selected'),
  requested: request.id,
  source: 'llm_arbitration',
  phase: 'RESPOND',
  operation: 'RESPOND',
}

describe('committed answer admission', () => {
  it('keeps arbitration private until selection and admits the selected settlement once', () => {
    const answers = new AcceptedAnswers()
    expect(answers.apply(request)).toBeUndefined()
    expect(answers.apply(settled)).toBeUndefined()
    expect(answers.apply(selected)).toEqual({ request, settled })
    expect(answers.apply(selected)).toBeUndefined()
  })

  it.each<JsonValue | undefined>([
    undefined,
    null,
    [],
    { kind: 'answer' },
    { kind: 'answer', content: 'text' },
    { kind: 'cannot_bind', content: [] },
  ])('does not project a legacy marker or unrelated output: %j', (output) => {
    const answers = new AcceptedAnswers()
    answers.apply(request)
    answers.apply({ ...settled, settlement: output === undefined ? {} : { output } })
    expect(answers.apply(selected)).toBeUndefined()
  })

  it('requires the exact request, successful settlement, and arbitration RESPOND selection', () => {
    for (const records of [
      [selected],
      [request, selected],
      [settled, selected],
      [
        request,
        { ...settled, settlement: { error: { code: 'REFUSED', message: 'Refused', retryable: false } } },
        selected,
      ],
      [request, settled, { ...selected, source: 'jev' as const }],
      [request, settled, { ...selected, operation: 'tool' }],
      [request, settled, { ...selected, phase: 'ACT' }],
      [{ ...request, call: { ...request.call, purpose: 'parameters' as const } }, settled, selected],
    ] satisfies RuntimeRecord[][]) {
      const answers = new AcceptedAnswers()
      expect(records.flatMap((record) => answers.apply(record) ?? [])).toEqual([])
    }
  })

  it('admits standalone answer settlements without an arbitration selection', () => {
    const answers = new AcceptedAnswers()
    const answerRequest = { ...request, call: { ...request.call, purpose: 'answer' as const } }
    answers.apply(answerRequest)
    expect(answers.apply(settled)).toEqual({ request: answerRequest, settled })
    expect(answers.apply(selected)).toBeUndefined()
  })
})
