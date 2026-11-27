import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { syncDirectorySync } from '@agnes/system-node'

export const LLMSG_KEY_FILE = 'cloud-key'
export type LlmsgKeyEnvironment = Readonly<Record<string, string | undefined>>
const MAX_FILE_BYTES = 8192
const invalid = () => Object.assign(new Error('Missing or invalid LLMSG cloud Key'), { code: 'E_LLMSG_KEY' })

function keyText(text: string): string {
  const key = text.trim()
  if (!/^[\x21-\x7e]{1,4096}$/u.test(key)) throw invalid()
  return key
}

function inspectLlmsgKey(home: string, tighten: boolean): boolean {
  let fd: number
  try {
    fd = openSync(
      join(home, LLMSG_KEY_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw invalid()
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw invalid()
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      throw Object.assign(new Error('E_HOME_UNSAFE'), { code: 'E_HOME_UNSAFE' })
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1)
    let size = 0
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null)
      if (read === 0) break
      size += read
    }
    if (size > MAX_FILE_BYTES) throw invalid()
    keyText(bytes.subarray(0, size).toString('utf8'))
    if ((stat.mode & 0o7777) !== 0o600) {
      if (stat.nlink > 1) throw invalid()
      if (tighten) fchmodSync(fd, 0o600)
    }
    return true
  } finally {
    closeSync(fd)
  }
}

export function validateLlmsgKeyReadOnly(home: string): boolean {
  return inspectLlmsgKey(home, false)
}

/** Read and protect the same inode, even if LLMSG replaces the path while we have it open. */
export function hasLlmsgKey(home: string): boolean {
  return inspectLlmsgKey(home, true)
}

export function llmsgFallbackKey(env: LlmsgKeyEnvironment): string {
  const { AGH_API_KEY: primary, AGH_CLOUD_KEY: legacy } = env
  if (primary && legacy && primary !== legacy)
    throw Object.assign(new Error('Conflicting LLMSG cloud Key variables'), { code: 'E_LLMSG_KEY' })
  return keyText(primary ?? legacy ?? '')
}

/** Called under the home initialization lock. Only LLMSG bootstrap owns this name in secrets. */
export function ensureLlmsgKey(home: string, secrets: string, env: LlmsgKeyEnvironment): void {
  const pending = join(secrets, '.llmsg-cloud-key.pending')
  const removePending = () => {
    try {
      const stat = lstatSync(pending)
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw invalid()
      unlinkSync(pending)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  // A killed writer may leave a complete copy or a partial write here. A published file remains linked.
  removePending()
  if (hasLlmsgKey(home)) return
  try {
    writeFileSync(pending, `${llmsgFallbackKey(env)}\n`, { mode: 0o600, flag: 'wx', flush: true })
    try {
      linkSync(pending, join(home, LLMSG_KEY_FILE))
      syncDirectorySync(home)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    removePending()
  }
  if (!hasLlmsgKey(home)) throw invalid()
}
