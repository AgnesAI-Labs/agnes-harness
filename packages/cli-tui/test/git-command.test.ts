import { describe, expect, it } from 'vitest'
import { gitCommand } from '../src/git-command.js'

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
