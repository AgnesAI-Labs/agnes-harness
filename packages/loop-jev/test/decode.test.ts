import { describe, expect, it } from 'vitest'
import { compileQuestions } from '../src/compile.js'
import { type DecodeResult, decodeAnswers, validateChoice } from '../src/decode.js'
import { resolveTool } from '../src/profile.js'
import type { Candidate, CompiledQuestions, ConsumedHead, ResolvedTool } from '../src/types.js'
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
      targetCandidates: {},
      modeHeads: {},
      memberHeads: {},
      multiTargetMax: {},
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

const files = (...keys: string[]): Candidate[] =>
  keys.map((key) => ({ key, kind: 'file', label: key, args: { offset: 1, limit: 200, path: key } }))
const pick = (options: string[], pickId: string, confidence: number) => ({
  choice: pickId,
  confidence,
  probabilities: Object.fromEntries(
    options.map((o) => [o, o === pickId ? confidence : (1 - confidence) / (options.length - 1)]),
  ),
})
const READ_ALL = ['ls', 'read', 'grep', 'find', 'write', 'edit', 'shell'].map(
  (name) =>
    resolveTool({ name, description: name, parameters: BUILTIN_SCHEMAS[name] } as never) as ResolvedTool,
)
const criteriaOf = (q: CompiledQuestions, head: string) =>
  Object.keys((q.questions[head] as { criteria: object }).criteria)
const base = (q: CompiledQuestions) => ({
  phase: pick(criteriaOf(q, 'phase'), 'INSPECT', 0.9),
  action__inspect: pick(criteriaOf(q, 'action__inspect'), 'read', 0.9),
})
const member = (pickId: 'include' | 'skip', confidence = 0.7) => pick(['include', 'skip'], pickId, confidence)
const decisionOf = (r: DecodeResult) => {
  if (!r.ok) throw new Error(r.reason)
  return r.decision
}
const mode = (pickId: 'one' | 'many', confidence = 0.8) => pick(['one', 'many'], pickId, confidence)

