import { createHash } from 'node:crypto'
import { close, fstat, ftruncate, read, readFile, writeFile } from 'node:fs'
import { promisify } from 'node:util'
import { canonicalFs, openCanonicalFileSync, openCanonicalWritableFileSync } from '@agnes/system-node'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import type { FsIo } from './fs-io.js'
import { createWin32Platform } from './platform.js'

const onWindows = createWin32Platform().matches()
const closeFd = promisify(close)
const statFd = promisify(fstat)
const truncateFd = promisify(ftruncate)
const readFd = promisify(read)
const readAllFd = promisify(readFile)
const writeFd = promisify(writeFile)

const primitives: FsIo = {
  async lstat(abs) {
    try {
      return await canonicalFs('stat', abs)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
      throw error
    }
  },
  readlink: (abs) => canonicalFs('readlink', abs),
  async readFile(abs) {
    const fd = openCanonicalFileSync(abs)
    try {
      return await readAllFd(fd)
    } finally {
      await closeFd(fd)
    }
  },
  async readRange(abs, opts) {
    const fd = openCanonicalFileSync(abs)
    try {
      const meta = await statFd(fd)
      const length = Math.max(0, Math.min(opts.limit ?? meta.size, meta.size - opts.offset))
      const bytes = new Uint8Array(length)
      let count = 0
      while (count < length) {
        const result = await readFd(fd, bytes, count, length - count, opts.offset + count)
        if (!result.bytesRead) break
        count += result.bytesRead
      }
      return bytes.subarray(0, count)
    } finally {
      await closeFd(fd)
    }
  },
  async createFile(abs, data) {
    const fd = openCanonicalWritableFileSync(abs, true)
    try {
      await writeFd(fd, data)
      const meta = await statFd(fd)
      if (meta.size !== data.length) throw new Error('Exclusive create wrote an incomplete file')
      const digest = createHash('sha256')
      const window = new Uint8Array(Math.min(64 * 1024, data.length))
      for (let at = 0; at < data.length; ) {
        const { bytesRead } = await readFd(fd, window, 0, Math.min(window.length, data.length - at), at)
        if (!bytesRead) throw new Error('Exclusive create verification failed')
        digest.update(window.subarray(0, bytesRead))
        at += bytesRead
      }
      return { size: meta.size, sha256: digest.digest('hex') }
    } finally {
      await closeFd(fd)
    }
  },
  async writeFile(abs, data) {
    const fd = openCanonicalWritableFileSync(abs)
    try {
      await truncateFd(fd, 0)
      await writeFd(fd, data)
    } finally {
      await closeFd(fd)
    }
  },
  mkdir: (abs) => canonicalFs('mkdir', abs, true),
  readdir: (abs) => canonicalFs('list', abs),
  rm: (abs, opts) => canonicalFs('rm', abs, opts.recursive),
}

/** Every operation holds real no-follow parents. No path-based fallback is permitted. */
export function createLocalFsIo(windows: boolean = onWindows): FsIo {
  return Object.freeze({
    ...primitives,
    ...(windows ? { finalPath: (abs: string) => canonicalFs('finalPath', abs) } : {}),
  })
}
export const localFsIo: FsIo = createLocalFsIo()
/** Initialization canonicalization only; never used to reopen an authorized operation. */
export function localRealpathSync(path: string): string {
  return nativeRealpathSync(path)
}
