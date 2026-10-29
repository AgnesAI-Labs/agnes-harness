import { spawn } from 'node:child_process'
import { closeSync, fstatSync, readSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { commandPath, openCanonicalFileSync } from '@agnes/system-node'

export type GitMark = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed'
export type GitStatus = {
  marks: Map<string, GitMark>
  status: 'available' | 'unavailable' | 'not-repository'
}
const MAX_GIT_BYTES = 256 * 1024
const GIT_TIMEOUT_MS = 500
const MAX_GIT_POINTER_BYTES = 1024
// Git for Windows recognizes /dev/null; Node's \\.\nul spelling is not a Git config path.
const devNull = '/dev/null'

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

/** Read a gitfile without following a link or allocating from an untrusted file size. */
function pointerTarget(path: string): string {
  const fd = openCanonicalFileSync(path)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > MAX_GIT_POINTER_BYTES) throw new Error('Invalid gitfile')
    const bytes = Buffer.alloc(MAX_GIT_POINTER_BYTES + 1)
    const size = readSync(fd, bytes, 0, bytes.length, 0)
    const after = fstatSync(fd)
    if (
      size !== before.size ||
      size > MAX_GIT_POINTER_BYTES ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('Changed gitfile')
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size))
    const match = /^gitdir: ([^\0\r\n]+)(?:\r?\n)?$/.exec(text)
    if (!match?.[1] || match[0] !== text || match[1].trim() !== match[1]) throw new Error('Invalid gitfile')
    return match[1]
  } finally {
    closeSync(fd)
  }
}

/** The final directory must itself be real, including when reached through a gitfile. */
async function gitDirectory(root: string): Promise<string> {
  const path = join(root, '.git')
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new Error('Linked git metadata')
  const target = info.isFile() ? resolve(root, pointerTarget(path)) : path
  const directory = await lstat(target)
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid git directory')
  return realpath(target)
}

/** No shell, inherited Git overrides, interactive prompts or network/lazy object fetches. */
function gitRead(
  root: string,
  gitdir: string,
  args: string[],
  deadline: number,
  maxBytes: number,
  emptyOK = false,
): Promise<Buffer | undefined> {
  const remaining = deadline - performance.now()
  if (remaining <= 0) return Promise.resolve(undefined)
  // A bare `git` on Windows would first run any git.exe in the workspace being inspected.
  const git = commandPath('git', root)
  if (!git) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const child = spawn(
      git,
      [
        '--no-pager',
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.alternateRefsCommand=',
        '-c',
        'gc.auto=0',
        '-c',
        'maintenance.auto=false',
        '-c',
        `core.hooksPath=${devNull}`,
        '-c',
        'core.untrackedCache=false',
        '-c',
        'core.preloadIndex=false',
        '-c',
        `core.attributesFile=${devNull}`,
        '-c',
        'diff.external=',
        '-c',
        'credential.helper=',
        '-c',
        'credential.interactive=false',
        '-c',
        'protocol.allow=never',
        '--git-dir',
        gitdir,
        '--work-tree',
        root,
        ...args,
      ],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_SYSTEM: devNull,
          GIT_CONFIG_GLOBAL: devNull,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_LAZY_FETCH: '1',
          GIT_ATTR_NOSYSTEM: '1',
        },
      },
    )
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (bytes?: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(bytes)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish()
    }, remaining)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        child.kill()
        finish()
        return
      }
      chunks.push(chunk)
    })
    child.on('error', () => finish())
    child.on('close', (code) =>
      finish(code === 0 || (emptyOK && code === 1 && size === 0) ? Buffer.concat(chunks) : undefined),
    )
  })
}

/** Only names are read: status can run clean/process filters while refreshing changed index entries. */
async function statusOverrides(
  root: string,
  gitdir: string,
  deadline: number,
): Promise<{ args: string[]; bytes: number } | undefined> {
  const names = await gitRead(
    root,
    gitdir,
    [
      'config',
      '--null',
      '--name-only',
      '--get-regexp',
      '^(filter\\..*\\.(clean|smudge|process|required)|diff\\..*\\.(command|textconv)|protocol\\..*\\.allow)$',
    ],
    deadline,
    MAX_GIT_BYTES,
    true,
  )
  if (!names) return undefined
  const args: string[] = []
  for (const name of new TextDecoder('utf-8', { fatal: true }).decode(names).split('\0').filter(Boolean)) {
    // A subsection containing '=' cannot be overridden safely with Git's -c key=value grammar.
    if (
      !/^(filter|diff|protocol)\.[^=\r\n\0]+\.(clean|smudge|process|required|command|textconv|allow)$/i.test(
        name,
      )
    )
      return undefined
    const value = name.toLowerCase().endsWith('.allow')
      ? 'never'
      : name.toLowerCase().endsWith('.required')
        ? 'false'
        : ''
    args.push('-c', `${name}=${value}`)
  }
  return { args, bytes: names.length }
}

/** Workbench-only metadata operation. Repository files remain outside document-read authority. */
export async function readGitStatus(root: string): Promise<GitStatus> {
  const unavailable = (): GitStatus => ({ marks: new Map(), status: 'unavailable' })
  try {
    await lstat(join(root, '.git'))
  } catch (error) {
    return {
      marks: new Map(),
      status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-repository' : 'unavailable',
    }
  }
  try {
    const gitdir = await gitDirectory(root)
    const deadline = performance.now() + GIT_TIMEOUT_MS
    const drivers = await statusOverrides(root, gitdir, deadline)
    if (!drivers) return unavailable()
    // Resolve again so a changed pointer or directory is never silently accepted between commands.
    if ((await gitDirectory(root)) !== gitdir) return unavailable()
    const bytes = await gitRead(
      root,
      gitdir,
      [...drivers.args, 'status', '--porcelain=v1', '-z', '--ignore-submodules=all', '--untracked-files=all'],
      deadline,
      MAX_GIT_BYTES - drivers.bytes,
    )
    return bytes ? { marks: parseGitPorcelain(bytes), status: 'available' } : unavailable()
  } catch {
    return unavailable()
  }
}
