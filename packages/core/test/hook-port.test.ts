import type { HookContext, HookHandler } from '@agnes/extension-api'
import { unavailableProjections } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { platformFacts } from '../src/effects/platform-facts.js'
import { HOOK_UNHANDLED, HookEngine } from '../src/hooks/engine.js'
import { type SessionHookInputs, SessionHookPort } from '../src/hooks/port.js'
import { deriveRequest } from '../src/request/derive.js'
import { createEnvelopeCache } from '../src/request/envelope-cache.js'
import { isLedgerRequest } from '../src/request/mint.js'
import { fakeSeams } from './helpers/fake-seams.js'

const platform = platformFacts(fakeSeams().platform)
const meta = { source: 'agnes/test', trust: 'trusted' as const }
const ctx = (): HookContext => ({
  session: { key: 's', lane: 'main', workspaceRoot: '/workspace' },
  projections: unavailableProjections,
  replayed: false,
  signal: new AbortController().signal,
  lease: { expiresAt: '2099-01-01T00:00:00Z', scope: {}, budget: { remaining: 10 } },
  log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  platform,
})
const setup = (overrides: Partial<SessionHookInputs> = {}) => {
  const engine = new HookEngine({ diag: () => undefined, onFailure: () => undefined, platform })
  const overflow: unknown[] = []
  const ignoredPlans: unknown[] = []
  const port = new SessionHookPort(engine, {
    context: ctx,
    budget: () => ({ remaining: 17, cap: 20 }),
    surface: () => [{ seq: 3, type: 'user/message' }],
    surfaceDigest: () => ({ nodes: 1, tokensEstimate: 123 }),
    verifierTier: () => 2,
    contextOverflow: (value) => {
      overflow.push(value)
    },
    compactPlanIgnored: (value) => {
      ignoredPlans.push(value)
    },
    ...overrides,
  })
  return { engine, port, overflow, ignoredPlans }
}
const make = () =>
  deriveRequest({
    kind: 'turn',
    merged: { tools: [], sections: [], runtimeContext: {}, conflicts: [] },
    harnessEntries: [],
    surface: [],
    disclosed: [],
    model: { slot: 'primary', route: 'local', model: 'm' },
    contract: { contract_id: 'agnes-model-contract@0', parser_version: '1' },
    nonce: 'a'.repeat(32),
    envelopeCache: createEnvelopeCache(),
  })
const tool = {
  toolUseId: 't',
  name: 'read',
  args: { path: 'a' },
  actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
  taint: false,
  resolvedPolicy: {
    isReadOnly: true,
    isDestructive: false,
    replay: 'safe' as const,
    requiresApproval: 'never' as const,
    approvalScopes: [],
    policyVersion: 'static-v1',
  },
  executionDomain: 'workspace' as const,
  definitionFingerprint: 'a'.repeat(64),
  policyHash: 'b'.repeat(64),
  meta: {
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    isOpenWorld: false,
    replay: 'safe' as const,
    costHint: undefined,
    deferLoading: undefined,
    requiresApproval: undefined,
  },
}

