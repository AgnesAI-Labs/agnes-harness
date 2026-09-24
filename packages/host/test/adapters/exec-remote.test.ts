import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExec, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from '../../src/adapters/exec.js'
import { createRemoteExec } from '../../src/adapters/exec-remote.js'
import { createLoopbackTransport, type RemoteTransport } from '../../src/adapters/remote-transport.js'

/**
 * A transport whose `alive()` the test owns, recording every exec it is asked for. `exec` resolving
 * with a plain success is deliberate: if the runner ever reaches the transport while the channel is
 * declared dead, the call succeeds and the assertion below fails on the success rather than on a
 * substituted error - the failure then reads as "it ran anyway", which is the finding.
 */
function transportDouble(opts: { alive: boolean; stdout?: string; stderr?: string }): RemoteTransport & {
  calls: { cmd: string[]; opts: Record<string, unknown> }[]
} {
  const calls: { cmd: string[]; opts: Record<string, unknown> }[] = []
  return {
    calls,
    alive: () => opts.alive,
    async close() {
      opts.alive = false
    },
    async exec(cmd, o) {
      calls.push({ cmd: [...cmd], opts: { ...o } })
      return { code: 0, stdout: opts.stdout ?? 'ran', stderr: opts.stderr ?? '', truncated: false }
    },
    async upload() {},
    async download() {
      return []
    },
  }
}

describe('createRemoteExec refuses outright when the channel is gone (RA7 / spec §4.6.1)', () => {
  it('rejects instead of running when the transport is not alive', async () => {
    const t = transportDouble({ alive: false })
    const runner = createRemoteExec(t)
    await expect(runner.run(['sh', '-c', 'printf ran'], { cwd: '/w' })).rejects.toThrow(/SANDBOX_UNAVAILABLE/)
    // Not "it rejected" alone: the command must never have reached the remote side at all.
    expect(t.calls).toHaveLength(0)
  })

  it('carries the SANDBOX_UNAVAILABLE code, the one callers above it match on', async () => {
    const runner = createRemoteExec(transportDouble({ alive: false }))
    await expect(runner.run(['true'], { cwd: '/w' })).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    })
  })

  /**
   * The point of RA7 is that the refusal is unconditional, not conditional on a flag. This function
   * takes no `onUnavailable` at all - there is no parameter, no closure, nothing to set - so the
   * only thing a test can assert is that no caller-supplied input changes the answer. Running the
   * same refusal under the most permissive request shape a caller could construct is that
   * assertion: if some future edit ever routes this decision through the gate's posture, the
   * `'allow'` posture is the one that would let it through, and it is asserted here to be inert.
   */
  it('has no unconfined-fallback allowance to consult: the refusal holds under every request shape', async () => {
    const t = transportDouble({ alive: false })
    const runner = createRemoteExec(t)
    await expect(
      runner.run(['sh', '-c', 'printf ran'], {
        cwd: '/w',
        env: { FOO: 'bar' },
        stdin: 'in',
        timeoutMs: 1_000,
        maxOutputBytes: 16,
        sandbox: { policyDigest: 'deadbeef', backend: 'remote' },
      }),
    ).rejects.toThrow(/SANDBOX_UNAVAILABLE/)
    expect(t.calls).toHaveLength(0)
  })

  it('still runs, and forwards the request, while the channel is alive', async () => {
    const t = transportDouble({ alive: true })
    const runner = createRemoteExec(t)
    await expect(runner.run(['sh', '-c', 'printf ran'], { cwd: '/w' })).resolves.toMatchObject({
      code: 0,
      stdout: 'ran',
    })
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]?.cmd).toEqual(['sh', '-c', 'printf ran'])
  })

  it('stops running the moment the channel closes under it', async () => {
    const t = transportDouble({ alive: true })
    const runner = createRemoteExec(t)
    await runner.run(['true'], { cwd: '/w' })
    await t.close()
    await expect(runner.run(['true'], { cwd: '/w' })).rejects.toThrow(/SANDBOX_UNAVAILABLE/)
    expect(t.calls).toHaveLength(1)
  })
})

/**
 * The four defaults `createExec` has always applied to a local child. Nothing between the seam and
 * the transport applies them for a remote deployment, so this runner is where they have to be, and
 * the cases below hold it to `createExec`'s own constants rather than to numbers retyped here.
 */
