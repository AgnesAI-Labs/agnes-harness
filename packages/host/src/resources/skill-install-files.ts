import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { decideFsPath, validateFsPolicy } from '@agnes/core'
import type { FsEntry, FsStat } from '@agnes/extension-api'
import type { SkillRootKey, SkillSourceIdentity } from '@agnes/protocol'
import { createPlatform } from '../adapters/platform.js'
import type { SkillInstallInvocation } from './skill-install-port.js'

export type InstallSkillRoot = Readonly<{
  scope: SkillSourceIdentity['scope']
  rootKey: SkillRootKey
  priority: number
  path: string
  workspaceKey?: string
}>
export type InstallSkillFs = Readonly<{
  list(path: string): Promise<FsEntry[]>
  stat(path: string): Promise<FsStat>
  read(path: string): Promise<Uint8Array>
  realpath?(path: string): Promise<string>
}>
export type InstallSkillCandidate = Readonly<{
  resourceId: string
  name: string
  normalizedName: string
  description: string
  revision: string
  capabilityHash: string
  sourceIdentity: SkillSourceIdentity
  priority: number
  body: string
  workspaceId?: string
  files?: readonly Readonly<{
    relativePath: string
    sha256: string
    kind: 'text' | 'binary'
    mime: string
    bytes: Uint8Array
  }>[]
}>
/** The daemon supplies package-owned discovery without Host importing a Package. */
export type SkillDiscovery = Readonly<{
  roots(paths: {
    workspaceRoot: string
    osHomeDir: string
    agnesHomeDir: string
  }): readonly InstallSkillRoot[]
  discover(
    fs: InstallSkillFs,
    root: InstallSkillRoot,
  ): Promise<Readonly<{ ok: true; candidates: readonly InstallSkillCandidate[] }> | Readonly<{ ok: false }>>
}>

export const installDigest = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')
export const installError = (code: string): Error => Object.assign(new Error(code), { code })
export type InstallBundle = Readonly<{
  directoryName: string
  files: ReadonlyMap<string, Buffer>
  digest: string
  candidate: InstallSkillCandidate
}>
const MAX_BYTES = 8 * 1024 * 1024
const MAX_FILES = 64
const SAFE_SEGMENT = /^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/
const safeName = (name: string) =>
  SAFE_SEGMENT.test(name) &&
  !name.endsWith('.') &&
  !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)
const windows = createPlatform().os === 'win32'

