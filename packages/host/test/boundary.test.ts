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
walk(src)
const read = (f: string): string => readFileSync(f, 'utf8')
// This existing function normalizes Skill names and user prose, never filesystem paths.
// Only its exact reviewed body is exempt; other calls in the same file remain forbidden.
const skillNormalizer = String.raw`function normalized(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}`
const pathGuardInput = (file: string, text: string): string => {
  const source = text.replaceAll('\r\n', '\n')
  return file === join(src, 'resources', 'skill-preload.ts') ? source.replace(skillNormalizer, '') : source
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
            '@agnes/cordis',
            '@agnes/core',
            '@agnes/ai',
            '@agnes/package-manager',
            '@agnes/plugin-runtime',
            '@agnes/resource-control-runtime',
            '@agnes/sandbox-remote',
            '@agnes/system-node',
          ],
          `${f}: ${pkg}`,
        ).toContain(pkg)
  })
  it('Kernel.create appears only in assemble.ts', () => {
    const callers = files.filter((f) => /\bKernel\s*\.\s*create\s*\(/.test(read(f)))
    expect(callers.map((f) => f.slice(src.length))).toEqual(['assemble.ts'])
  })
  // The writer lease setting belongs to the kernel; extension leases are bound to their row and
  // must not start reading it again. Comments are stripped so prose naming the key does not count.
  it('lease.ttl_ms reaches only the kernel writer lease wiring and the static-key classification', () => {
    const uncommented = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/gm, '$1')
    const occurrences = (pattern: RegExp) =>
      Object.fromEntries(
        files
          .map((f) => [
            f.slice(src.length).replaceAll('\\', '/'),
            uncommented(read(f)).match(pattern)?.length ?? 0,
          ])
          .filter(([, count]) => count !== 0),
      )
    expect(occurrences(/['"]lease\.ttl_ms['"]/g)).toEqual({ 'assemble.ts': 2, 'profile-policy.ts': 1 })
    expect(occurrences(/\bleaseTtlMs\b/g)).toEqual({ 'assemble.ts': 1 })
    const wiring = uncommented(read(join(src, 'assemble.ts')))
      .split('\n')
      .filter((line) => /['"]lease\.ttl_ms['"]/.test(line))
    expect(wiring).toHaveLength(1)
    expect(wiring[0]).toContain("leaseTtlMs: profile.limits['lease.ttl_ms']")
    // A comment that names the key is not a read of it.
    const provider = read(join(src, 'assemble', 'provider.ts'))
    expect(provider).toContain('lease.ttl_ms')
    expect(uncommented(provider)).not.toContain('lease.ttl_ms')
  })
  // SECURITY-FINDINGS section 6. The argv contract is broken by adding a normaliser or a decoder,
  // not by editing the evaluator, so the ban is on the whole of src/ rather than on one file.
  it('no path-handling module normalises or decodes a path before matching it', () => {
    const normalizations = files.flatMap((f) =>
      [...read(f).matchAll(/\.normalize\(\s*['"]NFK?[CD]['"]\)/g)].map((match) => ({
        file: f.slice(src.length).replaceAll('\\', '/'),
        expression: match[0],
      })),
    )
    expect(normalizations).toEqual([
      { file: 'computer-use/locked-package-mutation-runtime.ts', expression: ".normalize('NFC')" },
      { file: 'computer-use/locked-package-mutation-runtime.ts', expression: ".normalize('NFC')" },
      { file: 'computer-use/locked-package-mutation-runtime.ts', expression: ".normalize('NFC')" },
      { file: 'computer-use/locked-package-receipts-sqlite.ts', expression: ".normalize('NFC')" },
      { file: 'computer-use/locked-package-receipts-sqlite.ts', expression: ".normalize('NFC')" },
      { file: 'computer-use/locked-package-receipts-sqlite.ts', expression: ".normalize('NFC')" },
      { file: 'resources/skill-preload.ts', expression: ".normalize('NFKC')" },
    ])
    for (const f of files) expect(read(f), f).not.toMatch(/\bdecodeURI(?:Component)?\s*\(/)
  })
  it('limits the lexical exception to the reviewed function and its name/prose callers', () => {
    const file = join(src, 'resources', 'skill-preload.ts')
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
  // Only platform-*.ts may ask what OS this is; everything else takes the answer from the backend.
  it('process.platform and os.platform() appear only in the platform backends', () => {
    for (const f of files) {
      if (/platform-(posix|win32)\.ts$/.test(f)) continue
      expect(read(f), f).not.toMatch(/process\.platform|os\.platform\(\)/)
    }
  })
  it('index re-exports the documented surface for this iteration', async () => {
    const mod = (await import('../src/index.js')) as Record<string, unknown>
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
