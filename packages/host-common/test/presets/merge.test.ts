import { describe, expect, it } from 'vitest'
import { mergePresets, resolvePreset } from '../../src/presets/index.js'
import type { PresetDoc } from '../../src/presets/types.js'

const base: PresetDoc = {
  name: 'base',
  tools: {
    core: ['read', 'write', 'edit', 'shell', 'grep', 'find', 'ls', 'todo'],
    timeout_ms: 120000,
    timeouts: {},
  },
  compaction: { enabled: true, reserve_tokens: 16384, keep_recent_tokens: 20000, agent_callable: true },
  budget: {
    preflight: 'estimate',
    per_request_cap: null,
    on_exceed: 'quote',
    max_steps: 50,
    attribution: 'aggregate',
  },
  approval: {
    on_unavailable: 'deny',
    on_timeout: 'rejected',
    timeout_ms: 60000,
    pending_ttl_ms: 86400000,
    command_policy: [],
  },
  sandbox: { level: 'L1', required: false, on_unavailable: 'deny', extra_paths: [] },
  subagent: { max_depth: 1, max_fan_out: 4 },
  verifier: { timeout_ms: 30000, default_tier: 0 },
  repair: { max_rounds: 5, escalate_after: 3, timeout_ms: 10000 },
  completion_gate: { enabled: true, min_items: 3, allow_override: true },
  telemetry: { consent: 'DISABLED', invariants: false, timing: false },
  recovery: { unknown_child: 'model' },
  ext: { events_per_turn: 200 },
  locale: 'en',
}
const standard: PresetDoc = {
  name: 'standard',
  extends: 'base',
  disclosure: 'standard',
  model: { contract_id: 'agnes-model-contract@v1', route: { primary: 'default' } },
  budget: { per_request_cap: 4000, max_steps: 80 },
  approval: { command_policy: [{ tool: 'edit|write', argv: '^/repo/', action: 'allow' }] },
}
const code: PresetDoc = {
  name: 'code',
  extends: 'standard',
  disclosure: 'code',
  code_runtime: { language: 'python', state: 'persistent' },
}
const minimal: PresetDoc = { name: 'minimal-rl', disclosure: 'standard', tools: { core: ['shell', 'edit'] } }

describe('mergePresets', () => {
  it('scalar override, array replace, map deep merge', () => {
    const m = mergePresets([base, standard])
    expect((m.budget as Record<string, unknown>).per_request_cap).toBe(4000)
    expect((m.budget as Record<string, unknown>).preflight).toBe('estimate')
    expect((m.approval as Record<string, unknown[]>).command_policy).toHaveLength(1)
    expect((m.tools as Record<string, unknown[]>).core).toHaveLength(8)
  })
  it('an array in the later document replaces rather than concatenates', () => {
    const m = mergePresets([base, { name: 'x', tools: { core: ['shell'] } }])
    expect((m.tools as Record<string, unknown[]>).core).toEqual(['shell'])
  })
  it('drops the extends key from the merged document', () => {
    expect(mergePresets([base, standard]).extends).toBeUndefined()
  })
})

describe('resolvePreset', () => {
  const docs = { base, standard, code, 'minimal-rl': minimal }
  it('walks the extends chain and hashes the merged doc', () => {
    const r = resolvePreset('code', docs)
    expect(r.chain).toEqual(['base', 'standard', 'code'])
    expect(r.doc.disclosure).toBe('code')
    expect(r.hash).toMatch(/^sha256-/)
    expect(r.hash).toBe(resolvePreset('code', docs).hash)
  })
  it('the name in the view is the requested name, not the deepest base', () => {
    expect(resolvePreset('code', docs).view.name).toBe('code')
  })
  // The lookup key is what presets.allowed admits and what session/start records, so it is what the
  // resolved preset is called. A document registered under a key that disagrees with its own `name`
  // would otherwise resolve under a name the profile never admitted.
  it('resolves under the requested name even when the document names itself something else', () => {
    const r = resolvePreset('standard', { standard: { name: 'borrowed', disclosure: 'standard' } })
    expect(r.view.name).toBe('standard')
    expect(r.doc.name).toBe('standard')
  })
  it('refuses an empty preset name rather than resolving an empty document', () => {
    expect(() => resolvePreset('', docs)).toThrow(/E_PRESET_UNSUPPORTED/)
  })
  it('refuses extends: minimal-rl, naming the rule that fired', () => {
    try {
      resolvePreset('x', { ...docs, x: { name: 'x', extends: 'minimal-rl' } })
      expect.unreachable('expected a refusal')
    } catch (e) {
      expect((e as { code: string }).code).toBe('E_PRESET_UNSUPPORTED')
      expect((e as { detail: { rule: string } }).detail.rule).toBe('minimal-rl-not-extendable')
    }
  })
  it('refuses a cycle', () => {
    try {
      resolvePreset('a', { a: { name: 'a', extends: 'b' }, b: { name: 'b', extends: 'a' } })
      expect.unreachable('expected a refusal')
    } catch (e) {
      expect((e as { code: string }).code).toBe('E_PROFILE_CYCLE')
    }
  })
  it('unknown preset name is E_PRESET_UNSUPPORTED', () => {
    expect(() => resolvePreset('nope', docs)).toThrow(/E_PRESET_UNSUPPORTED/)
  })
  it('passes limits through to the view', () => {
    expect(
      resolvePreset('standard', docs, { limits: { 'approval.park': 1 } }).view.approval.onUnavailable,
    ).toBe('park')
    expect(resolvePreset('standard', docs).view.approval.onUnavailable).toBe('deny')
  })
})
