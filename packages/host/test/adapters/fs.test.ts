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
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { testFsPolicy } from '@agnes/core/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFs, type FsBinding } from '../../src/adapters/fs.js'

const directoryLink = process.platform === 'win32' ? 'junction' : 'dir' // guards-allow-platform: actual directory-link fixtures.

// The fence reads a full FsPolicy now. Tests build one through the core testkit, rooted at the
// canonical workspace spelling because that is what the enforcer compares after realpath.
const bindingFor = (root: string, deny: string[] = ['.git'], caseSensitive = true): FsBinding => ({
  policy: testFsPolicy(realpathSync(root), { deny }),
  caseSensitive,
})

describe('fs adapter', () => {
  let root: string
  let outside: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agnes-ws-'))
    outside = mkdtempSync(join(tmpdir(), 'agnes-out-'))
    mkdirSync(join(root, '.git'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  const fs = () => createFs(() => bindingFor(root))

  it('reads, writes, lists and stats inside the workspace', async () => {
    const f = fs()
    await f.write('a.txt', new TextEncoder().encode('l1\nl2\nl3\n'))
    expect(new TextDecoder().decode(await f.read('a.txt', { offset: 2, limit: 1 }))).toBe('l2\n')
    expect((await f.list('.')).map((e) => e.name)).toContain('a.txt')
    expect((await f.list('.')).find((e) => e.name === 'a.txt')?.kind).toBe('file')
    const st = await f.stat('a.txt')
    expect(st.kind).toBe('file')
    expect(st.size).toBe(9)
    expect(typeof st.mtimeMs).toBe('number')
  })
  it('reads the whole file when no window is asked for', async () => {
    const f = fs()
    await f.write('a.txt', new TextEncoder().encode('l1\nl2\nl3\n'))
    expect(new TextDecoder().decode(await f.read('a.txt'))).toBe('l1\nl2\nl3\n')
  })
  it('counts the read window in lines, one-based, and clamps at the end of the file', async () => {
    const f = fs()
    await f.write('a.txt', new TextEncoder().encode('l1\nl2\nl3\n'))
    const dec = (u: Uint8Array) => new TextDecoder().decode(u)
    expect(dec(await f.read('a.txt', { offset: 1, limit: 2 }))).toBe('l1\nl2\n')
    expect(dec(await f.read('a.txt', { offset: 3 }))).toBe('l3\n')
    expect(dec(await f.read('a.txt', { limit: 1 }))).toBe('l1\n')
    expect(dec(await f.read('a.txt', { offset: 9, limit: 2 }))).toBe('')
  })
  it('writes bytes verbatim, including bytes that are not valid text', async () => {
    const f = fs()
    const bytes = new Uint8Array([0, 1, 2, 250, 251])
    await f.write('bin', bytes)
    expect([...(await f.read('bin'))]).toEqual([...bytes])
    expect((await f.stat('bin')).size).toBe(5)
  })
  it('does the other four of the eight: realpath, mkdir, rm, and stat on a directory', async () => {
    const f = fs()
    await f.mkdir('nested/deep')
    expect((await f.stat('nested/deep')).kind).toBe('dir')
    expect(await f.realpath('nested/deep')).toBe(join(realpathSync(root), 'nested', 'deep'))
    await f.write('nested/deep/x', new Uint8Array([1]))
    await f.rm('nested', { recursive: true })
    await expect(f.stat('nested')).rejects.toThrow()
    await expect(f.rm('nested')).rejects.toThrow()
  })
  it('creates parent directories on write rather than failing on a missing one', async () => {
    const f = fs()
    await f.write('a/b/c.txt', new TextEncoder().encode('x'))
    expect((await f.stat('a/b/c.txt')).size).toBe(1)
  })
  it('round-trips Chinese and binary content through a path longer than 260 characters', async () => {
    const f = fs()
    const path = join(...Array.from({ length: 12 }, (_, i) => `中文 空格目录-${i}-abcdefghijkl`), '结果.txt')
    expect(join(root, path).length).toBeGreaterThan(260)
    const bytes = new TextEncoder().encode('中文结果\r\n\0二进制尾部')
    await f.write(path, bytes)
    expect(await f.read(path)).toEqual(bytes)
    expect((await f.stat(path)).size).toBe(bytes.length)
    expect((await f.list(dirname(path))).map((entry) => entry.name)).toEqual(['结果.txt'])
    await f.rm(path)
    expect(existsSync(join(root, path))).toBe(false)
  })
  it('refuses a non-recursive rm of a directory that has contents', async () => {
    const f = fs()
    await f.mkdir('d')
    await f.write('d/x', new Uint8Array([1]))
    await expect(f.rm('d')).rejects.toThrow()
    await f.rm('d', { recursive: true })
    await expect(f.stat('d')).rejects.toThrow()
  })
  it('reports a symlink as a symlink from list, and refuses to follow it out', async () => {
    const f = fs()
    writeFileSync(join(outside, 's'), 'x')
    symlinkSync(join(outside, 's'), join(root, 'out-link'))
    expect((await f.list('.')).find((e) => e.name === 'out-link')?.kind).toBe('symlink')
    await expect(f.read('out-link')).rejects.toThrow(/E_FS_DENIED/)
    // stat is a read too: the brief refuses read, list and stat alike, so describing a name
    // whose target is outside is refused even though only the link itself would be touched.
    await expect(f.stat('out-link')).rejects.toThrow(/E_FS_DENIED/)
  })
  // list() and stat() have to describe the same name the same way; statting the resolved target
  // could only ever answer file or dir, so a caller looping over a listing got two different
  // answers for one entry.
  it('stat describes the name asked about, agreeing with list on a symlink', async () => {
    const f = fs()
    await f.mkdir('real')
    symlinkSync(join(root, 'real'), join(root, 'inside-link'), directoryLink)
    expect((await f.list('.')).find((e) => e.name === 'inside-link')?.kind).toBe('symlink')
    expect((await f.stat('inside-link')).kind).toBe('symlink')
    expect((await f.stat('real')).kind).toBe('dir')
    for (const e of await f.list('.'))
      if (e.name !== '.git') expect((await f.stat(e.name)).kind, e.name).toBe(e.kind)
  })
  it('refuses paths outside the workspace and deny prefixes, including via symlink', async () => {
    const f = fs()
    writeFileSync(join(outside, 'secret'), 'x')
    symlinkSync(join(outside, 'secret'), join(root, 'link'))
    await expect(f.read('../x')).rejects.toThrow(/E_FS_DENIED/)
    await expect(f.read('link')).rejects.toThrow(/E_FS_DENIED/)
    await expect(f.write('.git/config', new Uint8Array())).rejects.toThrow(/E_FS_DENIED/)
    await expect(f.list('.git')).rejects.toThrow(/E_FS_DENIED/)
  })
  it('says which of the two rules refused, and refuses every one of the eight methods', async () => {
    const f = fs()
    await expect(f.read('../x')).rejects.toThrow(/outside every allow rule/)
    await expect(f.read('.git/config')).rejects.toThrow(/denied by policy/)
    const out = join(outside, 'x')
    writeFileSync(out, 'x')
    await expect(f.realpath(out)).rejects.toThrow(/E_FS_DENIED/)
    await expect(f.stat(out)).rejects.toThrow(/E_FS_DENIED/)
    await expect(f.list(outside)).rejects.toThrow(/E_FS_DENIED/)
    await expect(f.write(out, new Uint8Array())).rejects.toThrow(/E_FS_DENIED/)
    await expect(f.mkdir(join(outside, 'd'))).rejects.toThrow(/E_FS_DENIED/)
    await expect(f.rm(out)).rejects.toThrow(/E_FS_DENIED/)
  })
  // The escape does not have to be the last segment: a symlinked directory in the middle of the
  // path leaves every later segment outside the fence too.
  it('refuses a path whose escape is a symlinked directory in the middle', async () => {
    const f = fs()
    mkdirSync(join(outside, 'd'))
    writeFileSync(join(outside, 'd', 'x'), 'x')
    symlinkSync(join(outside, 'd'), join(root, 'dir-link'), directoryLink)
    expect((await f.list('.')).find((entry) => entry.name === 'dir-link')?.kind).toBe('symlink')
    await expect(f.stat('dir-link')).rejects.toThrow(/E_FS_DENIED/)
    await expect(f.list('dir-link')).rejects.toThrow(/E_FS_DENIED/)
    await expect(f.read('dir-link/x')).rejects.toThrow(/E_FS_DENIED/)
    await expect(f.write('dir-link/new', new Uint8Array([1]))).rejects.toThrow(/E_FS_DENIED/)
  })
  it('refuses a dangling final symlink to an outside target before creating that target', async () => {
    const f = fs()
    const target = join(outside, 'created-through-link')
    symlinkSync(target, join(root, 'dangling-link'))
    expect(existsSync(target)).toBe(false)
    await expect(f.write('dangling-link', new Uint8Array([1]))).rejects.toThrow(/E_FS_DENIED/)
    expect(existsSync(target)).toBe(false)
  })
  it('refuses a dangling directory link before creating its outside target', async () => {
    const f = fs()
    const target = join(outside, 'missing-directory')
    symlinkSync(target, join(root, 'missing-link'), directoryLink)
    expect((await f.list('.')).find((entry) => entry.name === 'missing-link')?.kind).toBe('symlink')
    await expect(f.write('missing-link/new.txt', new Uint8Array([1]))).rejects.toThrow(/E_FS_DENIED/)
    await expect(f.mkdir('missing-link/nested')).rejects.toThrow(/E_FS_DENIED/)
    expect(existsSync(target)).toBe(false)
  })
  it('re-canonicalizes when a previously missing parent becomes an outside symlink', async () => {
    const f = fs()
    expect(await f.realpath('late/new')).toBe(join(realpathSync(root), 'late', 'new'))
    mkdirSync(join(outside, 'late-target'))
    symlinkSync(join(outside, 'late-target'), join(root, 'late'), directoryLink)
    await expect(f.write('late/new', new Uint8Array([1]))).rejects.toThrow(/E_FS_DENIED/)
    expect(existsSync(join(outside, 'late-target', 'new'))).toBe(false)
  })
  it('allows a symlink that stays inside the workspace', async () => {
    const f = fs()
    await f.mkdir('real')
    await f.write('real/x', new TextEncoder().encode('ok'))
    symlinkSync(join(root, 'real'), join(root, 'inside-link'), directoryLink)
    expect(new TextDecoder().decode(await f.read('inside-link/x'))).toBe('ok')
  })
  it('refuses a deny path reached through a name that does not yet exist', async () => {
    const f = fs()
    await expect(f.write('.git/hooks/pre-commit', new Uint8Array([1]))).rejects.toThrow(/denied by policy/)
  })
  it('does not confuse a sibling whose name starts with a deny prefix', async () => {
    const f = fs()
    await f.write('.gitignore', new TextEncoder().encode('x'))
    expect((await f.stat('.gitignore')).size).toBe(1)
  })
  it('does not confuse a sibling directory whose name extends the workspace root', async () => {
    const sibling = `${realpathSync(root)}-evil`
    mkdirSync(sibling)
    try {
      const f = fs()
      await expect(f.read(join(sibling, 'x'))).rejects.toThrow(/E_FS_DENIED/)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })
  it('reads the policy on every call, so a changed workspace root takes effect at once', async () => {
    let binding = bindingFor(root, [])
    const f = createFs(() => binding)
    await f.write('a', new Uint8Array([1]))
    binding = bindingFor(outside, [])
    await expect(f.stat(join(root, 'a'))).rejects.toThrow(/E_FS_DENIED/)
  })
})

// The deny list is the store for credentials as well as the git directory, and it was compared
// byte for byte. On a case-insensitive filesystem - macOS, where this is developed - that is not a
// comparison at all: .GIT/config and .AGH/secrets/key name the same files as the spellings on
// the list. The refusal has to fold case unless the filesystem is known to be case-sensitive.
describe('fs adapter, deny paths and case', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agnes-case-'))
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'config'), 'secret')
    // `.agnes/secrets` is the store's name from before the `.agh` rename; the floor denies both.
    for (const name of ['.agh', '.agnes']) {
      mkdirSync(join(root, name, 'secrets'), { recursive: true })
      writeFileSync(join(root, name, 'secrets', 'key'), 'sekrit')
    }
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  const denying = (caseSensitive = false) =>
    createFs(() => bindingFor(root, ['.git', '.agh/secrets', '.agnes/secrets'], caseSensitive))

  it('refuses a deny path spelled in another case', async () => {
    const f = denying(false)
    await expect(f.read('.GIT/config')).rejects.toThrow(/denied by policy/)
    await expect(f.read('.Git/config')).rejects.toThrow(/denied by policy/)
    await expect(f.read('.AGH/Secrets/key')).rejects.toThrow(/denied by policy/)
    await expect(f.read('.AGNES/Secrets/key')).rejects.toThrow(/denied by policy/)
    await expect(f.stat('.GIT')).rejects.toThrow(/denied by policy/)
    await expect(f.list('.GIT')).rejects.toThrow(/denied by policy/)
    await expect(f.write('.GIT/hooks/x', new Uint8Array([1]))).rejects.toThrow(/denied by policy/)
  })
  it('folds case by default, because a policy that does not say is not a licence to allow', async () => {
    await expect(denying().read('.GIT/config')).rejects.toThrow(/denied by policy/)
  })
  it('refuses a directory alias into a protected directory without changing its contents', async () => {
    const f = denying(false)
    symlinkSync(join(root, '.agh', 'secrets'), join(root, 'ordinary-alias'), directoryLink)
    await expect(f.read('ordinary-alias/key')).rejects.toThrow(/denied by policy/)
    await expect(f.write('ordinary-alias/new', new Uint8Array([1]))).rejects.toThrow(/denied by policy/)
    await expect(f.rm('ordinary-alias/key')).rejects.toThrow(/denied by policy/)
    await expect(f.list('ordinary-alias')).rejects.toThrow(/denied by policy/)
    expect(readFileSync(join(root, '.agh', 'secrets', 'key'), 'utf8')).toBe('sekrit')
    expect(existsSync(join(root, '.agh', 'secrets', 'new'))).toBe(false)
  })
  it('still refuses the exact spelling, and still admits a sibling that only shares a prefix', async () => {
    const f = denying(false)
    await expect(f.read('.git/config')).rejects.toThrow(/denied by policy/)
    await f.write('.gitignore', new TextEncoder().encode('x'))
    expect((await f.stat('.gitignore')).size).toBe(1)
  })
  it('matches a deny path written with forward slashes whatever the platform separator is', async () => {
    const f = denying(false)
    for (const name of ['.agh', '.agnes']) {
      await expect(f.read(`${name}/secrets/key`)).rejects.toThrow(/denied by policy/)
      await expect(f.read(join(name, 'secrets', 'key'))).rejects.toThrow(/denied by policy/)
    }
  })
})

