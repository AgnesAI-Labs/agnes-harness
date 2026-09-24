import { readFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTestFile, listSourceFiles, repoRoot } from './repo.js'

const root = repoRoot()
const writer = join(root, 'packages/package-manager/src')
const host = join(root, 'packages/host/src')

/** Compatibility files may delegate, but may never regain filesystem or source ownership. */
function compatibilityViolation(source: string): boolean {
  return (
    /(?:from\s*|import\s*\()['"](?:node:|\.\.)/.test(source) ||
    /\b(?:writeFileSync|renameSync|rmSync|fetchSource|execFile)\s*\(/.test(source)
  )
}

/** A module combining package paths with native mutation creates a second storage authority. */
function storageViolation(source: string): boolean {
  // Preserve string literals while removing comments; a documentation mention is not a path.
  source = source.replace(
    /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (token) => (token.startsWith('/*') || token.startsWith('//') ? '' : token),
  )
  const packagePath =
    /agnes-lock\.json|\.agnes-lock\.lock|import\s*\{[^}]*\blockPath\b|\bpackageDir\b|\bjoin\([^;\n]*['"]packages['"]/.test(
      source,
    )
  const mutation =
    /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|rename(?:Sync)?|rm(?:Sync)?|unlink(?:Sync)?|mkdir(?:Sync)?|cp(?:Sync)?|copyFile(?:Sync)?|createWriteStream|open(?:Sync)?)\b/.test(
      source,
    )
  return packagePath && mutation
}

describe('Package lifecycle ownership', () => {
  it('keeps the PackageManager implementation independent of runtime and UI packages', () => {
    for (const file of listSourceFiles(writer)) {
      expect(readFileSync(file, 'utf8'), relative(root, file)).not.toMatch(
        /(?:@agnes\/(?:host|core|daemon|sdk|cli|web)|\.\.\/.*(?:host|core)\/)/,
      )
    }
  })
  it('Host package compatibility files only delegate to the unique owner', () => {
    for (const file of listSourceFiles(join(host, 'packages'))) {
      if (basename(file) === 'compat.ts') continue
      expect(compatibilityViolation(readFileSync(file, 'utf8')), relative(root, file)).toBe(false)
    }
  })
  it('no other production package writes the lock or package store', () => {
    for (const file of listSourceFiles(join(root, 'packages'))) {
      if (!file.includes(`${sep}src${sep}`) || isTestFile(file) || file.startsWith(`${writer}${sep}`))
        continue
      expect(storageViolation(readFileSync(file, 'utf8')), relative(root, file)).toBe(false)
    }
  })
  it('rejects native writers in Host runtime and other production packages', () => {
    expect(
      storageViolation("import { writeFileSync as save } from 'node:fs'; save('agnes-lock.json', '{}')"),
    ).toBe(true)
    expect(
      storageViolation("import { rm } from 'node:fs/promises'; await rm(packageDir(root, profile, id))"),
    ).toBe(true)
    expect(storageViolation("import { readFileSync } from 'node:fs'; readFileSync('agnes-lock.json')")).toBe(
      false,
    )
  })
  it('Host runtime code has no direct lock writer or package fetch call', () => {
    for (const file of listSourceFiles(host)) {
      if (relative(host, file).startsWith(`packages${sep}`)) continue
      expect(readFileSync(file, 'utf8'), relative(root, file)).not.toMatch(
        /\b(?:writeLock|snapshotPolicy|createPackageManager|fetchSource)\s*\(/,
      )
    }
  })
  it('rejects a restored Host filesystem writer (negative ownership oracle)', () => {
    expect(
      compatibilityViolation(
        "import { writeFileSync } from 'node:fs'\nwriteFileSync('agnes-lock.json', '{}')",
      ),
    ).toBe(true)
  })
})
