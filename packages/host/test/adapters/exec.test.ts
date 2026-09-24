import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createExec } from '../../src/adapters/exec.js'
import { runTestNode } from './test-node.js'

const cwd = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'agnes-exec-'))

describe('exec adapter', () => {
  const exec = createExec()
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  it('runs argv without a shell and captures output', async () => {
    const r = await runTestNode(
      exec,
      ['-e', 'process.stdout.write("hi"); process.stderr.write("err"); process.exit(3)'],
      { cwd },
    )
    expect(r).toMatchObject({ code: 3, stdout: 'hi', stderr: 'err', truncated: false, timedOut: false })
  })
  it('does not go through a shell, so shell syntax is an argument', async () => {
    const r = await runTestNode(exec, ['-e', 'process.stdout.write(process.argv[1] ?? "")', '$HOME && ls'], {
      cwd,
    })
    expect(r.stdout).toBe('$HOME && ls')
  })
  it('feeds stdin', async () => {
    const r = await runTestNode(exec, ['-e', 'process.stdin.pipe(process.stdout)'], { cwd, stdin: 'ping' })
    expect(r.stdout).toBe('ping')
  })
  it('closes stdin when none is supplied, so a reader does not hang', async () => {
    const r = await runTestNode(
      exec,
      ['-e', 'process.stdin.on("end", () => process.stdout.write("eof")); process.stdin.resume()'],
      { cwd, timeoutMs: 5000 },
    )
    expect(r).toMatchObject({ stdout: 'eof', timedOut: false })
  })
  it('rejects an empty argv rather than spawning something', async () => {
    await expect(exec.run([], { cwd })).rejects.toThrow(/empty argv/)
  })
  it('rejects when the executable does not exist', async () => {
    await expect(exec.run(['definitely-not-a-real-binary-xyz'], { cwd })).rejects.toThrow()
  })
  it('kills the whole process group on timeout', async () => {
    const script =
      'const { spawn } = require("node:child_process"); const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: process.env }); process.stdout.write(String(c.pid)); c.on("exit", () => {}); setInterval(()=>{},1000)'
    const r = await runTestNode(exec, ['-e', script], { cwd, timeoutMs: 300 })
    expect(r.timedOut).toBe(true)
    // Read as digits before it is read as a number. An empty stdout - the child killed before it
    // could print - passes Number.isInteger, because Number('') is 0, and process.kill(0, sig) on
    // POSIX addresses the caller's own process group rather than raising ESRCH. The liveness check
    // below would then be asking about this very test runner and would answer "alive", so the
    // failure would name the wrong thing and, under any signal but 0, would be aimed at us.
    expect(r.stdout).toMatch(/^[0-9]+$/)
    const grandchild = Number(r.stdout)
    await new Promise((res) => setTimeout(res, 200))
    expect(() => process.kill(grandchild, 0)).toThrow()
  })
  it('truncates output past maxOutputBytes, counted in bytes', async () => {
    const r = await runTestNode(exec, ['-e', 'process.stdout.write("x".repeat(5000))'], {
      cwd,
      maxOutputBytes: 1000,
    })
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThanOrEqual(1000)
  })
  // The cap is stated in bytes while String.length counts UTF-16 units, so a budget enforced on a
  // string is neither the stated limit nor a stable one. Four-byte characters make the two disagree
  // by a factor of two.
  it('counts the byte budget in bytes, not UTF-16 units', async () => {
    const r = await runTestNode(exec, ['-e', 'process.stdout.write("\\u{1F600}".repeat(1000))'], {
      cwd,
      maxOutputBytes: 400,
    })
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThanOrEqual(400)
    expect(r.stdout.length).toBeLessThanOrEqual(200)
  })
  it('does not truncate output that fits, and reports truncated false', async () => {
    const r = await runTestNode(exec, ['-e', 'process.stdout.write("y".repeat(999))'], {
      cwd,
      maxOutputBytes: 1000,
    })
    expect(r.truncated).toBe(false)
    expect(r.stdout.length).toBe(999)
  })
  it('gives the child a floor environment, not the host environment', async () => {
    process.env.AGNES_SECRET_TEST_LEAK = 'must-not-appear'
    try {
      const r = await runTestNode(
        exec,
        [
          '-e',
          'process.stdout.write(JSON.stringify({ path: Boolean(process.env.PATH), leak: process.env.AGNES_SECRET_TEST_LEAK ?? null, extra: process.env.EXTRA ?? null }))',
        ],
        { cwd, env: { EXTRA: 'yes' } },
      )
      expect(JSON.parse(r.stdout)).toEqual({ path: true, leak: null, extra: 'yes' })
    } finally {
      delete process.env.AGNES_SECRET_TEST_LEAK
    }
  })
  it('kills through the injected killTree exactly once when one is supplied', async () => {
    const calls: number[] = []
    const e = createExec({
      killTree: (pid) => {
        calls.push(pid)
        process.kill(-pid, 'SIGKILL')
      },
    })
    const r = await runTestNode(e, ['-e', 'setInterval(()=>{},1000)'], { cwd, timeoutMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(calls).toHaveLength(1)
  })
  it('does not reach for the group kill at all once a killTree is supplied', async () => {
    const calls: number[] = []
    // killTree succeeds without killing anything, so a fallback group kill would be the only thing
    // that could end the child. If the process still dies, the fallback ran when it should not have.
    const e = createExec({ killTree: (pid) => void calls.push(pid) })
    const p = runTestNode(e, ['-e', 'setTimeout(()=>{},400)'], { cwd, timeoutMs: 100 })
    const r = await p
    expect(calls).toHaveLength(1)
    expect(r.timedOut).toBe(true)
    expect(r.signal).toBeUndefined()
    expect(r.code).toBe(0)
  })
  it('honours AbortSignal', async () => {
    const ac = new AbortController()
    const p = runTestNode(exec, ['-e', 'setInterval(()=>{},1000)'], { cwd, signal: ac.signal })
    setTimeout(() => ac.abort(), 100)
    const r = await p
    expect(r.signal).toBe('SIGKILL')
  })
  it('killAll ends everything still in flight', async () => {
    const e = createExec()
    const p = runTestNode(e, ['-e', 'setInterval(()=>{},1000)'], { cwd, timeoutMs: 30_000 })
    await new Promise((res) => setTimeout(res, 150))
    await e.killAll()
    const r = await p
    expect(r.signal).toBe('SIGKILL')
    expect(r.timedOut).toBe(false)
  })
})

// A child that exits without draining stdin makes the write fail on the stream, and a stream error
// is not the `error` event on the child: unhandled, it reaches process.on('uncaughtException') and
// takes the daemon down. `head`, `grep -q` and any tool that validates and rejects do this.
describe('exec adapter, stdin that nobody reads', () => {
  const exec = createExec()
  it('survives a child that exits before reading stdin', async () => {
    const seen: unknown[] = []
    const onUncaught = (e: unknown) => seen.push(e)
    process.on('uncaughtException', onUncaught)
    try {
      const r = await runTestNode(exec, ['-e', 'process.exit(0)'], {
        cwd,
        stdin: 'x'.repeat(2_000_000),
      })
      expect(r.code).toBe(0)
      await new Promise((res) => setTimeout(res, 100))
    } finally {
      process.off('uncaughtException', onUncaught)
    }
    expect(seen).toEqual([])
  })
  it('still delivers stdin to a child that does read it', async () => {
    const r = await runTestNode(exec, ['-e', 'process.stdin.pipe(process.stdout)'], { cwd, stdin: 'ping' })
    expect(r.stdout).toBe('ping')
  })
})

// The bookkeeping around a finished child: it must leave `live`, its timeout timer must be cleared,
// and killAll must empty the set. Left unpinned, a completed child stays registered forever in a
// long-lived daemon and a stale timer fires killGroup on a reaped pid - which on POSIX is
// process.kill(-pid) against whatever process group has since been given that number.
describe('exec adapter, process lifecycle', () => {
  it('drops a finished child from the live set, so killAll does not reach for its pid', async () => {
    const calls: number[] = []
    const e = createExec({ killTree: (pid) => void calls.push(pid) })
    const r = await runTestNode(e, ['-e', 'process.stdout.write("done")'], { cwd })
    expect(r.stdout).toBe('done')
    await e.killAll()
    expect(calls).toEqual([])
  })
  // The clock is frozen for the duration of this one, and that is the whole point. The invariant is
  // "a child that has closed leaves no armed timer behind", which says nothing about how long the
  // child took; the earlier shape said it by giving a real `node` boot a 120 ms budget and then
  // sleeping past it, so a loaded machine that took longer to boot reported a timeout the adapter
  // had never got wrong. With setTimeout faked the deadline cannot fire on its own, the run is
  // awaited on the child's own close event, and the clock is only run forward afterwards - past any
  // deadline the call could have armed. An uncleared timer fires into that advance and records a
  // pid; a cleared one has nothing left to fire.
  it('clears the timeout timer, so nothing fires at a reaped pid afterwards', async () => {
    const calls: number[] = []
    const e = createExec({ killTree: (pid) => void calls.push(pid) })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const r = await runTestNode(e, ['-e', 'process.stdout.write("quick")'], { cwd, timeoutMs: 120 })
      expect(r).toMatchObject({ stdout: 'quick', timedOut: false })
      await vi.advanceTimersByTimeAsync(600_000)
    } finally {
      vi.useRealTimers()
    }
    expect(calls).toEqual([])
  })
  // The second killAll runs before the child has closed, so only the explicit clear can have
  // emptied the set: killTree here records the pid and kills nothing, which is why the child is
  // still live for the second call. Waiting for the close first would prove nothing, because the
  // close handler removes the child on its own.
  it('killAll empties the live set, so a second killAll does not reach the same child twice', async () => {
    const calls: number[] = []
    const e = createExec({ killTree: (pid) => void calls.push(pid) })
    const p = runTestNode(e, ['-e', 'setInterval(()=>{},1000)'], { cwd, timeoutMs: 30_000 })
    await new Promise((res) => setTimeout(res, 150))
    await e.killAll()
    await e.killAll()
    expect(calls).toHaveLength(1)
    const pid = calls[0] as number
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL')
    await p
  })
  it('gives the per-call timeout precedence over the adapter default', async () => {
    const e = createExec({ defaultTimeoutMs: 30_000 })
    const started = Date.now()
    const r = await runTestNode(e, ['-e', 'setInterval(()=>{},1000)'], { cwd, timeoutMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
  it('applies the adapter default when the call states no timeout', async () => {
    const e = createExec({ defaultTimeoutMs: 200 })
    const r = await runTestNode(e, ['-e', 'setInterval(()=>{},1000)'], { cwd })
    expect(r.timedOut).toBe(true)
  })
  // The `bytes.n >= max` guard cannot be pinned by a test, and the reason is narrower than it
  // first looks. Relaxing it to `>` does fall through to `room = 0`, but the fall-through lands in
  // `c.byteLength > room`, and for a zero-length chunk `0 > 0` is false: the mutant takes the else
  // branch and never sets truncated, where the original returns early and does. Three chunk
  // sequences ending in an empty chunk report different `truncated` values under the two
  // spellings, so they are not the same function.
  //
  // They are the same here because of the call site, not the code: Node's readable streams do not
  // emit zero-length `data` chunks in non-object mode, so nothing a spawned child can write reaches
  // the difference. That premise is the whole equivalence, and it stops holding the moment this
  // accumulator is fed by anything but a child-process pipe — a test double, or an in-process
  // runtime bridge. What the boundary itself means is what can be pinned, so that is what this
  // pins.
  it('reports the cap boundary exactly: max bytes is not truncation, one more is', async () => {
    const e = createExec()
    const at = await runTestNode(e, ['-e', 'process.stdout.write("z".repeat(1000))'], {
      cwd,
      maxOutputBytes: 1000,
    })
    expect([at.truncated, at.stdout.length]).toEqual([false, 1000])
    const over = await runTestNode(e, ['-e', 'process.stdout.write("z".repeat(1001))'], {
      cwd,
      maxOutputBytes: 1000,
    })
    expect([over.truncated, over.stdout.length]).toEqual([true, 1000])
  })

  // B-9: the abort listener never fires for a signal that had already aborted, so the command ran
  // and was killed after the fact. Cancellation has to mean the process was never started.
  it('an already-aborted signal is refused before anything is spawned', async () => {
    const exec = createExec()
    const marker = join(dir, 'ran.txt')
    const ac = new AbortController()
    ac.abort()
    await expect(
      exec.run([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], {
        cwd: dir,
        signal: ac.signal,
      }),
    ).rejects.toThrow(/aborted/)
    expect(existsSync(marker)).toBe(false)
  })
  it('the abort reason is handed back when the caller supplied one', async () => {
    const exec = createExec()
    const ac = new AbortController()
    ac.abort(new Error('turn cancelled'))
    await expect(exec.run([process.execPath, '-e', '0'], { cwd: dir, signal: ac.signal })).rejects.toThrow(
      'turn cancelled',
    )
  })
})
