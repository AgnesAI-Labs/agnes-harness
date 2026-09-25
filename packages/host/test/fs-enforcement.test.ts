import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeSeamInit } from '@agnes/base/testkit'
import { assertFsEnforces, type FsOps } from '@agnes/core'
import { fencedFs, testFsPolicy } from '@agnes/core/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createFs } from '../src/adapters/fs.js'
import { createRemoteFsIo } from '../src/adapters/fs-io-remote.js'
import { createLoopbackTransport } from '../src/adapters/remote-transport.js'
import { memoryFsIo } from '../testkit/fs-io-memory.js'

/**
 * One rule, one place: the file system that moves the bytes decides whether a path is allowed, and
 * the kernel decides nothing. That only holds if every file system in the repository decides the
 * same way, so every one of them is run through the same set of spellings here - the ones that used
 * to get past a comparison made on the raw string a caller wrote.
 *
 * The last case in this file scans the repository for file systems that refuse a path and fails if
 * one of them is not in the table below, because an implementation nobody put in the table is the
 * hole this file exists to close.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agnes-fsenf-'))
  dirs.push(d)
  return d
}

type Impl = {
  /** The source file that owns the comparison, matched against what the scan below finds. */
  file: string
  deny: string[]
  /** Whether this implementation also carries the host-integrity floor (.git, .agh/secrets, .agnes/secrets). */
  floor: boolean
  /**
   * Builds the file system with its denied contents in place, and says what its root is. An
   * implementation whose tree is not on disk also says how to plant a symlink in it.
   */
  open(): { fs: FsOps; root: string; link?: (at: string, target: string) => void }
  /** The canonical spelling of `root` the policy is built at: realpath where symlinks resolve, identity elsewhere. */
  realRoot(root: string): string
  /** Whether it resolves a symlink before judging, and whether it folds case. */
  resolvesSymlinks: boolean
  foldsCase: boolean
  /** Speaks posix paths only, so it is left out on win32. */
  posixOnly?: true
}

/**
 * The workspace deny list the host installs, and the one it installs for its own data directory.
 * `.agnes/secrets` is the secrets directory's name from before the `.agh` rename; it stays denied.
 */
const WORKSPACE_DENY = ['.git', '.agh/secrets', '.agnes/secrets']
const DATA_DENY = ['secrets', 'tables', 'audit', 'sessions.db']

function seedReal(root: string, deny: string[]): void {
  for (const d of deny) {
    mkdirSync(join(root, d), { recursive: true })
    writeFileSync(join(root, d, 'inside'), 'a credential', 'utf8')
  }
  writeFileSync(join(root, 'allowed.txt'), 'ordinary', 'utf8')
}

const IMPLEMENTATIONS: Record<string, Impl> = {
  'host adapter, workspace deny list': {
    file: 'packages/host/src/adapters/fs.ts',
    deny: WORKSPACE_DENY,
    floor: true,
    open() {
      const root = scratch()
      seedReal(root, WORKSPACE_DENY)
      const fs = createFs(() => ({
        policy: testFsPolicy(realpathSync.native(root), { deny: WORKSPACE_DENY }),
        caseSensitive: false,
      }))
      return { fs, root }
    },
    realRoot: (r) => realpathSync.native(r),
    resolvesSymlinks: true,
    foldsCase: true,
  },
  'host adapter, data directory deny list': {
    file: 'packages/host/src/adapters/fs.ts',
    deny: DATA_DENY,
    floor: true,
    open() {
      const root = scratch()
      seedReal(root, DATA_DENY)
      const fs = createFs(() => ({
        policy: testFsPolicy(realpathSync.native(root), { deny: DATA_DENY }),
        caseSensitive: false,
      }))
      return { fs, root }
    },
    realRoot: (r) => realpathSync.native(r),
    resolvesSymlinks: true,
    foldsCase: true,
  },
  "base's in-memory seam context, workspace": {
    file: 'packages/base/testkit/seam-init.ts',
    deny: WORKSPACE_DENY,
    floor: true,
    open() {
      const root = '/work/proj'
      const ctx = fakeSeamInit({
        workspaceRoot: root,
        files: Object.fromEntries(WORKSPACE_DENY.map((d) => [`${d}/inside`, 'a credential'])),
      })
      return { fs: ctx.adapters.fs, root }
    },
    realRoot: (r) => r,
    resolvesSymlinks: false,
    foldsCase: false,
  },
  "base's in-memory seam context, data directory": {
    file: 'packages/base/testkit/seam-init.ts',
    deny: DATA_DENY,
    floor: false,
    open() {
      const root = '/home/u/.agh'
      return { fs: fakeSeamInit({ dataDir: root }).adapters.dataFs, root }
    },
    realRoot: (r) => r,
    resolvesSymlinks: false,
    foldsCase: false,
  },
  "core's test double": {
    file: 'packages/core/testkit/fenced-fs.ts',
    deny: WORKSPACE_DENY,
    floor: true,
    open() {
      const root = '/w'
      const inner: FsOps = {
        read: async () => new Uint8Array(),
        write: async () => undefined,
        list: async () => [],
        stat: async () => ({ kind: 'file' as const, size: 0, mtimeMs: 0 }),
      }
      return { fs: fencedFs(inner, testFsPolicy(root, { deny: WORKSPACE_DENY })), root }
    },
    realRoot: (r) => r,
    resolvesSymlinks: false,
    foldsCase: false,
  },
  'host adapter over memory io': {
    file: 'packages/host/src/adapters/fs.ts',
    deny: WORKSPACE_DENY,
    floor: true,
    open() {
      const root = '/mem/ws'
      const mem = memoryFsIo()
      mem.seedDir(root)
      for (const d of WORKSPACE_DENY) mem.seedFile(`${root}/${d}/inside`, 'a credential')
      mem.seedFile(`${root}/allowed.txt`, 'ordinary')
      const fs = createFs(
        () => ({ policy: testFsPolicy(root, { deny: WORKSPACE_DENY }), caseSensitive: true }),
        mem,
      )
      return { fs, root, link: (at, target) => mem.symlink(target, at) }
    },
    realRoot: (r) => r,
    resolvesSymlinks: true,
    foldsCase: false,
    posixOnly: true,
  },
  'host adapter, remote io over loopback transport': {
    file: 'packages/host/src/adapters/fs.ts',
    deny: WORKSPACE_DENY,
    floor: true,
    open() {
      const root = scratch()
      seedReal(root, WORKSPACE_DENY)
      const fs = createFs(
        () => ({
          policy: testFsPolicy(realpathSync.native(root), { deny: WORKSPACE_DENY }),
          caseSensitive: true,
        }),
        createRemoteFsIo(createLoopbackTransport({ root })),
      )
      return { fs, root }
    },
    realRoot: (r) => realpathSync.native(r),
    resolvesSymlinks: true,
    // Case-fold behaviour lives in fs.ts itself, already exercised by the two real-disk rows above;
    // this row's only new coverage is the io, not the fold, so it skips the redundant run.
    foldsCase: false,
    // The remote io shells out to python3/readlink/mkdir/rm as spawned executables, which win32 has
    // no equivalents for as plain argv[0]s.
    posixOnly: true,
  },
}