describe('observed bindings', () => {
  it('decodes an observed read target into its displayed arguments', () => {
    const q = compileQuestions(READ_ALL, { read: files('a.md', 'b.md') })
    const r = decodeAnswers(
      {
        ...base(q),
        target__inspect__read: pick(['a.md', 'b.md', 'LLM_PARAMETERS'], 'b.md', 0.8),
        target_mode__inspect__read: mode('one'),
      },
      q,
    )
    expect(r).toMatchObject({
      ok: true,
      decision: {
        op: 'read',
        target: 'b.md',
        bindingMode: 'observed',
        args: { path: 'b.md', offset: 1, limit: 200 },
        targetConfidence: 0.8,
      },
    })
    expect(decisionOf(r).batch).toBeUndefined()
  })
  it("decodes many with two included members into a batch at the members' minimum confidence", () => {
    const q = compileQuestions(READ_ALL, { read: files('a.md', 'b.md', 'c.md') })
    const r = decodeAnswers(
      {
        ...base(q),
        target_mode__inspect__read: mode('many'),
        include__inspect__read__0: member('include'),
        include__inspect__read__1: member('include'),
        include__inspect__read__2: member('skip'),
      },
      q,
    )
    expect(r).toMatchObject({
      ok: true,
      decision: {
        target: ['a.md', 'b.md'],
        bindingMode: 'observed',
        confidence: 0.7,
        operationPathConfidence: 0.9,
        targetConfidence: 0.7,
      },
    })
    expect(decisionOf(r).batch).toEqual([
      { offset: 1, limit: 200, path: 'a.md' },
      { offset: 1, limit: 200, path: 'b.md' },
    ])
    expect(decisionOf(r).args).toEqual({ offset: 1, limit: 200, path: 'a.md' })
    expect(decisionOf(r).consumed.map((x: ConsumedHead) => x.role)).toEqual([
      'phase',
      'action',
      'target_mode',
      'target_member',
      'target_member',
      'target_member',
    ])
  })
  it('narrows many with one included member to that target', () => {
    const q = compileQuestions(READ_ALL, { read: files('a.md', 'b.md') })
    const r = decodeAnswers(
      {
        ...base(q),
        target_mode__inspect__read: mode('many'),
        include__inspect__read__0: member('skip'),
        include__inspect__read__1: member('include', 0.6),
      },
      q,
    )
    expect(r).toMatchObject({
      ok: true,
      decision: { target: 'b.md', bindingMode: 'observed', targetConfidence: 0.6 },
    })
    expect(decisionOf(r).batch).toBeUndefined()
  })
  it('falls back to the target head when every member skips', () => {
    const q = compileQuestions(READ_ALL, { read: files('a.md', 'b.md') })
    const r = decodeAnswers(
      {
        ...base(q),
        target_mode__inspect__read: mode('many'),
        include__inspect__read__0: member('skip', 0.9),
        include__inspect__read__1: member('skip', 0.9),
        target__inspect__read: pick(['a.md', 'b.md', 'LLM_PARAMETERS'], 'a.md', 0.75),
      },
      q,
    )
    expect(r).toMatchObject({ ok: true, decision: { target: 'a.md', targetConfidence: 0.75 } })
    expect(decisionOf(r).consumed.some((x: ConsumedHead) => x.role === 'target_fallback')).toBe(true)
  })
  it('refuses more included members than the tool allows', () => {
    const keys = ['a', 'b', 'c', 'd', 'e']
    const q = compileQuestions(READ_ALL, { read: files(...keys) })
    const members = Object.fromEntries(
      keys.map((_, i) => [`include__inspect__read__${i}`, member('include')]),
    )
    expect(decodeAnswers({ ...base(q), target_mode__inspect__read: mode('many'), ...members }, q)).toEqual({
      ok: false,
      reason: 'Jev selected 5 targets for read; multi-target mode allows at most 4.',
    })
  })
  it('refuses a batch whose members disagree on the other arguments', () => {
    const odd = [
      ...files('a.md'),
      {
        ...files('b.md')[0],
        key: 'b.md',
        kind: 'file' as const,
        label: 'b.md',
        args: { offset: 1, limit: 50, path: 'b.md' },
      },
    ]
    const q = compileQuestions(READ_ALL, { read: odd })
    expect(
      decodeAnswers(
        {
          ...base(q),
          target_mode__inspect__read: mode('many'),
          include__inspect__read__0: member('include'),
          include__inspect__read__1: member('include'),
        },
        q,
      ),
    ).toEqual({ ok: false, reason: 'Batch invocation candidates have incompatible arguments.' })
  })
  it('refuses a missing or invalid member answer', () => {
    const q = compileQuestions(READ_ALL, { read: files('a.md', 'b.md') })
    const r = decodeAnswers(
      {
        ...base(q),
        target_mode__inspect__read: mode('many'),
        include__inspect__read__0: member('include'),
      },
      q,
    )
    expect(r).toEqual({ ok: false, reason: 'Invalid answer for the include__inspect__read__1 head.' })
  })
  it('accepts exactly the maximum number of included members', () => {
    const keys = ['a', 'b', 'c', 'd', 'e']
    const q = compileQuestions(READ_ALL, { read: files(...keys) })
    const answers = Object.fromEntries(
      keys.map((_, i) => [`include__inspect__read__${i}`, member(i < 4 ? 'include' : 'skip')]),
    )
    const d = decisionOf(
      decodeAnswers({ ...base(q), target_mode__inspect__read: mode('many'), ...answers }, q),
    )
    expect(d.target).toEqual(['a', 'b', 'c', 'd'])
    expect(d.batch).toHaveLength(4)
  })
  it('refuses a batch whose second member has an extra argument', () => {
    const extra: Candidate = {
      key: 'b.md',
      kind: 'file',
      label: 'b.md',
      args: { offset: 1, limit: 200, path: 'b.md', more: 1 },
    }
    const q = compileQuestions(READ_ALL, { read: [...files('a.md'), extra] })
    expect(
      decodeAnswers(
        {
          ...base(q),
          target_mode__inspect__read: mode('many'),
          include__inspect__read__0: member('include'),
          include__inspect__read__1: member('include'),
        },
        q,
      ),
    ).toEqual({ ok: false, reason: 'Batch invocation candidates have incompatible arguments.' })
  })
  it('returns many-mode arguments that do not alias the compiled candidates', () => {
    const q = compileQuestions(READ_ALL, { read: files('a.md', 'b.md') })
    const d = decisionOf(
      decodeAnswers(
        {
          ...base(q),
          target_mode__inspect__read: mode('many'),
          include__inspect__read__0: member('include'),
          include__inspect__read__1: member('include'),
        },
        q,
      ),
    )
    d.args.limit = 999
    for (const call of d.batch ?? []) call.limit = 999
    expect(q.targetCandidates['INSPECT/read']?.map((candidate) => candidate.args.limit)).toEqual([200, 200])
  })
  it('takes targetConfidence from the lowest member head even when it is skipped', () => {
    const q = compileQuestions(READ_ALL, { read: files('a.md', 'b.md', 'c.md') })
    const r = decodeAnswers(
      {
        ...base(q),
        target_mode__inspect__read: mode('many'),
        include__inspect__read__0: member('include', 0.8),
        include__inspect__read__1: member('include', 0.9),
        include__inspect__read__2: member('skip', 0.55),
      },
      q,
    )
    expect(decisionOf(r)).toMatchObject({
      targetConfidence: 0.55,
      confidence: 0.55,
      operationPathConfidence: 0.9,
    })
  })
  it('honours LLM_PARAMETERS even when observed candidates exist', () => {
    const q = compileQuestions(READ_ALL, { read: files('a.md', 'b.md') })
    const r = decodeAnswers(
      {
        ...base(q),
        target_mode__inspect__read: mode('one'),
        target__inspect__read: pick(['a.md', 'b.md', 'LLM_PARAMETERS'], 'LLM_PARAMETERS', 0.9),
      },
      q,
    )
    expect(r).toMatchObject({ ok: true, decision: { bindingMode: 'llm_parameters', args: {} } })
  })
  it('refuses a target that is neither a synthetic option nor an observed candidate', () => {
    const q = compileQuestions(READ_ALL, { read: files('a.md', 'b.md') })
    const r = decodeAnswers(
      {
        ...base(q),
        target_mode__inspect__read: mode('one'),
        target__inspect__read: pick(['a.md', 'b.md', 'LLM_PARAMETERS'], 'a.md', 0.9),
      },
      { ...q, targetCandidates: {} },
    )
    expect(r).toEqual({ ok: false, reason: 'Unsupported target a.md for read.' })
  })
  it('binds a candidate named like a prototype key', () => {
    const q = compileQuestions(READ_ALL, { read: files('__proto__', 'constructor') })
    const r = decodeAnswers(
      {
        ...base(q),
        target_mode__inspect__read: mode('one'),
        target__inspect__read: pick(['__proto__', 'constructor', 'LLM_PARAMETERS'], '__proto__', 0.9),
      },
      q,
    )
    expect(decisionOf(r)).toMatchObject({ target: '__proto__', bindingMode: 'observed' })
    expect(Object.hasOwn(decisionOf(r).args, 'path')).toBe(true)
  })
  it('does not resolve a member head through the prototype chain', () => {
    const q = compileQuestions(READ_ALL, { read: files('constructor', 'b.md') })
    const r = decodeAnswers(
      {
        ...base(q),
        target_mode__inspect__read: mode('many'),
        include__inspect__read__0: member('include'),
        include__inspect__read__1: member('include'),
      },
      { ...q, memberHeads: { 'INSPECT/read': { 'b.md': 'include__inspect__read__1' } } },
    )
    expect(r).toEqual({ ok: false, reason: 'No member head is available for constructor.' })
  })
  it('returns arguments that do not alias the compiled candidates', () => {
    const q = compileQuestions(READ_ALL, { read: files('safe.py') })
    const r = decisionOf(
      decodeAnswers(
        { ...base(q), target__inspect__read: pick(['safe.py', 'LLM_PARAMETERS'], 'safe.py', 0.9) },
        q,
      ),
    )
    r.args.limit = 999
    expect(q.targetCandidates['INSPECT/read']?.[0]?.args.limit).toBe(200)
  })
})
