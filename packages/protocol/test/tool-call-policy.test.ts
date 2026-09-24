import { describe, expect, it } from 'vitest'
import { validateEvent, validateHook, validateToolDef } from '../src/index.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const legacyPolicy = {
  isReadOnly: true,
  isDestructive: false,
  replay: 'safe',
  requiresApproval: 'never',
  approvalScopes: [] as string[],
  policyVersion: 'v1',
}
const policy = { ...legacyPolicy, isConcurrencySafe: true, isOpenWorld: false }
const fingerprint = 'a'.repeat(64)
const policyHash = 'b'.repeat(64)
const policyEnvelope = {
  resolvedPolicy: policy,
  executionDomain: 'workspace',
  definitionFingerprint: fingerprint,
  policyHash,
}

function event(type: 'tool/call' | 'op.state', data: unknown): Record<string, unknown> {
  return {
    seq: 1,
    ts: '2026-09-16T00:00:00Z',
    id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
    type,
    data,
    actor,
    origin: 'system',
    trust: 'trusted',
  }
}

const legacyToolCall = { toolUseId: 't1', name: 'read_file', args: {}, ordinal: 0 }
const fullToolCall = {
  ...legacyToolCall,
  depth: 1,
  parentEffectId: 'parent-effect',
  resolvedPolicy: policy,
  executionDomain: 'workspace',
  definitionFingerprint: fingerprint,
  policyHash,
}
const legacyToolCallState = {
  ordinal: 0,
  toolUseId: 't1',
  name: 'read_file',
  argsSeq: 1,
  status: 'planned',
  replay: 'safe',
}
const fullToolCallState = {
  ...legacyToolCallState,
  status: 'dispatched',
  effectId: 'effect-1',
  depth: 1,
  parentEffectId: 'parent-effect',
  resolvedPolicy: policy,
  executionDomain: 'host-computer-use',
  definitionFingerprint: fingerprint,
  policyHash,
  dispatchAttempt: 1,
  dispatchPhase: 'may_have_sent',
}

function opState(call: Record<string, unknown>): Record<string, unknown> {
  return {
    meta: {
      turn: 1,
      lane: 'main',
      acceptedAt: '2026-09-16T00:00:00Z',
      triggerSeq: 1,
      presetName: 'default',
      profileHash: null,
      depthLimit: 3,
    },
    control: { status: 'running' },
    step: 1,
    latestAssistantSeq: null,
    taint: false,
    phase: { kind: 'tools', batch: { assistantSeq: 1, calls: [call] } },
  }
}

const meta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe',
  costHint: null,
  deferLoading: false,
  requiresApproval: 'never',
}
const legacyHookPayload = {
  toolUseId: 't1',
  name: 'read_file',
  args: {},
  meta,
  actor,
  taint: false,
}

