// Which worker turn failures are passing: AGH's model error codes, a 5xx, and a gateway's model budget, which the executor
// waits out with backoff; anything else fails the ticket.
import { describe, expect, it } from 'vitest'
import { transient, turnError } from '../../src/runtime/assignment.js'

describe('transient', () => {
  it.each([
    [{ code: 'RATE_LIMIT', message: 'provider busy' }, true],
    [{ code: 'TIMEOUT', message: 'no first token' }, true],
    [{ code: 'TRANSPORT', message: 'stream closed' }, true],
    [
      {
        code: 'FORMAT',
        message: '{"error":{"type":"budget_exceeded","message":"Budget has been exceeded!"}}',
      },
      true,
    ],
    [{ code: 'TRANSPORT', message: 'upstream answered 502' }, true],
    [{ code: 'AUTH', message: 'upstream answered 500' }, false],
    [{ code: 'QUOTA', message: 'insufficient quota' }, false],
    [
      {
        code: 'BUDGET_EXCEEDED',
        message: 'Session context budget (1000 tokens) cannot fit fixed instructions',
      },
      false,
    ],
    [{ code: 'TOOL_ARGS_INVALID', message: 'bad schema' }, false],
  ])('%o is passing: %s', (error, passing) => {
    expect(transient(turnError(error))).toBe(passing)
  })

  it('keeps reading HTTP statuses and network failures', () => {
    expect(transient(Object.assign(new Error('x'), { status: 503 }))).toBe(true)
    expect(transient(Object.assign(new Error('x'), { status: 400 }))).toBe(false)
    expect(transient(new Error('read ECONNRESET'))).toBe(true)
  })
})
