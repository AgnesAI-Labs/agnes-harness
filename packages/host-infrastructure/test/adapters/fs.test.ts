import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { testFsPolicy } from '@agnes/core/testkit'
import { withSessionFileAccess } from '@agnes/host-common/session-file-access'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFs, type FsBinding } from '../../src/adapters/fs.js'
import { localFsIo } from '../../src/adapters/fs-io-local.js'
import { createRemoteFsIo } from '../../src/adapters/fs-io-remote.js'
import { createLoopbackTransport } from '../../src/adapters/remote-transport.js'

const directoryLink = process.platform === 'win32' ? 'junction' : 'dir' // guards-allow-platform: actual directory-link fixtures.

// The fence reads a full FsPolicy now. Tests build one through the core testkit, rooted at the
// canonical workspace spelling because that is what the enforcer compares after realpath.
const bindingFor = (root: string, deny: string[] = ['.git'], caseSensitive = true): FsBinding => ({
  policy: testFsPolicy(realpathSync.native(root), { deny }),
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
  it('keeps a read-only workspace immutable even when the session skips approvals', async () => {
    writeFileSync(join(root, 'existing.txt'), 'keep')
    const f = createFs(() => ({ ...bindingFor(root), readOnly: true }))
    await withSessionFileAccess(
      f,
      () => true,
      async () => {
        expect(new TextDecoder().decode(await f.read('existing.txt'))).toBe('keep')
        await expect(f.write('existing.txt', new TextEncoder().encode('changed'))).rejects.toMatchObject({
          code: 'E_FS_DENIED',
        })
        await expect(f.mkdir('new')).rejects.toMatchObject({ code: 'E_FS_DENIED' })
      },
    )
    expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe('keep')
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
    expect(await f.realpath('nested/deep')).toBe(join(realpathSync.native(root), 'nested', 'deep'))
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
    writeFileSync(join(root, '.git', 'synthetic-state'), 'keep')
    await withSessionFileAccess(
      f,
      () => true,
      async () => {
        await expect(f.rm('.', { recursive: true })).rejects.toMatchObject({ code: 'E_FS_DENIED' })
      },
    )
    expect(readFileSync(join(root, '.git', 'synthetic-state'), 'utf8')).toBe('keep')
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
    let full = true
    await withSessionFileAccess(
      f,
      () => full,
      async () => {
        await f.write(out, new TextEncoder().encode('full'))
        expect(new TextDecoder().decode(await f.read(out))).toBe('full')
        expect((await f.stat(out)).kind).toBe('file')
        expect((await f.list(outside)).map((entry) => entry.name)).toContain('x')
        expect(await f.realpath(out)).toBe(join(realpathSync.native(outside), 'x'))
        await f.mkdir(join(outside, 'd'))
        await f.rm(join(outside, 'd'), { recursive: true })
        await expect(f.write('.git/config', new Uint8Array())).rejects.toThrow(/denied by policy/)
        await expect(fs().read(out)).rejects.toThrow(/E_FS_DENIED/)
        full = false
        await expect(f.read(out)).rejects.toThrow(/完全权限/)
        full = true
        await f.rm(out)
      },
    )
    await expect(f.list(outside)).rejects.toThrow(/E_FS_DENIED/)
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
    expect(await f.realpath('late/new')).toBe(join(realpathSync.native(root), 'late', 'new'))
    mkdirSync(join(outside, 'late-target'))
    symlinkSync(join(outside, 'late-target'), join(root, 'late'), directoryLink)
    await expect(f.write('late/new', new Uint8Array([1]))).rejects.toThrow(/E_FS_DENIED/)
    expect(existsSync(join(outside, 'late-target', 'new'))).toBe(false)
  })
  it.each(
    ['read', 'write', 'stat', 'list', 'mkdir', 'rm'].flatMap((operation) =>
      (process.platform === 'win32' ? ['local'] : ['local', 'remote']).map((backend) => ({
        operation: operation as 'read' | 'write' | 'stat' | 'list' | 'mkdir' | 'rm',
        backend,
      })),
    ),
  )(
    'refuses $backend $operation after an authorized parent changes identity without accessing the outside tree',
    async ({ operation, backend }) => {
      const canonicalRoot = realpathSync.native(root)
      const checked = join(canonicalRoot, 'checked')
      const destination = join(realpathSync.native(outside), 'protected')
      mkdirSync(checked)
      mkdirSync(destination)
      writeFileSync(join(checked, 'value'), 'authorized')
      writeFileSync(join(destination, 'value'), 'outside synthetic sentinel')
      const path = operation === 'list' ? checked : join(checked, operation === 'mkdir' ? 'new' : 'value')
      let changed = false
      const io =
        backend === 'local' ? localFsIo : createRemoteFsIo(createLoopbackTransport({ root: canonicalRoot }))
      const fenced = createFs(() => bindingFor(canonicalRoot), {
        ...io,
        async lstat(requested) {
          const result = await io.lstat(requested)
          if (!changed && requested === path) {
            changed = true
            renameSync(checked, join(canonicalRoot, 'checked-before-change'))
            symlinkSync(destination, checked, directoryLink)
          }
          return result
        },
      })
      const run = () =>
        operation === 'write'
          ? fenced.write(path, new TextEncoder().encode('replacement'))
          : operation === 'rm'
            ? fenced.rm(path, { recursive: true })
            : fenced[operation](path)
      await expect(run()).rejects.toThrow()
      expect(changed).toBe(true)
      expect(readFileSync(join(destination, 'value'), 'utf8')).toBe('outside synthetic sentinel')
      expect(existsSync(join(destination, 'new'))).toBe(false)
      expect(readFileSync(join(canonicalRoot, 'checked-before-change', 'value'), 'utf8')).toBe('authorized')
    },
  )
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
    const sibling = `${realpathSync.native(root)}-evil`
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
    for (const p of ['.', './', root, realpathSync.native(root), join(root, 'sub', '..')]) {
      const st = await f.stat(p)
      expect([p, st.kind]).toEqual([p, 'dir'])
    }
    expect((await f.list('.')).length).toBe(0)
    expect(await f.realpath('.')).toBe(realpathSync.native(root))
  })
  it('still refuses the parent of the workspace root', async () => {
    const f = createFs(() => bindingFor(root, []))
    await expect(f.stat('..')).rejects.toThrow(/E_FS_DENIED/)
    await expect(f.stat(dirname(realpathSync.native(root)))).rejects.toThrow(/E_FS_DENIED/)
  })
  it('still reports a symlink as a symlink, which is why the parent is resolved at all', async () => {
    const f = createFs(() => bindingFor(root, []))
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'link'), directoryLink)
    expect((await f.stat('link')).kind).toBe('symlink')
    expect((await f.stat('real')).kind).toBe('dir')
  })
})