describe('SessionHookPort', () => {
  it('keeps no-extension defaults and the original minted request', async () => {
    const { port } = setup(),
      request = make()
    await expect(port.beforeStep({ turn: 1, step: 1, depth: 0 })).resolves.toEqual({})
    await expect(port.toolCall(tool)).resolves.toEqual({ allow: true })
    await expect(port.turnStopping({ turn: 1, step: 1, proposedReason: 'completed' })).resolves.toEqual({
      action: 'stop',
    })
    await expect(port.context([])).resolves.toEqual([])
    const existing = [{ id: 'additional-context', order: 199, text: 'existing', source: 'caller' }]
    await expect(port.context(existing)).resolves.toEqual(existing)
    expect(await port.beforeRequest(request, 'primary', 0)).toBe(request)
  })

  it('adapts before_compact waterfall plans and the compact observation', async () => {
    const { engine, port } = setup()
    const plan = {
      keepFromSeq: 3,
      summarizeRange: [1, 2] as [number, number],
      prompts: { system: 'S', history: 'H' },
      maxTokens: 100,
      details: { readFiles: [], modifiedFiles: [] },
    }
    const seen: unknown[] = []
    engine.on('before_compact', () => plan, meta)
    engine.on(
      'compact',
      (payload) => {
        seen.push(payload)
      },
      meta,
    )
    const payload = {
      contextTokens: 90,
      contextWindow: 100,
      reserveTokens: 10,
      reason: 'threshold' as const,
      getSurface: () => [{ seq: 1, type: 'user/message' as const }],
    }
    await expect(port.beforeCompact(payload)).resolves.toEqual({ kind: 'handled', plan })
    await port.compact({ replaceSeq: 8, range: [1, 2], tokensBefore: 90, tokensAfter: 20 })
    expect(seen).toEqual([{ replaceSeq: 8, range: [1, 2], tokensBefore: 90, tokensAfter: 20 }])
  })

  it('distinguishes no before_compact handler, all-null opt-out, one plan, and multiple plans', async () => {
    const payload = {
      contextTokens: 90,
      contextWindow: 100,
      reserveTokens: 10,
      reason: 'threshold' as const,
      getSurface: () => [{ seq: 1, type: 'user/message' as const }],
    }
    const empty = setup()
    await expect(empty.port.beforeCompact(payload)).resolves.toEqual({ kind: 'unhandled' })

    const dynamicSkip = setup()
    dynamicSkip.engine.on('before_compact', () => HOOK_UNHANDLED as never, meta)
    await expect(dynamicSkip.port.beforeCompact(payload)).resolves.toEqual({ kind: 'unhandled' })

    const optedOut = setup()
    optedOut.engine.on('before_compact', () => null, meta)
    optedOut.engine.on('before_compact', () => null, { ...meta, source: 'agnes/other' })
    await expect(optedOut.port.beforeCompact(payload)).resolves.toEqual({
      kind: 'handled',
      plan: null,
    })

    // Two participants disagree: the first one registered (dispatch order) wins, the second is
    // dropped and reported through compactPlanIgnored instead of the whole call rejecting -- a
    // third party is now free to register on this event too (third-party-transform-directive-hooks
    // design §3 item 5).
    const competing = setup()
    const firstPlan = {
      keepFromSeq: 3,
      summarizeRange: [1, 2] as [number, number],
      prompts: { system: 'S', history: 'H' },
      maxTokens: 100,
      details: { readFiles: [], modifiedFiles: [] },
    }
    const secondPlan = { ...firstPlan, maxTokens: 200 }
    competing.engine.on('before_compact', () => firstPlan, meta)
    competing.engine.on('before_compact', () => secondPlan, { ...meta, source: 'agnes/other' })
    await expect(competing.port.beforeCompact(payload)).resolves.toEqual({
      kind: 'handled',
      plan: firstPlan,
    })
    expect(competing.ignoredPlans).toEqual([{ ext: 'agnes/other' }])
  })

  it('gets live budget from the assembled session and obeys a before_step block', async () => {
    let remaining = 17
    const { engine, port } = setup({ budget: () => ({ remaining, cap: 20 }) })
    engine.on(
      'before_step',
      (payload) => ({ block: payload.budget.remaining === 0, reason: String(payload.budget.remaining) }),
      meta,
    )
    await expect(port.beforeStep({ turn: 1, step: 1, depth: 0 })).resolves.toEqual({})
    remaining = 0
    await expect(port.beforeStep({ turn: 1, step: 2, depth: 0 })).resolves.toEqual({
      block: true,
      reason: '0',
    })
  })

  it('denies a failed tool_call and does not fall back to allow', async () => {
    const { engine, port } = setup()
    engine.on(
      'tool_call',
      () => {
        throw new Error('secret')
      },
      meta,
    )
    await expect(port.toolCall(tool)).resolves.toEqual({ allow: false, reason: 'hook execution failed' })
  })

  it('passes real tool args/meta/actor and honors the first deny', async () => {
    const { engine, port } = setup()
    let after = false
    engine.on(
      'tool_call',
      (payload) => {
        expect(payload).toEqual(tool)
        return { allow: false, reason: 'policy' }
      },
      meta,
    )
    engine.on(
      'tool_call',
      () => {
        after = true
        return { allow: true }
      },
      meta,
    )
    await expect(port.toolCall(tool)).resolves.toEqual({ allow: false, reason: 'policy' })
    expect(after).toBe(false)
  })

  it('rejects non-JSON tool args without invoking a handler', async () => {
    const { engine, port } = setup()
    let calls = 0
    engine.on(
      'tool_call',
      () => {
        calls++
        return { allow: true }
      },
      meta,
    )
    await expect(port.toolCall({ ...tool, args: { n: Number.NaN } })).resolves.toMatchObject({ allow: false })
    expect(calls).toBe(0)
  })

  it('normalizes verifier semantics using the session tier and honors continue', async () => {
    const { engine, port } = setup()
    engine.on(
      'turn_stopping',
      (payload) => {
        expect(payload.verifier).toEqual({ passed: false, reasons: ['missing'], tier: 2 })
        return { action: 'continue', note: 'finish work' }
      },
      meta,
    )
    await expect(
      port.turnStopping({
        turn: 1,
        step: 1,
        proposedReason: 'completed',
        verifier: { verdict: 'needs_revision', reasons: ['missing'] },
      }),
    ).resolves.toEqual({ action: 'continue', note: 'finish work' })
  })

  it('retains the stop default when an open turn_stopping handler fails', async () => {
    const { engine, port } = setup()
    engine.on(
      'turn_stopping',
      () => {
        throw new Error('failure')
      },
      meta,
    )
    await expect(port.turnStopping({ turn: 1, step: 1, proposedReason: 'completed' })).resolves.toEqual({
      action: 'stop',
    })
  })

  it('binds context to actual surface inputs and reports capped context once', async () => {
    const { engine, port, overflow } = setup()
    engine.on(
      'context',
      (payload) => {
        expect(payload.surfaceDigest).toEqual({ nodes: 1, tokensEstimate: 123 })
        expect(payload.getSurface()).toEqual([{ seq: 3, type: 'user/message' }])
        return { additionalContext: '界'.repeat(3000) }
      },
      meta,
    )
    engine.on(
      'context',
      (payload) => {
        expect(payload.sections[0]?.content).toBe('界'.repeat(2730))
        return { additionalContext: '界'.repeat(3000) }
      },
      meta,
    )
    const sections = await port.context([])
    expect(sections).toHaveLength(1)
    expect(sections[0]?.text).toBe('界'.repeat(2730))
    expect(overflow).toEqual([{ ext: 'agnes/test', bytes: 9000 }])
  })

  it('fails closed for context validation instead of silently dropping a bad return', async () => {
    const { engine, port } = setup()
    engine.on('context', (() => ({ injected: true })) as unknown as HookHandler<'context'>, meta)
    await expect(port.context([])).rejects.toThrow('hook rejected transformation')
  })

  it('remints each accepted request patch before the next author sees its view', async () => {
    const { engine, port } = setup(),
      original = make()
    const views: unknown[] = []
    engine.on(
      'before_request',
      (payload) => {
        views.push(payload.request)
        return { patch: { maxTokens: 12, samplingParams: { temperature: 0.2 } } }
      },
      meta,
    )
    engine.on(
      'before_request',
      (payload) => {
        expect(payload.request.maxTokens).toBe(12)
        expect(payload.request.samplingParams).toEqual({ temperature: 0.2 })
        expect(payload.request).not.toHaveProperty('messages')
        expect(payload.request).not.toHaveProperty('nonce')
        expect(payload.request).not.toHaveProperty('contractId')
        return { patch: { maxTokens: 24 } }
      },
      { source: 'agnes/second', trust: 'trusted' },
    )
    const result = await port.beforeRequest(original, 'primary', 2)
    expect(isLedgerRequest(result.request)).toBe(true)
    expect(result.request.maxTokens).toBe(24)
    expect(original.request.maxTokens).toBeUndefined()
    expect(result.header.derived_hash).not.toBe(original.header.derived_hash)
    expect(result.header.transforms).toEqual([
      { event: 'before_request', ext: 'agnes/test' },
      { event: 'before_request', ext: 'agnes/second' },
    ])
    expect(views).toEqual([
      { model: 'm', slot: 'primary', messageCount: 0, toolNames: [], samplingParams: {} },
    ])
  })

  it('refuses a message-body patch and never calls a later request transformer', async () => {
    const { engine, port } = setup()
    let later = false
    engine.on(
      'before_request',
      (() => ({ patch: { messages: [] } })) as unknown as HookHandler<'before_request'>,
      meta,
    )
    engine.on(
      'before_request',
      () => {
        later = true
        return {}
      },
      meta,
    )
    await expect(port.beforeRequest(make(), 'primary', 0)).rejects.toThrow('hook rejected transformation')
    expect(later).toBe(false)
  })
})

