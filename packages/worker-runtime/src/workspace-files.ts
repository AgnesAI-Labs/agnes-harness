import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, readSync } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { devNull, homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { HostSession } from '@agnes/host'
import { AGH_DIR, type RpcError, rpcError } from '@agnes/protocol'
import { listCanonicalDirectorySync, openCanonicalFileSync } from '@agnes/system-node'

/** Workbench reads stop at 1 MiB. Larger files report their size and omit text. */
export const MAX_READ_BYTES = 1024 * 1024
export const BINARY_SCAN_BYTES = 8192
export const MAX_LIST_ENTRIES = 500
const MAX_SCAN_ENTRIES = 5000
const MAX_IGNORE_BYTES = 256 * 1024
const MAX_GIT_BYTES = 256 * 1024
const GIT_TIMEOUT_MS = 500

export type WorkspaceKind = 'file' | 'directory' | 'other'
export type GitMark = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed'
export type WorkspaceEntry = { name: string; kind: WorkspaceKind; git?: GitMark }
export type WorkspaceList = {
  path: string
  truncated: boolean
  entries: WorkspaceEntry[]
  revision: string
  observedAt: string
  gitStatus: 'available' | 'unavailable' | 'not-repository'
}
export type WorkspaceRead = {
  path: string
  revision: string
  observedAt: string
  size: number
  binary: boolean
  truncated: boolean
  text?: string
}

type IgnoreRule = { negate: boolean; dirOnly: boolean; anchored: boolean; segments: string[] }
type IgnoreFile = { base: string; rules: IgnoreRule[] }
export type WorkspaceAuthority = { stat(path: string): Promise<unknown> }
const revision = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const denied = (): RpcError =>
  rpcError('SEMANTIC_REJECTED', { code: 'WORKSPACE_PATH_DENIED', reason: 'WORKSPACE_PATH_DENIED' })
const invalid = (): RpcError =>
  rpcError('SEMANTIC_REJECTED', { code: 'WORKSPACE_PATH_INVALID', reason: 'WORKSPACE_PATH_INVALID' })
const missing = (): RpcError =>
  rpcError('SEMANTIC_REJECTED', { code: 'WORKSPACE_PATH_NOT_FOUND', reason: 'WORKSPACE_PATH_NOT_FOUND' })

const isRpc = (error: unknown): error is RpcError =>
  typeof error === 'object' &&
  error !== null &&
  typeof (error as RpcError).code === 'number' &&
  typeof (error as RpcError).message === 'string'

/** Relative workspace path. `..`, absolute paths and NUL bytes are refused before any filesystem access. */
export function normalizeWorkspacePath(input: string): string {
  if (input.includes('\0')) throw denied()
  const slashed = input.replaceAll('\\', '/')
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) throw denied()
  const parts: string[] = []
  for (const part of slashed.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') throw denied()
    parts.push(part)
  }
  const rel = parts.join('/')
  if (rel.length > 4096) throw denied()
  return rel
}