// stat resolves the parent so that it can describe the name rather than what the name points at.
// The workspace root has no parent inside the fence, and every other method answers for it, so the
// answer must not depend on how the caller spells the root.
describe('fs adapter, stat at the workspace root', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agnes-root-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('stats the workspace root by every spelling that names it', async () => {
    const f = createFs(() => bindingFor(root, []))
    for (const p of ['.', './', root, realpathSync(root), join(root, 'sub', '..')]) {
      const st = await f.stat(p)
      expect([p, st.kind]).toEqual([p, 'dir'])
    }
    expect((await f.list('.')).length).toBe(0)
    expect(await f.realpath('.')).toBe(realpathSync(root))
  })
  it('still refuses the parent of the workspace root', async () => {
    const f = createFs(() => bindingFor(root, []))
    await expect(f.stat('..')).rejects.toThrow(/E_FS_DENIED/)
    await expect(f.stat(dirname(realpathSync(root)))).rejects.toThrow(/E_FS_DENIED/)
  })
  it('still reports a symlink as a symlink, which is why the parent is resolved at all', async () => {
    const f = createFs(() => bindingFor(root, []))
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'link'), directoryLink)
    expect((await f.stat('link')).kind).toBe('symlink')
    expect((await f.stat('real')).kind).toBe('dir')
  })
})