it('pins all five turn adapter events until resetTurn replaces their shared membership', async () => {
  const { engine, port } = setup()
  const register = (label: string) => [
    engine.on('before_step', () => ({ block: true, reason: label }), meta),
    engine.on('tool_call', () => ({ allow: false, reason: label }), meta),
    engine.on('turn_stopping', () => ({ action: 'continue', note: label }), meta),
    engine.on('context', () => ({ additionalContext: label }), meta),
    engine.on('before_request', () => ({ patch: { maxTokens: label === 'old' ? 17 : 23 } }), meta),
  ]
  const disposers = register('old')
  port.resetTurn()
  for (const dispose of disposers) dispose()
  register('new')
  const check = async (label: string) => {
    expect(await port.beforeStep({ turn: 1, step: 1, depth: 0 })).toEqual({ block: true, reason: label })
    expect(await port.toolCall(tool)).toEqual({ allow: false, reason: label })
    expect(await port.turnStopping({ turn: 1, step: 1, proposedReason: 'completed' })).toEqual({
      action: 'continue',
      note: label,
    })
    expect((await port.context([])).map((section) => section.text)).toEqual([label])
    expect((await port.beforeRequest(make(), 'primary', 0)).request.maxTokens).toBe(label === 'old' ? 17 : 23)
  }
  await check('old')
  port.resetTurn()
  await check('new')
})

