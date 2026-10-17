import { describe, expect, it } from 'vitest'
import {
  ACTION_PREAMBLE,
  CORE_ANSWER,
  compileQuestions,
  criteriaCharsAt,
  decisionSurface,
  estimateTokens,
  fitBudget,
  INCLUDE_INSTRUCTIONS,
  LLM_PARAMETERS_TEXT,
  META_AMBIGUITY,
  META_PROGRESS,
  PHASE_CRITERIA,
  PHASE_INSTRUCTIONS,
  pyRepr,
  TARGET_MODE_ONE,
  TARGET_PREAMBLE,
  targetModeMany,
} from '../src/compile.js'
import { resolveTool } from '../src/profile.js'
import type { Candidate, CompiledQuestions, ResolvedTool } from '../src/types.js'
import { BUILTIN_SCHEMAS } from './helpers/view.js'

const tools = (...names: string[]) =>
  names.map(
    (name) =>
      resolveTool({ name, description: name, parameters: BUILTIN_SCHEMAS[name] } as never) as ResolvedTool,
  )
const ALL = tools('ls', 'read', 'grep', 'find', 'write', 'edit', 'shell')

describe('compileQuestions', () => {
  it('compiles exactly the head set for the built-in surface with no observations', () => {
    const c = compileQuestions(ALL)
    expect(Object.keys(c.questions)).toEqual([
      'phase',
      'action__inspect',
      'target__inspect__ls',
      'action__act',
      'action__verify',
      'target__verify__ls',
      'meta_ambiguity',
      'meta_progress',
    ])
    expect(c.actionConstants).toEqual({ RESPOND: 'ANSWER' })
    expect(c.targetConstants['INSPECT/read']).toBe('LLM_PARAMETERS')
    expect(c.targetConstants['RESPOND/ANSWER']).toBe('LLM_PARAMETERS')
  })
  it('lists only phases that have actions, with the original texts', () => {
    const c = compileQuestions(tools('read'))
    expect(c.questions.phase).toEqual({
      type: 'choice',
      criteria: {
        INSPECT: PHASE_CRITERIA.INSPECT,
        VERIFY: PHASE_CRITERIA.VERIFY,
        RESPOND: PHASE_CRITERIA.RESPOND,
      },
      instructions: [PHASE_INSTRUCTIONS],
    })
    expect(Object.keys(c.questions)).toEqual(['phase', 'meta_ambiguity', 'meta_progress'])
    expect(compileQuestions([]).phaseActions).toEqual({ RESPOND: ['ANSWER'] })
  })
  it('uses the Jev criteria and the ANSWER core action in action heads', () => {
    const head = compileQuestions(ALL).questions.action__verify as {
      criteria: Record<string, string>
      instructions: string[]
    }
    expect(Object.keys(head.criteria)).toEqual(['ls', 'read', 'grep', 'find', 'shell'])
    expect(head.instructions).toEqual([ACTION_PREAMBLE.replace('{phase}', 'VERIFY')])
    expect(
      (compileQuestions(tools('ls')).questions.phase as { criteria: object }).criteria,
    ).not.toHaveProperty('ACT')
    expect(CORE_ANSWER).toMatch(/^Deliver the final answer/)
  })
  it('offers DEFAULT_ARGUMENTS with Python-style JSON only when complete', () => {
    const head = compileQuestions(ALL).questions.target__inspect__ls as { criteria: Record<string, unknown> }
    expect(head.criteria).toEqual({
      LLM_PARAMETERS: { binding: LLM_PARAMETERS_TEXT.target },
      DEFAULT_ARGUMENTS: {
        binding: "Use the tool's declared safe default arguments.",
        arguments: '{"path": "."}',
      },
    })
    const strict = resolveTool({
      name: 'ls',
      description: '',
      parameters: { ...BUILTIN_SCHEMAS.ls, required: ['limit'] },
    } as never) as ResolvedTool
    expect(compileQuestions([strict]).targetConstants['INSPECT/ls']).toBe('LLM_PARAMETERS')
  })
  it('attaches the decision surface', () => {
    expect(decisionSurface(compileQuestions(tools('ls')))).toEqual({
      phases: { INSPECT: ['ls'], VERIFY: ['ls'], RESPOND: ['ANSWER'] },
      targets: {
        'INSPECT/ls': ['LLM_PARAMETERS', 'DEFAULT_ARGUMENTS'],
        'VERIFY/ls': ['LLM_PARAMETERS', 'DEFAULT_ARGUMENTS'],
        'RESPOND/ANSWER': ['LLM_PARAMETERS'],
      },
    })
    expect((compileQuestions([]).questions.meta_progress as typeof META_PROGRESS).criteria).toHaveLength(4)
  })
})

