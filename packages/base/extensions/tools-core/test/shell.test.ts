import { resolve } from 'node:path'
import { checkToolDef, type HookContext, type ProcessExit, type ProcessOutput } from '@agnes/extension-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { createJobTools, jobHooks } from '../../jobs/src/index.js'
import { ShellJobs } from '../../jobs/src/registry.js'
import { OUTPUT_LIMITS } from '../src/guards/output.js'
import { createShellTool, SHELL_SENTINEL } from '../src/tools/shell.js'

// Compatibility foreground executor for hosts without a session job registry.
const shellTool = createShellTool()

const textOf = (r: { content: { type: string }[] }): string =>
  (r.content[0] as { type: 'text'; text: string }).text

describe('shell observation window with a live job registry', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  function setup(windowMs?: number) {
    vi.useFakeTimers()
    const ac = new AbortController()
    const ctx = { ...fakeToolContext({ timeoutMs: 1_800_000 }), signal: ac.signal }
    const jobs = new ShellJobs()
    let emit: (output: ProcessOutput) => void = () => {}
    let finish: (exit: ProcessExit) => void = () => {}
    const close = vi.fn(async () => {
      finish({ code: 0 })
    })
    ctx.sandbox.openProcess = async () => ({
      enforcement: { level: 'none', scope: [] },
      exited: new Promise((resolve) => {
        finish = resolve
      }),
      onOutput: (listener) => {
        emit = listener
        return () => {}
      },
      write: async () => {},
      resize: async () => {},
      signal: async () => {},
      close,
    })
    return {
      ctx,
      jobs,
      ac,
      close,
      tool: createShellTool(jobs, windowMs),
      emit: (output: ProcessOutput) => emit(output),
      finish: (exit: ProcessExit) => finish(exit),
    }
  }
  it.each([
    [10_000, 10_000],
    [30_000, 30_000],
    [undefined, 120_000],
  ] as const)(
    'window=%s returns at %s with captured output, preserving the same readable service',
    async (windowMs, expected) => {
      const h = setup(windowMs)
      try {
        let returned = false
        const pending = h.tool.execute({ command: 'serve', timeoutMs: 600_000 }, h.ctx).then((result) => {
          returned = true
          return result
        })
        await vi.advanceTimersByTimeAsync(0)
        h.emit({ stream: 'stdout', text: 'server ready\n' })
        h.emit({ stream: 'stderr', text: 'startup warning\n' })
        await vi.advanceTimersByTimeAsync(expected - 1)
        expect(returned).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        const result = await pending
        expect(result.structured).toMatchObject({ status: 'running' })
        expect(textOf(result)).toContain('server ready\n\n[stderr]\nstartup warning')
        expect(textOf(result)).not.toContain('[exit ')
        const id = h.jobs.list(h.ctx)[0]!.id
        expect(result.details).toMatchObject({ jobId: id, status: 'running' })
        h.emit({ stream: 'stdout', text: 'request handled\n' })
        const output = createJobTools(h.jobs).find((tool) => tool.name === 'job_output')!
        expect(textOf(await output.execute({ jobId: id }, h.ctx))).toContain('request handled')
        const hookCtx: HookContext = { ...h.ctx, replayed: false, unattended: true }
        const hooks = jobHooks(h.jobs)
        const stop = { turn: 1, step: 1, proposedReason: 'completed' as const }
        expect(await hooks.turn_stopping(stop, hookCtx)).toMatchObject({ action: 'continue' })
        expect(await hooks.turn_stopping(stop, hookCtx)).toEqual({ action: 'stop' })
        expect(h.jobs.list(h.ctx)[0]?.status).toBe('running')
        expect(h.close).not.toHaveBeenCalled()
        h.finish({ code: 0 })
        await vi.advanceTimersByTimeAsync(0)
        expect(await h.jobs.wait(h.ctx, id, 0)).toMatchObject({
          status: 'completed',
          stdout: 'server ready\nrequest handled\n',
        })
      } finally {
        await h.jobs.dispose()
      }
    },
  )
  it('returns on a fast exit without spending the observation window', async () => {
    const h = setup(10_000)
    try {
      const start = Date.now()
      const pending = h.tool.execute({ command: 'fast' }, h.ctx)
      await vi.advanceTimersByTimeAsync(0)
      h.emit({ stream: 'stdout', text: 'done' })
      h.finish({ code: 0 })
      await vi.advanceTimersByTimeAsync(0)
      const result = await pending
      expect(result.details).toMatchObject({ status: 'completed', code: 0 })
      expect(textOf(result)).toContain('done\n[exit 0]')
      expect(Date.now() - start).toBe(0)
    } finally {
      await h.jobs.dispose()
    }
  })
  it('bounds the running snapshot with explicit truncation and a retained tail', async () => {
    const h = setup(10_000)
    try {
      const pending = h.tool.execute({ command: 'logs' }, h.ctx)
      await vi.advanceTimersByTimeAsync(0)
      h.emit({ stream: 'stdout', text: 'HEAD\n' + 'x'.repeat(100_000) + '\nTAIL' })
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await pending
      expect(textOf(result)).toContain('HEAD')
      expect(textOf(result)).toContain('TAIL')
      expect(textOf(result)).toContain('[truncated:')
      expect(textOf(result).length).toBeLessThan(h.ctx.outputMaxBytes)
      expect(result.content.some((block) => block.type === 'ref')).toBe(true)
    } finally {
      await h.jobs.dispose()
    }
  })
  it('cancels an observed foreground job and keeps explicit termination deadlines', async () => {
    const h = setup(10_000)
    try {
      const pending = h.tool.execute({ command: 'long' }, h.ctx)
      await vi.advanceTimersByTimeAsync(0)
      h.ac.abort()
      expect((await pending).isError).toBe(true)
      expect(h.jobs.list(h.ctx)[0]?.status).toBe('killed')
      expect(h.close).toHaveBeenCalled()
    } finally {
      await h.jobs.dispose()
    }
    const terminating = setup(10_000)
    try {
      let returned = false
      const pending = terminating.tool
        .execute({ command: 'bounded', timeoutMs: 40_000, timeoutToBackground: false }, terminating.ctx)
        .then((result) => {
          returned = true
          return result
        })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(returned).toBe(false)
      await vi.advanceTimersByTimeAsync(30_000)
      expect((await pending).details).toMatchObject({ code: 'SHELL_TIMEOUT' })
      expect(terminating.jobs.list(terminating.ctx)[0]?.status).toBe('killed')
    } finally {
      await terminating.jobs.dispose()
    }
  })
})

