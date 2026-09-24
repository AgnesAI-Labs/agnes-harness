import { createHash } from 'node:crypto'
import { existsSync, promises as fs, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { FsEntry } from '@agnes/extension-api'
import { readBlob, readCommit, resolveRef, writeBlob, writeCommit, writeRef, writeTree } from 'isomorphic-git'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostFs, SeamInitContext } from '../../../src/seam-init.js'
import { createFsCheckpoint } from '../src/seam.js'
import { type CheckpointManifest, ShadowGit } from '../src/shadow-git.js'

const denied = (path: string) => Object.assign(new Error(`E_FS_DENIED: ${path}`), { code: 'E_FS_DENIED' })
function realFs(root: string): HostFs {
  const inside = (path: string): string => {
    const base = realpathSync(root)
    const absolute = isAbsolute(path) ? path : resolve(base, path)
    let probe = absolute
    while (!existsSync(probe)) probe = dirname(probe)
    const target = resolve(realpathSync(probe), relative(probe, absolute))
    const rel = relative(base, target)
    if (rel.startsWith('..') || isAbsolute(rel)) throw denied(path)
    return target
  }
  const kind = (stat: Awaited<ReturnType<typeof fs.lstat>>): FsEntry['kind'] =>
    stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : 'other'
  return {
    realpath: async (path) => inside(path),
    read: async (path) => new Uint8Array(await fs.readFile(inside(path))),
    write: async (path, data) => {
      const target = inside(path)
      await fs.mkdir(dirname(target), { recursive: true })
      await fs.writeFile(target, data)
    },
    stat: async (path) => {
      const base = realpathSync(root)
      const absolute = isAbsolute(path) ? path : resolve(base, path)
      inside(path)
      const stat = await fs.lstat(absolute)
      return { kind: kind(stat), size: stat.size, mtimeMs: stat.mtimeMs }
    },
    list: async (path) =>
      (await fs.readdir(inside(path), { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        kind: entry.isSymbolicLink()
          ? 'symlink'
          : entry.isFile()
            ? 'file'
            : entry.isDirectory()
              ? 'dir'
              : 'other',
      })),
    mkdir: async (path) => void (await fs.mkdir(inside(path), { recursive: true })),
    rm: async (path, opts) => void (await fs.rm(inside(path), { recursive: opts?.recursive ?? false })),
  }
}
function context(
  workspaceRoot: string,
  dataDir: string,
  preset: Record<string, unknown> = {},
): SeamInitContext {
  return {
    secrets: () => '',
    adapters: {
      fs: realFs(workspaceRoot),
      dataFs: realFs(dataDir),
      exec: async () => ({ code: 0, stdout: '', stderr: '', truncated: false, timedOut: false }),
      platform: {
        shell: () => 'posix',
        fs: () => ({ caseSensitive: true, pathSep: '/' }),
        terminal: () => ({ color: false }),
        capability: () => ({ level: 'unavailable', scope: [] }),
      },
      storage: {
        table: () => {
          throw new Error('checkpoint must not use storage.table')
        },
      },
    },
    profile: {
      name: 'test',
      resolvedProfileHash: null,
      workspaceRoot,
      dataDir,
      homeDir: dirname(dataDir),
      limits: {},
      preset,
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  }
}

const roots: string[] = []
async function setup(preset: Record<string, unknown> = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'agnes-checkpoint-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const data = join(root, 'data')
  await fs.mkdir(workspace)
  await fs.mkdir(data)
  const ids = Array.from({ length: 32 }, (_, n) => n.toString(16).padStart(32, '0'))
  let next = 0
  let clock = 1_800_000_000_000
  const deps = {
    nextId: () => ids[next++] as string,
    now: () => clock,
    workspaceHash: (value: string) => createHash('sha256').update(value).digest('hex'),
  }
  return {
    root,
    workspace,
    data,
    ids,
    deps,
    setClock: (value: number) => {
      clock = value
    },
    make: (over = deps) => createFsCheckpoint(context(workspace, data, preset), over),
  }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('filesystem checkpoint seam', () => {
  it('fits an independent checkpoint context to the invocation workspace', async () => {
    const h = await setup()
    const other = join(h.root, 'other-workspace')
    await fs.mkdir(other)
    await fs.writeFile(join(other, 'a.txt'), 'other')
    const seam = await h.make()
    const workspace = await seam.forWorkspace?.({ root: other, fs: realFs(other) })
    expect(workspace).toBeDefined()
    const id = (await workspace?.snapshot(['a.txt'], 'other'))?.id
    expect(id).toBeDefined()
    expect(await seam.list()).toEqual([])
    expect(await workspace?.list()).toEqual([{ id, stepId: 'other' }])
  })

  it('serializes shadow repository initialization for concurrent sessions on the same workspace', async () => {
    const h = await setup()
    const original = ShadowGit.prototype.init
    let active = 0
    let maximum = 0
    const init = vi.spyOn(ShadowGit.prototype, 'init').mockImplementation(async function (
      this: ShadowGit,
      ...args: Parameters<ShadowGit['init']>
    ) {
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      try {
        return await original.apply(this, args)
      } finally {
        active--
      }
    })
    try {
      const seam = await h.make()
      maximum = 0
      const workspace = { root: h.workspace, fs: realFs(h.workspace) }
      const [one, two] = await Promise.all([seam.forWorkspace?.(workspace), seam.forWorkspace?.(workspace)])
      expect(one).toBeDefined()
      expect(two).toBeDefined()
      expect(maximum).toBe(1)
    } finally {
      init.mockRestore()
    }
  })

  it('persists parentless checkpoints across seam reconstruction and rewinds the checkpoint itself', async () => {
    const h = await setup()
    await fs.writeFile(join(h.workspace, 'a.txt'), 'v1')
    const first = await h.make()
    const id1 = (await first.snapshot(['a.txt'], '1/1')).id
    await fs.writeFile(join(h.workspace, 'a.txt'), 'v2')
    const id2 = (await first.snapshot(['a.txt'], '1/2')).id
    const hash = h.deps.workspaceHash(await fs.realpath(h.workspace))
    const shadow = new ShadowGit(realFs(h.data), `checkpoints/${hash.slice(0, 16)}`)
    await shadow.init({ workspaceHash: hash })
    for (const id of [id1, id2]) {
      const oid = await resolveRef({
        fs: shadow.fs,
        gitdir: shadow.gitdir,
        ref: `refs/agnes/checkpoints/${id}`,
      })
      expect((await readCommit({ fs: shadow.fs, gitdir: shadow.gitdir, oid })).commit.parent).toEqual([])
    }
    await fs.writeFile(join(h.workspace, 'a.txt'), 'v3')
    const reopened = await h.make()
    expect(await reopened.list()).toEqual([
      { id: id1, stepId: '1/1' },
      { id: id2, stepId: '1/2' },
    ])
    await reopened.rewind(id2)
    expect(await fs.readFile(join(h.workspace, 'a.txt'), 'utf8')).toBe('v2')
    await reopened.rewind(id1)
    expect(await fs.readFile(join(h.workspace, 'a.txt'), 'utf8')).toBe('v1')
  })

  it('uses explicit absent tombstones and restores deleted files idempotently', async () => {
    const h = await setup()
    const seam = await h.make()
    const absent = (await seam.snapshot(['new.txt'], 'missing')).id
    await fs.writeFile(join(h.workspace, 'new.txt'), 'created')
    await seam.rewind(absent)
    await seam.rewind(absent)
    await expect(fs.stat(join(h.workspace, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await fs.writeFile(join(h.workspace, 'old.txt'), 'original')
    const present = (await seam.snapshot(['old.txt'], 'present')).id
    await fs.rm(join(h.workspace, 'old.txt'))
    await seam.rewind(present)
    await seam.rewind(present)
    expect(await fs.readFile(join(h.workspace, 'old.txt'), 'utf8')).toBe('original')
  })

  it('keeps duplicate snapshots distinct and canonicalizes duplicate parent-symlink paths', async () => {
    const h = await setup()
    await fs.mkdir(join(h.workspace, 'real'))
    await fs.writeFile(join(h.workspace, 'real/a.agnes-meta.json'), 'safe')
    // Windows directory junctions exercise real parent canonicalization without symlink privileges.
    const windows = process.platform === 'win32'
    await fs.symlink(
      windows ? join(h.workspace, 'real') : 'real',
      join(h.workspace, 'alias'),
      windows ? 'junction' : 'dir',
    )
    expect(await fs.realpath(join(h.workspace, 'alias'))).toBe(await fs.realpath(join(h.workspace, 'real')))
    const seam = await h.make()
    const a = await seam.snapshot(['real/a.agnes-meta.json', 'alias/a.agnes-meta.json'], 'same')
    const b = await seam.snapshot(['real/a.agnes-meta.json'], 'same')
    expect(a.id).not.toBe(b.id)
    expect(await seam.list()).toHaveLength(2)
    const hash = h.deps.workspaceHash(await fs.realpath(h.workspace))
    const shadow = new ShadowGit(realFs(h.data), `checkpoints/${hash.slice(0, 16)}`)
    await shadow.init({ workspaceHash: hash })
    expect((await shadow.read(a.id)).manifest.entries.map((entry) => entry.rel)).toEqual([
      'real/a.agnes-meta.json',
    ])
  })

  it('restores mixed present and absent paths', async () => {
    const h = await setup()
    await fs.writeFile(join(h.workspace, 'keep.txt'), 'before')
    const seam = await h.make()
    const id = (await seam.snapshot(['gone.txt', 'keep.txt', 'gone.txt'], 'mixed')).id
    await fs.writeFile(join(h.workspace, 'gone.txt'), 'remove me')
    await fs.writeFile(join(h.workspace, 'keep.txt'), 'after')
    await seam.rewind(id)
    expect(await fs.readFile(join(h.workspace, 'keep.txt'), 'utf8')).toBe('before')
    await expect(fs.stat(join(h.workspace, 'gone.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects relative and absolute escapes without creating refs or modifying outside content', async () => {
    const h = await setup()
    const outside = join(h.root, 'outside.txt')
    await fs.writeFile(outside, 'outside')
    const seam = await h.make()
    for (const path of ['../outside.txt', outside])
      await expect(seam.snapshot([path], 'escape')).rejects.toThrow(/E_FS_DENIED/)
    expect(await seam.list()).toEqual([])
    expect(await fs.readFile(outside, 'utf8')).toBe('outside')
  })

  it('rejects symlink escapes, final symlinks and a retarget before changing any entry', async () => {
    const h = await setup()
    const outside = join(h.root, 'outside.txt')
    await fs.writeFile(outside, 'outside')
    await fs.writeFile(join(h.workspace, 'a.txt'), 'one')
    await fs.writeFile(join(h.workspace, 'b.txt'), 'two')
    await fs.symlink(outside, join(h.workspace, 'outside-link'))
    await fs.symlink('a.txt', join(h.workspace, 'final-link'))
    const seam = await h.make()
    await expect(seam.snapshot(['outside-link'], 'escape')).rejects.toThrow(/E_FS_DENIED/)
    await expect(seam.snapshot(['final-link'], 'link')).rejects.toThrow(/E_CHECKPOINT_UNSUPPORTED/)
    const id = (await seam.snapshot(['a.txt', 'b.txt'], 'retarget')).id
    await fs.writeFile(join(h.workspace, 'a.txt'), 'changed-a')
    await fs.writeFile(join(h.workspace, 'b.txt'), 'changed-b')
    await fs.rm(join(h.workspace, 'b.txt'))
    await fs.symlink('a.txt', join(h.workspace, 'b.txt'))
    await expect(seam.rewind(id)).rejects.toThrow(/E_CHECKPOINT_PATH_CHANGED/)
    expect(await fs.readFile(join(h.workspace, 'a.txt'), 'utf8')).toBe('changed-a')
  })

  it('propagates non-ENOENT and rejects unstable capture without creating refs', async () => {
    const h = await setup()
    await fs.writeFile(join(h.workspace, 'a.txt'), 'a')
    const ctx = context(h.workspace, h.data)
    ctx.adapters.fs.read = async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    }
    const denied = await createFsCheckpoint(ctx, h.deps)
    await expect(denied.snapshot(['a.txt'], 'denied')).rejects.toMatchObject({ code: 'EACCES' })
    const racedCtx = context(h.workspace, h.data)
    let tick = 0
    const stat = racedCtx.adapters.fs.stat.bind(racedCtx.adapters.fs)
    racedCtx.adapters.fs.stat = async (path) => ({ ...(await stat(path)), mtimeMs: tick++ })
    const raced = await createFsCheckpoint(racedCtx, h.deps)
    await expect(raced.snapshot(['a.txt'], 'race')).rejects.toThrow(/E_CHECKPOINT_RACE/)
    expect(await raced.list()).toEqual([])
  })

  it('fails closed for large text and binary bytes without adding a checkpoint', async () => {
    const h = await setup({ checkpoint: { max_file_bytes: 4 } })
    const seam = await h.make()
    await fs.writeFile(join(h.workspace, 'large.txt'), '12345')
    await expect(seam.snapshot(['large.txt'], 'large')).rejects.toMatchObject({
      code: 'E_CHECKPOINT_UNRESTORABLE',
      size: 5,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    await fs.writeFile(join(h.workspace, 'binary'), new Uint8Array([1, 0, 2]))
    await expect(seam.snapshot(['binary'], 'binary')).rejects.toMatchObject({
      code: 'E_CHECKPOINT_UNRESTORABLE',
      size: 3,
    })
    expect(await seam.list()).toEqual([])
  })

  it('rejects a full workspace identity collision on the shared prefix', async () => {
    const h = await setup()
    const one = { ...h.deps, workspaceHash: () => `aaaaaaaaaaaaaaaa${'1'.repeat(48)}` }
    const two = { ...h.deps, workspaceHash: () => `aaaaaaaaaaaaaaaa${'2'.repeat(48)}` }
    await h.make(one)
    await expect(h.make(two)).rejects.toThrow(/E_CHECKPOINT_IDENTITY/)
  })

  it('serializes concurrent snapshots into complete, independently readable refs', async () => {
    const h = await setup()
    await fs.writeFile(join(h.workspace, 'a.txt'), 'same')
    const seam = await h.make()
    const made = await Promise.all(Array.from({ length: 8 }, (_, n) => seam.snapshot(['a.txt'], `s${n}`)))
    expect(new Set(made.map((item) => item.id)).size).toBe(8)
    expect(await seam.list()).toHaveLength(8)
    for (const item of made) {
      await fs.writeFile(join(h.workspace, 'a.txt'), `changed after ${item.id}`)
      await expect(seam.rewind(item.id)).resolves.toBeUndefined()
      expect(await fs.readFile(join(h.workspace, 'a.txt'), 'utf8')).toBe('same')
    }
  }, 30_000) // Eight real snapshots and restores include durable Git object validation.

  it('fails closed when manifest identity, commit parents, or payload bytes are tampered', async () => {
    for (const variant of ['identity', 'parent', 'payload'] as const) {
      const h = await setup()
      await fs.writeFile(join(h.workspace, 'a.txt'), 'trusted')
      const seam = await h.make()
      const id = (await seam.snapshot(['a.txt'], variant)).id
      const hash = h.deps.workspaceHash(await fs.realpath(h.workspace))
      const shadow = new ShadowGit(realFs(h.data), `checkpoints/${hash.slice(0, 16)}`)
      await shadow.init({ workspaceHash: hash })
      const ref = `refs/agnes/checkpoints/${id}`
      const oldOid = await resolveRef({ fs: shadow.fs, gitdir: shadow.gitdir, ref })
      const oldCommit = (await readCommit({ fs: shadow.fs, gitdir: shadow.gitdir, oid: oldOid })).commit
      const oldManifest = JSON.parse(
        new TextDecoder().decode(
          (await readBlob({ fs: shadow.fs, gitdir: shadow.gitdir, oid: oldOid, filepath: 'manifest.json' }))
            .blob,
        ),
      ) as CheckpointManifest
      if (variant === 'identity') oldManifest.workspaceHash = 'f'.repeat(64)
      const file = oldManifest.entries[0]
      if (file?.state !== 'file') throw new Error('fixture expected a file')
      const payload =
        variant === 'payload'
          ? new TextEncoder().encode('corrupt')
          : (await readBlob({ fs: shadow.fs, gitdir: shadow.gitdir, oid: oldOid, filepath: file.payload }))
              .blob
      const payloadOid = await writeBlob({ fs: shadow.fs, gitdir: shadow.gitdir, blob: payload })
      const payloadTree = await writeTree({
        fs: shadow.fs,
        gitdir: shadow.gitdir,
        tree: [{ mode: '100644', path: file.payload.slice(8), oid: payloadOid, type: 'blob' }],
      })
      const manifestOid = await writeBlob({
        fs: shadow.fs,
        gitdir: shadow.gitdir,
        blob: new TextEncoder().encode(JSON.stringify(oldManifest)),
      })
      const tree = await writeTree({
        fs: shadow.fs,
        gitdir: shadow.gitdir,
        tree: [
          { mode: '100644', path: 'manifest.json', oid: manifestOid, type: 'blob' },
          { mode: '040000', path: 'payload', oid: payloadTree, type: 'tree' },
        ],
      })
      const oid = await writeCommit({
        fs: shadow.fs,
        gitdir: shadow.gitdir,
        commit: {
          ...oldCommit,
          tree,
          parent: variant === 'parent' ? [oldOid] : [],
        },
      })
      await writeRef({ fs: shadow.fs, gitdir: shadow.gitdir, ref, value: oid, force: true })
      await expect(seam.rewind(id)).rejects.toThrow(/E_CHECKPOINT_CORRUPT/)
      await expect(seam.list()).rejects.toThrow(/E_CHECKPOINT_CORRUPT/)
    }
  })

  it('deletes refs only outside keep and age retention, and retained refs survive reopening', async () => {
    const h = await setup()
    const hash = 'a'.repeat(64)
    const makeShadow = async (name: string) => {
      const shadow = new ShadowGit(realFs(h.data), name)
      await shadow.init({ workspaceHash: hash })
      return shadow
    }
    const old = await makeShadow('old-quadrants')
    for (let n = 0; n < 4; n++)
      await old.create({ id: h.ids[n] as string, stepId: `old-${n}`, createdAt: n, files: [] })
    expect(
      await old.gc({ keep: 2, now: 10 * 24 * 60 * 60 * 1000, maxAgeMs: 7 * 24 * 60 * 60 * 1000 }),
    ).toEqual({ deleted: [h.ids[1], h.ids[0]] })
    const recent = await makeShadow('recent-quadrants')
    const now = 10 * 24 * 60 * 60 * 1000
    for (let n = 4; n < 8; n++)
      await recent.create({ id: h.ids[n] as string, stepId: `recent-${n}`, createdAt: now - n, files: [] })
    expect(await recent.gc({ keep: 1, now, maxAgeMs: 7 * 24 * 60 * 60 * 1000 })).toEqual({ deleted: [] })
    const reopened = await makeShadow('old-quadrants')
    expect((await reopened.list()).map((item) => item.id)).toEqual([h.ids[3], h.ids[2]])
    await expect(
      resolveRef({ fs: old.fs, gitdir: old.gitdir, ref: `refs/agnes/checkpoints/${h.ids[0]}` }),
    ).rejects.toBeTruthy()
    await expect(reopened.read(h.ids[3] as string)).resolves.toMatchObject({ manifest: { stepId: 'old-3' } })
  })
})
