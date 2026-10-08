import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  AGNES_ERRORS,
  APP_SERVER_SCHEMA,
  AppServerError,
  diagnosticRecords,
  errorMessageKey,
  httpRpcError,
  normalizeRpcError,
  observeDiagnostics,
  rpcError,
  safeDiagnosticRecord,
  validateAgainst,
} from '../src/index.js'

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

it('publishes safe, stable envelopes for every transport without leaking nested causes', () => {
  const cause = {
    code: 'CONFIG_CREDENTIAL_REJECTED',
    message: 'fixture-secret',
    stack: 'private-path',
    data: { token: 'fixture-secret' },
  }
  const error = normalizeRpcError(
    rpcError('SEMANTIC_REJECTED', { reason: 'CONFIG_CREDENTIAL_REJECTED', cause }),
  )
  expect(error).toMatchObject({
    code: -32011,
    message: 'SEMANTIC_REJECTED',
    data: {
      code: 'SEMANTIC_REJECTED',
      cause: { code: 'CONFIG_CREDENTIAL_REJECTED' },
      messageKey: 'appServer.errors.credentialRejected',
      diagnosticId: expect.any(String),
    },
  })
  expect(JSON.stringify(error)).not.toContain('fixture-secret')
  expect(JSON.stringify(error)).not.toContain('private-path')
  expect(validateAgainst(AppServerError, error).ok).toBe(true)
  expect(normalizeRpcError(error)).toEqual(error)
  const denied = httpRpcError(403, 'E_ADMIN_ORIGIN')
  expect(denied).toMatchObject({ code: -32006, data: { messageKey: 'appServer.errors.forbidden' } })
  expect(normalizeRpcError(rpcError('METHOD_NOT_FOUND'))).toHaveProperty(
    'data.messageKey',
    'appServer.errors.methodNotFound',
  )
  expect(
    normalizeRpcError(rpcError('INTERNAL_ERROR', { cause: { code: 'untrusted-secret', message: 'secret' } })),
  ).not.toHaveProperty('data.cause')
  expect(normalizeRpcError(rpcError('INVALID_PARAMS', { code: 'PATTERN', path: '/serverId' }))).toMatchObject(
    { code: -32602, data: { code: 'PATTERN', messageKey: 'appServer.errors.invalidParams' } },
  )
  expect(errorMessageKey('CONFIG_CREDENTIAL_REJECTED')).toBe(error.data.messageKey)
  expect(errorMessageKey('untrusted-secret')).toBe('appServer.errors.internal')
  expect(APP_SERVER_SCHEMA['x-version']).toBe(1)
  const row = diagnosticRecords().find((row) => row.diagnosticId === error.data.diagnosticId)
  expect(row).toMatchObject({
    diagnosticId: error.data.diagnosticId,
    code: error.code,
    cause: 'CONFIG_CREDENTIAL_REJECTED',
  })
  expect(JSON.stringify(row)).not.toContain('fixture-secret')
  const unknown = normalizeRpcError({ code: -32999, message: 'private error', data: { code: 'private-key' } })
  expect(
    safeDiagnosticRecord(diagnosticRecords().find((row) => row.diagnosticId === unknown.data.diagnosticId)),
  ).toMatchObject({ code: -32999, name: 'INTERNAL_ERROR' })
  let refuse = false
  const stop = observeDiagnostics(() => {
    if (refuse) throw new Error('synthetic sink unavailable')
  })
  refuse = true
  try {
    expect(normalizeRpcError(rpcError('INTERNAL_ERROR')).data).toHaveProperty('diagnosticUnavailable', true)
  } finally {
    stop()
  }
})

it('exports independently resolvable JSON Schema for every method and the error envelope', () => {
  const require = createRequire(import.meta.url)
  const Ajv = require('ajv/dist/2020.js')
  const ajv = new Ajv({ strict: false, validateFormats: false })
  ajv.addSchema(APP_SERVER_SCHEMA)
  const id = APP_SERVER_SCHEMA.$id as string
  const catalog = APP_SERVER_SCHEMA['x-methods'] as Record<
    string,
    { params: { $ref: string }; result?: { $ref: string } }
  >
  for (const spec of Object.values(catalog)) {
    expect(ajv.getSchema(id + spec.params.$ref)).toBeTypeOf('function')
    if (spec.result) expect(ajv.getSchema(id + spec.result.$ref)).toBeTypeOf('function')
  }
  const check = ajv.getSchema(id + '#/$defs/AppServerError')
  expect(check(normalizeRpcError(rpcError('AUTH_INVALID')))).toBe(true)
  expect(
    check({
      code: -32007,
      message: 'AUTH_INVALID',
      data: { code: 'AUTH_INVALID', messageKey: 'unsafe.secret', diagnosticId: 'missing' },
    }),
  ).toBe(false)
})
