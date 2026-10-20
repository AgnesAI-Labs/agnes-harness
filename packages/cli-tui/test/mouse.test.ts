import { afterEach, describe, expect, it, vi } from 'vitest'

const spawned: string[] = []
vi.mock('node:child_process', () => ({
  spawn: (command: string) => {
    spawned.push(command)
    return { on() {}, stdin: { on() {}, end() {} } }
  },
}))

const { copyToClipboard } = await import('../src/mouse.js')

describe('copyToClipboard', () => {
  afterEach(() => {
    spawned.length = 0
  })

  // A bare `clip` resolves through the working directory first on Windows; the workspace must not
  // be able to plant the command a copy runs.
  it('runs the platform command by absolute path and skips it over SSH', () => {
    const writes: string[] = []
    copyToClipboard('hi', (s) => writes.push(s), { SystemRoot: 'D:\\Win' }, 'win32')
    copyToClipboard('hi', () => {}, {}, 'darwin')
    copyToClipboard('hi', () => {}, {}, 'linux')
    copyToClipboard('hi', () => {}, { SSH_TTY: '/dev/ttys001' }, 'darwin')
    expect(spawned).toEqual(['D:\\Win\\System32\\clip.exe', '/usr/bin/pbcopy'])
    expect(writes).toEqual(['\x1b]52;c;aGk=\x07'])
  })
})
