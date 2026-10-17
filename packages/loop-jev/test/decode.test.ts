import { describe, expect, it } from 'vitest'
import { compileQuestions } from '../src/compile.js'
import { decodeAnswers, validateChoice } from '../src/decode.js'
import { resolveTool } from '../src/profile.js'
import type { CompiledQuestions, ResolvedTool } from '../src/types.js'
import { BUILTIN_SCHEMAS } from './helpers/view.js'

const IDS = ['search', 'open', 'done']
const answer = (choice = 'open', p = [0.1, 0.9, 0.0], confidence = 0.8) => ({
  choice,
  confidence,
  probabilities: Object.fromEntries(IDS.map((id, i) => [id, p[i]]).filter(([, v]) => v !== undefined)),
})

describe('validateChoice', () => {
  it('accepts a legal argmax over the full distribution', () =>
    expect(validateChoice(answer(), IDS)?.choice).toBe('open'))
  it.each([
    ['choice not in candidates', answer('unknown')],
    ['missing candidate probability', answer('open', [0.1, 0.9])],
    ['negative probability', answer('open', [0.3, 0.9, -0.2])],
    ['sums above 1', answer('open', [0.5, 0.6, 0.0])],
    ['chosen is not the argmax', answer('search', [0.1, 0.9, 0.0])],
    ['missing fields', { choice: 'open' }],
    [
      'non-numeric probability',
      { choice: 'open', probabilities: { search: 'x', open: 1, done: 0 }, confidence: 0.5 },
    ],
    ['confidence above 1', answer('open', [0.1, 0.9, 0], 1.2)],
    ['sum off by 0.03', answer('open', [0.1, 0.9, 0.03])],
    [
      'an extra probability key',
      { ...answer(), probabilities: { search: 0.1, open: 0.9, done: 0, extra: 0 } },
    ],
    [
      'boolean probability',
      { choice: 'open', probabilities: { search: false, open: 1, done: 0 }, confidence: 0.5 },
    ],
  ])('refuses %s', (_name, bad) => expect(validateChoice(bad, IDS)).toBeNull())
  it('tolerates a sum that is off by less than 0.02', () =>
    expect(validateChoice(answer('open', [0.1, 0.9, 0.015]), IDS)?.choice).toBe('open'))
})

const c = compileQuestions(
  ['ls', 'read', 'grep', 'find', 'write', 'edit', 'shell'].map(
    (name) =>
      resolveTool({ name, description: name, parameters: BUILTIN_SCHEMAS[name] } as never) as ResolvedTool,
  ),
)
const choice = (ids: string[], pick: string, confidence: number) => ({
  choice: pick,
  confidence,
  probabilities: Object.fromEntries(
    ids.map((id) => [id, id === pick ? confidence : (1 - confidence) / (ids.length - 1)]),
  ),
})
const PHASES = ['INSPECT', 'ACT', 'VERIFY', 'RESPOND']
const INSPECT = ['ls', 'read', 'grep', 'find', 'shell']

describe('decodeAnswers', () => {
  it('consumes phase, action and target and takes the minimum confidences', () => {
    const r = decodeAnswers(
      {
        phase: choice(PHASES, 'INSPECT', 0.9),
        action__inspect: choice(INSPECT, 'ls', 0.7),
        target__inspect__ls: choice(['LLM_PARAMETERS', 'DEFAULT_ARGUMENTS'], 'DEFAULT_ARGUMENTS', 0.6),
      },
      c,
    )
    expect(r.ok && r.decision).toMatchObject({
      phase: 'INSPECT',
      op: 'ls',
      target: 'DEFAULT_ARGUMENTS',
      bindingMode: 'defaults',
      args: { path: '.' },
      confidence: 0.6,
      operationPathConfidence: 0.7,
      targetConfidence: 0.6,
    })
  })
  it('treats a constant action as deterministic and outside the minimum', () => {
    const r = decodeAnswers({ phase: choice(PHASES, 'RESPOND', 0.8) }, c)
    expect(r.ok && r.decision).toMatchObject({
      op: 'ANSWER',
      bindingMode: 'llm_parameters',
      args: {},
      confidence: 0.8,
      operationPathConfidence: 0.8,
      targetConfidence: null,
      actionTop: [['ANSWER', 1]],
    })
  })
  it('refuses a missing selected head but ignores unconsumed garbage', () => {
    expect(decodeAnswers({ phase: choice(PHASES, 'INSPECT', 0.9) }, c).ok).toBe(false)
    expect(decodeAnswers({ phase: choice(PHASES, 'RESPOND', 0.9), action__act: 'garbage' }, c).ok).toBe(true)
    expect(decodeAnswers('not-an-object', c).ok).toBe(false)
  })
  it('parses meta signals leniently', () => {
    const good = decodeAnswers(
      {
        phase: choice(PHASES, 'RESPOND', 0.9),
        meta_ambiguity: { type: 'noul', noul: 0.83 },
        meta_progress: { type: 'score', score: 2.5, confidence: 0.6 },
      },
      c,
    )
    expect(good.ok && [good.decision.ambiguity, good.decision.progress]).toEqual([0.83, 2.5])
    const bad = decodeAnswers(
      { phase: choice(PHASES, 'RESPOND', 0.9), meta_ambiguity: { noul: 'x' }, meta_progress: { score: 4 } },
      c,
    )
    expect(bad.ok && [bad.decision.ambiguity, bad.decision.progress]).toEqual([null, null])
  })
  it('ranks the phase distribution for the arbitration note', () => {
    const r = decodeAnswers({ phase: choice(PHASES, 'RESPOND', 0.7) }, c)
    expect(r.ok && r.decision.phaseTop[0]).toEqual(['RESPOND', 0.7])
    expect(r.ok && r.decision.phaseTop).toHaveLength(4)
  })
})

