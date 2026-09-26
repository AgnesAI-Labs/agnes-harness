// Deep Bug Hunt M-06 (adversarial-tester, group A). Test-only; asserts the CORRECT behaviour, so a
// failure reproduces the defect. Production path: bin.ts main() --ephemeral (makeEphemeralHome, the
// finally that disposes it), installSignalLadder with the real process signals and the real hardExit.
// Oracle: cli-package design :82 "--ephemeral: 临时 AGNES_HOME，退出即删"; boot/inputs.ts:25 "writes
// nothing the machine keeps"; acp-concurrency.test.ts:225-233 "no application-owned entry may remain
// after every child exits". Every child gets a private TMPDIR made with mkdtemp and removed afterwards.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const fixture = fileURLToPath(new URL('./fixtures/dbh-m06-slow-acp-cli.ts', import.meta.url))
// On Windows child.kill('SIGINT') delivers no signal the child can handle: Node terminates it at once,
// so the signal ladder these cases exercise is only reachable on POSIX.
const posixSignals = process.platform !== 'win32'

type Wire = {
  id?: number
  method?: string
  result?: { sessionId?: string; stopReason?: string }
  error?: unknown
}
type Exit = { code: number | null; signal: NodeJS.Signals | null; ms: number }

function spawnAcp(turnMs: number, extraEnv: Record<string, string> = {}, mode: string[] = ['--mode', 'acp']) {
  const root = mkdtempSync(join(tmpdir(), 'dbh-m06-'))
  const dataDir = join(root, 'host')
  mkdirSync(dataDir)
  const started = performance.now()
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['--import', 'tsx', fixture, ...mode, '--ephemeral', '--profile', 'local-dev', '--cwd', dataDir],
    {
      env: {
        ...process.env,
        AGNES_ACP_FIXTURE_DIR: dataDir,
        DBH_TURN_MS: String(turnMs),
        TMPDIR: root,
        TMP: root,
        TEMP: root,
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const messages: Wire[] = []
  let buffer = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      try {
        messages.push(JSON.parse(buffer.slice(0, nl)) as Wire)
      } catch {
        // not a frame
      }
      buffer = buffer.slice(nl + 1)
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  child.stdin.on('error', () => undefined)
  const exited = new Promise<Exit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, ms: performance.now() - started }))
  })
  const until = async (predicate: () => boolean, ms: number, what: string): Promise<void> => {
    const deadline = performance.now() + ms
    while (!predicate()) {
      if (performance.now() > deadline)
        throw new Error(`timed out waiting for ${what}; stderr=${stderr.slice(-800)}`)
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
  const reply = async (id: number, ms = 20_000): Promise<Wire> => {
    await until(() => messages.some((m) => m.id === id && m.method === undefined), ms, `reply ${id}`)
    return messages.find((m) => m.id === id && m.method === undefined) as Wire
  }
  const send = (message: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }
  const ephemeral = (): string[] => readdirSync(root).filter((entry) => entry.startsWith('agnes-ephemeral-'))
  const waitExit = async (ms: number): Promise<Exit> => {
    const timer = setTimeout(() => child.kill('SIGKILL'), ms)
    const result = await exited
    clearTimeout(timer)
    return result
  }
  const dispose = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await exited
    }
    rmSync(root, { recursive: true, force: true })
  }
  const handshake = async (): Promise<string> => {
    send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    expect((await reply(1)).error).toBeUndefined()
    send({ id: 2, method: 'session/new', params: { cwd: dataDir, mcpServers: [] } })
    const sessionId = (await reply(2)).result?.sessionId
    if (!sessionId) throw new Error(`session/new failed; stderr=${stderr}`)
    return sessionId
  }
  return { child, root, until, reply, send, ephemeral, waitExit, dispose, handshake, stderr: () => stderr }
}

