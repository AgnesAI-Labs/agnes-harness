import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from './repo.js'

const root = repoRoot()
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

/** Extension ids a package declares, derived from its `agnes.extensions` directory list. */
function declaredExtensionIds(pkgJsonRel: string, scope: string): string[] {
  const json = JSON.parse(read(pkgJsonRel)) as { agnes?: { extensions?: string[] } }
  return (json.agnes?.extensions ?? []).map((dir) => `${scope}/${dir.split('/').pop() as string}`)
}

/** Reserved resource row ids, read as text so this guard imports no @agnes package. */
function resourceOwnedIds(): string[] {
  const source = read('packages/plugin-runtime/src/resource-owned.ts')
  return [...source.matchAll(/'(ext:[^']+)'/g)].map((m) => (m[1] as string).slice('ext:'.length))
}

function extRowIds(): string[] {
  const source = read('packages/host/src/assemble/ext-rows.ts')
  const block = /EXT_ROW_EXTENSION_IDS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/.exec(source)
  expect(block, 'EXT_ROW_EXTENSION_IDS must be a literal Set of string literals').toBeTruthy()
  return [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] as string)
}

describe('builtin ext: row id list', () => {
  it('is exactly the declared builtin extensions except the retired MCP client', () => {
    const declared = [
      ...declaredExtensionIds('packages/base/package.json', 'agnes'),
      ...declaredExtensionIds('packages/code/package.json', 'agnes'),
    ]
    const expected = declared.filter((id) => id !== 'agnes/mcp-client').sort()
    expect([...extRowIds()].sort()).toEqual(expected)
  })

  it('reserves the retired MCP client while allowing the Host-owned Skills row', () => {
    const resourceOwned = new Set(resourceOwnedIds())
    expect(resourceOwned.has('agnes/skills')).toBe(true)
    expect(extRowIds()).toContain('agnes/skills')
    expect(extRowIds()).not.toContain('agnes/mcp-client')
  })

  it('the computer-use grant is keyed on the row id, not on the owning package name', () => {
    // Read as text, not imported: tools/guards may not depend on any @agnes package. The narrow
    // literal is the GRANT condition that EXTENSION_ROW_GRANTS replaces; the Computer Use SUPPLY
    // gates elsewhere in the same file legitimately still compare the extension id.
    expect(read('packages/host/src/assemble.ts')).not.toContain(
      "owner === '@agnes/base' && extensionId === 'agnes/computer-use'",
    )
  })
})
