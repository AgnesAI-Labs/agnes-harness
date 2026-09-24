import { describe, expect, it } from 'vitest'
import { isWorkerGeneration, workerGeneration } from '../src/worker-generation.js'

describe('WorkerGeneration', () => {
  it('accepts only positive safe integers', () => {
    expect(isWorkerGeneration(1)).toBe(true)
    expect(isWorkerGeneration(Number.MAX_SAFE_INTEGER)).toBe(true)
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, '1', null]) {
      expect(isWorkerGeneration(value)).toBe(false)
      expect(() => workerGeneration(value)).toThrow('positive safe integer')
    }
  })
})