// These boundaries validate canonical paths but are not FsOps implementations, so they cannot run
// through describe.each(IMPLEMENTATIONS). Keep their dedicated behavioral test visible to this
// repository-wide inventory instead of silently exempting their source file from the scan.
const AUXILIARY_PATH_GUARDS: Record<string, { test: string; evidence: RegExp[] }> = {
  'packages/base/extensions/fs-checkpoint/src/seam.ts': {
    test: 'packages/base/extensions/fs-checkpoint/test/seam.test.ts',
    evidence: [/E_FS_DENIED/, /symlink/],
  },
}

/** The spellings of one file under a denied directory. Each one used to reach the bytes. */
function spellings(root: string, deny: string, file: string): Array<[string, string]> {
  return [
    ['plain relative', `${deny}/${file}`],
    ['dot-slash prefixed', `./${deny}/${file}`],
    ['a `..` that returns inside', `elsewhere/../${deny}/${file}`],
    ['absolute', `${root}/${deny}/${file}`],
    ['the denied directory itself', deny],
  ]
}

const flipCase = (s: string): string => (s === s.toUpperCase() ? s.toLowerCase() : s.toUpperCase())

/** The policy one implementation row enforces, rebuilt for the kernel probe with the same root. */
const policyFor = (impl: Impl, root: string) =>
  testFsPolicy(impl.realRoot(root), {
    deny: impl.deny,
    floor: impl.floor,
  })

