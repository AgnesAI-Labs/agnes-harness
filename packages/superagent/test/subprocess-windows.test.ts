import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { childEnvironment, type Processes, runCommand, setAgentVariables } from '../src/app/subprocess.js'
import { cmdArgument, findWindowsProgram, windowsLaunch } from '../src/app/windows-launch.js'
import { busy, retryBusy } from '../src/infra/busy.js'

// The Windows paths of the runner, with the platform given and the process start replaced: no Windows machine runs
// these, so they pin what Superagent asks Windows for.
let directory: string
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'subprocess-win-')))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
  setAgentVariables(undefined)
  vi.unstubAllEnvs()
})

/** A child process that runs until `end` is called. */
function fakeChild(pid: number) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdin: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  })
  const end = (code: number) => {
    child.exitCode = code
    child.emit('exit', code)
    child.emit('close', code)
  }
  return { child, end }
}

const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe'
/** A runner over a fake child and a fake taskkill, on Windows with its system directory at C:\\Windows. */
function windowsRun(pid: number) {
  vi.stubEnv('SystemRoot', 'C:\\Windows')
  const { child, end } = fakeChild(pid)
  const taskkill = new EventEmitter()
  const spawn = vi.fn((program: string, _args: string[], _options: object) =>
    program === TASKKILL ? taskkill : child,
  )
  const kill = vi.fn()
  const controller = new AbortController()
  const running = runCommand(['tool.exe', 'arg'], {
    platform: 'win32',
    signal: controller.signal,
    timeoutMs: 60_000,
    processes: { spawn: spawn as unknown as Processes['spawn'], kill },
  })
  return { child, end, taskkill, spawn, kill, controller, running }
}

