import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Auth } from '../gen/ts/agnes-v1.js'
import {
  BRIDGE_ERRORS,
  validateAgainst,
  validateApprovalAction,
  validateBridgeFrame,
  validateChannelCapabilities,
  validateCredential,
  validateDecision,
} from '../src/index.js'

describe('Task21 public contracts and existing consumer', () => {
  it('requires a real approval correlation identifier and accepts both forms together', () => {
    const action = { verdict: 'allowed-once', approverCredential: { kind: 'local' } }
    expect(validateApprovalAction(action).ok).toBe(false)
    expect(validateApprovalAction({ ...action, ticket: 'fixture' }).ok).toBe(true)
    expect(validateApprovalAction({ ...action, requestSeq: 1 }).ok).toBe(true)
    expect(validateApprovalAction({ ...action, ticket: 'fixture', requestSeq: 1 }).ok).toBe(true)
    expect(validateApprovalAction({ ...action, requestSeq: 0 }).ok).toBe(false)
  })
  it('rejects SQL and empty named-region lists through Decision itself', () => {
    for (const rowFilter of ['select * from table', 'named_regions[]', 'named_regions[a,,b]']) {
      expect(
        validateDecision({ decisionId: 'fixture', effect: 'allow', reason: 'fixture', rowFilter }).ok,
      ).toBe(false)
    }
  })
  it('does not supply policy decisions or capability defaults during validation', () => {
    const decision = Object.freeze({ decisionId: 'fixture', effect: 'deny', reason: 'fixture' })
    const result = validateDecision(decision)
    expect(result).toEqual({ ok: true, value: decision })
    if (result.ok) expect(result.value).toBe(decision)
    expect(decision).not.toHaveProperty('rowFilter')
    const capabilities = Object.freeze({ edit: false, card: false, thread: false, attachment: false })
    expect(validateChannelCapabilities(capabilities)).toEqual({ ok: true, value: capabilities })
    expect(capabilities).not.toHaveProperty('voice')
    expect(validateChannelCapabilities({}).ok).toBe(false)
  })
  it('rejects forged source-auth signatures without authenticating or resolving secrets', () => {
    const credential = { kind: 'source-auth', timestamp: 0, signature: 'invalid', nonce: '0'.repeat(32) }
    expect(validateCredential(credential).ok).toBe(false)
    expect(validateAgainst(Auth, credential).ok).toBe(false)
  })
  it('checks tools.invoke names and args through the actual BridgeFrame validator', () => {
    const frame = { jsonrpc: '2.0', id: 1, method: 'bridge.tools.invoke' }
    expect(validateBridgeFrame({ ...frame, params: { name: 'read_file', args: {} } }).ok).toBe(true)
    expect(validateBridgeFrame({ ...frame, params: { name: 'not valid', args: {} } }).ok).toBe(false)
    expect(validateBridgeFrame({ ...frame, params: { name: 'read_file' } }).ok).toBe(false)
    expect(validateBridgeFrame({ ...frame, params: { name: 'read_file', args: () => 1 } }).ok).toBe(false)
    expect(validateBridgeFrame({ ...frame, method: 'bridge.unknown', params: {} }).ok).toBe(false)
  })
  it('accepts internal failures separately from governed refusals without opening the error domain', () => {
    for (const id of [7, 'cell-1', null]) {
      expect(
        validateBridgeFrame({ jsonrpc: '2.0', id, error: { code: -32603, message: 'internal bridge error' } })
          .ok,
      ).toBe(true)
    }
    const error = { code: -32603, message: 'internal bridge error' }
    expect(validateBridgeFrame({ jsonrpc: '2.0', id: 7, error, result: null }).ok).toBe(false)
    expect(validateBridgeFrame({ jsonrpc: '2.0', id: 7, error: { ...error, code: -32604 } }).ok).toBe(false)
    expect(validateBridgeFrame({ jsonrpc: '2.0', id: 7, error: { ...error, code: 1006 } }).ok).toBe(false)
  })
  it('pins all eight bridge method names and schema-owned errors; byte cap remains transport work', () => {
    const doc = JSON.parse(readFileSync(new URL('../schema/bridge.json', import.meta.url), 'utf8'))
    expect(doc.$defs.BridgeMethod.enum).toEqual([
      'bridge.tools.invoke',
      'bridge.subagent.spawn',
      'bridge.subagent.fork',
      'bridge.subagent.collect',
      'bridge.artifacts.put',
      'bridge.artifacts.get',
      'bridge.plan.set',
      'bridge.log',
    ])
    expect(BRIDGE_ERRORS).toEqual(doc['x-agnes-bridge-errors'])
    expect(Object.keys(BRIDGE_ERRORS)).toEqual(['1001', '1002', '1003', '1004', '1005'])
    expect(Object.isFrozen(BRIDGE_ERRORS)).toBe(true)
    expect(doc['x-agnes-max-bytes']).toBe(1048576)
  })
  it('keeps secret and untrusted origin annotations at their shared source', () => {
    const defs = JSON.parse(readFileSync(new URL('../schema/channel.json', import.meta.url), 'utf8')).$defs
    for (const name of [
      'Credential',
      'Auth',
      'LocalCredential',
      'JwtCredential',
      'SourceAuthCredential',
      'PortalIdentityCredential',
      'SurfaceAuthCredential',
      'ChannelCredential',
    ])
      expect(defs[name]['x-secret']).toBe(true)
    expect(defs.ChannelCredential.properties.raw['x-trust']).toBe('untrusted')
    expect(defs.DirectoryEntry.properties.attrs['x-trust']).toBe('untrusted')
  })
  it('requires both a signed source and a signed subject for surface authentication', () => {
    const source = {
      kind: 'source-auth',
      timestamp: 1,
      signature: `v0=${'0'.repeat(64)}`,
      nonce: '0'.repeat(32),
    }
    expect(
      validateAgainst(Auth, {
        kind: 'surface',
        sourceId: 'reports',
        source,
        subject: { kind: 'portal-identity', token: 'subject-token' },
      }).ok,
    ).toBe(true)
    for (const invalid of [
      { kind: 'surface', sourceId: 'reports', subject: { kind: 'portal-identity', token: 'x' } },
      { kind: 'surface', sourceId: 'reports', source },
      { kind: 'surface', sourceId: '../reports', source, subject: { kind: 'jwt', token: 'x' } },
      { kind: 'surface', sourceId: 'reports', source, subject: { kind: 'local' } },
    ])
      expect(validateAgainst(Auth, invalid).ok).toBe(false)
  })
})