describe('shell', () => {
  it('preserves foreground execution when the Host process port is unavailable', async () => {
    const ctx = fakeToolContext({ cwd: resolve('/work/proj') })
    ctx.sandbox.openProcess = async () => {
      throw Object.assign(new Error('external backend'), { code: 'SANDBOX_UNAVAILABLE' })
    }
    const result = await createShellTool(new ShellJobs()).execute({ command: 'echo ready' }, ctx)
    expect(result.isError, JSON.stringify(result)).toBeUndefined()
    expect(ctx.calls.exec).toHaveLength(1)
    expect(ctx.calls.exec[0]).toEqual([SHELL_SENTINEL, 'echo ready'])
  })

  it.each([
    ['SHELL_BUSY: wait for the running command before sending another', 'SHELL_BUSY', 'job_output'],
    ['unsupported shell; choose bash, zsh or pwsh', 'SHELL_INVALID_INTERPRETER', 'bash, zsh or pwsh'],
    ['shell session is closed or is not a persistent shell', 'SHELL_SESSION_CLOSED', 'omit sessionId'],
    ['session job limit reached; close a running job first', 'SHELL_JOB_LIMIT', 'job_kill'],
    ['job cwd must be readable', 'SHELL_CWD_UNREADABLE', 'accessible directory'],
    ['/private/secret-root sk-private-backend-value-123456789', 'SHELL_JOB_FAILED', 'current state'],
  ])('returns a bounded recovery action for %s', async (message, code, next) => {
    const jobs = new ShellJobs()
    vi.spyOn(jobs, 'start').mockRejectedValue(new Error(message))
    const ctx = fakeToolContext()
    const result = await createShellTool(jobs).execute({ command: 'echo ready' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.details).toMatchObject({ code })
    expect(textOf(result)).toContain(next)
    expect(JSON.stringify(result)).not.toContain('/private/secret-root')
    expect(JSON.stringify(result)).not.toContain('sk-private')
    expect(ctx.calls.exec).toEqual([])
  })

  it('says a started job ran when its result cannot be read, instead of that it could not start', async () => {
    const jobs = new ShellJobs()
    vi.spyOn(jobs, 'start').mockResolvedValue({ id: 'job-7' } as never)
    vi.spyOn(jobs, 'wait').mockRejectedValue(new Error('backend lost'))
    const result = await createShellTool(jobs).execute({ command: 'echo ready' }, fakeToolContext())
    expect(result.isError).toBe(true)
    expect(result.details).toMatchObject({ code: 'SHELL_JOB_UNREAD' })
    expect(textOf(result)).toContain('command started as job job-7')
    expect(textOf(result)).not.toContain('could not be started')
  })

  it('has a complete definition with replay never', () => {
    expect(checkToolDef(shellTool)).toEqual({ ok: true })
    expect(shellTool.meta.replay).toBe('never')
    expect(shellTool.description).not.toMatch(/bash|powershell|windows|posix/i)
  })

  it('describes session jobs and their control tools', () => {
    expect(shellTool.description).not.toMatch(/background=true|poll the returned job/i)
    expect(shellTool.description).toContain('timeoutToBackground')
  })

  it('declares itself destructive, open-world and left to the command policy for approval', () => {
    expect(shellTool.meta).toEqual({
      isReadOnly: false,
      isDestructive: true,
      isConcurrencySafe: false,
      isOpenWorld: true,
      replay: 'never',
      commandArg: 'command',
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
    expect(r.content[0]).toEqual({
      type: 'text',
      text: '[stderr]\nboom\nCommand failed; inspect the output and current state, correct the command/arguments, then retry.\n[exit 2]',
    })
  })

  it('marks a negative exit code as a failure, not a success', async () => {
    // Runners report a signal death as a negative code. Only exactly zero is a success; anything
    // else, in either direction, has to reach the model as a failed call.
    const ctx = fakeToolContext({ exec: () => ({ code: -1, stdout: 'partial', stderr: '' }) })
    const r = await shellTool.execute({ command: 'killed' }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('partial\n')
    expect(textOf(r)).toContain('current state')
    expect(textOf(r)).toMatch(/\[exit -1\]$/)
    expect(r.details).toMatchObject({ code: 'SHELL_EXIT', exitCode: -1 })
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
    expect(r.details).toMatchObject({ code: 'SHELL_START_FAILED' })
    expect(textOf(r)).toContain('check the selected interpreter and cwd')
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
  const marker = (ms: number): string =>
    `[timed out after ${ms}ms: the command and the processes in its process group were killed; the output above is what was captured, and the command may have taken partial effect. Check the current state before retrying, and split the work into shorter steps or ask for a longer timeoutMs (capped by the deployment).]`

  it.each([
    ['the captured output, then the marker', { code: -1, stdout: 'part', stderr: '' }, 'part\n'],
    ['stderr before the marker', { code: -1, stdout: 'o', stderr: 'e' }, 'o\n[stderr]\ne\n'],
    ['no output at all, with guidance and the marker', { code: -1, stdout: '', stderr: '' }, ''],
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
  ])('reports %s', async (_name, result, before) => {
    const ctx = fakeToolContext({
      sessionKey: `timeout-${_name}`,
      timeoutMs: 1000,
      exec: () => ({ ...result, timedOut: true }),
    })
    const r = await shellTool.execute({ command: 'sleep 9' }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r).startsWith(before)).toBe(true)
    expect(textOf(r).endsWith(marker(1000))).toBe(true)
    expect(textOf(r)).toContain('do not rerun it unchanged')
    if (!result.stdout && !result.stderr) expect(textOf(r)).toContain('printed no output')
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
    expect(textOf(r)).toContain('o\n')
    expect(textOf(r)).not.toContain('timed out')
    expect(textOf(r)).toMatch(/\[exit 2\]$/)
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
    const result = await shellTool.execute({ command: 'x' }, ctx)
    expect(textOf(result)).toContain('o\n')
    expect(textOf(result)).not.toContain('timed out')
    expect(textOf(result)).toMatch(/\[exit -1\]$/)
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

// A turn with a time limit (agh -p --timeout) stops a foreground command short of its deadline, so one
// long command cannot run past it while the model has no chance to wrap up. The result says so.
describe('shell near the turn deadline', () => {
  afterEach(() => vi.restoreAllMocks())
  const NOW = 1_000_000
  // A 10-minute limit with 100 s left: the margin is max(15 s, 5% of 10 min) = 30 s, so 70 s remain.
  const limit = { timeLimitMs: 600_000, deadlineAt: NOW + 100_000 }

  it('caps a foreground command at the time left less a margin, and says the deadline stopped it', async () => {
    let now = NOW
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const ctx = fakeToolContext({
      timeoutMs: 598_000,
      defaultTimeoutMs: 120_000,
      turnTimeLimit: limit,
      exec: (_argv, opts) => {
        now += opts.timeoutMs ?? 0
        return { code: -1, stdout: 'partial', stderr: '', timedOut: true }
      },
    })
    const r = await shellTool.execute({ command: 'make all', timeoutMs: 300_000 }, ctx)
    expect(ctx.calls.execOpts[0]?.timeoutMs).toBe(70_000)
    expect(r.isError).toBe(true)
    expect(r.details).toEqual({ code: 'SHELL_TURN_DEADLINE' })
    expect(textOf(r)).toBe(
      "partial\n[stopped after 70000ms because this turn's time limit is nearly up: about 30s of the turn remains (deadline 00:18:20 UTC). The command and the processes in its process group were killed; the output above is what was captured, and the command may have taken partial effect. Use the time left for short steps: leave the work in its best checked state and end with a short summary.]",
    )
  })

  it.each([
    ['without a time limit', undefined, 120_000],
    ['with a deadline far enough away', { timeLimitMs: 3_600_000, deadlineAt: NOW + 3_000_000 }, 120_000],
    [
      'inside the margin, with a floor of one second',
      { timeLimitMs: 600_000, deadlineAt: NOW + 10_000 },
      1_000,
    ],
  ] as const)(
    'keeps its own timeout unless the deadline is nearer: %s',
    async (_name, turnTimeLimit, expected) => {
      vi.spyOn(Date, 'now').mockImplementation(() => NOW)
      const ctx = fakeToolContext({
        timeoutMs: 598_000,
        defaultTimeoutMs: 120_000,
        ...(turnTimeLimit ? { turnTimeLimit } : {}),
        exec: () => ({ code: -1, stdout: '', stderr: '', timedOut: true }),
      })
      const text = textOf(await shellTool.execute({ command: 'x' }, ctx))
      expect(ctx.calls.execOpts[0]?.timeoutMs).toBe(expected)
      // Only a cut the deadline made is reported as one.
      expect(text.includes('time limit is nearly up')).toBe(expected === 1_000)
      expect(text.includes('[timed out after')).toBe(expected !== 1_000)
    },
  )

  const jobsFor = (status: 'running' | 'exited') => {
    const jobs = new ShellJobs()
    const waits: number[] = []
    const view = { id: 'job-1', status, stdout: 'so far', stderr: '', code: status === 'exited' ? 0 : null }
    vi.spyOn(jobs, 'start').mockResolvedValue(view as never)
    vi.spyOn(jobs, 'wait').mockImplementation(async (_ctx, _id, ms) => {
      waits.push(ms)
      return view as never
    })
    const kill = vi.spyOn(jobs, 'kill').mockResolvedValue(view as never)
    return { tool: createShellTool(jobs), waits, kill }
  }

  // The process keeps running, so the wait hands control back with half of the usable time left
  // rather than at the margin: the model can still act on what it sees.
  it("ends a session job's foreground wait with time to spare and lets the same process continue", async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => NOW)
    const { tool, waits, kill } = jobsFor('running')
    const ctx = fakeToolContext({ timeoutMs: 598_000, defaultTimeoutMs: 120_000, turnTimeLimit: limit })
    const r = await tool.execute({ command: 'make all' }, ctx)
    expect(waits).toEqual([35_000])
    expect(kill).not.toHaveBeenCalled()
    expect(textOf(r)).toBe(
      'so far\nbackground job job-1 started (foreground wait stopped after 35000ms (requested 120000ms) to leave time in this turn: about 1m40s of the turn remains (deadline 00:18:20 UTC); the same process continues); use job_output, job_list or job_kill. Use the time left for short steps: leave the work in its best checked state and end with a short summary.',
    )
  })

  it('never lets one foreground wait take the rest of a timed turn', async () => {
    // 900 s asked for with 125 s of an 840 s turn left (margin 42 s): half the usable time.
    vi.spyOn(Date, 'now').mockImplementation(() => NOW)
    const { tool, waits } = jobsFor('running')
    const ctx = fakeToolContext({
      timeoutMs: 1_800_000,
      turnTimeLimit: { timeLimitMs: 840_000, deadlineAt: NOW + 125_000 },
    })
    await tool.execute({ command: 'sqlite3 db < slow.sql', timeoutMs: 900_000 }, ctx)
    expect(waits).toEqual([41_500])
    // A wait that fits in half the usable time is left alone.
    await tool.execute({ command: 'make', timeoutMs: 30_000 }, ctx)
    expect(waits).toEqual([41_500, 30_000])
  })

  // compile-compcert: a 600 s apt-get held the turn for ten minutes because half of a 40-minute turn
  // was still more than it asked for. A wait whose process continues now ends at a fixed bound,
  // with or without a turn limit, and the command goes on as the job the result names.
  it.each([
    ['without a time limit', undefined],
    ['with most of a long turn left', { timeLimitMs: 2_400_000, deadlineAt: NOW + 2_320_000 }],
  ] as const)(
    'ends a foreground wait at %s after two minutes and lets the job continue',
    async (_n, turnTimeLimit) => {
      vi.spyOn(Date, 'now').mockImplementation(() => NOW)
      const { tool, waits, kill } = jobsFor('running')
      const ctx = fakeToolContext({ timeoutMs: 1_800_000, ...(turnTimeLimit ? { turnTimeLimit } : {}) })
      const r = await tool.execute({ command: 'apt-get install -y coq', timeoutMs: 600_000 }, ctx)
      expect(waits).toEqual([120_000])
      expect(kill).not.toHaveBeenCalled()
      expect(r.details).toMatchObject({ jobId: 'job-1', status: 'running' })
      expect(textOf(r)).toBe(
        'so far\nbackground job job-1 started (foreground wait stopped at 120000ms, the most one call waits (requested 600000ms); the same process continues); use job_output, job_list or job_kill',
      )
      // A command that must not outlive its timeout keeps the time it asked for.
      await tool.execute({ command: 'make check', timeoutMs: 600_000, timeoutToBackground: false }, ctx)
      expect(waits).toEqual([120_000, 600_000])
    },
  )

  it('names only the job tools this request offers in full', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => NOW)
    const { tool } = jobsFor('running')
    const ctx = fakeToolContext({ timeoutMs: 1_800_000 })
    const offer = (offered: string[]) =>
      Object.assign(ctx.tools, {
        availability: (name: string) => ({
          status: offered.includes(name) ? ('offered' as const) : ('deferred' as const),
          message: '',
        }),
      })
    offer(['job_output'])
    const one = textOf(await tool.execute({ command: 'make', timeoutMs: 600_000 }, ctx))
    expect(one).toMatch(/; use job_output with jobId job-1$/)
    expect(one).not.toMatch(/job_list|job_kill/)
    offer(['tool_describe'])
    const none = textOf(await tool.execute({ command: 'make', timeoutMs: 600_000 }, ctx))
    expect(none).toMatch(/; to check on it, load job_output with tool_describe$/)
    expect(none).not.toMatch(/job_list|job_kill/)
  })

  it('kills a session job at the cap when it may not continue in the background', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => NOW)
    const { tool, kill } = jobsFor('running')
    const ctx = fakeToolContext({ timeoutMs: 598_000, turnTimeLimit: limit })
    const r = await tool.execute({ command: 'make all', timeoutToBackground: false }, ctx)
    expect(kill).toHaveBeenCalledOnce()
    expect(r.details).toEqual({ code: 'SHELL_TURN_DEADLINE' })
    expect(textOf(r)).toContain(
      "[stopped after 70000ms because this turn's time limit is nearly up: about 1m40s",
    )
    expect(textOf(r)).toContain('job job-1 and its process group were killed')
  })

  it('does not wait on, or cap, a background job', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => NOW)
    const { tool, waits } = jobsFor('running')
    const ctx = fakeToolContext({ timeoutMs: 598_000, turnTimeLimit: limit })
    const r = await tool.execute({ command: 'serve', background: true }, ctx)
    expect(waits).toEqual([])
    expect(textOf(r)).toBe('so far\nbackground job job-1 started; use job_output, job_list or job_kill')
  })

  it("keeps a job_output wait inside the turn's time, and leaves the job running", async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => NOW)
    const jobs = new ShellJobs()
    const seen: number[] = []
    vi.spyOn(jobs, 'syncChildren').mockResolvedValue(undefined as never)
    vi.spyOn(jobs, 'wait').mockImplementation(async (_ctx, _id, ms) => {
      seen.push(ms)
      return { id: 'job-1', status: 'running', stdout: '', stderr: '', code: null } as never
    })
    const output = createJobTools(jobs).find((tool) => tool.name === 'job_output')
    const near = { timeLimitMs: 600_000, deadlineAt: NOW + 40_000 }
    await output?.execute({ jobId: 'job-1', waitMs: 60_000 }, fakeToolContext({ turnTimeLimit: near }))
    await output?.execute({ jobId: 'job-1', waitMs: 60_000 }, fakeToolContext())
    // 40 s left less the 30 s margin; without a time limit the asked wait stands.
    expect(seen).toEqual([10_000, 60_000])
  })
})

