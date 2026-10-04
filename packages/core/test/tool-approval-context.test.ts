import type { ToolMeta } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { EffectRuntime } from '../src/effects/effect.js'
import {
  authorizeToolCall,
  type ToolApprovalCall,
  type ToolApprovalContext,
} from '../src/effects/tool-approval.js'
import { SeamRuntime } from '../src/effects/wrap.js'
import { sysEvent } from '../src/step/events.js'
import { presetDefaults } from '../src/step/preset.js'
import type { EventInput } from '../src/types.js'
import { fakeSeams } from './helpers/fake-seams.js'

const actor = { id: 'u', org: 'test', role: 'owner', deptPath: [], attrs: {} }
const meta: ToolMeta = {
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: false,
  isOpenWorld: false,
  replay: 'never',
  requiresApproval: 'always',
  costHint: undefined,
  deferLoading: undefined,
}
const call: ToolApprovalCall = {
  toolUseId: 'call-1',
  name: 'write',
  args: {},
  argsSeq: 1,
  definitionFingerprint: 'definition',
  policyHash: 'policy',
  executionDomain: 'workspace',
  resolvedPolicy: {
    ...meta,
    requiresApproval: 'always',
    policyVersion: '1',
    approvalScopes: ['write:test'],
  },
}

/** A non-Core runtime supplies only durable approval and execution identity ports. */
function context(overrides: Partial<ToolApprovalContext> = {}) {
  const events: EventInput[] = []
  const state = { actor, lane: 'main' }
  const event: ToolApprovalContext['event'] = (type, data, extra) => sysEvent(state, type, data, extra)
  const ctx: ToolApprovalContext = {
    sessionKey: 'other-runtime',
    lane: 'main',
    turn: 1,
    step: 1,
    actor,
    taint: false,
    fullAccess: false,
    approvalMode: 'manual',
    approvalTimeoutMs: 1000,
    profileHash: null,
    lastSeq: 1,
    hooks: { toolCall: async () => ({ allow: true }) },
    seams: new SeamRuntime(fakeSeams(), presetDefaults(), { clock: () => 1, onFailure: () => undefined }),
    effects: new EffectRuntime({ ev: event, clock: () => 1, effectId: () => 'guardian-1' }),
    sessionAllows: new Set(),
    clock: () => 1,
    requestId: () => 'ask-1',
    guardianModel: () => 'model',
    budgetCap: () => null,
    markLedgerFailed: () => undefined,
    scan: async () => [],
    event,
    commit: async (batch) => {
      events.push(...batch)
    },
    persistedApproval: async () => undefined,
    refuse: async (code, message) => ({
      content: [{ type: 'text', text: `${code}: ${message}` }],
      isError: true,
    }),
    waitingApproval: async () => undefined,
    askApproval: async () => 'allowed-once',
    ...overrides,
  }
  return { ctx, events }
}

describe('runtime-neutral tool approval', () => {
  it('commits scoped approvals and preserves pending asks for the caller parking transaction', async () => {
    const manual = context()
    expect(await authorizeToolCall(manual.ctx, call, meta, new AbortController().signal)).toEqual({
      decisionId: 'n/a',
    })
    expect(manual.events.map((event) => event.type)).toEqual(['approval/asked', 'approval/decided'])
    const pending = context({ askApproval: async () => ({ ticket: 'ticket', expiresAt: 'later' }) })
    expect(await authorizeToolCall(pending.ctx, call, meta, new AbortController().signal)).toMatchObject({
      park: { type: 'approval/asked', data: { pending: { ticket: 'ticket' } } },
    })
    expect(pending.events).toEqual([])
  })

  it('keeps authorization denial effective with full access and disabled approvals', async () => {
    const { ctx, events } = context({
      fullAccess: true,
      approvalMode: 'off',
      seams: new SeamRuntime(
        fakeSeams({
          principals: {
            authorize: async () => ({ decisionId: 'deny-1', effect: 'deny', reason: 'outside scope' }),
          },
        }),
        presetDefaults(),
        { clock: () => 1, onFailure: () => undefined },
      ),
      askApproval: async () => {
        throw new Error('denial must not ask')
      },
    })
    expect(await authorizeToolCall(ctx, call, meta, new AbortController().signal)).toMatchObject({
      result: { isError: true, content: [{ text: 'AUTHZ_DENIED: outside scope' }] },
    })
    expect(events).toEqual([])
  })

  it('refuses to invoke a guardian when its intent cannot commit', async () => {
    let guardianInvoked = false
    const { ctx } = context({
      approvalMode: 'smart',
      commit: async () => {
        throw new Error('writer failed')
      },
      seams: new SeamRuntime(
        fakeSeams({
          approval: {
            guard: async () => {
              guardianInvoked = true
              return { decision: 'allow-once', ruleVersion: 'fixture', reasons: [] }
            },
          },
        }),
        presetDefaults(),
        { clock: () => 1, onFailure: () => undefined },
      ),
    })
    await expect(authorizeToolCall(ctx, call, meta, new AbortController().signal)).rejects.toThrow(
      'writer failed',
    )
    expect(guardianInvoked).toBe(false)
  })
})
