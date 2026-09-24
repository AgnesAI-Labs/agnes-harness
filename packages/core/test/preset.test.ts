import { describe, expect, it } from 'vitest'
import { SEAM_NAMES, type SeamImplementations, type TestSeams } from '../src/effects/seams.js'
import { presetDefaults, readPreset } from '../src/step/preset.js'

describe('preset view', () => {
  it('preserves omitted, empty and selected prompt sections without sharing the input array', () => {
    expect(readPreset({}, 'default').model.promptSections).toBeUndefined()
    expect(readPreset({ model: { prompt_sections: [] } }, 'empty').model.promptSections).toEqual([])
    const declared = ['persona', 'channel-style']
    const view = readPreset({ model: { prompt_sections: declared } }, 'channel')
    declared.push('environment')
    expect(view.model.promptSections).toEqual(['persona', 'channel-style'])
  })

  it('has the core defaults', () => {
    const d = presetDefaults()
    expect(d.name).toBe('standard')
    expect(d.disclosure).toBe('standard')
    expect(d.model).toEqual({
      route: { primary: 'default' },
      id: {},
      thinking: {},
      retry: { maxAttempts: 2, baseDelayMs: 1000 },
      timeoutMs: 600000,
    })
    expect(d.budget).toEqual({
      preflight: 'estimate',
      perRequestCap: null,
      onExceed: 'quote',
      maxSteps: 50,
    })
    expect(d.approval).toEqual({
      onTimeout: 'rejected',
      timeoutMs: 60000,
      onUnavailable: 'deny',
      pendingTtlMs: 86400000,
    })
    expect(d.compaction).toEqual({
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
      agentCallable: true,
    })
    expect(d.sandbox).toEqual({ onUnavailable: 'deny' })
    expect(d.tools).toEqual({ timeoutMs: 120000, timeouts: {} })
    expect(d.verifier).toEqual({ timeoutMs: 30000, defaultTier: 0 })
    expect(d.repair).toEqual({ timeoutMs: 10000 })
    expect(d.completionGate).toEqual({ minItems: 3 })
    expect(d.telemetry).toEqual({ invariants: false, timing: false })
    expect(d.recovery).toEqual({ unknownChild: 'model' })
    expect(d.deferred).toEqual({ pollMs: 2000 })
    expect(d.depthLimit).toBe(2)
    expect(d.generationLimit).toBe(1)
    expect(d.maxFanOut).toBe(4)
    expect(d.treeBudgetCredits).toBeNull()
    expect(d.ext).toEqual({ eventsPerTurn: 200 })
  })

  it('defaults the two unavailability answers closed', () => {
    // Both are the fail-closed half of a seam contract: a missing approver or sandbox denies rather
    // than proceeding, unless the deployment says otherwise in writing.
    const d = presetDefaults()
    expect(d.approval.onUnavailable).toBe('deny')
    expect(d.sandbox.onUnavailable).toBe('deny')
    expect(d.approval.onTimeout).toBe('rejected')
  })

  it('hands back a fresh object each call, so one session cannot edit another session defaults', () => {
    const a = presetDefaults()
    a.tools.timeouts.shell = 1
    a.model.route.primary = 'edited'
    expect(presetDefaults().tools.timeouts).toEqual({})
    expect(presetDefaults().model.route).toEqual({ primary: 'default' })
  })

  it('reads a preset document with snake_case keys and overrides defaults', () => {
    const v = readPreset(
      {
        disclosure: 'code',
        budget: { max_steps: 80, per_request_cap: 4000 },
        approval: { on_unavailable: 'park' },
        tools: { timeouts: { shell: 5000 } },
        subagent: { max_depth: 2 },
      },
      'code',
    )
    expect(v.name).toBe('code')
    expect(v.disclosure).toBe('code')
    expect(v.budget.maxSteps).toBe(80)
    expect(v.budget.perRequestCap).toBe(4000)
    expect(v.approval.onUnavailable).toBe('park')
    expect(v.tools.timeouts.shell).toBe(5000)
    // The document counts the depth a subagent may add; the view counts the total.
    expect(v.depthLimit).toBe(3)
    // Untouched siblings keep their defaults rather than becoming undefined.
    expect(v.budget.onExceed).toBe('quote')
    expect(v.budget.preflight).toBe('estimate')
    expect(v.approval.timeoutMs).toBe(60000)
    expect(v.tools.timeoutMs).toBe(120000)
  })

  it('reads every key it promises, each from its own snake_case path', () => {
    const v = readPreset(
      {
        disclosure: 'hybrid',
        model: {
          route: { primary: 'fast' },
          id: { primary: 'gpt-4.1' },
          retry: { max_attempts: 5, base_delay_ms: 7 },
          timeout_ms: 11,
        },
        budget: { preflight: 'count', per_request_cap: 13, on_exceed: 'deny', max_steps: 17 },
        approval: { timeout_ms: 19, on_unavailable: 'park', pending_ttl_ms: 23 },
        sandbox: { on_unavailable: 'allow' },
        tools: { timeout_ms: 29, timeouts: { shell: 31 } },
        verifier: { timeout_ms: 37, default_tier: 2 },
        repair: { timeout_ms: 41 },
        completion_gate: { min_items: 43 },
        compaction: {
          enabled: false,
          reserve_tokens: 47,
          keep_recent_tokens: 53,
          agent_callable: false,
        },
        telemetry: { invariants: 'strict', timing: true },
        recovery: { unknown_child: 'human' },
        deferred: { poll_ms: 59 },
        subagent: { max_depth: 4 },
        ext: { events_per_turn: 61 },
      },
      'full',
    )
    expect(v).toEqual({
      name: 'full',
      disclosure: 'hybrid',
      model: {
        route: { primary: 'fast' },
        id: { primary: 'gpt-4.1' },
        thinking: {},
        retry: { maxAttempts: 5, baseDelayMs: 7 },
        timeoutMs: 11,
      },
      budget: { preflight: 'count', perRequestCap: 13, onExceed: 'deny', maxSteps: 17 },
      approval: { onTimeout: 'rejected', timeoutMs: 19, onUnavailable: 'park', pendingTtlMs: 23 },
      sandbox: { onUnavailable: 'allow' },
      tools: { timeoutMs: 29, timeouts: { shell: 31 } },
      verifier: { timeoutMs: 37, defaultTier: 2 },
      repair: { timeoutMs: 41 },
      completionGate: { minItems: 43 },
      compaction: { enabled: false, reserveTokens: 47, keepRecentTokens: 53, agentCallable: false },
      telemetry: { invariants: 'strict', timing: true },
      recovery: { unknownChild: 'human' },
      deferred: { pollMs: 59 },
      depthLimit: 5,
      generationLimit: 4,
      maxFanOut: 4,
      budgetInherit: 'aggregate',
      treeBudgetCredits: null,
      isolation: 'shared',
      ext: { eventsPerTurn: 61 },
    })
  })

  it('reads an explicit null and an explicit false rather than treating them as absent', () => {
    const v = readPreset(
      { budget: { per_request_cap: null, max_steps: 0 }, compaction: { enabled: false } },
      'edge',
    )
    expect(v.budget.perRequestCap).toBeNull()
    expect(v.budget.maxSteps).toBe(0)
    expect(v.compaction.enabled).toBe(false)
    // Only an absent key falls back. A null written where a number belongs is passed through for
    // the host validator to have already rejected, not quietly turned into the default — asserting
    // it on per_request_cap alone proves nothing, because its default is null.
    expect(readPreset({ approval: { pending_ttl_ms: null } }, 'x').approval.pendingTtlMs).toBeNull()
    expect(readPreset({ compaction: { reserve_tokens: null } }, 'x').compaction.reserveTokens).toBeNull()
  })

  it('ignores a camelCase key, so a mis-spelled document keeps the default instead of half-applying', () => {
    const v = readPreset({ budget: { maxSteps: 80 } }, 'typo')
    expect(v.budget.maxSteps).toBe(50)
  })

  it('survives a document whose branch is a scalar instead of an object', () => {
    const v = readPreset({ budget: 7, model: null }, 'broken')
    expect(v.budget).toEqual(presetDefaults().budget)
    expect(v.model).toEqual(presetDefaults().model)
  })
})

