import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TOOLS_CORE } from '../src/index.js'

// The parameter schemas and descriptions are what the model is shown and what a provider hashes
// into the prompt, so a change to any of them is a change to a contract rather than an edit to a
// string. The snapshot on disk is what makes that change appear in a diff.
//
// One half of "byte-identical on every platform" is here: nothing in the model-visible surface may
// name an operating system or a shell, since that is the only way a difference could get in from
// the machine the tools were built on. The other half - actually running this on three platforms
// and comparing the hash - needs a CI matrix that this suite does not add, and is still owed.

const fixture = (name: string): string =>
  readFileSync(new URL(`../../../fixtures/tool-schemas/${name}`, import.meta.url), 'utf8')

describe('tool schema snapshots', () => {
  for (const t of TOOLS_CORE) {
    it(`${t.name} parameters equal fixtures/tool-schemas/${t.name}.json`, () => {
      expect(`${JSON.stringify(t.parameters, null, 2)}\n`).toBe(fixture(`${t.name}.json`))
    })
  }

  it('covers every registered tool and nothing else', () => {
    // A snapshot file for a tool that no longer exists would keep passing on its own, and a tool
    // with no snapshot file would simply not be checked.
    expect(TOOLS_CORE.map((t) => t.name).sort()).toEqual(['read', 'write', 'edit', 'shell', 'todo'].sort())
  })

  it('has a stable combined hash that names no platform', () => {
    const canonical = JSON.stringify(
      TOOLS_CORE.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    )
    expect(canonical).not.toMatch(/darwin|linux|win32|windows|posix|powershell|bash|zsh|cmd\.exe/i)
    expect(`${createHash('sha256').update(canonical).digest('hex')}\n`).toBe(fixture('HASH'))
  })
})
