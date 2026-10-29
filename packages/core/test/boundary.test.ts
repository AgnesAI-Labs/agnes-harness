import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Provider } from '@agnes/core'
import { describe, expect, it } from 'vitest'

const src = fileURLToPath(new URL('../src/', import.meta.url))
const files: string[] = []
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (e.endsWith('.ts')) files.push(p)
  }
}
const ownerSrc = (owner: string): string => fileURLToPath(new URL(`../../${owner}/src/`, import.meta.url))
const roots = [src, ...['core-common', 'core-child-control', 'core-ledger', 'core-effects'].map(ownerSrc)]
for (const root of roots) walk(root)

// Value imports are limited to tool-contract helpers, event names, provider errors and public default algorithms.
// Hook registration reuses that builder for source attribution instead of copying its identifier gate.
// The registry reads the description bound from the contract so its post-sanitize check cannot drift.
// Everything else remains type-only; new runtime dependencies require an explicit boundary decision.
const EXT_VALUE_ALLOWED = new Set([
  'TOOL_NAME_PATTERN',
  'TOOL_META_KEYS',
  'TOOL_DESCRIPTION_MAX_LENGTH',
  'checkToolMeta',
  'checkToolDef',
  'resolveToolCallPolicy',
  'extEventType',
  'ProviderError', // shared provider admission failures; Core session opening keeps its compatibility alias
  'createCompactionThreshold', // authority-free default threshold shared with Base
  'mcpStablePrefix', // authority-free MCP namespace binding shared with role delegation
  'defaultToolPolicy', // authority-free default risk decision shared with Base
  'APPROVAL_DEFAULTS', // single public configuration defaults, shared with Core
  'unavailableDecisions', // registration and unconfigured test scopes refuse session access
  'unavailableProjections', // authority-free default; Host supplies the scoped invocation reader
])

function moduleSpecifiers(text: string): string[] {
  return [...text.matchAll(/\b(?:from|import|require)\s*\(?\s*['"`]([^'"`]+)['"`]/g)].map(
    (m) => m[1] as string,
  )
}

/**
 * The specifiers a core source file may not name. Node built-ins are limited to `node:util`, except
 * that `request/sha256-node.ts` may also use `node:crypto`: it is reached only through the `node`
 * condition of the `#sha256` import, and any other host resolves that import to the portable
 * implementation instead. No file names either implementation module directly, which would bypass
 * that selection.
 */
function importViolations(file: string, text: string): string[] {
  const allowed = file.endsWith(`${sep}request${sep}sha256-node.ts`)
    ? ['node:util', 'node:crypto']
    : ['node:util']
  return moduleSpecifiers(text).filter(
    (specifier) =>
      (isBuiltin(specifier) && !allowed.includes(specifier)) ||
      /(^|\/)sha256-(node|portable)(\.[jt]s)?$/.test(specifier),
  )
}

describe('core src boundary', () => {
  it('found source files to scan', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it('imports only @agnes/protocol, plus a named allowlist from @agnes/extension-api', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      expect(importViolations(f, text), f).toEqual([])
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

  it('sees every import form the built-in and digest-selection rules depend on', () => {
    const sample = [
      "import { createHash } from 'node:crypto'",
      "import 'node:crypto'",
      "const lazy = await import('node:crypto')",
      'const legacy = require("crypto")',
      'const spaced = import ( `node:fs` )',
      "export { sha256Hex } from './sha256-node.js'",
      "import './request/sha256-portable.js'",
      "import { inspect } from 'node:util'",
      "import type { Sha256Stream } from './sha256-types.js'",
      "import { jcs } from '@agnes/protocol'",
    ].join('\n')
    const offending = [
      'node:crypto',
      'node:crypto',
      'node:crypto',
      'crypto',
      'node:fs',
      './sha256-node.js',
      './request/sha256-portable.js',
    ]
    expect(importViolations(join(src, 'log', 'sample.ts'), sample)).toEqual(offending)
    // The node implementation may use `node:crypto` in any spelling Node accepts as that module,
    // but not the bare alias, another built-in, or the implementation modules.
    expect(importViolations(join(src, 'request', 'sha256-node.ts'), sample)).toEqual([
      'crypto',
      'node:fs',
      './sha256-node.js',
      './request/sha256-portable.js',
    ])
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
    const surface = await import('@agnes/core')
    expect(Object.keys(surface)).not.toContain('mintFrom')
    expect(Object.keys(surface)).not.toContain('sanitizeJson')
    expect(Object.keys(surface)).toContain('isLedgerRequest')
  })

  it('keeps the one function that spells a register cache key off the root export', async () => {
    const surface = await import('@agnes/core')
    expect(Object.keys(surface)).not.toContain('cacheKey')
    // The cell store itself is reachable inside the package but is not part of what core promises.
    expect(Object.keys(surface)).not.toContain('RegisterMap')
  })

  it('keeps process-global access and single-owner construction sites at their boundaries', () => {
    const owners = (pattern: RegExp) =>
      files
        .filter((file) => pattern.test(readFileSync(file, 'utf8')))
        .map((file) =>
          file
            .slice(fileURLToPath(new URL('../../', import.meta.url)).length)
            .split(sep)
            .join('/'),
        )
        .sort()

    expect(owners(/\.ev\(\s*['"]harness\/refine['"]/)).toEqual(['core/src/refine/apply.ts'])
    expect(owners(/Kernel\.create\(/)).toEqual([])
    expect(owners(/globalThis\.crypto/)).toEqual(['core-common/src/ids.ts'])
    expect(owners(/process\.env/)).toEqual([])
  })
})
