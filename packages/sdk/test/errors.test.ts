import { describe, expect, it } from 'vitest'
import {
  ClaimDenied,
  JsonRpcError,
  ProtocolViolation,
  RequestTimeout,
  SdkError,
  TransportClosed,
} from '../src/errors.js'

describe('SdkError family', () => {
  it('keeps raw subprocess diagnostics out of the error message', () => {
    const stderrTail = 'credential-value-for-test'
    const error = new TransportClosed({ reason: 'exit', exitCode: 3, stderrTail })
    expect(error.info.stderrTail).toBe(stderrTail)
    expect(error.message).not.toContain(stderrTail)
    expect(String(error)).not.toContain(stderrTail)
    expect(error.message).toContain('exit=3')
  })
  it('carries a closed-set kind and instanceof chain', () => {
    const e = new JsonRpcError({
      code: -32004,
      message: 'GENERATION_STALE',
      data: { code: 'GENERATION_STALE', generation: 3 },
    })
    expect(e).toBeInstanceOf(SdkError)
    expect(e).toBeInstanceOf(Error)
    expect(e.kind).toBe('json-rpc')
    expect(e.code).toBe(-32004)
    expect(e.data.generation).toBe(3)
    expect(new TransportClosed({ reason: 'exit', exitCode: 137, stderrTail: 'boom' }).kind).toBe(
      'transport-closed',
    )
    expect(new RequestTimeout('session/prompt', 30000).message).toContain('session/prompt')
    expect(new ProtocolViolation('frame too large').kind).toBe('protocol-violation')
    expect(new ProtocolViolation('legacy detail').violationKind).toBe('schema')
    expect(new ProtocolViolation('too large', 'frame-too-large')).toMatchObject({
      kind: 'protocol-violation',
      violationKind: 'frame-too-large',
      detail: 'too large',
    })
    expect(new ClaimDenied('timeout').kind).toBe('claim-denied')
  })
})