function inside(root: string, real: string): boolean {
  const rel = relative(root, real)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function canonicalRoot(cwd: string): Promise<string> {
  try {
    const real = await realpath(cwd)
    const info = await stat(real)
    if (!info.isDirectory()) throw denied()
    return real
  } catch (error) {
    if (isRpc(error)) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw missing()
    throw denied()
  }
}

async function resolveInside(root: string, rel: string, authority: WorkspaceAuthority): Promise<string> {
  const abs = rel === '' ? root : join(root, ...rel.split('/'))
  try {
    await assertPublicPath(abs)
    let current = root
    for (const part of rel.split('/').filter(Boolean)) {
      current = join(current, part)
      if ((await lstat(current)).isSymbolicLink()) throw denied()
    }
    const real = await realpath(abs)
    if (!inside(root, real)) throw denied()
    await assertPublicPath(real)
    await authority.stat(real)
    return real
  } catch (error) {
    if (isRpc(error)) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw missing()
    throw denied()
  }
}

/** Historical review receipts also require current root authority, even for an empty result. */
export async function assertWorkspacePublicRoot(cwd: string, authority: WorkspaceAuthority): Promise<void> {
  await resolveInside(await canonicalRoot(cwd), '', authority)
}

/** The installation home is never a workbench document source, even inside an admitted workspace. */
async function assertPublicPath(abs: string): Promise<void> {
  const home = resolve(
    process.env.AGH_HOME || process.env.AGNES_HOME || join(process.env.HOME || homedir(), AGH_DIR),
  )
  const canonical = await realpath(home).catch(() => home)
  if (inside(home, abs) || inside(canonical, abs)) throw denied()
}

function compileLine(line: string): IgnoreRule | undefined {
  const text = line.replace(/\r$/, '')
  if (!text.trim() || text.trimStart().startsWith('#')) return undefined
  let body = text
  let negate = false
  if (body.startsWith('!')) {
    negate = true
    body = body.slice(1)
  }
  if (!body) return undefined
  let dirOnly = false
  if (body.endsWith('/') && !body.endsWith('\\/')) {
    dirOnly = true
    body = body.slice(0, -1)
  }
  const anchored = body.startsWith('/') || body.includes('/')
  if (body.startsWith('/')) body = body.slice(1)
  if (!body) return undefined
  return { negate, dirOnly, anchored, segments: body.split('/') }
}

export function compileIgnore(base: string, text: string): IgnoreFile {
  const rules: IgnoreRule[] = []
  for (const line of text.split('\n')) {
    const rule = compileLine(line)
    if (rule) rules.push(rule)
  }
  return { base, rules }
}

function segmentMatch(pattern: string, part: string): boolean {
  let expression = '^'
  for (const char of pattern) {
    if (char === '*') expression += '[^/]*'
    else if (char === '?') expression += '[^/]'
    else expression += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${expression}$`).test(part)
}

function segmentsMatch(pattern: string[], parts: string[]): boolean {
  const visit = (patternIndex: number, partIndex: number): boolean => {
    if (patternIndex === pattern.length) return partIndex === parts.length
    const segment = pattern[patternIndex]
    if (segment === '**') {
      if (visit(patternIndex + 1, partIndex)) return true
      for (let index = partIndex; index < parts.length; index += 1)
        if (visit(patternIndex + 1, index + 1)) return true
      return false
    }
    if (segment === undefined || partIndex >= parts.length) return false
    if (!segmentMatch(segment, parts[partIndex] ?? '')) return false
    return visit(patternIndex + 1, partIndex + 1)
  }
  return visit(0, 0)
}

function ruleMatches(rule: IgnoreRule, relFromBase: string, isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false
  const parts = relFromBase.split('/').filter((part) => part !== '')
  if (rule.anchored) return segmentsMatch(rule.segments, parts)
  for (let index = 0; index < parts.length; index += 1)
    if (segmentsMatch(rule.segments, parts.slice(index))) return true
  return false
}

function relativeToBase(base: string, rel: string): string | undefined {
  if (base === '') return rel
  if (rel === base) return undefined
  const prefix = `${base}/`
  return rel.startsWith(prefix) ? rel.slice(prefix.length) : undefined
}

/** Last matching rule wins. `.gitignore` and `.aghignore` themselves stay visible. */
export function ignoredBy(rel: string, isDir: boolean, files: readonly IgnoreFile[]): boolean {
  const baseName = rel.split('/').at(-1) ?? rel
  if (baseName === '.gitignore' || baseName === '.aghignore') return false
  let ignored = false
  for (const file of files) {
    const fromBase = relativeToBase(file.base, rel)
    if (fromBase === undefined || fromBase === '') continue
    for (const rule of file.rules) if (ruleMatches(rule, fromBase, isDir)) ignored = !rule.negate
  }
  return ignored
}

function hiddenFromTree(rel: string, files: readonly IgnoreFile[]): boolean {
  const parts = rel.split('/')
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (ignoredBy(parts.slice(0, index + 1).join('/'), true, files)) return true
  }
  return ignoredBy(rel, false, files)
}

async function readInsideText(
  root: string,
  rel: string,
  name: string,
  authority: WorkspaceAuthority,
): Promise<string | undefined> {
  const abs = rel === '' ? join(root, name) : join(root, rel, name)
  try {
    const link = await lstat(abs)
    if (!link.isFile() && !link.isSymbolicLink()) return undefined
    if (link.isSymbolicLink()) return undefined
    const result = await readWorkspace(root, rel === '' ? name : `${rel}/${name}`, authority)
    if (result.binary || result.truncated || result.size > MAX_IGNORE_BYTES) return undefined
    return result.text
  } catch {
    return undefined
  }
}

async function ignoreFiles(root: string, rel: string, authority: WorkspaceAuthority): Promise<IgnoreFile[]> {
  const chain = ['']
  if (rel !== '') {
    const parts = rel.split('/')
    for (let index = 0; index < parts.length; index += 1) chain.push(parts.slice(0, index + 1).join('/'))
  }
  const files: IgnoreFile[] = []
  for (const base of chain) {
    for (const name of ['.gitignore', '.aghignore']) {
      const text = await readInsideText(root, base, name, authority)
      if (text !== undefined) files.push(compileIgnore(base, text))
    }
  }
  return files
}

export function gitMark(status: string): GitMark | undefined {
  if (status === '??') return 'untracked'
  const first = [...status].find((char) => char !== ' ')
  if (first === '?' || first === 'A') return first === '?' ? 'untracked' : 'added'
  if (first === 'M' || first === 'U') return 'modified'
  if (first === 'D') return 'deleted'
  if (first === 'R') return 'renamed'
  if (first === 'C') return 'added'
  return first ? 'modified' : undefined
}

/** In porcelain -z, the first rename path is the destination; the following path is the source. */
export function parseGitPorcelain(bytes: Buffer): Map<string, GitMark> {
  const marks = new Map<string, GitMark>()
  let offset = 0
  while (offset < bytes.length) {
    const end = bytes.indexOf(0, offset)
    const record = bytes.subarray(offset, end === -1 ? bytes.length : end)
    offset = end === -1 ? bytes.length : end + 1
    if (record.length < 4) continue
    const status = record.subarray(0, 2).toString('utf8')
    const mark = gitMark(status)
    if (!mark) continue
    if (status.includes('R') || status.includes('C')) {
      const nextEnd = bytes.indexOf(0, offset)
      const destination = record.subarray(3).toString('utf8')
      offset = nextEnd === -1 ? bytes.length : nextEnd + 1
      if (destination) marks.set(destination, mark)
      continue
    }
    const path = record.subarray(3).toString('utf8')
    if (path) marks.set(path, mark)
  }
  return marks
}

type GitStatus = { marks: Map<string, GitMark>; status: WorkspaceList['gitStatus'] }
function gitPorcelain(root: string): Promise<GitStatus> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (marks: Map<string, GitMark> | undefined) => {
      if (settled) return
      settled = true
      resolve({ marks: marks ?? new Map(), status: marks ? 'available' : 'unavailable' })
    }
    const child = spawn(
      'git',
      [
        '-c',
        'core.fsmonitor=false',
        '--git-dir',
        join(root, '.git'),
        '--work-tree',
        root,
        'status',
        '--porcelain=v1',
        '-z',
      ],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull },
      },
    )
    const chunks: Buffer[] = []
    let size = 0
    let overflow = false
    const timer = setTimeout(() => {
      child.kill()
      finish(undefined)
    }, GIT_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_GIT_BYTES) {
        overflow = true
        child.kill()
        return
      }
      chunks.push(chunk)
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish(undefined)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 || overflow) finish(undefined)
      else finish(parseGitPorcelain(Buffer.concat(chunks)))
    })
  })
}

async function gitStatus(root: string, authority: WorkspaceAuthority): Promise<GitStatus> {
  try {
    const git = await lstat(join(root, '.git'))
    if (!git.isDirectory() || git.isSymbolicLink()) return { marks: new Map(), status: 'unavailable' }
    await resolveInside(root, '.git', authority)
  } catch (error) {
    return {
      marks: new Map(),
      status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-repository' : 'unavailable',
    }
  }
  return gitPorcelain(root)
}

function directoryBadge(
  rel: string,
  marks: Map<string, GitMark>,
  files: readonly IgnoreFile[],
): GitMark | undefined {
  const prefix = rel === '' ? '' : `${rel}/`
  let saw = false
  let allUntracked = true
  for (const [path, mark] of marks) {
    if (prefix !== '' && path !== rel && !path.startsWith(prefix)) continue
    if (hiddenFromTree(path, files)) continue
    saw = true
    if (mark !== 'untracked') allUntracked = false
  }
  if (!saw) return undefined
  return allUntracked ? 'untracked' : 'modified'
}

function compareEntries(left: WorkspaceEntry, right: WorkspaceEntry): number {
  if (left.kind === 'directory' && right.kind !== 'directory') return -1
  if (right.kind === 'directory' && left.kind !== 'directory') return 1
  return left.name.localeCompare(right.name, 'en', { numeric: true })
}

async function classify(dirAbs: string, name: string, authority: WorkspaceAuthority): Promise<WorkspaceKind> {
  const abs = join(dirAbs, name)
  try {
    const info = await lstat(abs)
    await assertPublicPath(abs)
    await authority.stat(abs)
    if (info.isSymbolicLink()) return 'other'
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
    return 'other'
  } catch {
    return 'other'
  }
}

export async function listWorkspace(
  cwd: string,
  requested: string,
  authority: WorkspaceAuthority,
): Promise<WorkspaceList> {
  const rel = normalizeWorkspacePath(requested)
  const root = await canonicalRoot(cwd)
  const dirAbs = await resolveInside(root, rel, authority)
  const info = await stat(dirAbs)
  if (!info.isDirectory()) throw invalid()
  const files = await ignoreFiles(root, rel, authority)
  const gitState = await gitStatus(root, authority)
  const marks = gitState.marks
  const listed = listCanonicalDirectorySync(dirAbs)
  const names = listed
    .map((entry) => entry)
    .filter((name) => name !== '.' && name !== '..' && name.length <= 255 && !name.includes('\0'))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
  const scanned = names.length > MAX_SCAN_ENTRIES
  const entries: WorkspaceEntry[] = []
  for (const name of names.slice(0, MAX_SCAN_ENTRIES)) {
    const child = rel === '' ? name : `${rel}/${name}`
    try {
      await assertPublicPath(join(dirAbs, name))
    } catch {
      continue
    }
    const kind = await classify(dirAbs, name, authority)
    if (ignoredBy(child, kind === 'directory', files)) continue
    const exact = marks.get(child)
    const git =
      kind === 'directory'
        ? directoryBadge(child, marks, files)
        : exact && exact !== 'deleted'
          ? exact
          : undefined
    entries.push(git ? { name, kind, git } : { name, kind })
  }
  entries.sort(compareEntries)
  return {
    path: rel,
    observedAt: new Date().toISOString(),
    revision: revision(entries),
    gitStatus: gitState.status,
    truncated: scanned || entries.length > MAX_LIST_ENTRIES,
    entries: entries.slice(0, MAX_LIST_ENTRIES),
  }
}

export async function readWorkspace(
  cwd: string,
  requested: string,
  authority: WorkspaceAuthority,
): Promise<WorkspaceRead> {
  const rel = normalizeWorkspacePath(requested)
  if (rel === '') throw invalid()
  const root = await canonicalRoot(cwd)
  const abs = await resolveInside(root, rel, authority)
  const expected = await stat(abs)
  let fd: number
  try {
    fd = openCanonicalFileSync(abs)
  } catch {
    throw denied()
  }
  try {
    const info = fstatSync(fd)
    if (expected.dev !== info.dev || expected.ino !== info.ino) throw denied()
    if (!info.isFile()) throw invalid()
    const checked = await resolveInside(root, rel, authority)
    const identity = await stat(checked)
    if (identity.dev !== info.dev || identity.ino !== info.ino) throw denied()
    const bytes = Buffer.alloc(
      Math.min(info.size > MAX_READ_BYTES ? BINARY_SCAN_BYTES : MAX_READ_BYTES + 1, info.size + 1),
    )
    let size = 0
    while (size < bytes.length) {
      const next = readSync(fd, bytes, size, bytes.length - size, size)
      if (next === 0) break
      size += next
    }
    const after = fstatSync(fd)
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs)
      throw denied()
    await resolveInside(root, rel, authority)
    const binary = bytes.subarray(0, Math.min(size, BINARY_SCAN_BYTES)).includes(0)
    const truncated = info.size > MAX_READ_BYTES || size > MAX_READ_BYTES
    return {
      path: rel,
      observedAt: new Date().toISOString(),
      revision: truncated
        ? `weak:${info.mtimeMs}:${info.size}`
        : createHash('sha256').update(bytes.subarray(0, size)).digest('hex'),
      size: Math.max(info.size, size),
      binary,
      truncated,
      ...(!binary && !truncated ? { text: bytes.subarray(0, size).toString('utf8') } : {}),
    }
  } finally {
    closeSync(fd)
  }
}

/** Use the same revocable workspace capability as tools; the cwd alone grants no access. */
export async function sessionWorkspaceFiles(session: HostSession, operation: 'list' | 'read', path: string) {
  const port = session.d.workspaceInvocation
  if (!port) throw denied()
  const invoke = async (view: Parameters<Parameters<typeof port.run>[0]>[0]) => {
    const authority = view.fs()
    try {
      return operation === 'list'
        ? await listWorkspace(view.root, path, authority)
        : await readWorkspace(view.root, path, authority)
    } catch (error) {
      if (isRpc(error)) throw error
      throw denied()
    }
  }
  return session.d.workspacePublication
    ? session.d.workspacePublication.workspace(() => ({ port, handler: invoke }))
    : port.run(invoke)
}
