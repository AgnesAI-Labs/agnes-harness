import { presetDefaults } from '@agnes/core'
import { describe, expect, it } from 'vitest'
import { toPresetView } from '../../src/presets/view.js'

describe('toPresetView', () => {
  it('delegates to core readPreset: snake_case doc in, camelCase view out', () => {
    const v = toPresetView({
      name: 'standard',
      disclosure: 'standard',
      model: {
        route: { primary: 'default' },
        timeout_ms: 120000,
        retry: { max_attempts: 3, base_delay_ms: 500 },
      },
      budget: { preflight: 'count', per_request_cap: 4000, on_exceed: 'quote', max_steps: 80 },
      approval: { on_unavailable: 'park', timeout_ms: 1000, pending_ttl_ms: 5000 },
      sandbox: { on_unavailable: 'deny' },
      tools: { timeout_ms: 120000, timeouts: { shell: 60000 } },
      verifier: { timeout_ms: 30000, default_tier: 0 },
      repair: { timeout_ms: 10000 },
      completion_gate: { min_items: 3 },
      compaction: { enabled: true, reserve_tokens: 16384, keep_recent_tokens: 20000, agent_callable: true },
      telemetry: { invariants: false, timing: false },
      recovery: { unknown_child: 'model' },
      deferred: { poll_ms: 2000 },
      subagent: { max_depth: 2 },
      ext: { events_per_turn: 200 },
    })
    expect(v).toEqual({
      name: 'standard',
      disclosure: 'standard',
      model: {
        route: { primary: 'default' },
        id: {},
        thinking: {},
        retry: { maxAttempts: 3, baseDelayMs: 500 },
        timeoutMs: 120000,
      },
      budget: { preflight: 'count', perRequestCap: 4000, onExceed: 'quote', maxSteps: 80 },
      approval: { onTimeout: 'rejected', timeoutMs: 1000, onUnavailable: 'park', pendingTtlMs: 5000 },
      sandbox: { onUnavailable: 'deny' },
      tools: { timeoutMs: 120000, timeouts: { shell: 60000 } },
      verifier: { timeoutMs: 30000, defaultTier: 0 },
      repair: { timeoutMs: 10000 },
      completionGate: { minItems: 3 },
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, agentCallable: true },
      telemetry: { invariants: false, timing: false },
      recovery: { unknownChild: 'model' },
      deferred: { pollMs: 2000 },
      // The document counts the depth a subagent may add; the view counts the total.
      depthLimit: 3,
      generationLimit: 2,
      maxFanOut: 4,
      budgetInherit: 'aggregate',
      treeBudgetCredits: null,
      isolation: 'shared',
      ext: { eventsPerTurn: 200 },
    })
  })
  it('a bare doc gets exactly core presetDefaults, name aside', () => {
    expect(toPresetView({ name: 'bare' })).toEqual({ ...presetDefaults(), name: 'bare' })
  })

  // Two documents that used to be accepted and silently ignored. Both are now refusals, because a
  // preset that says something the runtime cannot honour must not boot looking like it was honoured.
  it('refuses approval.on_timeout other than rejected instead of dropping it', () => {
    try {
      toPresetView({ name: 'x', approval: { on_timeout: 'allowed' } })
      expect.unreachable('expected a refusal')
    } catch (e) {
      expect((e as { code: string }).code).toBe('E_PRESET_UNSUPPORTED')
      expect((e as { detail: { capability: string } }).detail.capability).toBe('approval.on_timeout')
    }
    expect(toPresetView({ name: 'x', approval: { on_timeout: 'rejected' } }).approval.onTimeout).toBe(
      'rejected',
    )
  })
  // A recipe that writes 0 means "no deadline". The view reads it as a deadline of zero, and a
  // timed-out approval is a rejection, so the knob inverts: the recipe that meant "wait" refuses
  // everything. The `claw` recipe was written that way.
  it('refuses approval.timeout_ms of 0, which reads as no timeout and behaves as refuse everything', () => {
    for (const bad of [0, -1, 1.5, '1000', null]) {
      try {
        toPresetView({ name: 'x', approval: { timeout_ms: bad } })
        expect.unreachable(`expected a refusal for ${JSON.stringify(bad)}`)
      } catch (e) {
        expect((e as { detail: { capability: string } }).detail.capability, JSON.stringify(bad)).toBe(
          'approval.timeout_ms',
        )
      }
    }
    expect(toPresetView({ name: 'x', approval: { timeout_ms: 1 } }).approval.timeoutMs).toBe(1)
    // Absent is the way to say "the default", and it stays the default.
    expect(toPresetView({ name: 'x' }).approval.timeoutMs).toBe(60000)
  })
  it('refuses verifier.default_tier outside 0|1|2 instead of coercing it to 0', () => {
    for (const bad of [3, -1, 1.5, '2', null]) {
      try {
        toPresetView({ name: 'x', verifier: { default_tier: bad } })
        expect.unreachable(`expected a refusal for ${JSON.stringify(bad)}`)
      } catch (e) {
        expect((e as { detail: { capability: string } }).detail.capability, JSON.stringify(bad)).toBe(
          'verifier.default_tier',
        )
      }
    }
    expect(toPresetView({ name: 'x', verifier: { default_tier: 2 } }).verifier.defaultTier).toBe(2)
  })

  // ERRATA B20: --park may not write a preset field through the flags layer, so cli sends it as a
  // Profile limit and the conversion to a session-level knob happens here.
  it('turns limits["approval.park"] = 1 into approval.onUnavailable = park', () => {
    expect(toPresetView({ name: 'x' }, { limits: { 'approval.park': 1 } }).approval.onUnavailable).toBe(
      'park',
    )
    expect(toPresetView({ name: 'x' }, { limits: {} }).approval.onUnavailable).toBe('deny')
    expect(
      toPresetView({ name: 'x', approval: { on_unavailable: 'park' } }, { limits: {} }).approval
        .onUnavailable,
    ).toBe('park')
  })
  // A recipe writes one object per slot; the view carries the route and the model id apart. Nothing
  // used to do the splitting, so a document in the object form reached materializeRoutes with an
  // object where a route name belonged and the host refused to assemble, naming a route called
  // `[object Object]`. @agnes/code's own shipped standard.yaml is written that way, which is how a
  // product recipe that could not boot a host shipped green.
  it('splits a route target object into model.route and model.id', () => {
    const v = toPresetView({
      name: 'x',
      model: {
        route: {
          primary: { route: 'gw', model: 'm1' },
          fast: { route: 'default', model: 'default' },
          verifier: 'other',
        },
      },
    })
    expect(v.model.route).toEqual({ primary: 'gw', fast: 'default', verifier: 'other' })
    // `default` as a model id is the unconfigured sentinel, not a pin: a pin the route never
    // declared is refused at assembly, so writing it down would make the sentinel unusable.
    expect(v.model.id).toEqual({ primary: 'm1' })
  })
  it('refuses a route target that names no route', () => {
    for (const target of [{ model: 'm1' }, { route: 7 }, null])
      expect(
        () => toPresetView({ name: 'x', model: { route: { primary: target } } }),
        JSON.stringify(target),
      ).toThrow(/names no route/)
  })
  it('leaves the bare string form exactly as it was', () => {
    const v = toPresetView({ name: 'x', model: { route: { primary: 'gw' }, id: { primary: 'm9' } } })
    expect(v.model.route).toEqual({ primary: 'gw' })
    expect(v.model.id).toEqual({ primary: 'm9' })
  })
  it('a limit value other than 1 does not park', () => {
    expect(toPresetView({ name: 'x' }, { limits: { 'approval.park': 0 } }).approval.onUnavailable).toBe(
      'deny',
    )
  })
})