it('targets shutdown by exact extension identity without refreshing the current turn snapshot', async () => {
  const { engine, port } = setup(),
    calls: string[] = []
  const off = engine.on('before_step', () => ({ block: true, reason: 'old' }), meta)
  port.resetTurn()
  off()
  engine.on('before_step', () => ({ block: true, reason: 'new' }), meta)
  engine.on(
    'shutdown',
    (payload, context) => {
      calls.push(`${context.session.key}:${payload.reason}`)
    },
    meta,
  )
  engine.on(
    'shutdown',
    () => {
      calls.push('wrong extension')
    },
    { ...meta, source: 'agnes/test-extra' },
  )
  await port.shutdownExtension(meta.source, 'revoke')
  await port.shutdownExtension(meta.source, 'reload')
  expect(calls).toEqual(['s:revoke', 's:reload'])
  expect(await port.beforeStep({ turn: 1, step: 1, depth: 0 })).toEqual({ block: true, reason: 'old' })
  port.resetTurn()
  expect(await port.beforeStep({ turn: 2, step: 1, depth: 0 })).toEqual({ block: true, reason: 'new' })
  await expect(port.shutdownExtension(undefined as unknown as string, 'revoke')).rejects.toThrow(/E_ENVELOPE/)
  expect(calls).toHaveLength(2)
})

describe('SessionHookPort.toolResult', () => {
  const result = { content: [{ type: 'text' as const, text: 'original' }] }
  const payload = () => ({
    toolUseId: 't',
    name: 'read',
    args: { path: 'a' },
    result,
    enforcement: { level: 'full' as const, scope: ['file'] as const },
  })

  it('keeps the tool’s own result when no extension is registered', async () => {
    const { port } = setup()
    await expect(port.toolResult(payload())).resolves.toEqual({ result })
  })

  it('lets a waterfall extension override the result surfaced downstream', async () => {
    const { engine, port } = setup()
    const overridden = { content: [{ type: 'text' as const, text: 'redacted' }] }
    engine.on(
      'tool_result',
      (p) => {
        expect(p.toolUseId).toBe('t')
        expect(p.enforcement).toEqual({ level: 'full', scope: ['file'] })
        return { result: overridden }
      },
      meta,
    )
    await expect(port.toolResult(payload())).resolves.toEqual({ result: overridden })
  })

  it('chains: a later handler sees the earlier handler’s accepted result, not the original', async () => {
    const { engine, port } = setup()
    const intercepted = {
      content: [
        { type: 'text' as const, text: 'original' },
        { type: 'text' as const, text: 'blocked: no' },
      ],
      isError: true,
    }
    const seenBySecond: unknown[] = []
    engine.on('tool_result', () => ({ result: intercepted }), meta)
    engine.on(
      'tool_result',
      (p) => {
        seenBySecond.push(p.result)
        // A handler that just passes the result through must not erase what the first handler did.
        return {}
      },
      { ...meta, source: 'agnes/other' },
    )
    await expect(port.toolResult(payload())).resolves.toEqual({ result: intercepted })
    expect(seenBySecond).toEqual([intercepted])
  })
})