// `pkill -f` matches the command line of the shell that runs it, which holds the pattern, so the
// command killed itself and came back as a bare `exit -1` (three tasks in one benchmark run).
describe('shell ended by a signal', () => {
  const ended = (command: string, signal: string | undefined, status: 'failed' | 'killed' = 'failed') => {
    const jobs = new ShellJobs()
    const view = {
      id: 'job-1',
      status,
      stdout: 'before\n',
      stderr: '',
      code: -1,
      ...(signal ? { signal } : {}),
    }
    vi.spyOn(jobs, 'start').mockResolvedValue({ ...view, status: 'running', code: null } as never)
    vi.spyOn(jobs, 'wait').mockResolvedValue(view as never)
    return createShellTool(jobs).execute({ command }, fakeToolContext())
  }

  it('says the shell was ended by a signal the command probably sent itself', async () => {
    const r = await ended('pkill -f "http.server 8080"; python3 -m http.server 8080 &', 'SIGTERM')
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain(
      "[the command's shell was ended by SIGTERM, which AGH did not send. pkill -f and killall match the command line of the shell running them, which contains the pattern, so this command probably ended its own shell. Match a narrower pattern (for example pkill -f '[s]erver.py') or use a PID.]",
    )
    expect(textOf(r)).toMatch(/\[exit -1\]$/)
  })

  it('names the signal without guessing a cause when the command sent none', async () => {
    const text = textOf(await ended('make -j8', 'SIGKILL'))
    expect(text).toContain("[the command's shell was ended by SIGKILL, which AGH did not send.]")
    expect(text).not.toContain('pkill')
  })

  it('adds nothing when the shell exited on its own or the job was stopped on request', async () => {
    expect(textOf(await ended('pkill -f x', undefined))).not.toContain('ended by')
    expect(textOf(await ended('pkill -f x', 'SIGKILL', 'killed'))).not.toContain('ended by')
  })
})

