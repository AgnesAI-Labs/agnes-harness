import { describe, expect, it } from 'vitest'
import { NODE_MEMORY_FLAGS, withNodeMemoryFlags } from '../runtime/node-flags.mjs'

describe('withNodeMemoryFlags', () => {
  it('starts every AGH Node process with a 2 MB young-generation semi-space', () => {
    expect(NODE_MEMORY_FLAGS).toEqual(['--max-semi-space-size=2'])
    expect(withNodeMemoryFlags()).toEqual(['--max-semi-space-size=2'])
  })

  it('puts the flags ahead of the execArgv it keeps', () => {
    expect(withNodeMemoryFlags(['--import', 'tsx'])).toEqual(['--max-semi-space-size=2', '--import', 'tsx'])
  })

  it.each([
    [['--max-semi-space-size=2']],
    [['--max-semi-space-size=8', '--import', 'tsx']],
    [['--max_semi_space_size=8']],
    [['--max-semi-space-size', '8']],
  ])('adds no second semi-space flag to %j', (execArgv) => {
    expect(withNodeMemoryFlags(execArgv)).toEqual(execArgv)
  })
})
