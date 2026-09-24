import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { readTool } from '../extensions/tools-core/src/tools/read.js'
import { expectManifestMatchesCode, expectToolMetaComplete, usedCapabilities } from './assertions.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** One extension on disk: a manifest, and whatever source files the case is about. */
function extension(capabilities: unknown, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-ext-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'agnes.extension.json'),
    JSON.stringify({
      id: 'agnes/x',
      version: '0.1.0',
      apiRange: '^1.0',
      entry: './src/index.ts',
      capabilities,
    }),
  )
  for (const [name, text] of Object.entries(files)) {
    const file = join(dir, 'src', name)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text)
  }
  return dir
}

const NOTHING = { hooks: [], slots: [], events: false, resources: [], network: [] }

describe('expectToolMetaComplete', () => {
  it('accepts a delivered tool', () => {
    expect(() => expectToolMetaComplete(readTool)).not.toThrow()
  })

  // The negative is the whole assertion: one that has only ever been called on a complete
  // definition proves nothing about its ability to find an incomplete one.
  it('names the missing meta keys rather than passing', () => {
    const half = { ...readTool, meta: { ...readTool.meta, replay: undefined } } as unknown as typeof readTool
    expect(() => expectToolMetaComplete(half)).toThrow(/read:.*replay/)
  })

  it('refuses a name that does not carry the prefix it was registered under', () => {
    expect(() => expectToolMetaComplete(readTool, { prefix: 'x_' })).toThrow(/prefix/)
  })
})

describe('usedCapabilities reads call sites, not every word in the file', () => {
  it('finds the five tools tools-core defines, and no hooks or slots', () => {
    const used = usedCapabilities(fileURLToPath(new URL('../extensions/tools-core/src', import.meta.url)))
    expect([...used.tools].sort()).toEqual(['edit', 'read', 'shell', 'todo', 'write'])
    expect([...used.hooks]).toEqual([])
    expect([...used.slots]).toEqual([])
  })

  it('finds the three tools tools-search defines, and no hooks or slots', () => {
    const used = usedCapabilities(fileURLToPath(new URL('../extensions/tools-search/src', import.meta.url)))
    expect([...used.tools].sort()).toEqual(['find', 'grep', 'ls'])
    expect([...used.hooks]).toEqual([])
    expect([...used.slots]).toEqual([])
  })

  // `kind` and `name` are ordinary words. A whole-file scan for them credited an extension with
  // capabilities it never asked for - tools-core alone writes `kind: 'file'` for directory entries
  // and `name:` in schemas - which is a manifest check that reports authority nobody requested.
  it('ignores kind and name outside a registerResource / defineTool call', () => {
    // The decoys come first in the file and the real calls after, so a scan that reads from the top
    // of the file rather than from the call site picks the decoy up instead: `mcp` for the resource
    // and `x_two` for the tool, neither of which this manifest declares.
    const dir = extension(
      { ...NOTHING, resources: ['skill'], tools: { prefix: 'x_', names: ['x_one'] } },
      {
        'index.ts': [
          `const decoyEntry = { kind: 'mcp' }`,
          `const decoyField = { name: 'x_two' }`,
          `agnes.registerResource({ kind: 'skill', id: 'a' })`,
          `export const t = defineTool({\n  name: 'x_one',\n})`,
          `export default [decoyEntry, decoyField]`,
        ].join('\n'),
      },
    )
    const used = usedCapabilities(join(dir, 'src'))
    expect([...used.tools]).toEqual(['x_one'])
    expect([...used.resources]).toEqual(['skill'])
    expect(() => expectManifestMatchesCode(dir)).not.toThrow()
  })

  it('finds nothing in a file that makes no registration call at all', () => {
    const dir = extension(NOTHING, {
      'index.ts': `const entry = { name: 'not_a_tool', kind: 'skill' }\nexport default entry\n`,
    })
    const used = usedCapabilities(join(dir, 'src'))
    expect([...used.tools]).toEqual([])
    expect([...used.resources]).toEqual([])
  })

  it('does not read test files as source', () => {
    const dir = extension(NOTHING, { 'a.test.ts': `agnes.registerHook('tool_call', () => {})\n` })
    expect([...usedCapabilities(join(dir, 'src')).hooks]).toEqual([])
  })
})

