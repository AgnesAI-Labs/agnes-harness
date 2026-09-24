import { describe, expect, it } from 'vitest'
import { HOOK_EVENTS } from '../src/index.js'

describe('hook event vocabulary', () => {
  it('exposes all seventeen events in the specified order and prevents mutation', () => {
    expect([...HOOK_EVENTS]).toEqual([
      'session_start',
      'resources_discover',
      'before_step',
      'context',
      'before_request',
      'before_provider_headers',
      'request_error',
      'tool_call',
      'tool_result',
      'turn_stopping',
      'approval_request',
      'before_compact',
      'compact',
      'subagent_start',
      'subagent_end',
      'format_deviation',
      'shutdown',
    ])
    expect(Object.isFrozen(HOOK_EVENTS)).toBe(true)
    expect(() => Reflect.set(HOOK_EVENTS, 0, 'forged')).not.toThrow()
    expect(Reflect.set(HOOK_EVENTS, 0, 'forged')).toBe(false)
    expect(HOOK_EVENTS[0]).toBe('session_start')
  })
})