describe('compileQuestions isolation and duplicates', () => {
  it('does not share mutable objects between compiles', () => {
    const first = compileQuestions(tools('ls'))
    ;(first.questions.meta_progress as { criteria: string[] }).criteria.length = 0
    ;(first.questions.meta_ambiguity as { instructions: string }).instructions = 'changed'
    ;(first.defaults.ls as { path: string }).path = 'changed'
    const second = compileQuestions(tools('ls'))
    expect((second.questions.meta_progress as typeof META_PROGRESS).criteria).toHaveLength(4)
    expect((second.questions.meta_ambiguity as typeof META_AMBIGUITY).instructions).toBe(
      META_AMBIGUITY.instructions,
    )
    expect(META_PROGRESS.criteria).toHaveLength(4)
    expect(second.defaults.ls).toEqual({ path: '.' })
  })
  it('lists a repeated tool once and ignores a tool named ANSWER', () => {
    const [ls, read] = tools('ls', 'read') as [ResolvedTool, ResolvedTool]
    const impostor = { ...read, name: 'ANSWER', criteria: 'impostor' }
    const c = compileQuestions([ls, ls, impostor, read])
    expect(c.phaseActions).toEqual({ INSPECT: ['ls', 'read'], VERIFY: ['ls', 'read'], RESPOND: ['ANSWER'] })
    const head = c.questions.action__verify as { criteria: Record<string, string> }
    expect(Object.keys(head.criteria)).toEqual(['ls', 'read'])
    expect(JSON.stringify(c.questions)).not.toContain('impostor')
  })
})

describe('token budget', () => {
  it('estimates ceil(utf8 bytes / 3)', () => {
    expect(estimateTokens('abc')).toBe(2)
    expect(estimateTokens('中文')).toBe(3)
  })
  const c = compileQuestions(ALL)
  const budget = { stateTokens: 24_000, requestTokens: 48_000 }
  it('fits a small state at level 0 and a long previous answer at level 3', () => {
    expect(fitBudget(c, () => ({ goal: 'x' }), budget)?.level).toBe(0)
    const state = (level: number) => ({
      previous_answer: level >= 3 ? 'p'.repeat(1000) : 'p'.repeat(100_000),
    })
    expect(fitBudget(c, state, budget)?.level).toBe(3)
  })
  it('fits a 30,000-character Chinese goal at level 7', () => {
    const goal = '中'.repeat(30_000)
    const fit = fitBudget(
      c,
      (level) => ({ goal: level >= 7 ? `${goal.slice(0, 2000)}\n…\n${goal.slice(-2000)}` : goal }),
      budget,
    )
    expect(fit?.level).toBe(7)
    expect(fit?.stateTokens).toBeLessThan(24_000)
  })
  it('returns null when nothing fits', () => {
    expect(fitBudget(c, () => ({ goal: 'x' }), { stateTokens: 10, requestTokens: 10 })).toBeNull()
  })
})

const files = (...keys: string[]): Candidate[] =>
  keys.map((key) => ({ key, kind: 'file', label: key, args: { offset: 1, limit: 200, path: key } }))
const dirs = (...keys: string[]): Candidate[] =>
  keys.map((key) => ({ key, kind: 'directory', label: key, args: { path: key } }))

