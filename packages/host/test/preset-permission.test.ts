import { readdirSync, readFileSync } from 'node:fs'
import { resolvePreset } from '@agnes/host-common/presets/resolve'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import { validatePreset } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const dirs = ['../../base/presets/', '../../code/presets/'].map((p) => new URL(p, import.meta.url))
const docs: Record<string, PresetDoc> = Object.fromEntries(
  dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.yaml'))
      .map((name) => {
        const doc = parse(readFileSync(new URL(name, dir), 'utf8')) as PresetDoc
        return [doc.name, doc] as const
      }),
  ),
)
/** Merged documents of every recipe captured on the code before the permission split. */
const golden = JSON.parse(
  readFileSync(new URL('./fixtures/preset-legacy-merged.json', import.meta.url), 'utf8'),
) as Record<string, { hash: string; doc: PresetDoc }>

/** An explicit default policy and an absent policy select the same provider. */
const withoutDefaultPolicy = (doc: PresetDoc): PresetDoc => {
  const copy = structuredClone(doc) as PresetDoc & { providers?: Record<string, { provider?: string }> }
  if (copy.providers?.['tool-policy']?.provider === 'default') {
    delete copy.providers['tool-policy']
    if (Object.keys(copy.providers).length === 0) delete copy.providers
  }
  return copy
}

describe('permission overlays preserve real recipe documents', () => {
  const names = Object.keys(golden).filter((name) => name !== 'base')

  it.each(names)('%s preserves the legacy document except for explicit product revisions', (name) => {
    const resolved = resolvePreset(name, docs)
    const expected = golden[name]!.doc
    // minimal sat on L0 with allow; it now takes the permission's L1. That is the one intended change.
    const intended =
      name === 'minimal' ? { sandbox: { level: 'L1', on_unavailable: 'allow-if-unimplemented' } } : {}
    const want = withoutDefaultPolicy(expected) as Record<string, unknown>
    const got = withoutDefaultPolicy(resolved.doc) as Record<string, unknown>
    if (name !== 'minimal-rl') {
      // Compaction now follows primary; tool discovery is a prompt section and UI has a guide.
      // Transform only these reviewed fields, then compare the complete document as before.
      const model = want.model as { route: Record<string, unknown>; prompt_sections: string[] }
      expect(model.route.compaction).toEqual({ route: 'default', model: 'default' })
      delete model.route.compaction
      const environment = model.prompt_sections.indexOf('environment')
      expect(environment).toBeGreaterThanOrEqual(0)
      model.prompt_sections.splice(environment + 1, 0, 'tools-available')
      const core = (want.tools as { core: string[] }).core
      const ask = core.indexOf('ask_user_question')
      if (ask >= 0) core.splice(ask + 1, 0, 'ui_guide')
    }
    if (name === 'minimal') {
      // The tool allowlist moved from a composition entry to the preset's own `tools.allow`.
      expect(got.tools).toMatchObject({ allow: ['read', 'grep', 'find', 'ls'] })
      delete (got.tools as Record<string, unknown>).allow
      delete want.composition
      expect(got.sandbox).toMatchObject(intended.sandbox as object)
      delete got.sandbox
      delete want.sandbox
      // minimal inherits base (no command table) and now takes the permission's.
      delete got.approval
      delete want.approval
      delete got.subagent
      delete want.subagent
    }
    expect(got).toEqual(want)
  })

  it('keeps the frozen baseline untouched and permission-less', () => {
    const resolved = resolvePreset('minimal-rl', docs)
    expect(resolved.hash).toBe(golden['minimal-rl']!.hash)
    expect(resolved.permission).toBeUndefined()
  })
})