describe('decodeAnswers on a hand-built surface', () => {
  const keys = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, id]))
  const options = keys('LLM_PARAMETERS', 'DEFAULT_ARGUMENTS')
  const surface = (overrides: Partial<CompiledQuestions> = {}): CompiledQuestions =>
    ({
      questions: {
        phase: { type: 'choice', criteria: keys('INSPECT', 'RESPOND'), instructions: [] },
        action__inspect: { type: 'choice', criteria: keys('ls', 'read'), instructions: [] },
        target__inspect__ls: { type: 'choice', criteria: options, instructions: [] },
      },
      phaseActions: {},
      actionHeads: { INSPECT: 'action__inspect' },
      actionConstants: { RESPOND: 'ANSWER' },
      targetHeads: { 'INSPECT/ls': 'target__inspect__ls' },
      targetConstants: { 'INSPECT/read': 'LLM_PARAMETERS', 'RESPOND/ANSWER': 'LLM_PARAMETERS' },
      targetOptions: {},
      defaults: { ls: { path: '.' } },
      ...overrides,
    }) as unknown as CompiledQuestions
  const phases = ['INSPECT', 'RESPOND']
  const ops = ['ls', 'read']

  it('returns args that do not alias the shared defaults', () => {
    const shared = surface()
    const r = decodeAnswers(
      {
        phase: choice(phases, 'INSPECT', 0.9),
        action__inspect: choice(ops, 'ls', 0.8),
        target__inspect__ls: choice(['LLM_PARAMETERS', 'DEFAULT_ARGUMENTS'], 'DEFAULT_ARGUMENTS', 0.7),
      },
      shared,
    )
    if (!r.ok) throw new Error(r.reason)
    ;(r.decision.args as { [key: string]: unknown }).path = 'changed'
    expect(shared.defaults.ls).toEqual({ path: '.' })
  })
  it('refuses a selected non-FIX action whose target head is missing', () => {
    const r = decodeAnswers(
      { phase: choice(phases, 'INSPECT', 0.9), action__inspect: choice(ops, 'ls', 0.8) },
      surface(),
    )
    expect(r.ok).toBe(false)
  })
  it('refuses DEFAULT_ARGUMENTS when the operation has no defaults', () => {
    const r = decodeAnswers(
      {
        phase: choice(phases, 'INSPECT', 0.9),
        action__inspect: choice(ops, 'ls', 0.8),
        target__inspect__ls: choice(['LLM_PARAMETERS', 'DEFAULT_ARGUMENTS'], 'DEFAULT_ARGUMENTS', 0.7),
      },
      surface({ defaults: {} }),
    )
    expect(r.ok).toBe(false)
  })
  it('takes both path confidences from a stochastic action with a constant target', () => {
    const r = decodeAnswers(
      { phase: choice(phases, 'INSPECT', 0.9), action__inspect: choice(ops, 'read', 0.6) },
      surface(),
    )
    expect(r.ok && r.decision).toMatchObject({
      op: 'read',
      target: 'LLM_PARAMETERS',
      bindingMode: 'llm_parameters',
      confidence: 0.6,
      operationPathConfidence: 0.6,
      targetConfidence: null,
    })
  })
  it('reports no ambiguity or progress when the meta heads are absent', () => {
    const r = decodeAnswers({ phase: choice(phases, 'RESPOND', 0.9) }, surface())
    expect(r.ok && [r.decision.ambiguity, r.decision.progress]).toEqual([null, null])
  })
})
