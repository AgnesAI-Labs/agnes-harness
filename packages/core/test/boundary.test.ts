import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Provider } from '../src/index.js'

const src = fileURLToPath(new URL('../src/', import.meta.url))
const files: string[] = []
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (e.endsWith('.ts')) files.push(p)
  }
}
walk(src)

// Value imports are limited to the four tool-contract helpers and the extension event-name builder.
// Hook registration reuses that builder for source attribution instead of copying its identifier gate.
// Everything else remains type-only; new runtime dependencies require an explicit boundary decision.
const EXT_VALUE_ALLOWED = new Set([
  'TOOL_NAME_PATTERN',
  'TOOL_META_KEYS',
  'checkToolMeta',
  'checkToolDef',
  'resolveToolCallPolicy',
  'extEventType',
  'unavailableProjections', // authority-free default; Host supplies the scoped invocation reader
])

describe('core src boundary', () => {
  it('found source files to scan', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it('imports only @agnes/protocol, plus a named allowlist from @agnes/extension-api', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      const nodeImports = [...text.matchAll(/from ['"](node:[^'"]+)['"]/g)].map((match) => match[1])
      expect(nodeImports, f).toEqual(nodeImports.filter((specifier) => specifier === 'node:util'))
      expect(text, f).not.toMatch(/from ['"]@agnes\/(ai|host|base|code|daemon|sdk|cli|channels|bridges)/)
      for (const m of text.matchAll(
        /(?<!type )import\s*\{([^}]*)\}\s*from ['"]@agnes\/extension-api[^'"]*['"]/g,
      )) {
        for (const raw of (m[1] as string).split(',')) {
          const spec = raw.trim()
          if (spec === '') continue
          if (spec.startsWith('type ')) continue
          const name = (spec.split(/\s+as\s+/)[0] as string).trim()
          expect(EXT_VALUE_ALLOWED.has(name), `${f}: value import ${name} from @agnes/extension-api`).toBe(
            true,
          )
        }
      }
      expect(text, f).not.toMatch(/pi-ai/)
      expect(text, f).not.toMatch(/process\.platform|os\.platform\(\)/)
      // Control characters are written as escapes, never as themselves. The register-key separator
      // is a NUL: as a literal it is an invisible gap a reader cannot tell from a typo, and it does
      // not survive copying the file around.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: finding one is the point of the check
      expect(text, f).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/)
    }
  })

  it('re-exports the model seam so a caller does not reach past core for it', () => {
    // Type-only, so there is nothing on the runtime surface to enumerate: the assertion is that this
    // shape is assignable to what core promises, which fails to compile if the re-export is missing.
    const fake = {
      infer: () => (async function* () {})(),
      models: () => [],
    } satisfies Provider
    expect(fake.models()).toEqual([])
  })

  it('keeps the single request construction point inside src/request', () => {
    // A second construction site would make the brand meaningless: whatever it marked would no
    // longer be "went through derivation" but "was cast somewhere".
    const casts = files.flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/as LedgerRequest/g)].map(() => f),
    )
    expect(casts).toHaveLength(1)
    expect(casts[0]?.split(sep).join('/')).toMatch(/src\/request\/mint\.ts$/)
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      if (/\bmintFrom\b/.test(text))
        expect(f.split(sep).join('/'), `${f} imports the minting function`).toMatch(/src\/request\//)
      // LedgerRequest's private brand remains owned by mint.ts. Other capability types may carry
      // their own unrelated private symbols without creating another LedgerRequest construction site.
      if (/export type LedgerRequest[^\n]*\[brand\]/.test(text))
        expect(f.split(sep).join('/')).toMatch(/src\/request\/mint\.ts$/)
    }
  })

  it('keeps the minting function and the unbranded body off the root export', async () => {
    const surface = await import('../src/index.js')
    expect(Object.keys(surface)).not.toContain('mintFrom')
    expect(Object.keys(surface)).not.toContain('sanitizeJson')
    expect(Object.keys(surface)).toContain('isLedgerRequest')
  })

  it('keeps the one function that spells a register cache key off the root export', async () => {
    const surface = await import('../src/index.js')
    expect(Object.keys(surface)).not.toContain('cacheKey')
    // The cell store itself is reachable inside the package but is not part of what core promises.
    expect(Object.keys(surface)).not.toContain('RegisterMap')
  })

  it('keeps process-global access and single-owner construction sites at their boundaries', () => {
    const owners = (pattern: RegExp) =>
      files
        .filter((file) => pattern.test(readFileSync(file, 'utf8')))
        .map((file) => file.slice(src.length).split(sep).join('/'))
        .sort()

    expect(owners(/\.ev\(\s*['"]harness\/refine['"]/)).toEqual(['refine/apply.ts'])
    expect(owners(/Kernel\.create\(/)).toEqual([])
    expect(owners(/globalThis\.crypto/)).toEqual(['ids.ts'])
    expect(owners(/process\.env/)).toEqual([])
  })
})
