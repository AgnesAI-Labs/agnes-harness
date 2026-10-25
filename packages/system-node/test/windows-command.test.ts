import { win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWindowsCommand } from '../runtime/windows-command.mjs'

// Pure: Windows path rules and an in-memory file set, so this runs on any host. It has not been
// run against a real Windows filesystem or libuv.
const files = (...names: string[]) => {
  const present = new Set(names.map((name) => name.toLowerCase()))
  return { path: win32, isFile: (candidate: string) => present.has(candidate.toLowerCase()) }
}
const workspace = 'C:\\work\\repo'
const env = (path: string, extra: Record<string, string> = {}) => ({ Path: path, ...extra })

describe('resolveWindowsCommand', () => {
  it('ignores a workspace git.cmd and finds git.exe on PATH', () => {
    const io = files(
      'C:\\work\\repo\\git.cmd',
      'C:\\work\\repo\\git.exe',
      'C:\\Program Files\\Git\\cmd\\git.exe',
    )
    expect(resolveWindowsCommand('git', workspace, env('C:\\Program Files\\Git\\cmd'), io)).toBe(
      'C:\\Program Files\\Git\\cmd\\git.EXE',
    )
  })

  it('never searches the current directory, even when git exists nowhere else', () => {
    const io = files('C:\\work\\repo\\git.cmd', 'C:\\work\\repo\\git.exe')
    expect(resolveWindowsCommand('git', workspace, env('C:\\Windows\\System32'), io)).toBeUndefined()
  })

  it('skips relative PATH entries and matches inside the workspace', () => {
    const io = files(
      'C:\\work\\repo\\bin\\git.exe',
      'C:\\work\\repo\\node_modules\\.bin\\git.cmd',
      'C:\\work\\repo\\tools\\git.exe',
      'C:\\Git\\cmd\\git.exe',
    )
    const path = [
      'bin',
      '.',
      '',
      '\\work\\repo\\tools',
      'C:tools',
      'C:\\work\\repo\\node_modules\\.bin',
      '"C:\\work\\repo\\bin"',
      'C:\\Git\\cmd',
    ].join(';')
    expect(resolveWindowsCommand('git', workspace, env(path), io)).toBe('C:\\Git\\cmd\\git.EXE')
    // The same rule holds for a workspace spelled with different case or a trailing separator.
    expect(resolveWindowsCommand('git', 'c:\\WORK\\Repo\\', env(path), io)).toBe('C:\\Git\\cmd\\git.EXE')
  })

  it('keeps PATH order and PATHEXT order, including a quoted entry and a UNC share', () => {
    const io = files(
      'C:\\Tools\\npm.cmd',
      'C:\\Tools\\npm.exe',
      'D:\\node\\npm.exe',
      '\\\\server\\bin\\gh.bat',
    )
    expect(resolveWindowsCommand('npm', workspace, env('"C:\\Tools";D:\\node'), io)).toBe(
      'C:\\Tools\\npm.EXE',
    )
    expect(
      resolveWindowsCommand('npm', workspace, env('"C:\\Tools";D:\\node', { PATHEXT: '.CMD;.EXE' }), io),
    ).toBe('C:\\Tools\\npm.CMD')
    expect(resolveWindowsCommand('gh', workspace, env('\\\\server\\bin'), io)).toBe('\\\\server\\bin\\gh.BAT')
    // Unknown PATHEXT entries are not launchable kinds and are ignored.
    expect(
      resolveWindowsCommand('npm', workspace, env('C:\\Tools', { PATHEXT: '.JS;.PS1' }), io),
    ).toBeUndefined()
  })

  it('resolves an explicit path against the working directory', () => {
    const io = files('C:\\work\\repo\\scripts\\build.cmd', 'D:\\bin\\tool.exe')
    expect(resolveWindowsCommand('scripts\\build', workspace, env(''), io)).toBe(
      'C:\\work\\repo\\scripts\\build.CMD',
    )
    expect(resolveWindowsCommand('D:\\bin\\tool.exe', workspace, env(''), io)).toBe('D:\\bin\\tool.exe')
  })
})
