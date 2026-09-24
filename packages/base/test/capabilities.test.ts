import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { expectManifestMatchesCode, usedCapabilities } from '../testkit/assertions.js'

/**
 * Every extension this package bundles, checked against its own manifest.
 *
 * The manifest is the grant: the host reads it before running the entry and refuses a registration
 * it does not cover. So a capability declared and never used is authority nobody needs and nobody
 * reviews, and one used and never declared is a piece that stops working the first time the host
 * enforces the list. Neither shows up in the extension's own tests, which run the code directly.
 */
const extensionsDir = fileURLToPath(new URL('../extensions', import.meta.url))
const names = readdirSync(extensionsDir)
  .filter((e) => statSync(join(extensionsDir, e)).isDirectory())
  .sort()

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  agnes?: { extensions?: string[] }
}
const loaded = new Set((pkg.agnes?.extensions ?? []).map((p) => p.replace(/^\.\/extensions\//, '')))

describe('bundled extensions declare what they use', () => {
  // A walk that found nothing would report every extension healthy.
  it('found the extensions on disk', () => {
    expect(names.length).toBeGreaterThanOrEqual(4)
    expect(names).toContain('tools-core')
  })

  it.each(names)('%s: manifest matches its source', (name) => {
    expectManifestMatchesCode(join(extensionsDir, name))
  })

  it.each(names)('%s: the manifest names itself and points at a file that exists', (name) => {
    const dir = join(extensionsDir, name)
    const m = JSON.parse(readFileSync(join(dir, 'agnes.extension.json'), 'utf8')) as {
      id: string
      entry: string
    }
    expect(m.id).toBe(`agnes/${name}`)
    expect(existsSync(join(dir, m.entry)), m.entry).toBe(true)
  })

  /**
   * The package.json list is what the host reads off disk; a directory missing from it is never
   * loaded, so nothing it declares can ever take effect. That is fine for a piece that is only a
   * seam implementation - the host reaches those through the package's named `seams` export - but
   * it must then declare no registrations at all, or the manifest is describing something that
   * cannot happen.
   */
  it.each(names)('%s: a piece the host never loads registers nothing', (name) => {
    if (loaded.has(name)) return
    const caps = (
      JSON.parse(readFileSync(join(extensionsDir, name, 'agnes.extension.json'), 'utf8')) as {
        capabilities?: {
          tools?: { names?: string[] }
          hooks?: string[]
          slots?: string[]
          resources?: string[]
        }
      }
    ).capabilities
    // P0 driver-lock/supply-chain gate: the wrapper is statically reviewable, but production assembly must
    // remain unable to expose it until Host can inject the attested per-session backend. Keep this exception
    // exact so no other unloaded extension can claim dormant authority.
    if (name === 'computer-use') {
      expect(caps?.tools?.names).toEqual(['computer_use'])
      expect(caps?.hooks ?? []).toEqual(['compact'])
      expect(caps?.slots ?? []).toEqual([])
      expect(caps?.resources ?? []).toEqual([])
      const used = usedCapabilities(join(extensionsDir, name, 'src'))
      expect([...used.tools]).toEqual(['computer_use'])
      expect([...used.hooks]).toEqual(['compact'])
      expect([...used.slots, ...used.resources]).toEqual([])
      expect(loaded.has(name)).toBe(false)
      return
    }
    expect(caps?.tools?.names ?? [], `${name} declares tools but is not in agnes.extensions`).toEqual([])
    expect(caps?.hooks ?? []).toEqual([])
    expect(caps?.slots ?? []).toEqual([])
    expect(caps?.resources ?? []).toEqual([])
    // And its source registers nothing either, which is the half a manifest cannot promise.
    const used = usedCapabilities(join(extensionsDir, name, 'src'))
    expect([...used.tools, ...used.hooks, ...used.slots, ...used.resources]).toEqual([])
  })

  it('every name in agnes.extensions is a directory that exists', () => {
    for (const name of loaded) expect(names, name).toContain(name)
  })
})
