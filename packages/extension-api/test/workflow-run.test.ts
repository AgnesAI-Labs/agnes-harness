import { describe, expect, it } from 'vitest'
import { isWorkflowRunId, MAX_WORKFLOW_RUN_ID } from '../src/index.js'

describe('isWorkflowRunId', () => {
  it('takes a plain identifier up to the workflow tool bound', () => {
    expect(isWorkflowRunId('a1b2c3d4-0000-4000-8000-000000000001')).toBe(true)
    expect(isWorkflowRunId('x')).toBe(true)
    expect(isWorkflowRunId('r'.repeat(MAX_WORKFLOW_RUN_ID))).toBe(true)
  })

  it('refuses anything that is not text-free: empty, long, spaced, control characters, not a string', () => {
    expect(isWorkflowRunId('')).toBe(false)
    expect(isWorkflowRunId('r'.repeat(MAX_WORKFLOW_RUN_ID + 1))).toBe(false)
    for (const bad of ['two words', 'tab\there', 'line\nbreak', 'nul\u0000', ' lead'])
      expect(isWorkflowRunId(bad), JSON.stringify(bad)).toBe(false)
    for (const bad of [undefined, null, 7, {}, ['a']]) expect(isWorkflowRunId(bad)).toBe(false)
  })
})
