import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = fileURLToPath(new URL('../src/', import.meta.url))
const files: string[] = []
const walk = (d: string): void => {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (e.endsWith('.ts')) files.push(p)
  }
}
const ownerSrc = (owner: string): string => fileURLToPath(new URL(`../../${owner}/src/`, import.meta.url))
const owners = [
  'host-common',
  'host-infrastructure',
  'host-computer-use',
  'host-artifacts',
  'host-extensions',
  'host-providers',
]
const roots = [src, ...owners.map(ownerSrc)]
const modulePath = (file: string): string => {
  const root = roots.find((root) => file.startsWith(root))!
  const owner = root === src ? 'host' : owners[roots.indexOf(root) - 1]
  return `${owner}/${file.slice(root.length).replaceAll('\\', '/')}`
}
for (const root of roots) walk(root)
files.sort((a, b) => modulePath(a).localeCompare(modulePath(b)))
const read = (f: string): string => readFileSync(f, 'utf8')
// This existing function normalizes Skill names and user prose, never filesystem paths.
// Only its exact reviewed body is exempt; other calls in the same file remain forbidden.
const skillNormalizer = String.raw`function normalized(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
}`
const installNameNormalizer = "item.name.trim().normalize('NFKC').toLowerCase()"
const pathGuardInput = (file: string, text: string): string => {
  const source = text.replaceAll('\r\n', '\n')
  if (file === join(ownerSrc('host-extensions'), 'resources', 'skill-install-content.ts'))
    return source.replace(installNameNormalizer, '')
  return file === join(ownerSrc('host-extensions'), 'resources', 'skill-preload.ts')
    ? source.replace(skillNormalizer, '')
    : source
}