it('stops a Windows command by ending its whole tree with taskkill, at once, and never as a process group', async () => {
  const { end, spawn, kill, controller, running } = windowsRun(4242)
  expect(spawn.mock.calls[0]?.[2]).toMatchObject({ detached: false, windowsHide: true })
  controller.abort()
  // Windows' own taskkill, by its full path: never one found on PATH or in the working directory.
  expect(spawn).toHaveBeenLastCalledWith(TASKKILL, ['/PID', '4242', '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  expect(kill, 'no process group signal').not.toHaveBeenCalled()
  end(1)
  expect((await running).code).toBe(1)
  expect(spawn).toHaveBeenCalledTimes(2)
})

it('ends the child itself when taskkill fails, or by the deadline when taskkill never returns', async () => {
  const failed = windowsRun(4343)
  failed.controller.abort()
  failed.taskkill.emit('exit', 128)
  expect(failed.child.kill).toHaveBeenCalledWith('SIGKILL')
  failed.end(1)
  await failed.running
  vi.useFakeTimers()
  try {
    const hung = windowsRun(4444)
    hung.controller.abort()
    expect(hung.child.kill).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2_000)
    expect(hung.child.kill).toHaveBeenCalledWith('SIGKILL')
    hung.end(1)
    await hung.running
  } finally {
    vi.useRealTimers()
  }
})

it('stops a POSIX command through its process group, as before', async () => {
  const { child, end } = fakeChild(4343)
  const spawn = vi.fn((_program: string, _args: string[], _options: object) => child)
  const kill = vi.fn()
  const controller = new AbortController()
  const running = runCommand(['tool'], {
    platform: 'linux',
    signal: controller.signal,
    timeoutMs: 60_000,
    processes: { spawn: spawn as unknown as Processes['spawn'], kill },
  })
  expect(spawn.mock.calls[0]?.[2]).toMatchObject({ detached: true })
  controller.abort()
  expect(kill).toHaveBeenCalledWith(-4343, 'SIGTERM')
  end(0)
  await running
})

it('finds a Windows program as a shell does: each PATH directory in turn, with the PATHEXT extensions', () => {
  const [first, second] = [join(directory, 'a'), join(directory, 'b')]
  mkdirSync(first)
  mkdirSync(second)
  writeFileSync(join(first, 'gh.cmd'), '')
  writeFileSync(join(second, 'gh.exe'), '')
  const env = { Path: `relative;${first};${second}`, PATHEXT: '.com;.exe;.bat;.cmd' }
  // The first directory wins, though its file is a batch file and a later one has an .exe.
  expect(findWindowsProgram('gh', env)).toBe(join(first, 'gh.cmd'))
  expect(findWindowsProgram('gh.exe', env)).toBe(join(second, 'gh.exe'))
  expect(findWindowsProgram('missing', env)).toBeUndefined()
  expect(findWindowsProgram(join(second, 'gh'), env)).toBe(join(second, 'gh.exe'))
})

it('runs a Windows batch file through cmd.exe with its arguments escaped twice, and refuses a line break', () => {
  // A directory with a space and parentheses, as under C:\Program Files (x86).
  const bin = join(directory, 'bin (x86)')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh-agent.cmd'), '')
  const env = { PATH: bin, PATHEXT: '.cmd', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }
  const launch = windowsLaunch('gh-agent', ['api', 'repos/a/b?per_page=1&page=2', 'a \\ 100%'], env)
  expect(launch).toEqual({
    program: 'C:\\Windows\\system32\\cmd.exe',
    args: [
      '/d',
      // Delayed expansion off, whatever the machine's default, so a `!` stays as it is.
      '/v:off',
      '/s',
      '/c',
      // The program's own special characters escaped once, each argument quoted and escaped twice.
      `"${join(directory, 'bin^ ^(x86^)', 'gh-agent.cmd')} ^^^"api^^^" ^^^"repos/a/b^^^?per_page=1^^^&page=2^^^" ^^^"a^^^ \\^^^ 100^^^%^^^""`,
    ],
    verbatim: true,
  })
  // Every character cmd.exe reads specially is escaped.
  expect(
    ['1%', 'e!f', 'c^d', 'g|h', '<i>', '(x)', 'a;b,c', 'w*?'].map((arg) => cmdArgument(arg, false)),
  ).toEqual([
    '^"1^%^"',
    '^"e^!f^"',
    '^"c^^d^"',
    '^"g^|h^"',
    '^"^<i^>^"',
    '^"^(x^)^"',
    '^"a^;b^,c^"',
    '^"w^*^?^"',
  ])
  // Quoted for the program, then each special character escaped once per cmd.exe pass.
  expect(cmdArgument('a&b', false)).toBe('^"a^&b^"')
  expect(cmdArgument('a&b', true)).toBe('^^^"a^^^&b^^^"')
  expect(cmdArgument('say "hi"\\', false)).toBe('^"say^ \\^"hi\\^"\\\\^"')
  expect(() => windowsLaunch('gh-agent', ['api', '-f', 'body=one\ntwo'], env)).toThrow(
    'gh-agent.cmd is a batch file, which cannot receive an argument with a line break',
  )
  // A quote passes: GitHub's ETags are quoted, and the conditional reads of the Source send one back.
  expect(
    windowsLaunch('gh-agent', ['api', 'repos/a/b/issues', '-H', 'If-None-Match: W/"0d8f"'], env).args[4],
  ).toBe(
    `"${join(directory, 'bin^ ^(x86^)', 'gh-agent.cmd')} ^^^"api^^^" ^^^"repos/a/b/issues^^^" ^^^"-H^^^" ^^^"If-None-Match:^^^ W/\\^^^"0d8f\\^^^"^^^""`,
  )
  // Any other program starts as itself, found on PATH, with its arguments as they are.
  writeFileSync(join(directory, 'git.exe'), '')
  expect(windowsLaunch('git', ['log', 'a\nb'], { PATH: directory, PATHEXT: '.exe' })).toEqual({
    program: join(directory, 'git.exe'),
    args: ['log', 'a\nb'],
    verbatim: false,
  })
})

it("merges a Windows child's variables without case: one PATH, the agent's", () => {
  vi.stubEnv('Path', 'C:\\Windows')
  vi.stubEnv('git_dir', 'C:\\elsewhere\\.git')
  setAgentVariables({ PATH: 'C:\\state\\worker-bin;C:\\Windows' })
  const env = childEnvironment({}, 'win32')
  const paths = Object.entries(env).filter(([name]) => name.toUpperCase() === 'PATH')
  expect(paths).toHaveLength(1)
  expect(paths[0]?.[1]).toBe('C:\\state\\worker-bin;C:\\Windows')
  expect(
    Object.keys(env).map((name) => name.toUpperCase()),
    'a lower-case GIT_DIR is ambient too',
  ).not.toContain('GIT_DIR')
})

it('retries a file another program holds, then gives up with its error; other errors at once', async () => {
  const held = Object.assign(new Error('held'), { code: 'EPERM' })
  expect([busy(held, 'win32'), busy(held, 'linux'), busy({ code: 'EBUSY' }, 'linux')]).toEqual([
    true,
    false,
    true,
  ])
  let calls = 0
  const sleeps: number[] = []
  const sleep = async (ms: number) => {
    sleeps.push(ms)
  }
  await expect(
    retryBusy(
      async () => {
        calls++
        if (calls < 3) throw held
        return 'moved'
      },
      'win32',
      [1, 2, 3],
      sleep,
    ),
  ).resolves.toBe('moved')
  expect(sleeps).toEqual([1, 2])
  calls = 0
  await expect(retryBusy(async () => (calls++, Promise.reject(held)), 'win32', [1, 2], sleep)).rejects.toBe(
    held,
  )
  expect(calls).toBe(3)
  calls = 0
  await expect(retryBusy(async () => (calls++, Promise.reject(held)), 'linux', [1, 2], sleep)).rejects.toBe(
    held,
  )
  expect(calls, 'EPERM is not a held file on POSIX').toBe(1)
})
