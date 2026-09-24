import { describe, expect, it } from 'vitest'
import { AGNES_ERRORS, rpcError } from '../src/index.js'

describe('errors', () => {
  it('maps the twelve _agnes codes', () => {
    expect(AGNES_ERRORS).toEqual({
      OVERLOADED: -32001,
      SESSION_BUSY: -32002,
      SESSION_NOT_FOUND: -32003,
      GENERATION_STALE: -32004,
      CURSOR_OUT_OF_RANGE: -32005,
      CAPABILITY_DENIED: -32006,
      AUTH_INVALID: -32007,
      PRESET_SWITCH_REJECTED: -32008,
      APPROVAL_REJECTED: -32009,
      CLAIM_DENIED: -32010,
      SEMANTIC_REJECTED: -32011,
      REQUEST_TIMEOUT: -32012,
      OUTCOME_UNKNOWN: -32013,
    })
  })
  it('builds a JSON-RPC error object with data.code', () => {
    expect(rpcError('GENERATION_STALE', { generation: 4 })).toEqual({
      code: -32004,
      message: 'GENERATION_STALE',
      data: { code: 'GENERATION_STALE', generation: 4 },
    })
    expect(rpcError('INVALID_PARAMS', { code: 'UNKNOWN_KEY', key: 'seams' })).toEqual({
      code: -32602,
      message: 'INVALID_PARAMS',
      data: { code: 'UNKNOWN_KEY', key: 'seams' },
    })
  })
})
