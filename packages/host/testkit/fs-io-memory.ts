import type { FsIo, FsIoStat } from '../src/adapters/fs-io.js'

/**
 * A posix, case-sensitive tree in memory: the second FsIo behind the fence's contract suite, and
 * the shape a remote io will take. Symlinks are first-class so the fence's escape, dangling and
 * cycle cases run here exactly as they run on disk. Paths are absolute and lexically resolved when
 * they arrive - the fence did that - and a symlink is never followed here: the fence walks links
 * itself through lstat/readlink, so a link in the middle of a path is a caller error answered as
 * ENOTDIR, the same answer the disk gives.
 */
type Node =
  | { kind: 'dir'; children: Map<string, Node>; mtimeMs: number }
  | { kind: 'file'; data: Uint8Array; mtimeMs: number }
  | { kind: 'symlink'; target: string; mtimeMs: number }

export type MemoryFsIo = FsIo & {
  seedDir(abs: string): void
  seedFile(abs: string, data: Uint8Array | string): void
  /** Creates a symlink at `at` pointing at `target`; the target need not exist. */
  symlink(target: string, at: string): void
}

type Dir = Extract<Node, { kind: 'dir' }>
type Code = 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'EEXIST' | 'ENOTEMPTY' | 'EINVAL' | 'ERR_FS_EISDIR'
const fail = (code: Code, abs: string): Error => Object.assign(new Error(`${code}: ${abs}`), { code })

const segments = (abs: string): string[] => {
  if (!abs.startsWith('/')) throw fail('EINVAL', abs)
  return abs.split('/').filter((s) => s !== '')
}

export function memoryFsIo(): MemoryFsIo {
  const root: Dir = { kind: 'dir', children: new Map(), mtimeMs: 0 }
  let clock = 1
  const now = (): number => clock++

  /** The node at `abs`, or undefined when a component is missing or is not a directory. */
  const lookup = (abs: string): Node | undefined => {
    let node: Node = root
    for (const seg of segments(abs)) {
      if (node.kind !== 'dir') return undefined
      const next = node.children.get(seg)
      if (!next) return undefined
      node = next
    }
    return node
  }
  /** The parent directory of `abs` and the final name; undefined when the parent is not a directory. */
  const parentOf = (abs: string): { dir: Dir; name: string } | undefined => {
    const segs = segments(abs)
    const name = segs.pop()
    if (name === undefined) return undefined
    const dir = lookup(`/${segs.join('/')}`)
    return dir?.kind === 'dir' ? { dir, name } : undefined
  }
  const mkdirp = (abs: string): Dir => {
    let node: Dir = root
    const segs = segments(abs)
    for (let index = 0; index < segs.length; index++) {
      const seg = segs[index] as string
      const next = node.children.get(seg)
      if (next === undefined) {
        const made: Dir = { kind: 'dir', children: new Map(), mtimeMs: now() }
        node.children.set(seg, made)
        node = made
      } else if (next.kind === 'dir') node = next
      // node:fs's mkdir(recursive) tells the final segment apart from an intermediate one: a
      // non-directory collision at the leaf is EEXIST (the thing you asked to create is already
      // there), the same collision partway down the path is ENOTDIR (the path can't continue
      // through it).
      else if (index === segs.length - 1) throw fail('EEXIST', abs)
      else throw fail('ENOTDIR', abs)
    }
    return node
  }
  /** Seeding only: creates the parent chain and sets the leaf, the way a test fixture would on disk. */
  const place = (abs: string, node: Node): void => {
    const slash = abs.lastIndexOf('/')
    const dir = mkdirp(slash === 0 ? '/' : abs.slice(0, slash))
    dir.children.set(abs.slice(slash + 1), node)
  }
  const sizeOf = (node: Node): number =>
    node.kind === 'file' ? node.data.byteLength : node.kind === 'symlink' ? node.target.length : 0
  const statOf = (node: Node): FsIoStat => ({ kind: node.kind, size: sizeOf(node), mtimeMs: node.mtimeMs })

  return {
    async lstat(abs) {
      const node = lookup(abs)
      return node === undefined ? undefined : statOf(node)
    },
    async readlink(abs) {
      const node = lookup(abs)
      if (node === undefined) throw fail('ENOENT', abs)
      if (node.kind !== 'symlink') throw fail('EINVAL', abs)
      return node.target
    },
    async readFile(abs) {
      const node = lookup(abs)
      if (node === undefined) throw fail('ENOENT', abs)
      if (node.kind === 'dir') throw fail('EISDIR', abs)
      if (node.kind !== 'file') throw fail('ENOENT', abs)
      return new Uint8Array(node.data)
    },
    async writeFile(abs, data) {
      const at = parentOf(abs)
      if (!at) throw fail('ENOENT', abs)
      // node:fs opens the path for writing: colliding with a directory is EISDIR, the same code
      // `open()` gives, not EEXIST - there's no O_EXCL here to make existence itself the problem.
      if (at.dir.children.get(at.name)?.kind === 'dir') throw fail('EISDIR', abs)
      at.dir.children.set(at.name, { kind: 'file', data: new Uint8Array(data), mtimeMs: now() })
    },
    async mkdir(abs) {
      mkdirp(abs)
    },
    async readdir(abs) {
      const node = lookup(abs)
      if (node === undefined) throw fail('ENOENT', abs)
      if (node.kind !== 'dir') throw fail('ENOTDIR', abs)
      return [...node.children.entries()].map(([name, child]) => ({ name, kind: child.kind }))
    },
    async rm(abs, opts) {
      const at = parentOf(abs)
      const node = at?.dir.children.get(at.name)
      if (!at || !node) throw fail('ENOENT', abs)
      // node:fs's rm(recursive: false) refuses ANY directory, empty or not - `force: false` is what
      // localFsIo passes, and that path never reaches the ENOTEMPTY check node's rmdir would give;
      // it fails earlier, on the directory itself, as ERR_FS_EISDIR.
      if (node.kind === 'dir' && !opts.recursive) throw fail('ERR_FS_EISDIR', abs)
      at.dir.children.delete(at.name)
    },
    seedDir(abs) {
      mkdirp(abs)
    },
    seedFile(abs, data) {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
      place(abs, { kind: 'file', data: bytes, mtimeMs: now() })
    },
    symlink(target, at) {
      place(at, { kind: 'symlink', target, mtimeMs: now() })
    },
  }
}
