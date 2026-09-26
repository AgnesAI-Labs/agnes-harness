import { type Dirent, promises as fsp, realpathSync, type Stats } from 'node:fs'
import type { FsIo, FsIoKind } from './fs-io.js'
import { createWin32Platform } from './platform.js'

const onWindows = createWin32Platform().matches()

const kindOf = (e: Dirent | Stats): FsIoKind =>
  e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other'

const primitives: FsIo = {
  async lstat(abs) {
    try {
      const st = await fsp.lstat(abs)
      return { kind: kindOf(st), size: st.size, mtimeMs: st.mtimeMs }
    } catch (error) {
      // ENOTDIR joins ENOENT: a path through a plain file resolves no further, and the fence decides
      // on the deepest real prefix plus the unresolved remainder - fail-closed, and correct on a
      // worktree, where `.git` is a file, not a directory.
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
      throw error
    }
  },
  readlink: (abs) => fsp.readlink(abs),
  readFile: (abs) => fsp.readFile(abs),
  writeFile: (abs, data) => fsp.writeFile(abs, data),
  async mkdir(abs) {
    await fsp.mkdir(abs, { recursive: true })
  },
  async readdir(abs) {
    const ents = await fsp.readdir(abs, { withFileTypes: true })
    return ents.map((e) => ({ name: e.name, kind: kindOf(e) }))
  },
  rm: (abs, opts) => fsp.rm(abs, { recursive: opts.recursive, force: false }),
}

/**
 * node:fs, one call per primitive. The two "missing" codes become undefined; anything else throws.
 * On Windows `finalPath` is the native resolver, which expands 8.3 short names; the portable one
 * keeps whatever spelling it was given.
 */
export function createLocalFsIo(windows: boolean = onWindows): FsIo {
  return Object.freeze({
    ...primitives,
    ...(windows ? { finalPath: (abs: string) => fsp.realpath(abs) } : {}),
  })
}

export const localFsIo: FsIo = createLocalFsIo()

/**
 * The synchronous counterpart of a canonicalization through the local io: native on Windows, so a
 * root resolved here is spelled as the fence and the daemon spell it.
 */
export function localRealpathSync(path: string): string {
  return onWindows ? realpathSync.native(path) : realpathSync(path)
}