describe('createRemoteExec applies the same safety defaults createExec does', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
    delete process.env.AGNES_SECRET_REVIEW_PROBE
  })
  const scratch = (): string => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-remote-exec-'))
    return dir
  }
  // Printed rather than signalled through an exit code so an absent variable and an empty one stay
  // distinguishable in the assertion.
  const readProbe = ['node', '-e', 'process.stdout.write(String(process.env.AGNES_SECRET_REVIEW_PROBE))']

  it('keeps AGNES_SECRET_* out of a remote command, the way the local path always has', async () => {
    const root = scratch()
    process.env.AGNES_SECRET_REVIEW_PROBE = 'leaked-to-the-remote-host'
    // The loopback transport spawns for real and, like any transport handed no explicit `env`,
    // inherits this process's environment. That inheritance is the leak: a credential this host
    // holds ends up readable by a command running on someone else's machine.
    const remote = createRemoteExec(createLoopbackTransport({ root }))
    await expect(remote.run(readProbe, { cwd: root })).resolves.toMatchObject({ stdout: 'undefined' })
    // Parity asserted rather than assumed - the local adapter is the behaviour being matched.
    const local = createExec({ detached: false })
    await expect(local.run(readProbe, { cwd: root })).resolves.toMatchObject({ stdout: 'undefined' })
  })

  it('still hands a remote command the vars the caller asked for, over the floor it needs to run', async () => {
    const root = scratch()
    const remote = createRemoteExec(createLoopbackTransport({ root }))
    const script = 'process.stdout.write(process.env.WANTED + "|" + (process.env.PATH !== undefined))'
    const got = await remote.run(['node', '-e', script], { cwd: root, env: { WANTED: 'yes' } })
    expect(got.stdout).toBe('yes|true')
  })

  it('sends the default deadline when the caller names none, and the caller’s when it does', async () => {
    const t = transportDouble({ alive: true })
    const runner = createRemoteExec(t)
    await runner.run(['true'], { cwd: '/w' })
    expect(t.calls[0]?.opts.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    await runner.run(['true'], { cwd: '/w', timeoutMs: 250 })
    expect(t.calls[1]?.opts.timeoutMs).toBe(250)
  })

  it('sends the default output cap when the caller names none, and the caller’s when it does', async () => {
    const t = transportDouble({ alive: true })
    const runner = createRemoteExec(t)
    await runner.run(['true'], { cwd: '/w' })
    expect(t.calls[0]?.opts.maxOutputBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES)
    await runner.run(['true'], { cwd: '/w', maxOutputBytes: 8 })
    expect(t.calls[1]?.opts.maxOutputBytes).toBe(8)
  })

  it('clamps output a transport returned over the cap instead of trusting it to have obeyed', async () => {
    // Stage A's own loopback ignores maxOutputBytes entirely (its doc comment says so), and a
    // third-party transport may too - so the cap is applied on this side as well, or it is a
    // request rather than a limit.
    const t = transportDouble({ alive: true, stdout: 'x'.repeat(40), stderr: 'y'.repeat(40) })
    const got = await createRemoteExec(t).run(['true'], { cwd: '/w', maxOutputBytes: 10 })
    expect(got.stdout).toBe('x'.repeat(10))
    expect(got.stderr).toBe('y'.repeat(10))
    expect(got.truncated).toBe(true)
  })

  it('leaves output under the cap untouched and unflagged', async () => {
    const t = transportDouble({ alive: true, stdout: 'short', stderr: '' })
    const got = await createRemoteExec(t).run(['true'], { cwd: '/w', maxOutputBytes: 10 })
    expect(got).toMatchObject({ stdout: 'short', stderr: '', truncated: false })
  })

  it('refuses to start a command for a signal that aborted before the call', async () => {
    const t = transportDouble({ alive: true })
    const reason = new Error('the turn was cancelled')
    await expect(
      createRemoteExec(t).run(['true'], { cwd: '/w', signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason)
    // The command must not have reached the remote host. Once started there this host has no way to
    // take it back: `killAll()` is empty under remote mode, by design.
    expect(t.calls).toHaveLength(0)
  })

  it('reports a generic abort when the signal carries no error reason', async () => {
    const t = transportDouble({ alive: true })
    await expect(
      createRemoteExec(t).run(['true'], { cwd: '/w', signal: AbortSignal.abort('just a string') }),
    ).rejects.toThrow(/aborted before start/)
    expect(t.calls).toHaveLength(0)
  })

  it('runs normally for a signal that has not aborted', async () => {
    const t = transportDouble({ alive: true })
    const ac = new AbortController()
    await expect(createRemoteExec(t).run(['true'], { cwd: '/w', signal: ac.signal })).resolves.toMatchObject({
      code: 0,
    })
    expect(t.calls).toHaveLength(1)
  })
})

describe('B1 remote result fields', () => {
  it('preserves timeout and terminating signal from the transport', async () => {
    const t = {
      ...transportDouble({ alive: true }),
      exec: async () => ({
        code: 143,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: true,
        signal: 'SIGTERM',
      }),
    }
    await expect(createRemoteExec(t).run(['test'], { cwd: '/w' })).resolves.toMatchObject({
      timedOut: true,
      signal: 'SIGTERM',
    })
  })
})