describe('resolved tool-call policy protocol', () => {
  it('keeps legacy ledger rows and hook payloads readable while accepting the full persisted contract', () => {
    expect(validateEvent(event('tool/call', legacyToolCall)).ok).toBe(true)
    expect(
      validateEvent(
        event('tool/call', {
          ...fullToolCall,
          resolvedPolicy: legacyPolicy,
        }),
      ).ok,
    ).toBe(true)
    expect(validateEvent(event('tool/call', fullToolCall)).ok).toBe(true)
    expect(validateEvent(event('op.state', opState(legacyToolCallState))).ok).toBe(true)
    expect(validateEvent(event('op.state', opState(fullToolCallState))).ok).toBe(true)
    expect(validateHook('tool_call', 'payload', legacyHookPayload).ok).toBe(true)
    expect(
      validateHook('tool_call', 'payload', {
        ...legacyHookPayload,
        resolvedPolicy: policy,
        executionDomain: 'host-computer-use',
        definitionFingerprint: fingerprint,
        policyHash,
      }).ok,
    ).toBe(true)
  })

  it('rejects every partial persisted-policy envelope while keeping all-absent legacy records valid', () => {
    const envelopeKeys = ['resolvedPolicy', 'executionDomain', 'definitionFingerprint', 'policyHash'] as const
    for (const omitted of envelopeKeys) {
      const call = { ...fullToolCall }
      delete call[omitted]
      expect(validateEvent(event('tool/call', call)).ok, `tool/call missing ${omitted}`).toBe(false)

      const state = { ...fullToolCallState }
      delete state[omitted]
      expect(validateEvent(event('op.state', opState(state))).ok, `ToolCallState missing ${omitted}`).toBe(
        false,
      )

      const hook = {
        ...legacyHookPayload,
        resolvedPolicy: policy,
        executionDomain: 'host-computer-use',
        definitionFingerprint: fingerprint,
        policyHash,
      }
      delete hook[omitted]
      expect(validateHook('tool_call', 'payload', hook).ok, `hook payload missing ${omitted}`).toBe(false)
    }
  })

  it('rejects incomplete, unbounded and self-attesting policies', () => {
    const { policyVersion: _policyVersion, ...incomplete } = policy
    expect(validateEvent(event('tool/call', { ...fullToolCall, resolvedPolicy: incomplete })).ok).toBe(false)
    expect(
      validateEvent(
        event('tool/call', {
          ...fullToolCall,
          resolvedPolicy: { ...policy, approvalScopes: Array.from({ length: 17 }, (_, i) => `scope.${i}`) },
        }),
      ).ok,
    ).toBe(false)
    expect(
      validateEvent(
        event('tool/call', {
          ...fullToolCall,
          resolvedPolicy: { ...policy, approvalScopes: ['screen.front', 'screen.front'] },
        }),
      ).ok,
    ).toBe(false)
    // Legacy static ToolMeta allowed this contradictory pair. Protocol keeps it readable; the
    // Extension API's dynamic classifier validator is the boundary that rejects new classifiers
    // returning it.
    expect(
      validateEvent(
        event('tool/call', {
          ...fullToolCall,
          resolvedPolicy: { ...policy, isDestructive: true, policyVersion: 'static-v1' },
        }),
      ).ok,
    ).toBe(true)
    expect(
      validateHook('tool_call', 'payload', {
        ...legacyHookPayload,
        resolvedPolicy: { ...policy, executionDomain: 'host-computer-use' },
      }).ok,
    ).toBe(false)
    for (const key of ['isConcurrencySafe', 'isOpenWorld'] as const)
      expect(
        validateEvent(
          event('tool/call', {
            ...fullToolCall,
            resolvedPolicy: { ...policy, [key]: 'yes' },
          }),
        ).ok,
        `${key} must be boolean when present`,
      ).toBe(false)
  })

  it('rejects invented domains, malformed fingerprints and non-contract dispatch phases', () => {
    expect(
      validateEvent(event('tool/call', { ...fullToolCall, executionDomain: 'ordinary-sandbox' })).ok,
    ).toBe(false)
    expect(validateEvent(event('tool/call', { ...fullToolCall, definitionFingerprint: 'short' })).ok).toBe(
      false,
    )
    expect(validateEvent(event('tool/call', { ...fullToolCall, policyHash: 'short' })).ok).toBe(false)
    expect(
      validateEvent(event('op.state', opState({ ...fullToolCallState, dispatchPhase: 'dispatched' }))).ok,
    ).toBe(false)
  })

  it('accepts every durable dispatch state and the legacy effect_pending shape', () => {
    const states = [
      legacyToolCallState,
      { ...legacyToolCallState, status: 'awaiting_approval' },
      { ...legacyToolCallState, ...policyEnvelope, status: 'approved' },
      {
        ...legacyToolCallState,
        ...policyEnvelope,
        status: 'dispatch_pending',
        effectId: 'effect-1',
        dispatchAttempt: 1,
      },
      {
        ...legacyToolCallState,
        ...policyEnvelope,
        executionDomain: 'host-computer-use',
        status: 'dispatch_pending',
        effectId: 'effect-1',
        dispatchAttempt: 2,
        dispatchPhase: 'not_sent',
      },
      { ...legacyToolCallState, status: 'effect_pending', effectId: 'effect-1' },
      {
        ...legacyToolCallState,
        ...policyEnvelope,
        status: 'dispatched',
        effectId: 'effect-1',
        dispatchAttempt: 1,
        dispatchPhase: 'may_have_sent',
      },
      {
        ...legacyToolCallState,
        ...policyEnvelope,
        status: 'responded',
        effectId: 'effect-1',
        dispatchAttempt: 1,
        dispatchPhase: 'responded',
      },
      { ...legacyToolCallState, status: 'completed' },
      { ...legacyToolCallState, status: 'completed', effectId: 'effect-1' },
      { ...legacyToolCallState, ...policyEnvelope, status: 'completed', effectId: 'effect-1' },
      {
        ...legacyToolCallState,
        ...policyEnvelope,
        status: 'completed',
        effectId: 'effect-1',
        dispatchAttempt: 2,
        dispatchPhase: 'responded',
      },
    ]
    for (const state of states) {
      expect(validateEvent(event('op.state', opState(state))).ok, JSON.stringify(state)).toBe(true)
    }
  })

  it('rejects impossible status, effect, dispatch-attempt and phase combinations', () => {
    const invalidStates = [
      { ...legacyToolCallState, effectId: 'effect-1' },
      { ...legacyToolCallState, dispatchAttempt: 1 },
      { ...legacyToolCallState, dispatchPhase: 'not_sent' },
      { ...legacyToolCallState, status: 'awaiting_approval', effectId: 'effect-1' },
      { ...legacyToolCallState, status: 'approved', dispatchAttempt: 1 },
      { ...legacyToolCallState, status: 'approved' },
      { ...legacyToolCallState, status: 'dispatch_pending', dispatchAttempt: 1 },
      { ...legacyToolCallState, status: 'dispatch_pending', effectId: 'effect-1' },
      {
        ...legacyToolCallState,
        ...policyEnvelope,
        status: 'dispatch_pending',
        effectId: 'effect-1',
        dispatchAttempt: 1,
        dispatchPhase: 'may_have_sent',
      },
      {
        ...legacyToolCallState,
        ...policyEnvelope,
        status: 'dispatch_pending',
        effectId: 'effect-1',
        dispatchAttempt: 2,
        dispatchPhase: 'not_sent',
      },
      { ...legacyToolCallState, status: 'effect_pending' },
      {
        ...legacyToolCallState,
        status: 'effect_pending',
        effectId: 'effect-1',
        dispatchAttempt: 1,
      },
      {
        ...legacyToolCallState,
        status: 'effect_pending',
        effectId: 'effect-1',
        dispatchPhase: 'may_have_sent',
      },
      {
        ...legacyToolCallState,
        status: 'effect_pending',
        effectId: 'effect-1',
        dispatchAttempt: 1,
        dispatchPhase: 'responded',
      },
      { ...legacyToolCallState, status: 'completed', dispatchPhase: 'responded' },
      {
        ...legacyToolCallState,
        status: 'completed',
        effectId: 'effect-1',
        dispatchPhase: 'may_have_sent',
      },
      {
        ...legacyToolCallState,
        status: 'dispatched',
        effectId: 'effect-1',
        dispatchAttempt: 1,
        dispatchPhase: 'not_sent',
      },
      {
        ...legacyToolCallState,
        status: 'responded',
        effectId: 'effect-1',
        dispatchAttempt: 1,
        dispatchPhase: 'may_have_sent',
      },
      {
        ...legacyToolCallState,
        status: 'completed',
        dispatchAttempt: 1,
        dispatchPhase: 'responded',
      },
      {
        ...legacyToolCallState,
        status: 'completed',
        effectId: 'effect-1',
        dispatchAttempt: 1,
        dispatchPhase: 'responded',
      },
      {
        ...legacyToolCallState,
        status: 'completed',
        effectId: 'effect-1',
        dispatchAttempt: 1,
      },
      {
        ...legacyToolCallState,
        status: 'completed',
        effectId: 'effect-1',
        dispatchAttempt: 0,
        dispatchPhase: 'not_sent',
      },
      {
        ...legacyToolCallState,
        status: 'completed',
        effectId: 'effect-1',
        dispatchAttempt: 3,
        dispatchPhase: 'responded',
      },
    ]
    for (const state of invalidStates) {
      expect(validateEvent(event('op.state', opState(state))).ok, JSON.stringify(state)).toBe(false)
    }
  })

  it('does not let an author-written ToolDef carry execution-domain attestation', () => {
    const definition = {
      name: 'read_file',
      description: 'read',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      meta,
      executionDomain: 'host-computer-use',
    }
    const result = validateToolDef(definition)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toMatchObject({ code: 'UNKNOWN_KEY', key: 'executionDomain' })
  })
})