describe('seam names', () => {
  it('lists every seam name, and every seam the kernel fits is one of them', () => {
    // No literal count here. A hard-coded length is the wrong tripwire for an eleventh seam: an
    // eleventh key on SeamImplementations is caught by tsc against the object below, and a bumped
    // number would be the change that made this pass again without proving anything.
    expect(SEAM_NAMES).toContain('platform')
    // Typed as SeamImplementations, so a seam added to that type without a key here fails tsc, and
    // a key added here without a name in SEAM_NAMES fails this comparison. Adding a seam to the
    // type alone therefore cannot leave the list quietly short.
    const fitted: SeamImplementations = {
      approval: null as never,
      checkpoint: null as never,
      ledger: null as never,
      sandbox: null as never,
      verifier: null as never,
      repair: null as never,
      artifacts: null as never,
      principals: null as never,
      platform: null as never,
      harness: null as never,
    }
    expect(Object.keys(fitted).sort()).toEqual([...SEAM_NAMES].sort())
    expect(new Set(SEAM_NAMES).size).toBe(SEAM_NAMES.length)
  })

  it('leaves the ledger out of the test seam set and nothing else', () => {
    const test: TestSeams = {
      approval: null as never,
      checkpoint: null as never,
      sandbox: null as never,
      verifier: null as never,
      repair: null as never,
      artifacts: null as never,
      principals: null as never,
      platform: null as never,
      harness: null as never,
    }
    expect(Object.keys(test).sort()).toEqual(SEAM_NAMES.filter((n) => n !== 'ledger').sort())
  })
})
