import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { execGit, gitCommand } from '../src/git-command.js'

// Pure: Windows path rules and an in-memory file set, so this runs on any host. It has not been
// run against a real Windows filesystem or libuv.
const windows = (path: string, ...files: string[]) => {
  const present = new Set(files.map((file) => file.toLowerCase()))
  return {
    platform: 'win32' as const,
    env: { Path: path },
    isFile: (candidate: string) => present.has(candidate.toLowerCase()),
  }
}
const workspace = 'C:\\work\\repo'

describe('gitCommand', () => {
  it('ignores a workspace git.cmd and git.exe and finds git.exe on PATH', () => {
    const io = windows(
      'C:\\Program Files\\Git\\cmd',
      'C:\\work\\repo\\git.cmd',
      'C:\\work\\repo\\git.exe',
      'C:\\Program Files\\Git\\cmd\\git.exe',
    )
    expect(gitCommand(workspace, io)).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
  })

  it('never falls back to the working directory', () => {
    expect(gitCommand(workspace, windows('C:\\Windows', 'C:\\work\\repo\\git.exe'))).toBeUndefined()
  })

  it('skips relative entries and anything inside the workspace, in any spelling', () => {
    const path = [
      'bin',
      '.',
      '',
      '\\work\\repo\\tools',
      'C:tools',
      '"C:\\work\\repo\\bin"',
      'C:\\work\\repo\\node_modules\\.bin',
      '"C:\\Git\\cmd"',
    ].join(';')
    const io = windows(
      path,
      'C:\\work\\repo\\bin\\git.exe',
      'C:\\work\\repo\\tools\\git.exe',
      'C:\\work\\repo\\node_modules\\.bin\\git.exe',
      'C:\\Git\\cmd\\git.exe',
    )
    expect(gitCommand(workspace, io)).toBe('C:\\Git\\cmd\\git.exe')
    expect(gitCommand('c:\\WORK\\Repo\\', io)).toBe('C:\\Git\\cmd\\git.exe')
  })

  it('does not pick a batch file that execFile cannot start, and keeps PATH order', () => {
    expect(gitCommand(workspace, windows('C:\\Tools', 'C:\\Tools\\git.cmd'))).toBeUndefined()
    const io = windows('\\\\server\\bin;D:\\git', '\\\\server\\bin\\git.exe', 'D:\\git\\git.exe')
    expect(gitCommand(workspace, io)).toBe('\\\\server\\bin\\git.exe')
  })

  it('leaves git to the system lookup elsewhere', () => {
    expect(gitCommand('/work/repo', { platform: 'darwin', env: {} })).toBe('git')
  })
})

describe('execGit', () => {
  // A failing spawn aborted at once used to kill pid 0 - the caller's whole process group - so the
  // case runs in a child with a process group of its own and must exit normally.
  it('an abort while the spawn is failing ends only that call, never the process group', async () => {
    const module = pathToFileURL(fileURLToPath(new URL('../src/git-command.ts', import.meta.url))).href
    const script = `
      const { execGit } = await import(${JSON.stringify(module)})
      const stop = new AbortController()
      const pending = execGit(${JSON.stringify(join(tmpdir(), 'agh-missing-git-cwd', 'gone'))}, ['status'], { signal: stop.signal, maxBuffer: 1024 })
      stop.abort()
      console.log(JSON.stringify(await pending))`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    const [status, signal] = await once(child, 'exit')
    expect(signal).toBeNull()
    expect(status, stderr).toBe(0)
    expect(stdout.trim()).toBe('undefined')
  }, 30_000)

  it('settles once the child has exited after an abort', async () => {
    const stop = new AbortController()
    const pending = execGit(tmpdir(), ['rev-parse', '--show-toplevel'], {
      signal: stop.signal,
      maxBuffer: 1024,
    })
    stop.abort()
    expect(await pending).toBeUndefined()
  })
})
