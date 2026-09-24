import { describe, expect, it } from 'vitest'
import { readSubagentLimits } from '../src/ecosystem.js'

describe('subagent ecosystem policy', () => {
  it('maps the resolved preset spelling to tool limits', () => {
    expect(
      readSubagentLimits({
        subagent: { max_depth: 2, max_fan_out: 7, isolation: 'worktree' },
      }),
    ).toEqual({ maxDepth: 2, maxFanOut: 7, isolation: 'worktree' })
  })

  it.each([
    [{}, 'missing subagent policy'],
    [{ subagent: { max_depth: -1, max_fan_out: 1, isolation: 'shared' } }, 'max_depth'],
    [{ subagent: { max_depth: 1, max_fan_out: 1.5, isolation: 'shared' } }, 'max_fan_out'],
    [{ subagent: { max_depth: 1, max_fan_out: 2, isolation: 'remote' } }, 'isolation'],
  ])('refuses malformed policy %#', (preset, message) => {
    expect(() => readSubagentLimits(preset)).toThrow(message)
  })
})