describe('host boundaries', () => {
  it('found the source tree it is asserting about', () => {
    // Without this every assertion below passes vacuously if the walk ever comes back empty.
    expect(files.length).toBeGreaterThan(15)
  })
  it('never imports a Package (base / code / enterprise / connectors) statically', () => {
    for (const f of files)
      expect(read(f), f).not.toMatch(/from ['"]@agnes\/(base|code|enterprise|connector-[a-z]+)/)
  })
  it('imports only from the approved packages, including the shared system leaf', () => {
    for (const f of files)
      for (const [, pkg] of read(f).matchAll(/from ['"](@agnes\/[a-z-]+)/g))
        expect(
          [
            '@agnes/protocol',
            '@agnes/protocol-validation',
            '@agnes/extension-api',
            '@agnes/git-worktree-contract',
            '@agnes/intelligent-ui-contract',
            '@agnes/cordis',
            '@agnes/core',
            '@agnes/core-ledger',
            '@agnes/ai',
            '@agnes/model-adapters',
            '@agnes/observability',
            '@agnes/history-index',
            '@agnes/package-manager',
            '@agnes/distribution',
            '@agnes/plugin-runtime',
            '@agnes/resource-control-runtime',
            '@agnes/sandbox-remote',
            '@agnes/system-node',
            ...owners.map((owner) => `@agnes/${owner}`),
          ],
          `${f}: ${pkg}`,
        ).toContain(pkg)
  })
  it('Kernel.create appears only in the kernel assembly stage', () => {
    const callers = files.filter((f) => /\bKernel\s*\.\s*create\s*\(/.test(read(f)))
    expect(callers.map((f) => modulePath(f))).toEqual(['host/runtime/assemble/kernel-stage.ts'])
  })
  // The writer lease setting belongs to the kernel; extension leases are bound to their row and
  // must not start reading it again. Comments are stripped so prose naming the key does not count.
  it('lease.ttl_ms reaches only the kernel writer lease wiring and the static-key classification', () => {
    const uncommented = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/gm, '$1')
    const occurrences = (pattern: RegExp) =>
      Object.fromEntries(
        files
          .map((f) => [modulePath(f), uncommented(read(f)).match(pattern)?.length ?? 0])
          .filter(([, count]) => count !== 0),
      )
    expect(occurrences(/['"]lease\.ttl_ms['"]/g)).toEqual({
      'host/runtime/assemble/kernel-stage.ts': 2,
      'host-common/profile-policy.ts': 1,
    })
    expect(occurrences(/\bleaseTtlMs\b/g)).toEqual({ 'host/runtime/assemble/kernel-stage.ts': 1 })
    // One expression reads the key, and what it reads becomes the kernel's leaseTtlMs.
    const wiring = uncommented(read(join(src, 'runtime', 'assemble', 'kernel-stage.ts'))).match(
      /\.limits\['lease\.ttl_ms'\]\s*!==\s*undefined\s*\?\s*\{\s*leaseTtlMs:\s*[\w.]+\.limits\['lease\.ttl_ms'\]\s*\}/g,
    )
    expect(wiring).toHaveLength(1)
    // A comment that names the key is not a read of it.
    const provider = read(join(ownerSrc('host-providers'), 'assemble', 'provider.ts'))
    expect(provider).toContain('lease.ttl_ms')
    expect(uncommented(provider)).not.toContain('lease.ttl_ms')
  })
  // SECURITY-FINDINGS section 6. The argv contract is broken by adding a normaliser or a decoder,
  // not by editing the evaluator, so the ban is on the whole of src/ rather than on one file.
  it('no path-handling module normalises or decodes a path before matching it', () => {
    const normalizations = files.flatMap((f) =>
      [...read(f).matchAll(/\.normalize\(\s*['"]NFK?[CD]['"]\)/g)].map((match) => ({
        file: modulePath(f),
        expression: match[0],
      })),
    )
    expect(normalizations).toEqual([
      {
        file: 'host-computer-use/computer-use/locked-package-mutation-runtime.ts',
        expression: ".normalize('NFC')",
      },
      {
        file: 'host-computer-use/computer-use/locked-package-mutation-runtime.ts',
        expression: ".normalize('NFC')",
      },
      {
        file: 'host-computer-use/computer-use/locked-package-mutation-runtime.ts',
        expression: ".normalize('NFC')",
      },
      {
        file: 'host-computer-use/computer-use/locked-package-receipts-sqlite.ts',
        expression: ".normalize('NFC')",
      },
      {
        file: 'host-computer-use/computer-use/locked-package-receipts-sqlite.ts',
        expression: ".normalize('NFC')",
      },
      {
        file: 'host-computer-use/computer-use/locked-package-receipts-sqlite.ts',
        expression: ".normalize('NFC')",
      },
      { file: 'host-extensions/resources/skill-install-content.ts', expression: ".normalize('NFKC')" },
      { file: 'host-extensions/resources/skill-preload.ts', expression: ".normalize('NFKC')" },
      // isConfigPath folds only to widen a protective match (it can take always-allow away, never
      // admit a path); the fence's own decisions still match the path as given.
      { file: 'host-infrastructure/adapters/fs.ts', expression: ".normalize('NFKC')" },
    ])
    for (const f of files) expect(read(f), f).not.toMatch(/\bdecodeURI(?:Component)?\s*\(/)
  })
  it('limits the lexical exception to the reviewed function and its name/prose callers', () => {
    const file = join(ownerSrc('host-extensions'), 'resources', 'skill-preload.ts')
    const source = read(file).replaceAll('\r\n', '\n')
    expect(source).toContain(skillNormalizer)
    expect(source.match(/\bnormalized\([^)]*\)/g)).toEqual([
      'normalized(value: string)',
      'normalized(name)',
      'normalized(prompt)',
    ])
    const forbidden = /\.normalize\(\s*['"]NFK?[CD]['"]/
    expect(pathGuardInput(file, skillNormalizer)).not.toMatch(forbidden)
    expect(pathGuardInput(join(src, 'adapters', 'fs.ts'), skillNormalizer)).toMatch(forbidden)
    expect(pathGuardInput(file, `${skillNormalizer}\npath.normalize('NFKC')`)).toMatch(forbidden)
    expect(pathGuardInput(file, skillNormalizer.replace('value.normalize', 'path.normalize'))).toMatch(
      forbidden,
    )
    expect(pathGuardInput(file, `${skillNormalizer}\n${skillNormalizer}`)).toMatch(forbidden)
    // Reviewed install-name collision checks normalize catalog names, never paths.
    const installFile = join(ownerSrc('host-extensions'), 'resources', 'skill-install-content.ts')
    expect(read(installFile)).toContain(installNameNormalizer)
    expect(pathGuardInput(installFile, read(installFile))).not.toMatch(forbidden)
    expect(pathGuardInput(installFile, installNameNormalizer.replace('item.name', 'item.path'))).toMatch(
      forbidden,
    )
    expect(pathGuardInput(file, installNameNormalizer)).toMatch(forbidden)
    expect(pathGuardInput(installFile, `${installNameNormalizer}\n${installNameNormalizer}`)).toMatch(
      forbidden,
    )
  })
  it('that ban would fire on the spellings it is written to catch', () => {
    // The inverse pin: a guard that matches nothing passes on an empty regex just as happily.
    const banned = [
      "x.normalize('NFKC')",
      'x.normalize("NFKD")',
      "x.normalize( 'NFC' )",
      'decodeURIComponent(x)',
      'decodeURI(x)',
    ]
    for (const s of banned)
      expect(/\.normalize\(\s*['"]NFK?[CD]['"]/.test(s) || /\bdecodeURI(?:Component)?\s*\(/.test(s), s).toBe(
        true,
      )
  })
  // Private home initialization selects native ACLs before a platform backend can be assembled.
  it('keeps OS detection in platform backends and private home initialization', () => {
    const callers = files.filter((f) => /process\.platform|os\.platform\(\)/.test(read(f)))
    expect(callers.map(modulePath)).toEqual([
      'host-common/home-initialize.ts',
      'host-infrastructure/adapters/platform-posix.ts',
      'host-infrastructure/adapters/platform-win32.ts',
    ])
  })
  it('index re-exports the documented surface for this iteration', async () => {
    const mod = (await import('@agnes/host')) as Record<string, unknown>
    for (const n of [
      'resolveProfile',
      'createHost',
      'HostError',
      'looksLikeSecret',
      'loadTemplate',
      'resolvePreset',
      'toPresetView',
      'createSqliteStorage',
      'assemble',
      'createMemoryAudit',
      'createFileAudit',
      'createCredentialStore',
      'credentialFileEnforcement',
      'CredentialStoreError',
      'materializeRoutes',
      'sweepAwsDestination',
      'checkCommandRule',
      'createSession',
      'closeHost',
      'Rollback',
    ])
      expect(mod, n).toHaveProperty(n)
  })
  it('the package-manager surface is added to index.ts by the task that defines it', () => {
    // Kept as a reminder, not a pin: createPackageManager / renderResolved / lockState are a later
    // iteration's exports, and asserting them here would make this file unpassable until then.
    expect(files.some((f) => f.endsWith('index.ts'))).toBe(true)
  })
})
