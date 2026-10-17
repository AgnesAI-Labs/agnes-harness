import { describe, expect, it } from 'vitest'
import { argvHash, normalizeArgv } from '../src/command-table/normalize.js'

describe('Windows approval path identity', () => {
  const root = 'C:\\work\\repo'
  it.each(['//server', '//server/../repo', 'C:/', '//server/share'])(
    'refuses ambiguous or volume-wide workspace %s',
    (workspace) => {
      expect(() => normalizeArgv('edit', { path: 'file' }, workspace)).toThrow('NotCanonical')
    },
  )
  it.each(['//server', 'NUL .txt', '//server/./repo'])(
    'refuses incomplete authority or device alias %s',
    (path) => {
      expect(() => normalizeArgv('edit', { path }, root)).toThrow('NotCanonical')
    },
  )
  it.each(['src/file.txt', 'src\\file.txt', 'C:\\work\\repo\\src\\file.txt', 'c:/work/repo/src/file.txt'])(
    'normalizes %s',
    (path) => {
      expect(normalizeArgv('edit', { path }, root)).toBe('C:/work/repo/src/file.txt')
    },
  )
  it('uses the workspace base for an explicitly classified extra path', () => {
    expect(normalizeArgv('write', { path: '../extra/a.txt' }, root, undefined, 'C:/work/extra')).toBe(
      'C:/work/extra/a.txt',
    )
    expect(() =>
      normalizeArgv('write', { path: '../other/a.txt' }, root, undefined, 'C:/work/extra'),
    ).toThrow('NotCanonical')
    expect(() =>
      normalizeArgv('write', { path: 'C:/work/extra/NUL.txt' }, root, undefined, 'C:/work/extra'),
    ).toThrow('NotCanonical')
  })
  it('preserves Chinese names, spaces and dot names', () => {
    expect(normalizeArgv('edit', { path: '中文 空格\\a..b.txt' }, root)).toBe(
      'C:/work/repo/中文 空格/a..b.txt',
    )
  })
  it('preserves the UNC share identity', () => {
    expect(normalizeArgv('write', { path: 'src\\file' }, '\\\\server\\share\\repo')).toBe(
      '//server/share/repo/src/file',
    )
    expect(() =>
      normalizeArgv('write', { path: '\\\\server\\other\\repo\\file' }, '\\\\server\\share\\repo'),
    ).toThrow('NotCanonical')
    // Parent traversal cannot climb above a share and then re-enter a similarly named machine path.
    expect(normalizeArgv('write', { path: '../../repo/file' }, '\\\\server\\share\\repo')).toBe(
      '//server/share/repo/file',
    )
    expect(() =>
      normalizeArgv('write', { path: '../../../server/share/repo/file' }, '\\\\server\\share\\repo'),
    ).toThrow('NotCanonical')
    expect(() => normalizeArgv('write', { path: 'Z:/repo/file' }, '\\\\server\\share\\repo')).toThrow(
      'NotCanonical',
    )
  })
  it.each([
    '../outside',
    'D:/work/repo/file',
    'C:/work/repository/file',
    'C:relative',
    '/work/repo/file',
    '\\work\\repo\\file',
    '\\\\?\\C:\\work\\repo\\file',
    '\\\\.\\pipe\\x',
    'file:stream',
    'src\\C:foo',
    'a\n.txt',
    'NUL',
    'con.txt',
    'COM¹.log',
    'file.',
    'file ',
    'dir.\\file',
    'C:/WORK/repo/file',
  ])('does not automatically identify unsafe or foreign spelling %s', (path) => {
    expect(() => normalizeArgv('edit', { path }, root)).toThrow('NotCanonical')
  })
  it('hashes separator aliases alike without merging different files or case-sensitive names', () => {
    const hash = (path: string) => argvHash('edit', { path }, root).hash
    expect(hash('src/file')).toBe(hash('src\\file'))
    expect(hash('src/file')).not.toBe(hash('src/File'))
    expect(hash('src/file')).not.toBe(hash('src/other'))
  })
})