export function within(parent: string, child: string): boolean {
  const part = relative(parent, child)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

/** Reject links in every existing component, including Windows junctions. */
export function unlinked(path: string): string {
  if (!isAbsolute(path) || [...path].some((char) => char.charCodeAt(0) < 32))
    throw installError('SKILL_PATH_INVALID')
  // Platform choice is owned by the Host backend; reject device/UNC/ADS paths on Windows.
  if (windows && (!/^[A-Za-z]:[\\/]/.test(path) || path.slice(2).includes(':')))
    throw installError('SKILL_PATH_INVALID')
  const target = resolve(path)
  let cursor = target
  while (true) {
    try {
      const stat = lstatSync(cursor)
      if (stat.isSymbolicLink()) throw installError('SKILL_LINK_REFUSED')
      if (cursor !== target && !stat.isDirectory()) throw installError('SKILL_PATH_INVALID')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return target
}

export function boundedInstallFile(path: string, maxBytes = 1024 * 1024): Buffer {
  unlinked(path)
  const before = lstatSync(path)
  if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes)
    throw installError('SKILL_FILE_REFUSED')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw installError('SKILL_SOURCE_CHANGED')
    unlinked(path)
    // Read at most the checked size plus one, never an unbounded growing file.
    const bytes = Buffer.alloc(before.size + 1)
    const fs = requireRead(fd, bytes)
    const after = fstatSync(fd)
    if (fs !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw installError('SKILL_SOURCE_CHANGED')
    return bytes.subarray(0, fs)
  } finally {
    closeSync(fd)
  }
}

// Kept separate so all source reads use one bounded descriptor operation.
function requireRead(fd: number, bytes: Buffer): number {
  let count = 0
  while (count < bytes.length) {
    const size = readSync(fd, bytes, count, bytes.length - count, null)
    if (size === 0) break
    count += size
  }
  return count
}

/** Shared validator for the authenticated worker boundary; legacy denials remain conservative. */
export function validInstallPathPolicy(value: unknown): boolean {
  try {
    const input = value as NonNullable<SkillInstallInvocation['pathPolicy']>
    if (
      !input ||
      typeof input.caseSensitive !== 'boolean' ||
      Object.keys(input).some((key) => !['policy', 'caseSensitive'].includes(key)) ||
      !Array.isArray(input.policy?.rules) ||
      input.policy.rules.length > 256 ||
      input.policy.rules.some((rule) => typeof rule?.path !== 'string' || rule.path.length > 4096)
    )
      return false
    validateFsPolicy(input.policy)
    return true
  } catch {
    return false
  }
}

export function assertInstallPath(invocation: SkillInstallInvocation, path: string): void {
  if (invocation.pathPolicy !== undefined) {
    if (!validInstallPathPolicy(invocation.pathPolicy)) throw installError('SKILL_PATH_DENIED')
    const decision = decideFsPath(invocation.pathPolicy.policy, path, invocation.pathPolicy)
    // A no-match is eligible for explicit local read approval, never an implicit read grant.
    if (decision.effect === 'deny' && decision.reason !== 'no-match') throw installError('SKILL_PATH_DENIED')
  } else if (!invocation.deniedPaths || invocation.deniedPaths.some((deny) => within(deny, path))) {
    throw installError('SKILL_PATH_DENIED')
  }
}

export async function readInstallBundle(
  source: string,
  root: InstallSkillRoot,
  denied: readonly string[] | ((path: string) => void),
  discovery: Pick<SkillDiscovery, 'discover'>,
): Promise<InstallBundle> {
  const checkPath = (path: string) => {
    if (typeof denied === 'function') denied(path)
    else if (denied.some((deny) => within(deny, path))) throw installError('SKILL_PATH_DENIED')
  }
  source = unlinked(source)
  checkPath(source)
  const real = realpathSync(source)
  if (relative(real, source) !== '') throw installError('SKILL_LINK_REFUSED')
  const directoryName = basename(source)
  if (!safeName(directoryName)) throw installError('SKILL_NAME_INVALID')
  if (!lstatSync(source).isDirectory()) throw installError('SKILL_SOURCE_NOT_DIRECTORY')
  const files = new Map<string, Buffer>()
  let bytes = 0
  let entries = 0
  const walk = (path: string, depth: number) => {
    if (depth > 4) throw installError('SKILL_SIZE_LIMIT')
    const directory = opendirSync(path)
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (++entries > 128) throw installError('SKILL_SIZE_LIMIT')
        if (!safeName(entry.name)) throw installError('SKILL_FILE_REFUSED')
        const full = join(path, entry.name)
        checkPath(full)
        if (entry.isSymbolicLink()) throw installError('SKILL_LINK_REFUSED')
        if (entry.isDirectory()) {
          unlinked(full)
          walk(full, depth + 1)
        } else if (entry.isFile()) {
          const name = relative(source, full).split(sep).join('/')
          if (files.size >= MAX_FILES) throw installError('SKILL_SIZE_LIMIT')
          const content = boundedInstallFile(full)
          bytes += content.length
          if (bytes > MAX_BYTES) throw installError('SKILL_SIZE_LIMIT')
          files.set(name, content)
        } else throw installError('SKILL_FILE_REFUSED')
      }
    } finally {
      directory.closeSync()
    }
  }
  walk(source, 0)
  const base = join(root.path, directoryName)
  const key = (path: string) => relative(base, path).split(sep).join('/')
  const fs: InstallSkillFs = {
    async realpath(path) {
      return path
    },
    async read(path) {
      const bytes = files.get(key(path))
      if (!bytes) throw installError('SKILL_FILE_MISSING')
      return bytes
    },
    async stat(path) {
      const bytes = files.get(key(path))
      if (bytes) return { kind: 'file', size: bytes.length, mtimeMs: 0 }
      if (
        path === root.path ||
        path === base ||
        [...files.keys()].some((name) => name.startsWith(`${key(path)}/`))
      )
        return { kind: 'dir', size: 0, mtimeMs: 0 }
      throw installError('SKILL_FILE_MISSING')
    },
    async list(path) {
      if (path === root.path) return [{ name: directoryName, kind: 'dir' }]
      const prefix = path === base ? '' : `${key(path)}/`
      const entries = new Map<string, 'file' | 'dir'>()
      for (const name of files.keys()) {
        if (!name.startsWith(prefix)) continue
        const tail = name.slice(prefix.length).split('/')
        const segment = tail[0]
        if (!segment) throw installError('SKILL_FILE_REFUSED')
        entries.set(segment, tail.length > 1 ? 'dir' : 'file')
      }
      return [...entries].map(([name, kind]) => ({ name, kind }))
    },
  }
  const scan = await discovery.discover(fs, root)
  const candidate = scan.ok ? scan.candidates[0] : undefined
  if (!candidate) throw installError('SKILL_DOCUMENT_INVALID')
  const digest = installDigest(
    JSON.stringify(
      [...files]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, content]) => [name, installDigest(content)]),
    ),
  )
  return { directoryName, files, digest, candidate }
}