describe.each(
  Object.entries(IMPLEMENTATIONS).filter(([, i]) => !i.posixOnly || process.platform !== 'win32'),
)('%s', (_name, impl) => {
  // The remote io spawns one python3 process per canonicalized path segment; the local and
  // in-memory rows finish in milliseconds, but this loop's ~500 subprocess spawns for the remote
  // row alone need more than vitest's 5s default.
  it('refuses every spelling of every denied path, on all four operations', async () => {
    const { fs, root } = impl.open()
    for (const deny of impl.deny)
      for (const [how, path] of spellings(root, deny, 'inside')) {
        await expect(fs.read(path), how).rejects.toThrow(/E_FS_DENIED/)
        await expect(fs.list(path), how).rejects.toThrow(/E_FS_DENIED/)
        await expect(fs.stat(path), how).rejects.toThrow(/E_FS_DENIED/)
        await expect(fs.write(path, new Uint8Array([1])), how).rejects.toThrow(/E_FS_DENIED/)
      }
  }, 90_000)

  it('refuses a path outside its root', async () => {
    const { fs, root } = impl.open()
    for (const path of ['../outside', `${root}/../outside`, '/etc/passwd'])
      await expect(fs.read(path), path).rejects.toThrow(/E_FS_DENIED/)
  })

  // The remote row spawns a process per path segment here too: about 3 s alone, and more than five
  // times that on a loaded macOS runner.
  it('passes the enforcement check the kernel runs before a session opens', async () => {
    const { fs, root } = impl.open()
    await expect(assertFsEnforces(fs, policyFor(impl, root))).resolves.toBeUndefined()
  }, 60_000)

  it.runIf(impl.resolvesSymlinks)('refuses a directory link pointing at a denied path', async () => {
    const {
      fs,
      root,
      link = (at, target) => {
        symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
        expect(realpathSync.native(at)).toBe(realpathSync.native(target))
      },
    } = impl.open()
    link(join(root, 'link'), join(root, impl.deny[0] as string))

    await expect(fs.read('link/inside')).rejects.toThrow(/E_FS_DENIED/)
    await expect(fs.list('link')).rejects.toThrow(/E_FS_DENIED/)
    await expect(fs.stat('link/inside')).rejects.toThrow(/E_FS_DENIED/)
    await expect(fs.write('link/inside', new Uint8Array([1]))).rejects.toThrow(/E_FS_DENIED/)
  })

  // A deny list that does not state the answer is not a licence to allow: on a volume where
  // `.GIT/config` and `.git/config` are the same file, the folded comparison is the correct one,
  // and it is what the adapter does unless the caller declares the volume case-sensitive.
  //
  // The root is deliberately empty. Where the denied directory exists on a case-insensitive volume,
  // realpath canonicalises the variant back to the real name and the refusal proves nothing about
  // the comparison; with nothing on disk to canonicalise against, only the fold can answer.
  it.runIf(impl.foldsCase)('refuses a case variation unless told the volume is case-sensitive', async () => {
    const root = scratch()
    const deny = impl.deny[0] as string
    const folded = createFs(() => ({
      policy: testFsPolicy(realpathSync.native(root), { deny: impl.deny }),
      caseSensitive: false,
    }))
    await expect(folded.read(`${flipCase(deny)}/inside`)).rejects.toThrow(/E_FS_DENIED/)
    // Declaring the volume case-sensitive is the one way to get the byte-exact comparison, and it
    // has to keep working: on such a volume the variant names a different file. Whether that file
    // then exists is the platform's business, so only the reason is asserted, not the outcome.
    const sensitive = createFs(() => ({
      policy: testFsPolicy(realpathSync.native(root), { deny: impl.deny }),
      caseSensitive: true,
    }))
    const why = await sensitive.read(`${flipCase(deny)}/inside`).then(
      () => '',
      (e: Error) => e.message,
    )
    expect(why).not.toMatch(/E_FS_DENIED/)
  })
})

describe('every file system in the repository is in the table above', () => {
  // Comments are removed first. This very rule is described in prose in more than one source file,
  // and a scan that read those descriptions as implementations would name files that refuse nothing.
  const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  const sources = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (['node_modules', 'dist', 'gen', 'generated', 'fixtures'].includes(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) sources(full, out)
      else if (/\.((m|c)?tsx?|vue|css)$/.test(entry) && !/\.test\.(m|c)?tsx?$/.test(entry)) out.push(full)
    }
    return out
  }

  it('finds no path-refusing file system outside it', () => {
    const fsImplementations = Object.values(IMPLEMENTATIONS).map((i) => i.file)
    const covered = new Set([...fsImplementations, ...Object.keys(AUXILIARY_PATH_GUARDS)])
    const found = sources(join(repoRoot, 'packages'))
      // A throw carrying the marker, spelled out or through the exported constant. The file that
      // defines the marker does not throw it and is not an implementation.
      .filter((f) => /throw[\s\S]{0,120}FS_DENIED/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(repoRoot, f).split(sep).join('/'))
    expect(found.length, 'the scan found nothing, so it is proving nothing').toBeGreaterThan(0)
    expect(
      found.filter((f) => !covered.has(f)).sort(),
      'a file system that refuses paths but is not in IMPLEMENTATIONS is one nothing here holds to the rule',
    ).toEqual([])
    // And the other way: a table row naming a file that no longer refuses anything is a row that
    // has quietly stopped testing what it says it tests.
    expect(fsImplementations.filter((f) => !found.includes(f)).sort()).toEqual([])
    for (const [source, aux] of Object.entries(AUXILIARY_PATH_GUARDS)) {
      expect(found, source).toContain(source)
      const evidence = readFileSync(join(repoRoot, aux.test), 'utf8')
      for (const marker of aux.evidence) expect(evidence, `${aux.test}: ${marker}`).toMatch(marker)
    }
  })

  it('scans the whole of packages/, not one corner of it', () => {
    const files = sources(join(repoRoot, 'packages')).map((f) => relative(repoRoot, f).split(sep).join('/'))
    expect(files.length).toBeGreaterThan(100)
    // Every package is reached, so a file system added to a package this file has never heard of is
    // still found.
    const packages = readdirSync(join(repoRoot, 'packages')).filter((p) =>
      statSync(join(repoRoot, 'packages', p)).isDirectory(),
    )
    for (const p of packages)
      expect(
        files.some((f) => f.startsWith(`packages/${p}/`)),
        p,
      ).toBe(true)
  })
})