describe('resolving a recipe under a chosen permission', () => {
  it('layers the overlay after the recipe and reports the permission', () => {
    const ptc = resolvePreset('ptc', docs, { permission: 'read-only' })
    expect(ptc.permission).toBe('read-only')
    expect(ptc.view.permission).toBe('read-only')
    expect((ptc.doc.providers as { 'tool-policy': { provider: string } })['tool-policy'].provider).toBe(
      'read-only',
    )
    expect(ptc.doc.disclosure).toBe('code')
    expect(validatePreset(ptc.doc)).toMatchObject({ ok: true })
  })

  it('gives the same permission fields to every recipe, whatever it extends', () => {
    for (const permission of ['read-only', 'workspace-write', 'full-access'] as const) {
      const fields = ['standard', 'ptc', 'channel', 'minimal'].map((name) => {
        const doc = resolvePreset(name, docs, { permission }).doc as Record<string, Record<string, unknown>>
        return {
          policy: doc.providers?.['tool-policy'],
          commands: doc.approval?.command_policy,
          level: doc.sandbox?.level,
          unavailable: doc.sandbox?.on_unavailable,
          isolation: doc.subagent?.isolation,
        }
      })
      for (const one of fields) expect(one).toEqual(fields[0])
    }
  })

  it('is deterministic about which document it hashes', () => {
    expect(resolvePreset('ptc', docs, { permission: 'read-only' }).hash).not.toBe(
      resolvePreset('ptc', docs, { permission: 'workspace-write' }).hash,
    )
    expect(resolvePreset('ptc', docs).hash).toBe(
      resolvePreset('ptc', docs, { permission: 'workspace-write' }).hash,
    )
  })

  it.each(['read-only', 'workspace-write', 'full-access'] as const)(
    'refuses the retired %s recipe alias',
    (name) => {
      expect(() => resolvePreset(name, docs)).toThrow(/Retired.*clean home/)
      expect(() => resolvePreset(name, docs, { permission: name })).toThrow(/Retired.*clean home/)
    },
  )

  it('refuses a level for a recipe that carries its own table', () => {
    expect(() => resolvePreset('standard-windows', docs, { permission: 'read-only' })).toThrow(
      'carries its own permission settings',
    )
    expect(resolvePreset('standard-windows', docs).permission).toBeUndefined()
  })

  it('never lets an overlay lower a required sandbox to L0', () => {
    expect(() => resolvePreset('claw', docs, { permission: 'full-access' })).toThrow('requires sandbox')
    expect(resolvePreset('claw', docs, { permission: 'read-only' }).doc.sandbox).toMatchObject({
      required: true,
      level: 'L1',
    })
  })

  it('does not let a permission overlay be opened as a session recipe', () => {
    expect(() => resolvePreset('permission-read-only', docs)).toThrow('not a preset')
  })

  it('refuses an overlay that writes outside the permission axis', () => {
    const bad = {
      ...docs,
      'permission-read-only': { ...docs['permission-read-only']!, sandbox: { required: false } },
    }
    expect(() => resolvePreset('standard', bad, { permission: 'read-only' })).toThrow('sandbox.required')
  })
})

describe('a recipe that names its own tool policy provider', () => {
  const strict: PresetDoc = {
    name: 'strict',
    extends: 'standard',
    providers: { 'tool-policy': { provider: 'acme.strict' } },
  }
  it('keeps it, and takes no level on top of it', () => {
    const catalogue = { ...docs, strict }
    const resolved = resolvePreset('strict', catalogue)
    expect((resolved.doc.providers as { 'tool-policy': { provider: string } })['tool-policy'].provider).toBe(
      'acme.strict',
    )
    expect(resolved.permission).toBeUndefined()
    expect(() => resolvePreset('strict', catalogue, { permission: 'full-access' })).toThrow(
      'carries its own permission settings',
    )
  })
  it('is not mistaken for a profile that selects one policy provider for every document', () => {
    const selected = Object.fromEntries(
      Object.entries(docs).map(([name, doc]) => [
        name,
        {
          ...doc,
          providers: { ...(doc.providers as object), 'tool-policy': { provider: 'acme.deployment' } },
        },
      ]),
    )
    const resolved = resolvePreset('ptc', selected, { permission: 'read-only' })
    expect(resolved.permission).toBe('read-only')
    expect((resolved.doc.providers as { 'tool-policy': { provider: string } })['tool-policy'].provider).toBe(
      'acme.deployment',
    )
  })
})
