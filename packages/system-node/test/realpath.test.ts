import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep, toNamespacedPath } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeRealpathSync } from '../src/realpath.js'

let temp: string
let root: string
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'agh-realpath-'))
  root = join(temp, '中文 package with spaces')
  mkdirSync(root)
  writeFileSync(join(root, 'entry.txt'), '中文 bytes')
})
afterEach(() => rmSync(temp, { recursive: true, force: true }))

function inside(base: string, file: string) {
  const rel = relative(nativeRealpathSync(base), nativeRealpathSync(file))
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

it('resolves Chinese names and spaces to the same path as native asynchronous realpath', async () => {
  const file = join(root, 'entry.txt')
  expect(nativeRealpathSync(file)).toBe(await realpath(file))
  expect(readFileSync(nativeRealpathSync(file), 'utf8')).toBe('中文 bytes')
})

it('keeps internal symlinks and nested link chains inside while identifying escapes', () => {
  const nested = join(root, 'nested')
  mkdirSync(nested)
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(nested, join(root, 'first'), linkType)
  symlinkSync(join(root, 'first'), join(root, 'second'), linkType)
  writeFileSync(join(nested, 'ok.txt'), 'ok')
  symlinkSync(temp, join(root, 'escape'), linkType)
  for (const alias of ['first', 'second']) {
    expect(inside(root, join(root, alias, 'ok.txt'))).toBe(true)
    expect(nativeRealpathSync(join(root, alias))).toBe(nativeRealpathSync(nested))
  }
  expect(inside(root, join(root, 'escape'))).toBe(false)
})

it('propagates ENOENT for missing paths and dangling links', () => {
  const missing = join(root, 'missing')
  symlinkSync(missing, join(root, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const path of [missing, join(missing, 'entry'), join(root, 'dangling')])
    expect(() => nativeRealpathSync(path)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
})

it('resolves paths longer than MAX_PATH without changing their file identity', () => {
  const deep = join(root, ...Array.from({ length: 8 }, (_, i) => `${i}-${'segment'.repeat(5)}`))
  mkdirSync(toNamespacedPath(deep), { recursive: true })
  const file = join(deep, '文件.txt')
  writeFileSync(toNamespacedPath(file), 'long')
  expect(file.length).toBeGreaterThan(260)
  expect(inside(root, file)).toBe(true)
  expect(readFileSync(nativeRealpathSync(file), 'utf8')).toBe('long')
})

it.runIf(process.platform === 'win32')('rejects a junction escape after canonicalizing both roots', () => {
  symlinkSync(temp, join(root, 'junction'), 'junction')
  expect(inside(root, join(root, 'junction'))).toBe(false)
})

it.runIf(process.platform === 'win32')('unifies drive-letter case and namespace-prefixed paths', () => {
  const canonical = nativeRealpathSync(root)
  expect(canonical).toMatch(/^[A-Z]:\\/)
  expect(nativeRealpathSync(root.replace(/^[A-Z]:/i, (s) => s.toLowerCase()))).toBe(canonical)
  expect(nativeRealpathSync(toNamespacedPath(root))).toBe(canonical)
  expect(inside(toNamespacedPath(root), join(root, 'entry.txt'))).toBe(true)
  expect(() => nativeRealpathSync(toNamespacedPath(join(root, 'missing')))).toThrow(
    expect.objectContaining({ code: 'ENOENT' }),
  )
})

it.runIf(process.platform === 'win32')('expands an NTFS 8.3 alias before comparing containment', (ctx) => {
  const long = join(temp, 'LongDirectoryForShortName'),
    short = join(temp, 'LONGDI~1')
  mkdirSync(long)
  // Volumes can disable 8.3 generation. Do not pretend a long-name-only fixture exercises it.
  if (!existsSync(short)) return ctx.skip('8.3 name generation is disabled on this volume')
  writeFileSync(join(long, 'entry.txt'), 'short alias')
  expect(nativeRealpathSync(short)).toBe(nativeRealpathSync(long))
  expect(inside(short, join(long, 'entry.txt'))).toBe(true)
  expect(inside(short, root)).toBe(false)
})

it.runIf(process.platform === 'win32')('uses the physical root for a subst-like directory alias', () => {
  const alias = join(temp, 'other-root')
  symlinkSync(root, alias, 'junction')
  expect(nativeRealpathSync(alias)).toBe(nativeRealpathSync(root))
  expect(inside(alias, join(root, 'entry.txt'))).toBe(true)
  expect(inside(alias, temp)).toBe(false)
  // If TEMP uses a profile's 8.3 spelling, both sides must still expand to the same long spelling.
  expect(inside(temp, root)).toBe(true)
})

it.runIf(process.platform === 'win32')(
  'preserves a different native drive or UNC root without folding names',
  () => {
    // Exercise native return shapes without creating a machine-wide subst or network mapping.
    const native = vi.spyOn(realpathSync, 'native')
    try {
      native.mockReturnValue('\\\\?\\c:\\PhysicalRoot\\CaseSensitive')
      expect(nativeRealpathSync('Z:\\SHORT~1')).toBe('C:\\PhysicalRoot\\CaseSensitive')
      native.mockReturnValue('\\\\?\\UNC\\server\\share\\CaseSensitive')
      expect(nativeRealpathSync('Z:\\mapped')).toBe('\\\\server\\share\\CaseSensitive')
    } finally {
      native.mockRestore()
    }
  },
)
