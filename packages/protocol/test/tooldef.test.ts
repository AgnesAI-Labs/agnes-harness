import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateToolDef } from '../src/index.js'
import { type Fixture, runFixtureLine } from '../tools/conformance-core.js'

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
const def = {
  name: 'read',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  meta,
}

describe('tooldef', () => {
  it('accepts the base read tool', () => {
    const r = validateToolDef(def)
    expect(r.ok, r.ok ? '' : JSON.stringify(r.errors)).toBe(true)
    expect(
      validateToolDef({
        ...def,
        meta: {
          ...meta,
          presentation: {
            title: 'Read document',
            description: 'Inspect the selected document',
            summary: 'Review requested source',
          },
        },
      }).ok,
    ).toBe(true)
    expect(
      validateToolDef({ ...def, meta: { ...meta, presentation: { title: '', description: 'Read' } } }).ok,
    ).toBe(false)
  })
  it('rejects meta missing a required execution flag', () => {
    const { isConcurrencySafe: _flag, ...missingFlag } = meta
    const r = validateToolDef({ ...def, meta: missingFlag })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toMatchObject({ code: 'MISSING', key: 'isConcurrencySafe' })
  })
  // Two different rejection reasons. Asserting only `.ok` would let either one quietly start
  // failing for the other's reason.
  it('rejects a bad tool name and open parameters', () => {
    const name = validateToolDef({ ...def, name: 'sales-analysis' })
    expect(name.ok).toBe(false)
    if (!name.ok) expect(name.errors[0]).toMatchObject({ code: 'PATTERN', path: '/name' })
    const open = validateToolDef({
      ...def,
      parameters: { ...def.parameters, additionalProperties: true },
    })
    expect(open.ok).toBe(false)
    if (!open.ok) expect(open.errors[0]).toMatchObject({ path: '/parameters/additionalProperties' })
  })
  // The three keys whose "no declaration" value is null on the wire. All three are walked: nothing
  // else in the repo proves the wire form of an undeclared key validates.
  it('accepts null in all three declarable-absent keys', () => {
    const r = validateToolDef({
      ...def,
      meta: { ...meta, costHint: null, deferLoading: null, requiresApproval: null },
    })
    expect(r.ok, r.ok ? '' : JSON.stringify(r.errors)).toBe(true)
  })
  // Optional declarations may be omitted or null on the wire; required execution flags may not.
  it('accepts omitted or null optional metadata while preserving required execution flags', () => {
    const inProcess = { ...meta, costHint: undefined, deferLoading: undefined, requiresApproval: undefined }
    const naive = JSON.parse(JSON.stringify({ ...def, meta: inProcess }))
    expect(validateToolDef(naive).ok).toBe(true)
    expect(naive.meta).not.toHaveProperty('costHint')
    expect(naive.meta).not.toHaveProperty('deferLoading')
    expect(naive.meta).not.toHaveProperty('requiresApproval')
    expect(naive.meta).toMatchObject({
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe',
    })
    const mapped = {
      ...def,
      meta: { ...inProcess, costHint: null, deferLoading: null, requiresApproval: null },
    }
    expect(validateToolDef(mapped).ok).toBe(true)
  })
  it('rejects execute leaking into the schema half', () => {
    const r = validateToolDef({ ...def, execute: 'fn' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toMatchObject({ code: 'UNKNOWN_KEY', key: 'execute' })
  })
  // The schema accepts null without inserting a default; discovery owns its runtime meaning.
  it('deferLoading null is accepted and is not yet a default of any kind', () => {
    expect(validateToolDef({ ...def, meta: { ...meta, deferLoading: null } }).ok).toBe(true)
    const doc = JSON.parse(readFileSync(new URL('../schema/tooldef.json', import.meta.url), 'utf8')) as {
      $defs: { ToolMeta: { properties: { deferLoading: Record<string, unknown> } } }
    }
    expect(doc.$defs.ToolMeta.properties.deferLoading).not.toHaveProperty('default')
  })
  it('the checked-in tooldef fixtures agree with the validator', () => {
    const lines = readFileSync(new URL('../fixtures/tooldef/tooldef.jsonl', import.meta.url), 'utf8')
      .split('\n')
      .filter(Boolean)
    expect(lines.length).toBe(3)
    for (const line of lines) {
      const f = JSON.parse(line) as Fixture
      expect(runFixtureLine(f).pass, f.id).toBe(true)
    }
  })
})
