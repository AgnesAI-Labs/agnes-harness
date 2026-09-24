import { describe, expect, it } from 'vitest'
import { checkSkillRoots, loadSkillRoots, parseSkillRootsJson } from '../src/index.js'

describe('skill-roots', () => {
  it('loads five immutable roots in stable precedence order', () => {
    const roots = loadSkillRoots()
    expect(roots.map((root) => root.root)).toEqual([
      '~/.agh/skills',
      '<workspace>/.agh/skills',
      '~/.agents/skills',
      '~/.claude/skills',
      '~/.codex/skills',
    ])
    expect(roots.every((root) => root.layout === 'dir/SKILL.md')).toBe(true)
    expect(Object.isFrozen(roots)).toBe(true)
    expect(roots.every(Object.isFrozen)).toBe(true)
  })

  it('rejects malformed JSON without throwing', () => {
    const result = parseSkillRootsJson('{broken')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problems[0]).toMatch(/^invalid JSON:/)
  })

  it('rejects a duplicate root and all closed-vocabulary or unknown-key violations', () => {
    const result = checkSkillRoots([
      { root: 'a', host: 'unknown', layout: 'dir/SKILL.md', extra: true },
      { root: 'a', host: 'agnes', layout: 'flat', trust: 'remote' },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.problems).toEqual([
        '[0]: unknown key extra',
        '[0].host: unknown host unknown',
        '[1].root: duplicate a',
        '[1].layout: must be dir/SKILL.md',
        '[1].trust: unknown trust remote',
      ])
  })

  it('accepts the checked-in fact table', () => {
    expect(checkSkillRoots(loadSkillRoots()).ok).toBe(true)
  })
})