describe('DBH M-06: --ephemeral home after a signalled exit', () => {
  it('control: a completed exchange closed by stdin EOF exits 0 and leaves no ephemeral home', async () => {
    const c = spawnAcp(1)
    try {
      const sessionId = await c.handshake()
      c.send({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
      })
      expect((await c.reply(3)).result?.stopReason).toBe('end_turn')
      c.child.stdin.end()
      const exit = await c.waitExit(15_000)
      expect({ code: exit.code, leaked: c.ephemeral() }).toEqual({ code: 0, leaked: [] })
    } finally {
      await c.dispose()
    }
  }, 60_000)

  it.runIf(posixSignals)(
    'SIGINT during boot (home already created, ladder not yet installed) leaves no ephemeral home',
    async () => {
      const runs = 5
      const observed: Array<Exit & { leaked: number }> = []
      for (let i = 0; i < runs; i++) {
        const c = spawnAcp(1)
        try {
          await c.until(() => c.ephemeral().length > 0, 20_000, 'agnes-ephemeral-* to appear')
          c.child.kill('SIGINT')
          const exit = await c.waitExit(15_000)
          observed.push({ ...exit, leaked: c.ephemeral().length })
        } finally {
          await c.dispose()
        }
      }
      const summary = observed.map((o) => `code=${o.code} signal=${o.signal} leaked=${o.leaked}`).join(' | ')
      expect(observed.filter((o) => o.leaked > 0).length, summary).toBe(0)
    },
    120_000,
  )

  it.runIf(posixSignals)(
    'two SIGINTs after initialize leave no ephemeral home',
    async () => {
      const runs = 3
      const observed: Array<Exit & { leaked: number }> = []
      for (let i = 0; i < runs; i++) {
        const c = spawnAcp(1)
        try {
          await c.handshake()
          c.child.kill('SIGINT')
          c.child.kill('SIGINT')
          const exit = await c.waitExit(15_000)
          observed.push({ ...exit, leaked: c.ephemeral().length })
        } finally {
          await c.dispose()
        }
      }
      const summary = observed.map((o) => `code=${o.code} signal=${o.signal} leaked=${o.leaked}`).join(' | ')
      expect(observed.filter((o) => o.leaked > 0).length, summary).toBe(0)
    },
    120_000,
  )

  it.runIf(posixSignals)(
    'one SIGINT during a slow in-flight prompt: the grace hard-exit leaves no ephemeral home',
    async () => {
      const c = spawnAcp(60_000)
      try {
        const sessionId = await c.handshake()
        c.send({
          id: 3,
          method: 'session/prompt',
          params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
        })
        await c.until(() => c.stderr().includes('dbh: turn started'), 20_000, 'turn start')
        const t0 = performance.now()
        c.child.kill('SIGINT')
        const exit = await c.waitExit(20_000)
        const afterSignalMs = performance.now() - t0
        expect(
          { exitedBeforeSigkill: exit.signal !== 'SIGKILL', leaked: c.ephemeral() },
          `code=${exit.code} signal=${exit.signal} afterSignalMs=${afterSignalMs.toFixed(0)} stderr=${c.stderr().slice(-400)}`,
        ).toEqual({ exitedBeforeSigkill: true, leaked: [] })
      } finally {
        await c.dispose()
      }
    },
    60_000,
  )
})

// Both hard-exit rungs leave through hardExit (exit code now, process.exit 100 ms later) without waiting
// for the first signal's shutdown. With a host whose close never settles that shutdown never finishes,
// so main's finally -- the only place the home was removed -- has not run when the process ends.
describe.runIf(posixSignals)('DBH M-06: --ephemeral home after a hard exit that outruns shutdown', () => {
  async function hardExitRun(signals: number) {
    const c = spawnAcp(60_000, { DBH_HANG_CLOSE: '1' })
    try {
      const sessionId = await c.handshake()
      c.send({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
      })
      await c.until(() => c.stderr().includes('dbh: turn started'), 20_000, 'turn start')
      for (let i = 0; i < signals; i++) {
        // Spaced out: two back-to-back kills can reach the process as one pending signal.
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 200))
        c.child.kill('SIGINT')
      }
      const t0 = performance.now()
      const exit = await c.waitExit(20_000)
      const ms = performance.now() - t0
      return { code: exit.code, signal: exit.signal, leaked: c.ephemeral(), exitedWithinGrace: ms < 4_000 }
    } finally {
      await c.dispose()
    }
  }

  it('two SIGINTs while shutdown hangs leave no ephemeral home', async () => {
    // The second rung leaves at once rather than after the 5 s grace.
    expect(await hardExitRun(2)).toEqual({ code: 130, signal: null, leaked: [], exitedWithinGrace: true })
  }, 60_000)

  it('one SIGINT whose shutdown outlives the 5 s grace leaves no ephemeral home', async () => {
    expect(await hardExitRun(1)).toMatchObject({ code: 130, signal: null, leaked: [] })
  }, 60_000)
})

describe.runIf(posixSignals)('DBH M-06: the ephemeral guard stays out of the ladder', () => {
  it('[preserve] one SIGINT during a print turn still cancels it gracefully and reports the reason', async () => {
    const c = spawnAcp(60_000, {}, ['-p', 'x'])
    try {
      c.child.stdin.end()
      await c.until(() => c.stderr().includes('dbh: turn started'), 20_000, 'turn start')
      c.child.kill('SIGINT')
      const exit = await c.waitExit(20_000)
      expect(
        {
          code: exit.code,
          leaked: c.ephemeral(),
          reported: c.stderr().includes('SIGINT; turn ended: aborted'),
        },
        c.stderr().slice(-400),
      ).toEqual({ code: 130, leaked: [], reported: true })
    } finally {
      await c.dispose()
    }
  }, 60_000)
})
