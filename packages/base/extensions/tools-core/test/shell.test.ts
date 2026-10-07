import { checkToolDef } from '@agnes/extension-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { ShellJobs } from '../../jobs/src/registry.js'
import { OUTPUT_LIMITS } from '../src/guards/output.js'
import { createShellTool, SHELL_SENTINEL } from '../src/tools/shell.js'

// Compatibility foreground executor for hosts without a session job registry.
const shellTool = createShellTool()

const textOf = (r: { content: { type: string }[] }): string =>
  (r.content[0] as { type: 'text'; text: string }).text

describe('shell', () => {
  it('preserves foreground execution for a backend that cannot rewrite host argv', async () => {
    const ctx = fakeToolContext()
    ctx.sandbox.confine = async () => {
      throw Object.assign(new Error('external backend'), { code: 'SANDBOX_UNAVAILABLE' })
    }
    const result = await createShellTool(new ShellJobs()).execute({ command: 'echo ready' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(ctx.calls.exec).toHaveLength(1)
    expect(ctx.calls.exec[0]).toEqual([SHELL_SENTINEL, 'echo ready'])
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
      costHint: {},
      deferLoading: false,
      requiresApproval: undefined,
    })
  })

  it('runs through ctx.exec with the shell sentinel and default timeout', async () => {
    const ctx = fakeToolContext({ exec: (cmd) => ({ code: 0, stdout: `ran ${cmd[1]}`, stderr: '' }) })
    const r = await shellTool.execute({ command: 'echo hi' }, ctx)
    expect(ctx.calls.exec[0]).toEqual([SHELL_SENTINEL, 'echo hi'])
    expect(ctx.calls.execOpts[0]).toEqual({ cwd: ctx.cwd, timeoutMs: ctx.timeoutMs })
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
  const marker = (ms: number): string =>
    `[timed out after ${ms}ms: the command and the processes in its process group were killed; the output above is what was captured, and the command may have taken partial effect. Check the current state before retrying, and split the work into shorter steps or ask for a longer timeoutMs (capped by the deployment).]`

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
  ])('reports %s', async (_name, result, before) => {
    const ctx = fakeToolContext({ timeoutMs: 1000, exec: () => ({ ...result, timedOut: true }) })
    const r = await shellTool.execute({ command: 'sleep 9' }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe(`${before}${marker(1000)}`)
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