describe('observed targets', () => {
  it('puts observed candidates before LLM_PARAMETERS and DEFAULT_ARGUMENTS', () => {
    const c = compileQuestions(ALL, { ls: dirs('src') })
    const criteria = (c.questions.target__inspect__ls as { criteria: Record<string, unknown> }).criteria
    expect(Object.keys(criteria)).toEqual(['src', 'LLM_PARAMETERS', 'DEFAULT_ARGUMENTS'])
    expect(criteria.src).toEqual({ directory: 'src', arguments: '{"path": "src"}' })
    expect(c.targetCandidates['INSPECT/ls']).toEqual(dirs('src'))
  })
  it('gives read a target head, a mode head and one include head per candidate in each phase', () => {
    const c = compileQuestions(ALL, { read: files('a.md', 'b.md', 'c.md') })
    for (const phase of ['inspect', 'verify']) {
      expect(c.questions[`target__${phase}__read`]).toMatchObject({
        criteria: { 'a.md': { file: 'a.md', arguments: '{"limit": 200, "offset": 1, "path": "a.md"}' } },
      })
      expect(c.questions[`target_mode__${phase}__read`]).toMatchObject({
        criteria: { one: TARGET_MODE_ONE, many: targetModeMany(4) },
      })
      expect(c.questions[`include__${phase}__read__2`]).toEqual({
        type: 'choice',
        criteria: { include: "Include offered target 'c.md'.", skip: "Skip offered target 'c.md'." },
        instructions: [INCLUDE_INSTRUCTIONS],
      })
    }
    expect(c.memberHeads['INSPECT/read']).toEqual({
      'a.md': 'include__inspect__read__0',
      'b.md': 'include__inspect__read__1',
      'c.md': 'include__inspect__read__2',
    })
    expect(c.multiTargetMax['INSPECT/read']).toBe(4)
  })
  it('adds no mode head for one candidate, for more than 20, or for a tool that reads one target', () => {
    expect(compileQuestions(ALL, { read: files('a.md') }).modeHeads).toEqual({})
    expect(
      compileQuestions(ALL, { read: files(...Array.from({ length: 21 }, (_, i) => `f${i}`)) }).modeHeads,
    ).toEqual({})
    expect(compileQuestions(ALL, { ls: dirs('a', 'b', 'c') }).modeHeads).toEqual({})
  })
  it('offers a path named like a prototype key as an ordinary option', () => {
    const c = compileQuestions(ALL, { read: files('__proto__', 'b.md') })
    const head = c.questions.target__inspect__read as { criteria: Record<string, unknown> }
    expect(Object.keys(head.criteria)).toEqual(['__proto__', 'b.md', 'LLM_PARAMETERS'])
    expect(Object.keys(c.memberHeads['INSPECT/read'] ?? {})).toEqual(['__proto__', 'b.md'])
    expect(c.targetOptions['INSPECT/read']).toEqual(['__proto__', 'b.md', 'LLM_PARAMETERS'])
  })
  it('keeps LLM_PARAMETERS on every target when nothing was observed', () => {
    const c = compileQuestions(ALL)
    for (const options of Object.values(c.targetOptions)) expect(options).toContain('LLM_PARAMETERS')
  })
  it('clips labels to 300 characters', () => {
    const c = compileQuestions(ALL, {
      read: [{ ...(files('a.md')[0] as Candidate), label: `a.md${'x'.repeat(400)}` }],
    })
    const head = c.questions.target__inspect__read as { criteria: Record<string, { file: string }> }
    expect(head.criteria['a.md']?.file.length).toBe(300)
  })
  it('clips the criteria of tools without a profile at the last shrink levels, keeping every id', () => {
    const other = {
      ...(ALL[0] as ResolvedTool),
      name: 'docs_search',
      profiled: false,
      criteria: 'd'.repeat(2000),
      phases: ['INSPECT'] as const,
      targetParam: null,
      defaults: null,
      bindingDefaults: null,
      referenceKind: null,
    }
    const full = compileQuestions([...ALL, other])
    const short = compileQuestions([...ALL, other], {}, { criteriaChars: 500 })
    expect(Object.keys(short.questions)).toEqual(Object.keys(full.questions))
    const criteria = (q: CompiledQuestions) =>
      (q.questions.action__inspect as { criteria: Record<string, string> }).criteria
    expect(criteria(short).docs_search).toHaveLength(500)
    expect(criteria(full).docs_search).toHaveLength(1500)
  })
  it('renders a target key the way Python repr does', () => {
    expect(pyRepr('a.md')).toBe("'a.md'")
    expect(pyRepr("it's.md")).toBe(`"it's.md"`)
    expect(pyRepr(`a'b"c`)).toBe(`'a\\'b"c'`)
    expect(pyRepr('tab\there')).toBe("'tab\\there'")
    expect(pyRepr('a\u0001b\nc\\d\u007f')).toBe("'a\\x01b\\nc\\\\d\\x7f'")
  })
  it('compiles the questions again for each shrink level it tries and returns those it used', () => {
    const other = {
      ...(ALL[0] as ResolvedTool),
      name: 'docs_search',
      profiled: false,
      criteria: 'd'.repeat(2000),
    }
    const at = (level: number) =>
      compileQuestions([...ALL, other], {}, { criteriaChars: criteriaCharsAt(level) })
    const tight = estimateTokens({ state: {}, questions: at(6).questions })
    const fit = fitBudget(at, () => ({}), { stateTokens: 24_000, requestTokens: tight })
    expect(fit?.level).toBe(6)
    expect(fit?.questions).toEqual(at(6).questions)
    expect(fitBudget(at(0), () => ({}), { stateTokens: 24_000, requestTokens: 48_000 })?.questions).toEqual(
      at(0).questions,
    )
  })
  it('skips reserved and repeated candidate keys and records only the offered candidates', () => {
    const [a, b] = files('a.md', 'b.md') as [Candidate, Candidate]
    const reserved = files('LLM_PARAMETERS', 'DEFAULT_ARGUMENTS')
    const c = compileQuestions(ALL, { read: [a, ...reserved, { ...a, label: 'again' }, b] })
    expect(c.targetOptions['INSPECT/read']).toEqual(['a.md', 'b.md', 'LLM_PARAMETERS'])
    const head = c.questions.target__inspect__read as { criteria: Record<string, { file?: string }> }
    expect(head.criteria['a.md']?.file).toBe('a.md')
    expect(head.criteria.LLM_PARAMETERS).toEqual({ binding: LLM_PARAMETERS_TEXT.target })
    expect(c.targetCandidates['INSPECT/read']).toEqual([a, b])
    expect(c.memberHeads['INSPECT/read']).toEqual({
      'a.md': 'include__inspect__read__0',
      'b.md': 'include__inspect__read__1',
    })
  })
  it('orders each batch as target head, mode head, include heads, with the target preamble on the mode head', () => {
    const c = compileQuestions(ALL, { read: files('a.md', 'b.md') })
    const ids = Object.keys(c.questions)
    for (const phase of ['inspect', 'verify']) {
      const at = ids.indexOf(`target__${phase}__read`)
      expect(ids.slice(at, at + 4)).toEqual([
        `target__${phase}__read`,
        `target_mode__${phase}__read`,
        `include__${phase}__read__0`,
        `include__${phase}__read__1`,
      ])
      const name = phase.toUpperCase()
      expect((c.questions[`target_mode__${phase}__read`] as { instructions: string[] }).instructions).toEqual(
        [TARGET_PREAMBLE.replace('{phase}', name).replace('{operation}', 'read')],
      )
      expect(c.modeHeads[`${name}/read`]).toBe(`target_mode__${phase}__read`)
    }
    expect(c.memberHeads['VERIFY/read']).toEqual({
      'a.md': 'include__verify__read__0',
      'b.md': 'include__verify__read__1',
    })
    expect(c.multiTargetMax['VERIFY/read']).toBe(4)
  })
  it('compiles tools named like object prototype keys like any other tool', () => {
    const [ls, read] = tools('ls', 'read') as [ResolvedTool, ResolvedTool]
    const names = ['constructor', 'toString', '__proto__']
    const renamed = names.map((name) => ({ ...ls, name, phases: ['INSPECT'] as const }))
    const plain = compileQuestions([read, ...renamed])
    const criteria = (plain.questions.action__inspect as { criteria: Record<string, string> }).criteria
    expect(Object.keys(criteria)).toEqual(['read', ...names])
    for (const name of names) {
      expect(plain.targetOptions[`INSPECT/${name}`]).toEqual(['LLM_PARAMETERS', 'DEFAULT_ARGUMENTS'])
      expect(Object.hasOwn(plain.defaults, name)).toBe(true)
      expect(plain.defaults[name]).toEqual({ path: '.' })
    }
    expect(plain.targetCandidates).toEqual({})
    expect(plain.modeHeads).toEqual({})

    const batched = names.map((name) => ({ ...read, name }))
    const observed = compileQuestions(
      batched,
      Object.fromEntries(names.map((name) => [name, files('a.md', 'b.md')])),
    )
    for (const name of names) {
      expect(observed.targetCandidates[`INSPECT/${name}`]).toEqual(files('a.md', 'b.md'))
      expect(observed.modeHeads[`VERIFY/${name}`]).toBe(`target_mode__verify__${name}`)
      expect(observed.memberHeads[`INSPECT/${name}`]).toEqual({
        'a.md': `include__inspect__${name}__0`,
        'b.md': `include__inspect__${name}__1`,
      })
    }
  })
})
