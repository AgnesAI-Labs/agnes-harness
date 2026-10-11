import type { SandboxProcess } from '@agnes/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExec, createPolicyStart, STOP_GRACE_MS } from '../../src/adapters/exec.js'

const cwd = process.cwd()
// See test-node.ts: an Electron test runner needs Node mode kept in the child.
const env = process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE } : {}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
// The child prints its own child's pid, then "ready", and keeps both running.
const parentOfOne =
  'const { spawn } = require("node:child_process"); const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: process.env, stdio: "ignore" }); process.stdout.write(c.pid + " ready\\n"); setInterval(()=>{},1000)'

function collect(process: SandboxProcess): { text: () => string } {
  let text = ''
  process.onOutput((chunk) => {
    text += chunk
  })
  return { text: () => text }
}

const started: SandboxProcess[] = []
afterEach(async () => {
  await Promise.allSettled(started.splice(0).map((p) => p.stop()))
})

describe.skipIf(process.platform === 'win32')('exec adapter, background processes', () => {
  const exec = createExec()
  const start = async (args: string[]) => {
    const p = await (exec.start as NonNullable<typeof exec.start>)([process.execPath, ...args], { cwd, env })
    started.push(p)
    return p
  }

  it('keeps a process running after start returns, streams its output, and stops its whole group', async () => {
    const p = await start(['-e', parentOfOne])
    const out = collect(p)
    await vi.waitFor(() => expect(out.text()).toMatch(/^[0-9]+ ready\n$/), { timeout: 5000 })
    const grandchild = Number(out.text().split(' ')[0])
    expect(alive(p.pid as number)).toBe(true)
    expect(alive(grandchild)).toBe(true)
    await p.stop()
    expect(await p.done).toMatchObject({ code: null, signal: 'SIGTERM' })
    await vi.waitFor(() => expect(alive(grandchild)).toBe(false), { timeout: 2000 })
  })

  it('replays what was printed before anyone listened', async () => {
    const p = await start([
      '-e',
      'process.stdout.write("early\\n"); process.stderr.write("err\\n"); setInterval(()=>{},1000)',
    ])
    await new Promise((wait) => setTimeout(wait, 300))
    const out = collect(p)
    await vi.waitFor(() => expect(out.text()).toContain('early\n'), { timeout: 2000 })
    expect(out.text()).toContain('err\n')
  })

  it('stops what a process left in its group as soon as it exits, without waiting for stop', async () => {
    const leaves =
      'const { spawn } = require("node:child_process"); const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: process.env, stdio: "ignore" }); process.stdout.write(String(c.pid), () => process.exit(0))'
    const p = await start(['-e', leaves])
    const out = collect(p)
    expect(await p.done).toEqual({ code: 0 })
    await vi.waitFor(() => expect(out.text()).toMatch(/^[0-9]+$/), { timeout: 2000 })
    await vi.waitFor(() => expect(alive(Number(out.text()))).toBe(false), { timeout: 2000 })
  })

  it('reports the exit of a process that ends on its own', async () => {
    const p = await start(['-e', 'process.exit(4)'])
    expect(await p.done).toEqual({ code: 4 })
  })

  it('kills a process that ignores SIGTERM once the grace is over', async () => {
    const p = await start([
      '-e',
      'process.on("SIGTERM", () => {}); process.stdout.write("up\\n"); setInterval(()=>{},1000)',
    ])
    const out = collect(p)
    await vi.waitFor(() => expect(out.text()).toBe('up\n'), { timeout: 5000 })
    const began = Date.now()
    await p.stop()
    expect(Date.now() - began).toBeGreaterThanOrEqual(STOP_GRACE_MS - 50)
    expect(await p.done).toMatchObject({ signal: 'SIGKILL' })
  })

  it('stops background processes on killAll', async () => {
    const e = createExec()
    const p = await (e.start as NonNullable<typeof e.start>)(
      [process.execPath, '-e', 'setInterval(()=>{},1000)'],
      {
        cwd,
        env,
      },
    )
    started.push(p)
    await e.killAll()
    expect(await p.done).toMatchObject({ signal: 'SIGKILL' })
  })

  it('rejects an executable that does not exist instead of handing back a process', async () => {
    await expect(
      (exec.start as NonNullable<typeof exec.start>)(['/nonexistent/agnes-no-such-program'], { cwd }),
    ).rejects.toThrow()
  })
})

describe('the policy gate for background processes', () => {
  const process_: SandboxProcess = Object.freeze({
    pid: 1,
    onOutput: () => {},
    done: new Promise<never>(() => {}),
    stop: async () => {},
  })
  const gate = (bound: string | null) => ({
    boundDigest: () => bound,
    state: () => ({ backend: 'l1' as const, onUnavailable: 'deny' as const }),
    authorizeCwd: async (dir: string) => `/canonical${dir}`,
  })
  const binding = { policyDigest: 'a'.repeat(64), backend: 'l1' as const }

  it('admits a request on the same terms as exec and hands the canonical cwd on', async () => {
    const inner = vi.fn(async () => process_)
    const start = createPolicyStart(inner, gate('a'.repeat(64)))
    await expect(start(['x'], { cwd: '/w', sandbox: binding })).resolves.toBe(process_)
    expect(inner).toHaveBeenCalledWith(['x'], { cwd: '/canonical/w', sandbox: binding })
  })

  it.each([
    ['no binding', undefined, 'a'.repeat(64)],
    ['a stale binding', binding, 'b'.repeat(64)],
    ['no bound policy', binding, null],
  ])('refuses %s without starting anything', async (_, sandbox, bound) => {
    const inner = vi.fn(async () => process_)
    const start = createPolicyStart(inner, gate(bound))
    await expect(start(['x'], { cwd: '/w', ...(sandbox ? { sandbox } : {}) })).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    })
    expect(inner).not.toHaveBeenCalled()
  })
})
