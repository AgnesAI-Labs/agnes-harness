import { checkToolDef, type JobInfo, type JobOutput, type ToolContext } from '@agnes/extension-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { OUTPUT_LIMITS } from '../src/guards/output.js'
import { MAX_TIMED_OUT_ENTRIES, SHELL_SENTINEL, shellTool } from '../src/tools/shell.js'

const textOf = (r: { content: { type: string }[] }): string =>
  (r.content[0] as { type: 'text'; text: string }).text

describe('shell', () => {
  it('has a complete definition with replay never', () => {
    expect(checkToolDef(shellTool)).toEqual({ ok: true })
    expect(shellTool.meta.replay).toBe('never')
    expect(shellTool.description).not.toMatch(/bash|powershell|windows|posix/i)
  })

  it('says what background does and that nothing a foreground command starts outlives the call', () => {
    expect(shellTool.description).toMatch(/foreground command starts does not outlive the call/)
    expect(shellTool.description).toMatch(/background: true starts the command as a background job/)
    expect(shellTool.description).toMatch(/job tool/)
  })

  it('declares itself destructive, open-world and left to the command policy for approval', () => {
    expect(shellTool.meta).toEqual({
      isReadOnly: false,
      isDestructive: true,
      isConcurrencySafe: false,
      isOpenWorld: true,
      replay: 'never',
      costHint: {},
      deferLoading: false,
      requiresApproval: undefined,
    })
  })

  it('runs through ctx.exec with the shell sentinel and default timeout', async () => {
    const ctx = fakeToolContext({ exec: (cmd) => ({ code: 0, stdout: `ran ${cmd[1]}`, stderr: '' }) })
    const r = await shellTool.execute({ command: 'echo hi' }, ctx)
    expect(ctx.calls.exec[0]).toEqual([SHELL_SENTINEL, 'echo hi'])
    expect(ctx.calls.execOpts[0]).toEqual({
      cwd: ctx.cwd,
      timeoutMs: ctx.timeoutMs,
      env: { PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' },
    })
    expect(r.isError).toBeUndefined()
    expect(r.content[0]).toEqual({ type: 'text', text: 'ran echo hi\n[exit 0]' })
  })

  it('marks non-zero exit as error and includes stderr', async () => {
    const ctx = fakeToolContext({ exec: () => ({ code: 2, stdout: '', stderr: 'boom' }) })
    const r = await shellTool.execute({ command: 'false' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content[0]).toEqual({ type: 'text', text: '[stderr]\nboom\n[exit 2]' })
  })

  it('marks a negative exit code as a failure, not a success', async () => {
    // Runners report a signal death as a negative code. Only exactly zero is a success; anything
    // else, in either direction, has to reach the model as a failed call.
    const ctx = fakeToolContext({ exec: () => ({ code: -1, stdout: 'partial', stderr: '' }) })
    const r = await shellTool.execute({ command: 'killed' }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('partial\n[exit -1]')
  })

  it('reports an exit code of zero with no output at all', async () => {
    const ctx = fakeToolContext()
    expect(textOf(await shellTool.execute({ command: 'true' }, ctx))).toBe('[exit 0]')
  })

  it('passes a caller cwd through unchanged', async () => {
    const ctx = fakeToolContext()
    await shellTool.execute({ command: 'ls', cwd: '../elsewhere' }, ctx)
    // Not resolved or rewritten here: whatever confines the command must see the directory that was
    // actually asked for.
    expect(ctx.calls.execOpts[0]?.cwd).toBe('../elsewhere')
  })

  it('says the output was cut short when the sandbox cut it short', async () => {
    const ctx = fakeToolContext({ exec: () => ({ code: 0, stdout: 'partial', stderr: '', truncated: true }) })
    expect(textOf(await shellTool.execute({ command: 'yes' }, ctx))).toBe(
      'partial\n[exit 0] [output truncated by sandbox]',
    )
  })

  it('bounds long output through the output guard', async () => {
    const ctx = fakeToolContext({
      exec: () => ({ code: 0, stdout: 'z'.repeat(OUTPUT_LIMITS.maxBytes + 1), stderr: '' }),
    })
    const r = await shellTool.execute({ command: 'cat big' }, ctx)
    expect(textOf(r)).toContain('[truncated')
    expect(textOf(r).length).toBeLessThanOrEqual(OUTPUT_LIMITS.maxBytes)
    expect(r.content[1]).toMatchObject({ type: 'ref' })
  })

  it('reports a command that could not be started as an error rather than throwing', async () => {
    const ctx = fakeToolContext({
      exec: () => {
        throw new Error('sandbox refused to launch')
      },
    })
    const r = await shellTool.execute({ command: 'rm -rf /' }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('sandbox refused to launch')
    expect(textOf(r)).toContain('could not be started')
  })

  it('returns a result rather than letting a hostile store rejection escape execute()', async () => {
    // Same boundary as read: the guard is called outside the `try` around `ctx.exec`, so a throw
    // while describing a store failure would leave `execute()` altogether.
    const ctx = fakeToolContext({
      exec: () => ({ code: 0, stdout: 'z'.repeat(OUTPUT_LIMITS.maxBytes + 1), stderr: '' }),
    })
    ctx.artifacts.put = () => Promise.reject(Object.create(null))
    const r = await shellTool.execute({ command: 'yes' }, ctx)
    expect(textOf(r)).toContain('could not be stored')
    expect(r.isError).toBeUndefined()
  })
})

// The command line reaches the interpreter exactly as the model wrote it. Anything this tool added,
// removed or split would either execute something nobody asked for, or hide from the policy layer
// what is about to run.
describe('shell does not widen what it executes', () => {
  it('passes the command as one argv element, whatever it contains', async () => {
    const ctx = fakeToolContext()
    for (const command of [
      'echo "a b"; rm -rf /tmp/x && echo `whoami`',
      'printf "%s\\n" $HOME',
      'grep -r "needle" . | head -1',
      'echo one\necho two',
      "sed -i '' 's/a/b/' f",
      // A NUL is passed on as written rather than stripped: sanitising it here would change the
      // command line without saying so, and rejecting it is the host's call, not this tool's.
      'echo \u0000 nul',
    ]) {
      const before = ctx.calls.exec.length
      await shellTool.execute({ command }, ctx)
      expect(ctx.calls.exec[before], command).toEqual([SHELL_SENTINEL, command])
    }
  })

  it('never puts anything else on the argv', async () => {
    const ctx = fakeToolContext()
    await shellTool.execute({ command: 'ls', cwd: '/tmp', timeoutMs: 10 }, ctx)
    expect(ctx.calls.exec[0]).toHaveLength(2)
    expect(ctx.calls.exec[0]?.[0]).toBe('$SHELL')
  })

  it('does not mistake a sentinel inside the command for the interpreter slot', async () => {
    const ctx = fakeToolContext()
    await shellTool.execute({ command: 'echo $SHELL' }, ctx)
    expect(ctx.calls.exec[0]).toEqual(['$SHELL', 'echo $SHELL'])
  })

  it('lets the caller shorten the timeout but not lengthen it past the host limit', async () => {
    const ctx = fakeToolContext({ timeoutMs: 1000 })
    await shellTool.execute({ command: 'a', timeoutMs: 250 }, ctx)
    expect(ctx.calls.execOpts[0]?.timeoutMs).toBe(250)
    await shellTool.execute({ command: 'b', timeoutMs: 86_400_000 }, ctx)
    expect(ctx.calls.execOpts[1]?.timeoutMs).toBe(1000)
  })

  it('falls back to the host limit for a timeout that is not a positive whole number', async () => {
    // The schema rejects each of these, but the clamp is the last thing between the model and the
    // host ceiling, so it has to hold without the schema in front of it. NaN is the dangerous one:
    // Math.min(NaN, ceiling) is NaN, which is no ceiling at all.
    const ctx = fakeToolContext({ timeoutMs: 1000 })
    for (const t of [Number.NaN, -1, 0, 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const before = ctx.calls.execOpts.length
      await shellTool.execute({ command: 'a', timeoutMs: t }, ctx)
      expect(ctx.calls.execOpts[before]?.timeoutMs, String(t)).toBe(1000)
    }
  })
})

// How long a foreground call may run: the preset default unless the caller asks, a caller may ask for
// more up to the call's limit, and what it asked for beyond that is capped. There is no background
// mode to fall back on, so this is how a long command gets its time.
describe('shell foreground time', () => {
  const asked = async (opts: Parameters<typeof fakeToolContext>[0], args: { timeoutMs?: number }) => {
    const ctx = fakeToolContext(opts)
    await shellTool.execute({ command: 'x', ...args }, ctx)
    return ctx.calls.execOpts[0]?.timeoutMs
  }
  it.each([
    [
      'uses the preset default when the caller asks for nothing',
      { timeoutMs: 598_000, defaultTimeoutMs: 100_000 },
      {},
      100_000,
    ],
    [
      'grants a request between the default and the limit as asked',
      { timeoutMs: 598_000, defaultTimeoutMs: 100_000 },
      { timeoutMs: 300_000 },
      300_000,
    ],
    [
      'caps a request above the limit at the limit',
      { timeoutMs: 598_000, defaultTimeoutMs: 100_000 },
      { timeoutMs: 86_400_000 },
      598_000,
    ],
    ['falls back to 120000 when the host states no default', { timeoutMs: 598_000 }, {}, 120_000],
    [
      'never gives a default longer than the limit',
      { timeoutMs: 30_000, defaultTimeoutMs: 120_000 },
      {},
      30_000,
    ],
    [
      'ignores a request that is not a positive whole number',
      { timeoutMs: 598_000, defaultTimeoutMs: 100_000 },
      { timeoutMs: 1.5 },
      100_000,
    ],
  ] as const)('%s', async (_name, opts, args, expected) => {
    expect(await asked(opts, args)).toBe(expected)
  })

  it('says in the timeout text that the request was capped, and only then', async () => {
    const exec = () => ({ code: -1, stdout: '', stderr: '', timedOut: true })
    const capped = fakeToolContext({ timeoutMs: 598_000, defaultTimeoutMs: 100_000, exec })
    expect(textOf(await shellTool.execute({ command: 'x', timeoutMs: 86_400_000 }, capped))).toContain(
      '[timed out after 598000ms (requested 86400000ms, capped): ',
    )
    const granted = fakeToolContext({ timeoutMs: 598_000, defaultTimeoutMs: 100_000, exec })
    expect(textOf(await shellTool.execute({ command: 'x', timeoutMs: 300_000 }, granted))).toContain(
      '[timed out after 300000ms: ',
    )
  })

  it('does not promise an extension beyond a deployment maximum in a number', () => {
    expect(shellTool.description).not.toMatch(/\d{4,}/)
    expect(shellTool.description).toMatch(/longer timeoutMs|timeoutMs.*up to/i)
  })
})

// The executor's own deadline is the first cause when it says so. The model is told what was captured,
// how long the limit was, that the processes were killed, and what it can do about it; there is no
// exit line, because the exit code of a killed command says nothing and the UI reads `[exit N]` last.
describe('shell timeout', () => {
  afterEach(() => vi.restoreAllMocks())
  const marker = (ms: number, printed = true): string =>
    `[timed out after ${ms}ms: the command and the processes in its process group were killed; ${printed ? 'the output above is what was captured' : 'it printed nothing, so this result does not show where it was or why it was slow'}, and the command may have taken partial effect. Check the current state before retrying. Do not rerun it unchanged: make it print its progress, split it into shorter steps, or ask for a longer timeoutMs (capped by the deployment).]`

  it.each([
    ['the captured output, then the marker', { code: -1, stdout: 'part', stderr: '' }, 'part\n'],
    ['stderr before the marker', { code: -1, stdout: 'o', stderr: 'e' }, 'o\n[stderr]\ne\n'],
    ['no output at all, just the marker', { code: -1, stdout: '', stderr: '' }, ''],
    [
      'the marker even when the command trapped the kill and exited 0',
      { code: 0, stdout: 'x', stderr: '' },
      'x\n',
    ],
    [
      'a sandbox truncation note before the marker',
      { code: -1, stdout: 'x', stderr: '', truncated: true },
      'x\n[output truncated by sandbox]\n',
    ],
  ])('reports %s', async (name, result, before) => {
    const ctx = fakeToolContext({
      sessionKey: `timeout-${name}`,
      timeoutMs: 1000,
      exec: () => ({ ...result, timedOut: true }),
    })
    const r = await shellTool.execute({ command: 'sleep 9' }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe(`${before}${marker(1000, before !== '')}`)
    expect(textOf(r)).not.toMatch(/\[exit /)
    expect(textOf(r)).not.toContain('background=true')
  })

  it('names the limit that was actually passed to the executor', async () => {
    const ctx = fakeToolContext({
      timeoutMs: 1000,
      exec: () => ({ code: -1, stdout: '', stderr: '', timedOut: true }),
    })
    const r = await shellTool.execute({ command: 'sleep 9', timeoutMs: 250 }, ctx)
    expect(textOf(r)).toContain('[timed out after 250ms:')
  })

  it('keeps the marker last when long output is cut by the guard', async () => {
    const ctx = fakeToolContext({
      timeoutMs: 1000,
      exec: () => ({ code: -1, stdout: 'z'.repeat(OUTPUT_LIMITS.maxBytes + 1), stderr: '', timedOut: true }),
    })
    const text = textOf(await shellTool.execute({ command: 'yes' }, ctx))
    expect(text).toContain('[truncated')
    expect(text.endsWith(marker(1000))).toBe(true)
  })

  it('does not call a command that finished on its own a timeout', async () => {
    const ctx = fakeToolContext({
      timeoutMs: 1000,
      exec: () => ({ code: 2, stdout: 'o', stderr: '', timedOut: false }),
    })
    const r = await shellTool.execute({ command: 'false' }, ctx)
    expect(textOf(r)).toBe('o\n[exit 2]')
  })

  it('trusts an executor that says the deadline was not the cause, however long the call took', async () => {
    let now = 5000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const ctx = fakeToolContext({
      timeoutMs: 1000,
      exec: () => {
        now += 1000
        return { code: -1, stdout: 'o', stderr: '', timedOut: false }
      },
    })
    expect(textOf(await shellTool.execute({ command: 'x' }, ctx))).toBe('o\n[exit -1]')
  })

  // An exec that never says (a third-party seam, an older host) still has the kernel's cut-off behind
  // it, so a killed-looking result that took the whole limit is read as the timeout it was.
  it.each([
    ['killed after the whole limit', -1, 1000, true],
    ['killed early by something else', -1, 10, false],
    ['a late ordinary failure', 2, 1000, false],
    ['a late success', 0, 1000, false],
  ])(
    'infers a timeout only when the field is absent and the result looks like one: %s',
    async (_name, code, took, expected) => {
      let now = 5000
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      const ctx = fakeToolContext({
        timeoutMs: 1000,
        exec: () => {
          now += took
          return { code, stdout: 'o', stderr: '' }
        },
      })
      const r = await shellTool.execute({ command: 'x' }, ctx)
      expect(textOf(r).includes('[timed out after 1000ms:')).toBe(expected)
    },
  )
})

const job: JobInfo = {
  id: 'job-1',
  command: 'serve',
  cwd: '/work/proj',
  status: 'running',
  startedAt: '2026-10-11T00:00:00.000Z',
}

/** Jobs that answer `output` from a script, then wait out `waitMs` with nothing new. */
function scriptedJobs(script: { outputs?: Partial<JobOutput>[]; startError?: Error } = {}) {
  const calls = { start: [] as unknown[][], output: [] as unknown[][] }
  let read = 0
  const jobs: NonNullable<ToolContext['jobs']> = {
    async start(cmd, opts) {
      calls.start.push([cmd, opts])
      if (script.startError) throw script.startError
      return { ...job }
    },
    async output(id, opts) {
      calls.output.push([id, opts])
      const next = script.outputs?.[read++]
      if (!next) await new Promise((wait) => setTimeout(wait, opts?.waitMs ?? 0))
      return { ...job, text: '', next: 0, dropped: 0, ...next }
    },
    stop: async () => ({ ...job, status: 'stopped' }),
    list: async () => [{ ...job }],
  }
  return { jobs, calls }
}

describe('shell background jobs', () => {
  afterEach(() => vi.useRealTimers())

  it('starts the command as a job and returns what it printed in its first second', async () => {
    vi.useFakeTimers()
    const { jobs, calls } = scriptedJobs({
      outputs: [{ text: 'Uvicorn running on http://127.0.0.1:8000\n' }],
    })
    const ctx = fakeToolContext({ jobs })
    const pending = shellTool.execute({ command: 'uvicorn app:app', background: true, cwd: 'srv' }, ctx)
    await vi.advanceTimersByTimeAsync(1000)
    const r = await pending
    expect(ctx.calls.exec).toHaveLength(0)
    expect(calls.start).toEqual([
      [[SHELL_SENTINEL, 'uvicorn app:app'], { cwd: 'srv', env: { PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' } }],
    ])
    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toBe(
      'background job job-1 started: uvicorn app:app\nUvicorn running on http://127.0.0.1:8000\n[job-1 running]\nRead its output with the job tool (action output, id job-1; waitMs waits for more) and stop it with action stop. It ends when the session closes.',
    )
  })

  it('reports a job that failed within its first second as an error', async () => {
    const { jobs } = scriptedJobs({
      outputs: [{ text: 'Address already in use\n', status: 'exited', code: 1 }],
    })
    const r = await shellTool.execute({ command: 'serve', background: true }, fakeToolContext({ jobs }))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('Address already in use\n[job-1 exited 1]')
  })

  it('does not call a job that finished cleanly at once a failure', async () => {
    const { jobs } = scriptedJobs({ outputs: [{ text: 'done\n', status: 'exited', code: 0 }] })
    const r = await shellTool.execute({ command: 'true', background: true }, fakeToolContext({ jobs }))
    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toContain('done\n[job-1 exited 0]')
  })

  it('reports a job that could not be started, with the way out', async () => {
    const { jobs } = scriptedJobs({
      startError: new Error('E_JOB_LIMIT: 8 background jobs are already running'),
    })
    const r = await shellTool.execute({ command: 'serve', background: true }, fakeToolContext({ jobs }))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('E_JOB_LIMIT: 8 background jobs are already running')
    expect(textOf(r)).toMatch(/background execution is unavailable here; run the command in the foreground/)
  })

  it('says background execution is unavailable where the session keeps no jobs', async () => {
    const ctx = fakeToolContext()
    const r = await shellTool.execute({ command: 'serve', background: true }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('this session keeps no background jobs')
    expect(ctx.calls.exec).toHaveLength(0)
  })
})

// An executor that owns every process a command starts stops what the command left running when it
// returns. Unsaid, the model found the server it had just started gone a call later and spent the
// next hour blaming the command.
describe('shell says what was stopped when the command returned', () => {
  it('names the processes before the exit line, which stays last', async () => {
    const ctx = fakeToolContext({
      exec: () => ({ code: 0, stdout: 'started', stderr: '', stoppedProcesses: 2 }),
    })
    const r = await shellTool.execute({ command: 'start-server' }, ctx)
    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toBe(
      'started\n[2 processes this command started were still running when it returned and were stopped with it: nothing a foreground command starts outlives the call. Run a process that has to keep going (a server, a watcher) with background: true.]\n[exit 0]',
    )
  })

  it('speaks of one process in the singular', async () => {
    const ctx = fakeToolContext({ exec: () => ({ code: 0, stdout: '', stderr: '', stoppedProcesses: 1 }) })
    expect(textOf(await shellTool.execute({ command: 'start-server' }, ctx))).toContain(
      '[1 process this command started was still running when it returned and was stopped with it:',
    )
  })

  it.each([0, undefined])('says nothing when the executor stopped %j', async (stoppedProcesses) => {
    const ctx = fakeToolContext({
      exec: () => ({
        code: 0,
        stdout: 'ok',
        stderr: '',
        ...(stoppedProcesses === undefined ? {} : { stoppedProcesses }),
      }),
    })
    expect(textOf(await shellTool.execute({ command: 'true' }, ctx))).toBe('ok\n[exit 0]')
  })
})

// A timeout says what to do instead of running the same thing again, and a second timeout of the
// same command in the same place says it is the second. A model re-ran a five-minute command that
// had printed nothing, unchanged, twice, and between the runs named a cause it had no output for.
describe('shell after a timeout', () => {
  let sessions = 0
  const timingOut = (opts: Parameters<typeof fakeToolContext>[0] = {}) =>
    fakeToolContext({
      sessionKey: `after-timeout-${sessions++}`,
      timeoutMs: 1000,
      exec: () => ({ code: -1, stdout: '', stderr: '', timedOut: true }),
      ...opts,
    })
  const run = async (ctx: ReturnType<typeof fakeToolContext>, command: string, cwd?: string) =>
    textOf(await shellTool.execute({ command, ...(cwd ? { cwd } : {}) }, ctx))
  const AGAIN = /\[this exact command has now timed out \d+ times in this session\.\]/

  it('offers a background job as a way out only where the session keeps jobs', async () => {
    const without = await run(timingOut(), 'slow')
    expect(without).toContain(
      'Do not rerun it unchanged: make it print its progress, split it into shorter steps, or ask',
    )
    expect(without).not.toContain('background')
    const { jobs } = scriptedJobs()
    expect(await run(timingOut({ jobs }), 'slow')).toContain(
      'split it into shorter steps, run it with background: true and read its output with the job tool, or ask for a longer timeoutMs',
    )
  })

  it('counts the timeouts of the same command in the same directory, and says so from the second', async () => {
    const ctx = timingOut()
    expect(await run(ctx, 'python check.py')).not.toMatch(AGAIN)
    expect(await run(ctx, 'python other.py')).not.toMatch(AGAIN)
    expect(await run(ctx, 'python check.py', 'elsewhere')).not.toMatch(AGAIN)
    const second = await run(ctx, 'python check.py')
    expect(second).toMatch(
      /^\[this exact command has now timed out 2 times in this session\.\]\n\[timed out after/,
    )
    expect(await run(ctx, 'python check.py')).toMatch(/timed out 3 times/)
  })

  it('keeps each session to its own count', async () => {
    const first = timingOut()
    await run(first, 'python check.py')
    expect(await run(timingOut(), 'python check.py')).not.toMatch(AGAIN)
    expect(await run(first, 'python check.py')).toMatch(AGAIN)
  })

  it('starts again after the same command finishes in time', async () => {
    let timedOut = true
    const ctx = timingOut({ exec: () => ({ code: timedOut ? -1 : 0, stdout: '', stderr: '', timedOut }) })
    await run(ctx, 'make test')
    timedOut = false
    expect(await run(ctx, 'make test')).toBe('[exit 0]')
    timedOut = true
    expect(await run(ctx, 'make test')).not.toMatch(AGAIN)
  })

  it('forgets the oldest command first once the table is full', async () => {
    const ctx = timingOut()
    await run(ctx, 'first')
    for (let i = 0; i < MAX_TIMED_OUT_ENTRIES; i++) await run(ctx, `other ${i}`)
    expect(await run(ctx, 'first')).not.toMatch(AGAIN)
    expect(await run(ctx, `other ${MAX_TIMED_OUT_ENTRIES - 1}`)).toMatch(AGAIN)
  })
})

// Under PowerShell, a model wrapped a third of its commands in `powershell -Command "..."`; wherever
// the string held a `$`, the outer shell expanded it first and the inner one failed to parse what
// was left. The wrapper is recognised at the start of the line, and only under PowerShell.
describe('shell under PowerShell', () => {
  const NOTE =
    '[this command already runs in PowerShell: a powershell or pwsh -Command wrapper makes the outer shell expand $ variables and quotes in its string before the inner one runs. Write the command directly.]'
  const inShell = (shell: 'posix' | 'powershell', opts: Parameters<typeof fakeToolContext>[0] = {}) => {
    const ctx = fakeToolContext(opts)
    return Object.assign(ctx, { platform: { ...ctx.platform, shell } })
  }

  it.each([
    'powershell -Command "try { $r = Invoke-WebRequest $u } catch { $_ }"',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-Date"',
    "pwsh -c 'Get-Date'",
    '& "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -command Get-Date',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Com Get-Date',
    '  PowerShell -Command @"\nGet-Date\n"@',
  ])('says the wrapper is not needed, before the exit line: %s', async (command) => {
    const ctx = inShell('powershell', { exec: () => ({ code: 1, stdout: '', stderr: 'ParserError' }) })
    expect(textOf(await shellTool.execute({ command }, ctx))).toBe(`[stderr]\nParserError\n${NOTE}\n[exit 1]`)
  })

  it.each([
    'Get-Date',
    'Write-Output "powershell -Command x"',
    'powershell -File build.ps1 -c 1',
    'pwsh script.ps1 -c',
    'powershell -NoProfile "Get-Date"',
    'powershell -EncodedCommand AAAA',
    'powershellx -c x',
    'python -c "print(1)"',
    'cmd /c run.bat',
  ])('says nothing about a command that does not wrap itself: %s', async (command) => {
    const ctx = inShell('powershell')
    expect(textOf(await shellTool.execute({ command }, ctx))).toBe('[exit 0]')
  })

  it('says nothing where the shell is not PowerShell, where calling pwsh is how to reach it', async () => {
    expect(textOf(await shellTool.execute({ command: "pwsh -c 'Get-Date'" }, inShell('posix')))).toBe(
      '[exit 0]',
    )
  })

  it('says it before a timeout marker, which stays last', async () => {
    const ctx = inShell('powershell', {
      sessionKey: 'powershell-timeout',
      timeoutMs: 1000,
      exec: () => ({ code: -1, stdout: '', stderr: '', timedOut: true }),
    })
    const text = textOf(await shellTool.execute({ command: 'powershell -Command "Start-Sleep 9"' }, ctx))
    expect(text.startsWith(`${NOTE}\n[timed out after 1000ms:`)).toBe(true)
  })

  it('says it when the wrapped command starts as a background job', async () => {
    const { jobs } = scriptedJobs({ outputs: [{ text: 'ok\n', status: 'exited', code: 0 }] })
    const ctx = inShell('powershell', { jobs })
    const text = textOf(await shellTool.execute({ command: 'pwsh -c serve', background: true }, ctx))
    expect(text).toContain(`ok\n${NOTE}\n[job-1 exited 0]`)
  })
})
