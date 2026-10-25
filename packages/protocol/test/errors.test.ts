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
  publicErrorHelp,
  publicRejectionRpc,
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
  const refusal = publicRejectionRpc({ code: 'CONFIG_CHAT_MODEL_REQUIRED' })
  if (!refusal) throw new Error('missing public rejection')
  const generation = normalizeRpcError(refusal)
  expect(publicErrorHelp(generation, 'zh-CN')).toMatchObject({
    reason: '图片或视频生成模型不能用于对话。',
    action: '请在模型设置中选择支持对话的模型。',
  })
  expect(publicErrorHelp(generation, 'en')?.reason).toContain('cannot be used for chat')
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
  expect(httpRpcError(409, 'E_PRESET_UNRESOLVED').data.messageKey).toBe('appServer.errors.unavailable')
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

it('keeps unknown rejections generic and ignores forged public copy and unsafe reason identifiers', () => {
  for (const code of ['UNKNOWN_DENIED', 'UNKNOWN_AUTH', 'PRIVATE_TIMEOUT', 'constructor', '__proto__']) {
    expect(
      publicRejectionRpc({
        code,
        message: 'private',
        detail: { reason: 'permission-axis' },
        data: { code: 'SEMANTIC_REJECTED', reason: 'APPROVAL_REJECTED' },
      }),
    ).toBeUndefined()
    expect(
      publicErrorHelp({ data: { code, publicReason: 'private', userAction: 'private' } }),
    ).toBeUndefined()
    expect(
      publicErrorHelp({ data: { code, reason: 'APPROVAL_REJECTED', cause: { code: 'E_BUDGET' } } }),
    ).toBeUndefined()
    expect(errorMessageKey(code)).toBe('appServer.errors.internal')
  }
  const error = normalizeRpcError(
    rpcError('PRESET_SWITCH_REJECTED', {
      code: 'E_PRESET_UNSUPPORTED',
      reason: 'private reason',
      publicReason: 'private',
      userAction: 'private',
    }),
  )
  expect(error.data.publicReason).toBe('The preset or permission selection was refused.')
  expect(error.data.userAction).toBe('Choose a supported preset and a compatible permission level.')
  expect(normalizeRpcError(error)).toEqual(error)
})

it('keeps accessor-backed codes closed when their values change during classification', () => {
  let causeReads = 0
  const cause = {
    get code() {
      return causeReads++ === 0 ? 'E_BUDGET' : 'private-code'
    },
  }
  const envelope = normalizeRpcError(rpcError('SEMANTIC_REJECTED', { cause }))
  expect(envelope.data.cause).toEqual({ code: 'E_BUDGET' })
  expect(JSON.stringify(envelope)).not.toContain('private')
  let domainReads = 0
  const domain = {
    get code() {
      return domainReads++ === 0 ? 'E_BUDGET' : 'private-code'
    },
  }
  expect(publicErrorHelp(domain)).toMatchObject({
    code: 'E_BUDGET',
    reason: 'The operation was refused by the budget limit.',
  })
})

it('describes an unknown model as a catalogue miss, not a preset or permission refusal', () => {
  const error = normalizeRpcError(rpcError('PRESET_SWITCH_REJECTED', { code: 'E_MODEL_UNKNOWN' }))
  expect(error.data.publicReason).toBe(
    'The requested model or route is not in the configured model catalogue.',
  )
  expect(error.data.userAction).toContain('agh doctor provider')
  expect(publicErrorHelp(error, 'zh-CN')).toMatchObject({
    reason: '所请求的模型或路由不在已配置的模型目录中。',
    action: expect.stringContaining('agh doctor provider'),
  })
  expect(JSON.stringify(error)).not.toContain('preset')
})

it.each(['E_PRESET_UNSUPPORTED', 'E_PACKAGE_INTEGRITY', 'E_RELATION', 'E_HOME_INVALID'])(
  'preserves actionable clean-home guidance for %s across serialization',
  (code) => {
    const failure = publicRejectionRpc({
      code,
      reason: 'private implementation log',
      detail: { reason: 'clean-home-required' },
    })
    expect(failure).toBeDefined()
    const serialized = JSON.parse(JSON.stringify(failure))
    expect(publicErrorHelp(serialized)?.action).toContain('new, empty private AGH_HOME')
    expect(publicErrorHelp(serialized, 'zh-CN')?.action).toContain('新的空私有 AGH_HOME')
    expect(JSON.stringify(serialized)).not.toContain('private implementation log')
  },
)