// Full access widens every path no rule names, and the installation's own state - credentials and
// profiles - is such a path. The model may read it (a deliberate trade-off), but the file tools must
// not rewrite it: a profile.yaml saying `approvals.mode: off` outlives the session that wrote it.
describe('fs adapter, full access over the installation own state', () => {
  let base: string
  let root: string
  let home: string
  let protectedRoots: string[]
  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-own-state-')))
    root = join(base, 'work')
    home = join(base, 'home')
    mkdirSync(join(root, '.git'), { recursive: true })
    for (const dir of ['secrets/canary', 'auth/canary', 'profiles/local-dev', 'profiles-extra', 'other'])
      mkdirSync(join(home, dir), { recursive: true })
    writeFileSync(join(home, 'secrets', 'canary', 'probe'), 'CANARY-SECRETS')
    writeFileSync(join(home, 'auth', 'canary', 'probe.json'), 'CANARY-AUTH')
    writeFileSync(join(home, 'profiles', 'local-dev', 'profile.yaml'), 'name: local-dev\n')
    protectedRoots = ['secrets', 'auth', 'profiles'].map((dir) => join(home, dir))
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))
  const bytes = (text: string) => new TextEncoder().encode(text)
  const fenceFor = (workspace = root, caseSensitive = true) =>
    createFs(
      () => ({ policy: testFsPolicy(workspace, { deny: ['.git'] }), caseSensitive }),
      undefined,
      undefined,
      () => protectedRoots,
    )
  const full = <T>(f: object, invoke: () => Promise<T>): Promise<T> =>
    withSessionFileAccess(f, () => true, invoke)
  const profileYaml = () => join(home, 'profiles', 'local-dev', 'profile.yaml')

  it('keeps the state readable and refuses every way of changing it', async () => {
    const f = fenceFor()
    await full(f, async () => {
      expect(new TextDecoder().decode(await f.read(join(home, 'secrets', 'canary', 'probe')))).toBe(
        'CANARY-SECRETS',
      )
      expect(new TextDecoder().decode(await f.read(join(home, 'auth', 'canary', 'probe.json')))).toBe(
        'CANARY-AUTH',
      )
      expect((await f.list(join(home, 'profiles'))).map((e) => e.name)).toEqual(['local-dev'])
      expect((await f.stat(profileYaml())).kind).toBe('file')
      expect(await f.realpath(profileYaml())).toBe(profileYaml())
      const refused = /denied by policy/
      await expect(f.write(profileYaml(), bytes('approvals:\n  mode: off\n'))).rejects.toThrow(refused)
      await expect(f.write(join(home, 'profiles', 'local-dev', 'new.yaml'), bytes('x'))).rejects.toThrow(
        refused,
      )
      await expect(f.write(join(home, 'secrets', 'fresh', 'k'), bytes('x'))).rejects.toThrow(refused)
      await expect(f.mkdir(join(home, 'auth', 'new'))).rejects.toThrow(refused)
      await expect(f.rm(profileYaml())).rejects.toThrow(refused)
      await expect(f.rm(join(home, 'profiles'), { recursive: true })).rejects.toThrow(refused)
      // The home itself holds all of it: removing it recursively is removing the state.
      await expect(f.rm(home, { recursive: true })).rejects.toThrow(refused)
      await expect(f.write(profileYaml(), bytes('x'))).rejects.toMatchObject({ code: 'E_FS_DENIED' })
    })
    expect(readFileSync(profileYaml(), 'utf8')).toBe('name: local-dev\n')
    expect(existsSync(join(home, 'profiles', 'local-dev', 'new.yaml'))).toBe(false)
    expect(existsSync(join(home, 'auth', 'new'))).toBe(false)
  })

  it('changes nothing else under full access: other home paths, siblings and the workspace stay writable', async () => {
    const f = fenceFor()
    await full(f, async () => {
      await f.write(join(home, 'other', 'x'), bytes('ok'))
      await f.write(join(home, 'profiles-extra', 'x'), bytes('ok'))
      await f.write('inside.txt', bytes('ok'))
      await f.rm(join(home, 'other', 'x'))
      await expect(f.write('.git/config', bytes('x'))).rejects.toThrow(/denied by policy/)
    })
    expect(readFileSync(join(root, 'inside.txt'), 'utf8')).toBe('ok')
  })

  it('does not touch the answer without full access', async () => {
    const f = fenceFor()
    await expect(f.read(profileYaml())).rejects.toThrow(/完全权限/)
    await expect(f.write(profileYaml(), bytes('x'))).rejects.toThrow(/完全权限/)
    await f.write('inside.txt', bytes('ok'))
    // The revocation is seen at once, mid-invocation.
    let on = true
    await withSessionFileAccess(
      f,
      () => on,
      async () => {
        await expect(f.write(profileYaml(), bytes('x'))).rejects.toThrow(/denied by policy/)
        on = false
        await expect(f.write(profileYaml(), bytes('x'))).rejects.toThrow(/完全权限/)
      },
    )
  })

  it('holds through symlinks, case and dot segments, and reads the roots on every call', async () => {
    const f = fenceFor(root, false)
    symlinkSync(join(home, 'profiles'), join(root, 'alias'), directoryLink)
    symlinkSync(profileYaml(), join(root, 'file-alias'))
    symlinkSync(join(home, 'profiles', 'later'), join(root, 'dangling'))
    await full(f, async () => {
      expect(new TextDecoder().decode(await f.read('alias/local-dev/profile.yaml'))).toBe('name: local-dev\n')
      for (const spelling of [
        'alias/local-dev/profile.yaml',
        'alias/new.yaml',
        'file-alias',
        'dangling',
        join(home, 'PROFILES', 'local-dev', 'profile.yaml'),
        join(home, 'other', '..', 'profiles', 'local-dev', 'profile.yaml'),
        join(home, 'profiles', 'a', '..', 'local-dev', 'profile.yaml'),
      ])
        await expect(f.write(spelling, bytes('x')), spelling).rejects.toThrow(/denied by policy/)
      await expect(f.rm('file-alias')).rejects.toThrow(/denied by policy/)
      protectedRoots = []
      await f.write(join(home, 'other', 'y'), bytes('ok'))
      await f.write('alias/new.yaml', bytes('now writable'))
    })
    expect(existsSync(join(home, 'profiles', 'later'))).toBe(false)
  })

  it('refuses under full access even when the workspace itself covers the state, and leaves the workspace case alone otherwise', async () => {
    const f = fenceFor(home)
    // An explicit workspace over the home keeps its ordinary behaviour without full access ...
    await f.write(join(home, 'profiles', 'local-dev', 'plain.txt'), bytes('ok'))
    // ... and loses the write to the state once the session has full access, reads included staying open.
    await full(f, async () => {
      expect(new TextDecoder().decode(await f.read(profileYaml()))).toBe('name: local-dev\n')
      await expect(f.write(profileYaml(), bytes('x'))).rejects.toThrow(/denied by policy/)
      await f.write(join(home, 'other', 'z'), bytes('ok'))
    })
  })
})