describe('shell without a job registry', () => {
  it('fails clearly without pretending a generic artifact job executed the command', async () => {
    const ctx = fakeToolContext()
    const result = await shellTool.execute({ command: 'sleep 100', background: true }, ctx)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('background execution is unavailable')
    expect(ctx.calls.exec).toHaveLength(0)
    expect(ctx.calls.jobs).toHaveLength(0)
  })
})

it('reports measured descendant cleanup and PowerShell wrapper guidance, without claiming a timeout cause', async () => {
  const original = fakeToolContext({ sessionKey: 'shell-guidance' })
  const ctx = { ...original, platform: { ...original.platform, shell: 'powershell' as const } }
  ctx.exec = async () => ({ code: 0, stdout: 'ready', stderr: '', truncated: false, stoppedProcesses: 2 })
  const result = textOf(await shellTool.execute({ command: 'pwsh -Command echo ready' }, ctx))
  expect(result).toContain('stopped 2 descendant')
  expect(result).toContain('omit the extra')
  expect(result).toMatch(/\[exit 0\]$/)
  ctx.exec = async () => ({ code: -1, stdout: '', stderr: '', truncated: false, timedOut: true })
  for (let i = 1; i <= 2; i++) {
    const timeout = textOf(await shellTool.execute({ command: 'slow' }, ctx))
    expect(timeout).toContain('printed no output')
    expect(timeout).toContain('do not rerun it unchanged')
    if (i === 2) expect(timeout).toContain('timed out 2 times')
  }
})
