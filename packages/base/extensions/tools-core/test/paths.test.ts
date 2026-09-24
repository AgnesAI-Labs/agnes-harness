import { describe, expect, it } from 'vitest'
import { normalizeWorkspacePath } from '../src/paths.js'

const root = '/work/proj'

describe('normalizeWorkspacePath', () => {
  it('folds . and .. and reports inside', () => {
    expect(normalizeWorkspacePath('src/../src/./a.ts', root)).toEqual({
      rel: 'src/a.ts',
      abs: '/work/proj/src/a.ts',
      inside: true,
    })
  })

  it('keeps absolute paths outside the workspace absolute', () => {
    expect(normalizeWorkspacePath('/etc/passwd', root)).toEqual({
      rel: '/etc/passwd',
      abs: '/etc/passwd',
      inside: false,
    })
    expect(normalizeWorkspacePath('../secret', root)).toEqual({
      rel: '/work/secret',
      abs: '/work/secret',
      inside: false,
    })
  })

  it('normalizes windows separators and drive letters lexically', () => {
    expect(normalizeWorkspacePath('src\\a.ts', root).rel).toBe('src/a.ts')
    expect(normalizeWorkspacePath('C:\\other\\x', root).inside).toBe(false)
  })

  it('reports the workspace root itself as the relative path "."', () => {
    expect(normalizeWorkspacePath('', root)).toEqual({ rel: '.', abs: '/work/proj', inside: true })
    expect(normalizeWorkspacePath('.', root)).toEqual({ rel: '.', abs: '/work/proj', inside: true })
    expect(normalizeWorkspacePath('/work/proj/', root).rel).toBe('.')
  })

  it('tolerates a workspace root with redundant separators and dot segments', () => {
    for (const r of ['/work//proj', '/work/proj/', '/work/./proj', '/work/x/../proj'])
      expect(normalizeWorkspacePath('a.ts', r), r).toEqual({
        rel: 'a.ts',
        abs: '/work/proj/a.ts',
        inside: true,
      })
  })
})