describe('SessionHookPort.approvalRequest', () => {
  const request = {
    tool: 'shell',
    argv: { cmd: 'rm' } as const,
    risk: 'destructive' as const,
    actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    summary: 'run rm',
  }

  it('returns no override when no extension is registered', async () => {
    const { port } = setup()
    await expect(port.approvalRequest({ request })).resolves.toEqual({})
  })

  it('lets an extension raise the summary/context/risk an approver sees', async () => {
    const { engine, port } = setup()
    engine.on(
      'approval_request',
      (p) => {
        expect(p.request).toEqual(request)
        return { request: { summary: 'run rm -rf /', risk: 'always' } }
      },
      meta,
    )
    await expect(port.approvalRequest({ request })).resolves.toEqual({
      request: { summary: 'run rm -rf /', risk: 'always' },
    })
  })

  it('fails closed when a handler throws, since approval_request has failPolicy closed', async () => {
    const { engine, port } = setup()
    engine.on(
      'approval_request',
      () => {
        throw new Error('boom')
      },
      meta,
    )
    await expect(port.approvalRequest({ request })).rejects.toThrow('hook rejected transformation')
  })

  it('chains: a later handler sees the earlier handler’s accepted override folded into request', async () => {
    const { engine, port } = setup()
    const seenBySecond: unknown[] = []
    engine.on('approval_request', () => ({ request: { risk: 'always' as const } }), meta)
    engine.on(
      'approval_request',
      (p) => {
        seenBySecond.push(p.request.risk)
        return { request: { summary: 'run rm -rf /' } }
      },
      { ...meta, source: 'agnes/other' },
    )
    await expect(port.approvalRequest({ request })).resolves.toEqual({
      request: { risk: 'always', summary: 'run rm -rf /' },
    })
    expect(seenBySecond).toEqual(['always'])
  })
})

describe('SessionHookPort.requestError', () => {
  it('dispatches to a registered observer without needing a return value', async () => {
    const { engine, port } = setup()
    const seen: unknown[] = []
    engine.on(
      'request_error',
      (p) => {
        seen.push(p)
      },
      meta,
    )
    await port.requestError({ code: 'RATE_LIMIT', message: 'slow', attempt: 1, retryable: true })
    expect(seen).toEqual([{ code: 'RATE_LIMIT', message: 'slow', attempt: 1, retryable: true }])
  })
})

describe('SessionHookPort.formatDeviation', () => {
  it('dispatches to a registered observer without needing a return value', async () => {
    const { engine, port } = setup()
    const seen: unknown[] = []
    engine.on(
      'format_deviation',
      (p) => {
        seen.push(p)
      },
      meta,
    )
    await port.formatDeviation({ rule: 'unparsed', model: 'm', sampleHash: 'a'.repeat(64) })
    expect(seen).toEqual([{ rule: 'unparsed', model: 'm', sampleHash: 'a'.repeat(64) }])
  })
})

it('bounds targeted shutdown by the protocol default despite an already cancelled session signal', async () => {
  vi.useFakeTimers()
  try {
    const { engine, port } = setup({ context: () => ({ ...ctx(), signal: AbortSignal.abort() }) })
    let called = false,
      signal: AbortSignal | undefined,
      done = false
    engine.on(
      'shutdown',
      async (_payload, context) => {
        called = true
        signal = context.signal
        await new Promise(() => {})
      },
      meta,
    )
    const pending = port.shutdownExtension(meta.source, 'revoke').then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(called).toBe(true)
    expect(signal?.aborted).toBe(false)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