describe('expectManifestMatchesCode', () => {
  it('accepts every extension this package bundles', () => {
    for (const name of ['tools-core', 'tools-search', 'principals-local', 'artifacts-local'])
      expect(() =>
        expectManifestMatchesCode(fileURLToPath(new URL(`../extensions/${name}`, import.meta.url))),
      ).not.toThrow()
  })

  it('reports a hook the code registers and the manifest does not grant', () => {
    const dir = extension(NOTHING, { 'index.ts': `agnes.registerHook('tool_call', () => {})\n` })
    expect(() => expectManifestMatchesCode(dir)).toThrow(/hook used but not declared: tool_call/)
  })

  it('reports a hook the manifest grants and nothing registers', () => {
    const dir = extension({ ...NOTHING, hooks: ['session_start'] }, { 'index.ts': 'export default 1\n' })
    expect(() => expectManifestMatchesCode(dir)).toThrow(/hook declared but unused: session_start/)
  })

  it('reports a slot in each direction', () => {
    const used = extension(NOTHING, { 'index.ts': `agnes.registerSlot('chat.footer', () => null)\n` })
    expect(() => expectManifestMatchesCode(used)).toThrow(/slot used but not declared: chat.footer/)
    const idle = extension({ ...NOTHING, slots: ['chat.footer'] }, { 'index.ts': 'export default 1\n' })
    expect(() => expectManifestMatchesCode(idle)).toThrow(/slot declared but unused: chat.footer/)
  })

  it('reports a resource kind in each direction', () => {
    const used = extension(NOTHING, { 'index.ts': `agnes.registerResource({ kind: 'skill', id: 'a' })\n` })
    expect(() => expectManifestMatchesCode(used)).toThrow(/resource used but not declared: skill/)
    const idle = extension({ ...NOTHING, resources: ['mcp'] }, { 'index.ts': 'export default 1\n' })
    expect(() => expectManifestMatchesCode(idle)).toThrow(/resource declared but unused: mcp/)
  })

  // A kind computed at run time cannot be compared with a static declaration. Passing such a call
  // silently would make the check strongest on the extensions that need it least.
  it('refuses a registerResource whose kind is not a literal instead of skipping it', () => {
    const dir = extension(NOTHING, { 'index.ts': `agnes.registerResource({ kind: k, id: 'a' })\n` })
    expect(() => expectManifestMatchesCode(dir)).toThrow(/no literal kind/)
  })

  it('reports events.append against a manifest that does not grant events', () => {
    const dir = extension(NOTHING, { 'index.ts': `await agnes.events.append('x', {})\n` })
    expect(() => expectManifestMatchesCode(dir)).toThrow(/events\.append used but capabilities\.events/)
  })

  // One direction only: a granted event the code has not started emitting yet is not a defect, and
  // tools-core ships exactly that.
  it('accepts a granted events capability that nothing uses yet', () => {
    const dir = extension({ ...NOTHING, events: true }, { 'index.ts': 'export default 1\n' })
    expect(() => expectManifestMatchesCode(dir)).not.toThrow()
  })

  it('reports a tool defined outside the closed set the manifest names', () => {
    const dir = extension(
      { ...NOTHING, tools: { prefix: '', names: ['read'] } },
      { 'a.ts': `export const t = defineTool({\n  name: 'write',\n})\n` },
    )
    expect(() => expectManifestMatchesCode(dir)).toThrow(/tool defined but not declared: write/)
  })

  it('reports a tool that does not carry the declared prefix', () => {
    const dir = extension(
      { ...NOTHING, tools: { prefix: 'x_' } },
      { 'a.ts': `export const t = defineTool({\n  name: 'write',\n})\n` },
    )
    expect(() => expectManifestMatchesCode(dir)).toThrow(/does not carry the declared prefix x_/)
  })

  // An absent `names` is a prefix-bounded open set, which the host reads the same way.
  it('accepts any prefixed name when the manifest names no closed set', () => {
    const dir = extension(
      { ...NOTHING, tools: { prefix: 'x_' } },
      { 'a.ts': `export const t = defineTool({\n  name: 'x_anything',\n})\n` },
    )
    expect(() => expectManifestMatchesCode(dir)).not.toThrow()
  })

  // Registering fewer names than the manifest allows is the safe direction: a name nobody
  // registers is a name nobody can call.
  it('accepts a declared tool name that nothing defines yet', () => {
    const dir = extension(
      { ...NOTHING, tools: { prefix: '', names: ['read', 'write'] } },
      {
        'a.ts': `export const t = defineTool({\n  name: 'read',\n})\n`,
      },
    )
    expect(() => expectManifestMatchesCode(dir)).not.toThrow()
  })
})