// Every case below is an escape attempt: an input that must NOT be reported as inside the workspace.
// `inside: true` on any of them would hand a caller a relative path it believes is workspace-local.
describe('normalizeWorkspacePath rejects escapes', () => {
  it('does not fold .. away before joining it onto the root', () => {
    // The escape this pins: folding the input on its own turns `../secret` into `secret`, which then
    // joins onto the root as a workspace-local file. Folding has to happen after the join.
    expect(normalizeWorkspacePath('../secret', root).abs).toBe('/work/secret')
    expect(normalizeWorkspacePath('../secret', root).inside).toBe(false)
  })

  it('walks out through .. from any depth', () => {
    for (const p of [
      '../../../../etc/passwd',
      'src/../../etc/passwd',
      'src/deep/../../../etc/passwd',
      './../../etc/passwd',
      '..\\..\\etc\\passwd',
      'src\\..\\..\\etc',
    ])
      expect(normalizeWorkspacePath(p, root).inside, p).toBe(false)
  })

  it('clamps .. at the filesystem root instead of underflowing into the workspace', () => {
    const r = normalizeWorkspacePath('../../../../../../..', root)
    expect(r.abs).toBe('/')
    expect(r.inside).toBe(false)
  })

  it('compares whole segments, so a sibling sharing the root prefix is outside', () => {
    for (const p of ['/work/proj-evil/x', '/work/projx', '../proj-evil/x', '/work/proj.bak/x'])
      expect(normalizeWorkspacePath(p, root).inside, p).toBe(false)
    // The same string as a real child, to show the case above is not just "everything is outside".
    expect(normalizeWorkspacePath('/work/proj/evil/x', root).inside).toBe(true)
  })

  it('folds .. inside an absolute path too', () => {
    expect(normalizeWorkspacePath('/work/proj/../../etc', root)).toEqual({
      rel: '/etc',
      abs: '/etc',
      inside: false,
    })
  })

  it('treats a leading separator as absolute in both spellings', () => {
    expect(normalizeWorkspacePath('/secret', root).inside).toBe(false)
    expect(normalizeWorkspacePath('\\secret', root).abs).toBe('/secret')
  })

  it('does not decode percent-escapes, so ..%2f stays one ordinary segment', () => {
    // Decoding here would create a separator the caller never wrote. The segment keeps its literal
    // name and stays inside the workspace, where a real filesystem would also look for it.
    const r = normalizeWorkspacePath('..%2f..%2fetc/passwd', root)
    expect(r.inside).toBe(true)
    expect(r.rel).toBe('..%2f..%2fetc/passwd')
  })

  it('does not truncate at a NUL byte', () => {
    // A caller that compares the returned path against a policy must see the whole string; dropping
    // everything after a NUL would let a suffix ride along invisibly.
    const r = normalizeWorkspacePath('a.ts\u0000/../../etc/passwd', root)
    expect(r.abs).toBe('/work/etc/passwd')
    expect(r.inside).toBe(false)
    expect(normalizeWorkspacePath('a\u0000b.ts', root).rel).toBe('a\u0000b.ts')
  })

  it('folds a segment that a NUL-truncating consumer would read as ..', () => {
    // `..\0x` is not the `..` segment as a JavaScript string, but anything that stops at the NUL —
    // a sandbox helper binary, any C-level path API — sees exactly `..`. Reporting the path inside
    // would leave the two readings of one string pointing at different directories.
    for (const p of ['..\u0000/secret', '..\u0000x/secret', 'sub/..\u0000/../secret'])
      expect(normalizeWorkspacePath(p, root).inside, p).toBe(false)
    expect(normalizeWorkspacePath('..\u0000/secret', root).abs).toBe('/work/secret')
  })

  it('refuses a workspace root that would make every path inside', () => {
    // A root of '', '/' or '.' folds to zero segments, and the containment check is then vacuously
    // true for every path on the machine. A relative root is refused too: it would be promoted to
    // an absolute one naming a directory nobody configured.
    for (const r of ['', '/', '.', './', '//', 'work/proj', './work/proj'])
      expect(() => normalizeWorkspacePath('/etc/passwd', r), r).toThrow(/workspaceRoot/)
    // A missing root is a misconfiguration too, and must not read as "everything is inside".
    for (const r of [undefined, null])
      expect(() => normalizeWorkspacePath('/etc/passwd', r as unknown as string), String(r)).toThrow(
        /workspaceRoot/,
      )
    // The same rule applies to a drive root, which is a root with zero segments too: 'C:/' would
    // make every path on drive C inside, and 'C:.' / 'C:..' name no directory at all.
    for (const r of ['C:', 'C:/', 'C:\\', 'C:.', 'C:..', 'C:/..', 'c:/'])
      expect(() => normalizeWorkspacePath('C:/etc/passwd', r), r).toThrow(/workspaceRoot/)
    // A drive root with a segment is still usable.
    expect(normalizeWorkspacePath('C:/etc/passwd', 'C:/work').inside).toBe(false)
    expect(normalizeWorkspacePath('C:/work/a.ts', 'C:/work').inside).toBe(true)
  })

  it('does not treat other unicode slashes as separators', () => {
    for (const p of ['..\u2215..\u2215etc', '..\uff0f..\uff0fetc'])
      expect(normalizeWorkspacePath(p, root).inside, p).toBe(true)
  })
})

describe('normalizeWorkspacePath with a drive-rooted workspace', () => {
  const winRoot = 'C:\\work\\proj'

  it('resolves children of a drive-rooted workspace', () => {
    expect(normalizeWorkspacePath('src\\a.ts', winRoot)).toEqual({
      rel: 'src/a.ts',
      abs: 'C:/work/proj/src/a.ts',
      inside: true,
    })
  })

  it('matches the drive letter case-insensitively but segments case-sensitively', () => {
    expect(normalizeWorkspacePath('c:\\work\\proj\\a.ts', winRoot).inside).toBe(true)
    // Reporting a case-variant segment as outside is the conservative answer on a case-insensitive
    // filesystem: a caller treats it as foreign rather than as a workspace file.
    expect(normalizeWorkspacePath('C:\\WORK\\proj\\a.ts', winRoot).inside).toBe(false)
  })

  it('keeps a different drive outside', () => {
    expect(normalizeWorkspacePath('D:\\work\\proj\\a.ts', winRoot).inside).toBe(false)
    expect(normalizeWorkspacePath('/work/proj/a.ts', winRoot).inside).toBe(false)
  })

  it('folds .. in a drive path and clamps at the drive root', () => {
    expect(normalizeWorkspacePath('C:\\work\\proj\\..\\..\\..\\..\\x', winRoot)).toEqual({
      rel: 'C:/x',
      abs: 'C:/x',
      inside: false,
    })
  })
})
