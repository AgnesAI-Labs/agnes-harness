import { readFileSync } from 'node:fs'
import { presetDefaults, readPreset } from '@agnes/core'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { PACKAGE_NAME, parsePreset, presets, TOOLS_CORE, TOOLS_SEARCH, TOOLS_WEB } from '../src/index.js'

const text = readFileSync(new URL('../presets/base.yaml', import.meta.url), 'utf8')
const doc = parse(text) as Record<string, unknown>

/**
 * The keys a base preset has to carry. protocol's `validatePreset` and the document schema behind
 * it do not exist yet, so the shape is checked here directly; every assertion below is one that
 * schema will subsume, and none of them is weaker than "the parser returned an object".
 */
const REQUIRED_KEYS = [
  'name',
  'tools',
  'mcp',
  'skills_roots',
  'compaction',
  'checkpoint',
  'budget',
  'approval',
  'sandbox',
  'loop',
  'repair',
  'verifier',
  'completion_gate',
  'subagent',
  'harness',
  'telemetry',
  'recovery',
  'ext',
  'locale',
]

/**
 * A product package's recipe adds these; the root carries none of them. `extends` is on the list
 * because the root is what everything else extends, so it may not extend anything itself.
 */
const PRODUCT_KEYS = ['model', 'prompt_sections', 'disclosure', 'surfaces', 'extends', 'ext_ui', 'hooks']

const at = (path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined),
      doc,
    )

describe('presets/base.yaml', () => {
  it('is the document the package exports, under the name it declares', () => {
    expect(presets.base).toEqual(doc)
    expect(Object.keys(presets)).toEqual(['base'])
    expect(presets.base?.name).toBe('base')
    expect(PACKAGE_NAME).toBe('@agnes/base')
  })

  it('carries every required key', () => {
    for (const k of REQUIRED_KEYS) expect(doc, k).toHaveProperty(k)
  })

  it('carries no product opinion', () => {
    for (const k of PRODUCT_KEYS) expect(doc, k).not.toHaveProperty(k)
  })

  // Not a restatement of the list above: it is the list against what this package actually ships,
  // so a tool added to the package without being named here, or named here without being shipped,
  // is a failure rather than a preset that offers a tool nobody registers. The preset names one
  // flat `tools.core` list across every bundled extension - read/write/edit/shell/todo from
  // `tools-core`, grep/find/ls from the sibling `tools-search` - so membership is what is checked,
  // not the order either extension happens to register its own tools in.
  it('names exactly the tools this package delivers', () => {
    expect(doc.tools).toHaveProperty('core')
    const shipped = [...TOOLS_CORE, ...TOOLS_SEARCH, ...TOOLS_WEB].map((t) => t.name).sort()
    expect([...(doc.tools as { core: string[] }).core].sort()).toEqual(shipped)
  })
})

/**
 * The document is snake_case and the kernel reads it by exact path, keeping its own default for a
 * key spelled any other way. So a misspelling here is silent, and the only thing that catches it is
 * asserting the paths exist in the document rather than asserting the resolved view - which would
 * report the default and look correct.
 */
describe('every key the kernel reads is spelled the way the kernel spells it', () => {
  const PATHS = [
    'tools.timeout_ms',
    'tools.timeouts',
    'budget.preflight',
    'budget.per_request_cap',
    'budget.on_exceed',
    'budget.max_steps',
    'approval.timeout_ms',
    'approval.on_unavailable',
    'approval.pending_ttl_ms',
    'sandbox.on_unavailable',
    'verifier.timeout_ms',
    'verifier.default_tier',
    'repair.timeout_ms',
    'completion_gate.min_items',
    'compaction.enabled',
    'compaction.reserve_tokens',
    'compaction.keep_recent_tokens',
    'compaction.agent_callable',
    'telemetry.invariants',
    'telemetry.timing',
    'recovery.unknown_child',
    'subagent.max_depth',
    'ext.events_per_turn',
  ]

  it.each(PATHS)('%s is present in the document', (path) => {
    // `per_request_cap` is deliberately null, which is a value and not an absence.
    expect(at(path), path).not.toBeUndefined()
  })

  it('resolves through the kernel reader to the values the document states', () => {
    const view = readPreset(doc, 'base')
    expect(view.name).toBe('base')
    expect(view.budget.maxSteps).toBe(at('budget.max_steps'))
    expect(view.budget.perRequestCap).toBe(null)
    expect(view.approval.pendingTtlMs).toBe(at('approval.pending_ttl_ms'))
    expect(view.compaction.reserveTokens).toBe(at('compaction.reserve_tokens'))
    // The view counts the total depth; the document counts what a subagent may add.
    expect(view.depthLimit).toBe((at('subagent.max_depth') as number) + 1)
  })

  it('distinguishes explicit product policy from values equal to the kernel default', () => {
    const d = presetDefaults()
    const fromDoc = readPreset(doc, 'base')
    const fromNothing = readPreset({}, 'base')
    expect(fromDoc.budget).toEqual(fromNothing.budget)
    expect(fromDoc.approval).toEqual(fromNothing.approval)
    expect(fromDoc.compaction).toEqual(fromNothing.compaction)
    expect(fromDoc.budget).toEqual(d.budget)
    expect(fromDoc.approval).toEqual(d.approval)
    expect(fromDoc.compaction).toEqual(d.compaction)
    // Product default: Base ships worktree isolation. Kernel empty-doc fallback remains shared.
    expect(fromDoc.isolation).toBe('worktree')
    expect(fromNothing.isolation).toBe('shared')
    expect(fromDoc).toEqual({
      ...fromNothing,
      isolation: 'worktree',
      tools: { ...fromNothing.tools, timeouts: { web_fetch: 30000, skill_helper_import: 240000 } },
    })
  })
})

describe('skills_roots ship unexpanded', () => {
  // The tilde is the operator's home and nothing in this package knows whose. Joining one of these
  // onto a path without expanding it creates a directory literally named `~`, which is a failure
  // that works: it reads back correctly from the directory that made it and nowhere else. The
  // strings are pinned here so a consumer landing later cannot quietly start treating them as paths.
  it('are four tilde-rooted strings, and nothing in this package joins them onto anything', () => {
    expect(doc.skills_roots).toEqual([
      '~/.agh/skills',
      '~/.agents/skills',
      '~/.claude/skills',
      '~/.codex/skills',
    ])
    for (const r of doc.skills_roots as string[]) expect(r.startsWith('~/'), r).toBe(true)
  })
})

describe('parsePreset', () => {
  it('refuses a document filed under a name it does not declare', () => {
    expect(() => parsePreset(text, 'standard')).toThrow(/declares name=base/)
  })

  it('refuses a document that is not a mapping', () => {
    expect(() => parsePreset('- a\n- b\n', 'base')).toThrow(/not a mapping/)
    expect(() => parsePreset('null\n', 'base')).toThrow(/not a mapping/)
  })
})
