import { describe, expect, it } from 'vitest'
import { RuntimeSchemas, RuntimeServiceCatalog, validateRuntime } from '../../src/runtime/index.js'

describe('public Runtime payloads', () => {
  it('publishes a concrete input and output schema for every Wire service method', () => {
    expect(Object.keys(RuntimeServiceCatalog)).toHaveLength(52)
    for (const contract of Object.values(RuntimeServiceCatalog)) {
      expect(contract.major).toBe(1)
      for (const method of Object.values(contract.methods)) {
        if ('local' in method && method.local) continue
        expect(Object.hasOwn(RuntimeSchemas, method.input)).toBe(true)
        expect(Object.hasOwn(RuntimeSchemas, method.output)).toBe(true)
      }
    }
  })

  it('keeps tool outputs closed and rejects binary and Local values on the Wire', () => {
    const output = { content: [{ type: 'text', text: 'result' }], structured: { nested: [null, true] } }
    expect(validateRuntime('StandardToolOutput', output).ok).toBe(true)
    for (const invalid of [
      { ...output, details: {} },
      { ...output, content: [{ type: 'image', url: 'https://example.com/image' }] },
      { ...output, structured: new Uint8Array([1, 2]) },
      { ...output, structured: { signal: new AbortController().signal } },
    ])
      expect(validateRuntime('StandardToolOutput', invalid).ok).toBe(false)
  })

  it('enforces conditional consent evidence and UInt53 references in new payloads', () => {
    const consent = {
      sessionId: 'session',
      level: 'FULL',
      sourceDigest: 'a'.repeat(64),
      profileId: 'profile',
      recordedAt: '2026-09-30T12:00:00Z',
      explicitFull: true,
      evidence: 'trusted-config',
    }
    expect(validateRuntime('TelemetryConsent', consent).ok).toBe(true)
    expect(validateRuntime('TelemetryConsent', { ...consent, explicitFull: false }).ok).toBe(false)
    expect(
      validateRuntime('ProviderResponseEvidence', { status: 200, headers: { 'request-id': 'one' } }).ok,
    ).toBe(true)
    expect(validateRuntime('ProviderResponseEvidence', { status: -0 }).ok).toBe(false)
    expect(
      validateRuntime('ProviderResponseEvidence', { status: 200, headers: { 'Bad Header': 'one' } }).ok,
    ).toBe(false)
    const headers = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`header-${index}`, 'value']))
    expect(validateRuntime('ProviderResponseEvidence', { status: 200, headers }).ok).toBe(false)
  })

  it('validates null enum members using an actual null schema', () => {
    const value = {
      toolCalls: [],
      deviations: 0,
      recentToolKeys: [],
      surfaceTailHashes: [],
      newToolResults: 0,
      lastFinishReason: null,
    }
    const schema = RuntimeSchemas.LoopQualityInput.$defs.LoopQualityInput
    expect(JSON.stringify(schema)).not.toContain('"const":null')
    expect(validateRuntime('LoopQualityInput', value).ok).toBe(true)
    expect(validateRuntime('LoopQualityInput', { ...value, lastFinishReason: 'invalid' }).ok).toBe(false)
  })

  it('accepts a complete approval title and rejects a missing title', () => {
    const request = {
      kind: 'approval',
      risk: 'destructive',
      intentDigest: 'b'.repeat(64),
      title: 'Approve execution',
      body: 'A bounded action',
      actionRef: 'action',
      inputDigest: 'a'.repeat(64),
      policyDecisionRef: 'policy',
      scope: { kind: 'runtime', installationId: 'installation', runtimeId: 'runtime' },
      allowedResponders: ['principal'],
      expiresAt: '2026-09-30T12:00:00Z',
      idempotencyKey: 'approval',
    }
    expect(validateRuntime('ApprovalRequest', request).ok).toBe(true)
    const { title: _title, ...incomplete } = request
    expect(validateRuntime('ApprovalRequest', incomplete).ok).toBe(false)
  })
})
