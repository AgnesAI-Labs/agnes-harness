import { checkToolDef } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { OUTPUT_LIMITS } from '../src/guards/output.js'
import { SHELL_SENTINEL, shellTool } from '../src/tools/shell.js'

const textOf = (r: { content: { type: string }[] }): string =>
  (r.content[0] as { type: 'text'; text: string }).text

describe('shell', () => {
  it('has a complete definition with replay never', () => {
    expect(checkToolDef(shellTool)).toEqual({ ok: true })
    expect(shellTool.meta.replay).toBe('never')
    expect(shellTool.description).not.toMatch(/bash|powershell|windows|posix/i)
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

describe('shell background jobs', () => {
  it('submits a background job instead of blocking', async () => {
    const ctx = fakeToolContext()
    const r = await shellTool.execute({ command: 'sleep 100', background: true }, ctx)
    expect(ctx.calls.exec).toHaveLength(0)
    expect(r.content[0]).toEqual({ type: 'text', text: 'background job job-1 started' })
    expect(r.isError).toBeUndefined()
  })

  it('submits the command and cwd under the tool call id as its idempotency key', async () => {
    const ctx = fakeToolContext()
    await shellTool.execute({ command: 'sleep 100', background: true, cwd: '/tmp' }, ctx)
    expect(ctx.calls.jobs[0]).toEqual({
      idempotencyKey: ctx.session.toolUseId,
      payload: { kind: 'shell', command: 'sleep 100', cwd: '/tmp' },
      schedule: { kind: 'once' },
    })
  })

  it('reports a job that could not be submitted as an error', async () => {
    const ctx = fakeToolContext()
    ctx.artifacts.submitJob = () => Promise.reject(new Error('job store offline'))
    const r = await shellTool.execute({ command: 'sleep 100', background: true }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('job store offline')
  })
})
