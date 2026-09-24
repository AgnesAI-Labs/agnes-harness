import { readdirSync, readFileSync } from 'node:fs'
import { validatePreset } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { resolvePreset } from '../src/presets/resolve.js'
import type { PresetDoc } from '../src/presets/types.js'

const dirs = ['../../base/presets/', '../../code/presets/'].map((p) => new URL(p, import.meta.url))
const docs = Object.fromEntries(
  dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.yaml'))
      .map((name) => {
        const doc = parse(readFileSync(new URL(name, dir), 'utf8')) as PresetDoc
        return [doc.name, doc] as const
      }),
  ),
)

describe('delivered preset schema conformance', () => {
  it('includes all six delivered recipes and validates exact YAML and merged documents', () => {
    expect(Object.keys(docs).sort()).toEqual([
      'base',
      'channel',
      'claw',
      'minimal-rl',
      'standard',
      'standard-windows',
    ])
    for (const [name, doc] of Object.entries(docs)) {
      const before = JSON.stringify(doc)
      expect(validatePreset(doc), `${name}: raw YAML`).toMatchObject({ ok: true })
      expect(validatePreset(resolvePreset(name, docs).doc), `${name}: merged`).toMatchObject({ ok: true })
      expect(JSON.stringify(doc), `${name}: validation must not fill defaults`).toBe(before)
    }
  })
})

// This follows the default assembly and session entry points; direct validatePreset alone would
// stay green if production forgot to call the validator or supplied a different default document.
describe('shipped presets through host assembly and session creation', () => {
  it.each(Object.keys(docs))(
    '%s opens from its exact shipped YAML through the real resolver',
    async (name) => {
      const { mkdtempSync, rmSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const { createTestHost } = await import('../testkit/index.js')
      const dataDir = mkdtempSync(join(tmpdir(), 'agnes-preset-schema-'))
      const { base, ...product } = docs
      if (!base) throw new Error('missing base recipe')
      const { host } = await createTestHost({
        dataDir,
        allowed: Object.keys(docs),
        packages: { '@agnes/base': { presets: { base } }, '@agnes/code': { presets: product } },
      })
      try {
        const session = await host.createSession({
          cwd: dataDir,
          ...(name === 'standard' ? {} : { preset: name }),
        })
        const start = (await session.scan({ type: 'session/start', limit: 1 }))[0]
        expect(start?.data).toMatchObject({
          preset: name,
        })
        expect(session.preset.name).toBe(name)
        const resolved = resolvePreset(name, docs).view
        expect(session.preset.compaction).toEqual(resolved.compaction)
        expect(session.preset.budget).toEqual(resolved.budget)
      } finally {
        await host.close()
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  )
  it('the default assembly refuses an unknown nested field before a session can open', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createTestHost } = await import('../testkit/index.js')
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-preset-reject-'))
    try {
      await expect(
        createTestHost({
          dataDir,
          presets: { standard: { name: 'standard', extends: 'base', tools: { unknown: true } } },
        }),
      ).rejects.toMatchObject({
        code: 'E_PRESET_UNSUPPORTED',
        detail: { errors: [{ path: '/tools/unknown', code: 'UNKNOWN_KEY' }] },
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
