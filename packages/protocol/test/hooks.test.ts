import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HOOK_EVENTS, HOOK_TABLE, isHookEvent, validateHook } from '../src/index.js'
import { type Fixture, runFixtureLine } from '../tools/conformance-core.js'

describe('hooks', () => {
  // The whole five-tuple table, all seventeen rows times five cells, written out. Spot-checking a
  // few cells is what would let a wrong timeout or a wrong failPolicy ship: the extension host and
  // the hooks runner read this table and nothing else pins it. The expected object is written from
  // the decision table, not copied back out of hooks.json, or the assertion proves only itself.
  it('the five-tuple table matches the decision table cell for cell', () => {
    expect(HOOK_EVENTS).toHaveLength(17)
    expect(HOOK_TABLE).toEqual({
      session_start: {
        mode: 'parallel',
        category: 'observe',
        failPolicy: 'open',
        timeoutMs: 500,
        replayOnResume: true,
      },
      resources_discover: {
        mode: 'waterfall',
        category: 'transform',
        failPolicy: 'open',
        timeoutMs: 1000,
        replayOnResume: true,
      },
      before_step: {
        mode: 'serial',
        category: 'directive',
        failPolicy: 'closed',
        timeoutMs: 1000,
        replayOnResume: false,
      },
      context: {
        mode: 'waterfall',
        category: 'transform',
        failPolicy: 'closed',
        timeoutMs: 1500,
        replayOnResume: false,
      },
      before_request: {
        mode: 'waterfall',
        category: 'transform',
        failPolicy: 'closed',
        timeoutMs: 1500,
        replayOnResume: false,
      },
      before_provider_headers: {
        mode: 'waterfall',
        category: 'transform',
        failPolicy: 'closed',
        timeoutMs: 500,
        replayOnResume: false,
      },
      request_error: {
        mode: 'parallel',
        category: 'observe',
        failPolicy: 'open',
        timeoutMs: 500,
        replayOnResume: false,
      },
      tool_call: {
        mode: 'serial',
        category: 'directive',
        failPolicy: 'closed',
        timeoutMs: 2000,
        replayOnResume: false,
      },
      tool_result: {
        mode: 'waterfall',
        category: 'transform',
        failPolicy: 'open',
        timeoutMs: 2000,
        replayOnResume: false,
      },
      turn_stopping: {
        mode: 'serial',
        category: 'directive',
        failPolicy: 'open',
        timeoutMs: 1000,
        replayOnResume: false,
      },
      approval_request: {
        mode: 'waterfall',
        category: 'transform',
        failPolicy: 'closed',
        timeoutMs: 1000,
        replayOnResume: false,
      },
      before_compact: {
        mode: 'waterfall',
        category: 'transform',
        failPolicy: 'closed',
        timeoutMs: 3000,
        replayOnResume: false,
      },
      compact: {
        mode: 'parallel',
        category: 'observe',
        failPolicy: 'open',
        timeoutMs: 1000,
        replayOnResume: false,
      },
      subagent_start: {
        mode: 'emit',
        category: 'observe',
        failPolicy: 'open',
        timeoutMs: 200,
        replayOnResume: false,
      },
      subagent_end: {
        mode: 'emit',
        category: 'observe',
        failPolicy: 'open',
        timeoutMs: 200,
        replayOnResume: false,
      },
      format_deviation: {
        mode: 'parallel',
        category: 'observe',
        failPolicy: 'open',
        timeoutMs: 500,
        replayOnResume: false,
      },
      shutdown: {
        mode: 'parallel',
        category: 'observe',
        failPolicy: 'open',
        timeoutMs: 1000,
        replayOnResume: false,
      },
    })
    expect(isHookEvent('tool_call')).toBe(true)
    expect(isHookEvent('registerCommand')).toBe(false)
  })
  // Every event has both halves of its IO pair. A missing row is `undefined` at runtime and
  // invisible to the type checker, because Record over a literal union is a mapped type.
  it('every event resolves both a payload schema and a return schema', () => {
    for (const e of HOOK_EVENTS) {
      expect(validateHook(e, 'payload', undefined).ok, `${e} payload`).toBe(false)
      expect(() => validateHook(e, 'return', null), `${e} return`).not.toThrow()
    }
  })
  it('mode and category obey the rule that pairs them', () => {
    for (const e of HOOK_EVENTS) {
      const { mode, category } = HOOK_TABLE[e]
      if (category === 'observe') expect(['emit', 'parallel'], e).toContain(mode)
      if (category === 'transform') expect(mode, e).toBe('waterfall')
      if (category === 'directive') expect(mode, e).toBe('serial')
    }
  })
  it('validates tool_call return as allow or deny and nothing else', () => {
    expect(validateHook('tool_call', 'return', { allow: true }).ok).toBe(true)
    expect(validateHook('tool_call', 'return', { allow: false, reason: 'no' }).ok).toBe(true)
    expect(validateHook('tool_call', 'return', { allow: 'ask' }).ok).toBe(false)
    // A deny with no reason is a refusal nobody can explain to the caller.
    expect(validateHook('tool_call', 'return', { allow: false }).ok).toBe(false)
  })
  it('before_compact returns null or a plan; the headers hook may only add X-Ext-*', () => {
    expect(validateHook('before_compact', 'return', null).ok).toBe(true)
    expect(validateHook('before_provider_headers', 'return', { headers: { 'X-Ext-Trace': '1' } }).ok).toBe(
      true,
    )
    // TypeBox compiles a patterned Record key to `patternProperties` alone, which constrains nothing
    // by itself; the generator closes it with additionalProperties:false so this is really refused.
    // Without that, an extension could overwrite the harness's own headers through this return.
    const r = validateHook('before_provider_headers', 'return', { headers: { 'X-Agnes-Session': 'x' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toMatchObject({ code: 'UNKNOWN_KEY' })
  })
  it('turn_stopping continue carries a note, stop does not', () => {
    expect(validateHook('turn_stopping', 'return', { action: 'stop' }).ok).toBe(true)
    expect(validateHook('turn_stopping', 'return', { action: 'continue', note: 'one more' }).ok).toBe(true)
    expect(validateHook('turn_stopping', 'return', { action: 'continue' }).ok).toBe(false)
  })
  it('the checked-in hook fixtures agree with the validator', () => {
    const lines = readFileSync(new URL('../fixtures/hooks/hooks.jsonl', import.meta.url), 'utf8')
      .split('\n')
      .filter(Boolean)
    expect(lines.length).toBe(34) // 17 events x (one positive + one negative)
    for (const line of lines) {
      const f = JSON.parse(line) as Fixture
      expect(runFixtureLine(f).pass, f.id).toBe(true)
    }
  })
})
