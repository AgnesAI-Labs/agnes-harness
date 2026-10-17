import { describe, expect, it } from 'vitest'
import {
  ACTION_PREAMBLE,
  CORE_ANSWER,
  compileQuestions,
  decisionSurface,
  estimateTokens,
  fitBudget,
  LLM_PARAMETERS_TEXT,
  META_AMBIGUITY,
  META_PROGRESS,
  PHASE_CRITERIA,
  PHASE_INSTRUCTIONS,
} from '../src/compile.js'
import { resolveTool } from '../src/profile.js'
import type { ResolvedTool } from '../src/types.js'
import { BUILTIN_SCHEMAS } from './helpers/view.js'

const tools = (...names: string[]) =>
  names.map(
    (name) =>
      resolveTool({ name, description: name, parameters: BUILTIN_SCHEMAS[name] } as never) as ResolvedTool,
  )
const ALL = tools('ls', 'read', 'grep', 'find', 'write', 'edit', 'shell')

describe('compileQuestions', () => {
  it('compiles exactly the stage-one head set for the built-in surface', () => {
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
