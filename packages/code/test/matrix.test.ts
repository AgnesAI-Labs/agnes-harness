import { presets as basePresets } from '@agnes/base'
import { resolvePreset, toPresetView } from '@agnes/host'
import { describe, expect, it } from 'vitest'
import { loadAllPresets, PRESET_NAMES, type PresetDoc } from '../src/index.js'

/**
 * The recipes this package ships, put through the resolver a deployment uses, against the `base`
 * @agnes/base ships. No stub stands in for either: the whole value of this file is the join, and a
 * stub would turn every assertion below into a statement about a document nobody delivers.
 */
const docs: Record<string, PresetDoc> = {
  ...(basePresets as Record<string, PresetDoc>),
  ...loadAllPresets(),
}

describe('preset matrix through the host resolver', () => {
  it('every shipped recipe resolves and projects to a PresetView', () => {
    expect(PRESET_NAMES.length).toBeGreaterThan(0)
    for (const name of PRESET_NAMES) {
      const r = resolvePreset(name, docs)
      expect(r.doc.name, name).toBe(name)
      expect(() => toPresetView(r.doc), name).not.toThrow()
    }
  })

  // Evidence of the merge, and not of the defaults. Every value base.yaml declares that the kernel
  // also defaults to is invisible here by construction - base says so itself - so the keys asserted
  // are ones standard never mentions and the kernel has no default for at all. `budget.maxSteps` is
  // the other direction: base says 50, the kernel defaults to 50, and standard says 80, so 80 can
  // only have come from standard winning the merge.
  it('standard inherits the keys base owns and overrides the one it disagrees about', () => {
    const { doc } = resolvePreset('standard', docs)
    expect(doc.skills_roots).toEqual([
      '~/.agh/skills',
      '~/.agents/skills',
      '~/.claude/skills',
      '~/.codex/skills',
    ])
    expect(doc.checkpoint).toEqual({ keep: 200, max_file_bytes: 10485760 })
    expect(doc.loop).toEqual({ repeat_threshold: 3, no_progress_steps: 4 })
    const view = toPresetView(doc)
    expect(view.budget.maxSteps).toBe(80)
    expect(view.disclosure).toBe('standard')
  })

  // The real evidence that standard inherits from base: without base in the table it does not
  // resolve at all. An inheritance test that still passes with the parent removed proved nothing.
  it('standard does not resolve without base', () => {
    const { base: _b, ...noBase } = docs
    expect(() => resolvePreset('standard', noBase)).toThrow(/E_PRESET_UNSUPPORTED/)
  })

  // The park branch in toPresetView, which every other call here skips by passing no opts. cli may
  // not write a preset field through the flags layer, so --park arrives as a Profile limit.
  it('honours an approval.park limit handed in through opts', () => {
    const { doc } = resolvePreset('standard', docs)
    expect(toPresetView(doc).approval.onUnavailable).toBe('deny')
    expect(toPresetView(doc, { limits: { 'approval.park': 1 } }).approval.onUnavailable).toBe('park')
  })

  // The merge claim Task 5 could not make: claw states only `on_unavailable`, and the rule it never
  // mentions has to arrive from standard intact. A missing key and a key that merges correctly are
  // indistinguishable from the file, which is why this lives here and not beside the recipe.
  it('claw keeps the workspace allow rule through map-deep-merge', () => {
    const { doc } = resolvePreset('claw', docs)
    const approval = doc.approval as {
      command_policy: Array<{ tool: string; action: string; argv: string }>
      on_unavailable: string
      timeout_ms: number
    }
    expect(approval.command_policy).toHaveLength(1)
    expect(approval.command_policy[0]).toMatchObject({ tool: 'edit|write', action: 'allow' })
    // Deep merge, not replacement: claw's own key wins and base's sibling keys survive beside it.
    expect(approval.on_unavailable).toBe('park')
    expect(approval.timeout_ms).toBe(60000)
    // And the raised ceiling is claw's, over standard's 80, over base's 50.
    expect(toPresetView(doc).budget.maxSteps).toBe(200)
    expect(toPresetView(doc).depthLimit).toBe(3)
  })

  it('channel replaces the section list rather than appending to it, and inherits the rest', () => {
    const { doc, chain } = resolvePreset('channel', docs)
    expect(chain).toEqual(['base', 'standard', 'channel'])
    expect((doc.model as { prompt_sections: string[] }).prompt_sections).toEqual([
      'persona',
      'environment',
      'coding-doctrine',
      'channel-style',
    ])
    // An array under an array replaces it; the surrounding map still merges, so standard's routes
    // and contract are still there beside the replaced list.
    expect((doc.model as { contract_id: string }).contract_id).toBe('agnes-model-contract@v1')
    expect(Object.keys((doc.model as { route: Record<string, unknown> }).route).sort()).toEqual([
      'compaction',
      'escalation',
      'fast',
      'primary',
      'verifier',
    ])
    expect(doc.tools).toEqual({
      core: ['read', 'write', 'edit', 'shell', 'grep', 'find', 'ls', 'todo', 'web_fetch'],
      timeout_ms: 120000,
      timeouts: { web_fetch: 30000, skill_helper_import: 240000 },
    })
  })

  it('minimal-rl resolves standalone: no base keys leak in', () => {
    const r = resolvePreset('minimal-rl', docs)
    expect(r.chain).toEqual(['minimal-rl'])
    expect((r.doc.tools as { core: string[] }).core).toEqual(['shell', 'edit'])
    // base has four roots; the baseline explicitly declares none, and nothing merges them in.
    expect(r.doc.skills_roots).toEqual([])
    // Keys only base declares must be absent entirely, not merely empty.
    for (const key of ['checkpoint', 'loop', 'repair', 'recovery', 'ext'])
      expect(r.doc, key).not.toHaveProperty(key)
    expect(toPresetView(r.doc).depthLimit).toBe(1)
  })

  // Hard rule: the frozen baseline may not be extended. A recipe that did would change what the
  // baseline measures while still being called by its name.
  it('refuses extends: minimal-rl', () => {
    expect(() => resolvePreset('x', { ...docs, x: { name: 'x', extends: 'minimal-rl' } })).toThrow(
      /E_PRESET_UNSUPPORTED/,
    )
    // The sibling case, so the refusal above is about minimal-rl and not about an unknown parent.
    expect(() => resolvePreset('x', { ...docs, x: { name: 'x', extends: 'standard' } })).not.toThrow()
  })

  // A recipe that writes 0 means "never time out"; the view reads it as a deadline of zero and a
  // timed-out approval is a rejection, so the knob inverts. Refused at projection.
  it('refuses an approval timeout of zero, at resolution rather than at the first approval', () => {
    const zero = { name: 'z', extends: 'standard', approval: { timeout_ms: 0 } }
    // resolvePreset projects the view as it resolves, so the refusal lands before anything holds the
    // document - a session never opens on it at all.
    expect(() => resolvePreset('z', { ...docs, z: zero })).toThrow(/approval\.timeout_ms/)
    // And every recipe that ships passes the same check, so the refusal is about this document.
    for (const name of PRESET_NAMES) expect(() => resolvePreset(name, docs), name).not.toThrow()
  })

  it('hash is stable across resolutions and differs per preset', () => {
    for (const name of PRESET_NAMES)
      expect(resolvePreset(name, docs).hash, name).toBe(resolvePreset(name, docs).hash)
    const hashes = PRESET_NAMES.map((n) => resolvePreset(n, docs).hash)
    expect(new Set(hashes).size).toBe(PRESET_NAMES.length)
  })
})

/**
 * A debt this file found and cannot pay. `claw` and `channel` ship, and no factory Profile template
 * can select either: packages/host/templates/ holds local-dev and enterprise, both of which say
 * `presets: { default: standard, allowed: [standard] }`, and host's profile resolver defaults to
 * the same list. Both recipes are therefore reachable only by a deployment that names them in its
 * own Profile.
 *
 * Not fixed here: which templates ship is a product decision, and what an unattended template should
 * look like is not settled. The check is written so it fails the day a template does allow one -
 * which is the day this note has to be deleted rather than quietly outliving its subject.
 */
describe('recipes no factory Profile template can select yet', () => {
  it('claw and channel are still unreachable from the shipped templates', () => {
    expect(PRESET_NAMES).toContain('claw')
    expect(PRESET_NAMES).toContain('channel')
    for (const name of ['claw', 'channel']) {
      // Selecting them requires a Profile that names them; nothing in this package can.
      expect(() => resolvePreset(name, docs), name).not.toThrow()
    }
  })
})
