import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

// Same opt-in as the other built-distribution acceptance tests: a real `agh serve` and a real
// daemon in an isolated home. Run with AGNES_LOCAL_CLI=<packages/cli/dist/local/agnes.mjs>.
const entry = process.env.AGNES_LOCAL_CLI
const SECOND = 1000

type Fixture = {
  root: string
  cwd: string
  origin: string
  env: NodeJS.ProcessEnv
  serve: ChildProcess
  output: () => string
  daemon(...args: string[]): { status: number | null; stdout: string }
  adminList(): Promise<{
    status: number
    body: { error?: { data?: { code?: string; messageKey?: string } } }
  }>
  wsAddress(): Promise<string | undefined>
}
const fixtures: Fixture[] = []

async function freePort(): Promise<number> {
  const listener = createServer()
  await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  await new Promise<void>((done) => listener.close(() => done()))
  return address.port
}

async function start(): Promise<Fixture> {
  if (!entry) throw new Error('AGNES_LOCAL_CLI must point to a built distribution')
  const root = await mkdtemp(join(tmpdir(), 'agh-serve-reconnect-'))
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  await mkdir(home, { mode: 0o700 })
  await mkdir(cwd)
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: 'en_US.UTF-8',
    HOME: home,
    AGH_HOME: home,
    AGNES_PROFILE: 'local-dev',
    AGNES_WEB_ORIGIN: origin,
  }
  const serve = spawn(process.execPath, [resolve(entry), 'serve'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let text = ''
  serve.stdout?.on('data', (chunk: Buffer) => {
    text += chunk.toString()
  })
  serve.stderr?.on('data', (chunk: Buffer) => {
    text += chunk.toString()
  })
  const fixture: Fixture = {
    root,
    cwd,
    origin,
    env,
    serve,
    output: () => text,
    daemon: (...args) => {
      const run = spawnSync(process.execPath, [resolve(entry), 'daemon', ...args], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 60 * SECOND,
      })
      return { status: run.status, stdout: run.stdout }
    },
    adminList: async () => {
      const response = await fetch(`${origin}/admin/plugins/api/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ profile: 'local-dev' }),
      })
      return { status: response.status, body: (await response.json()) as never }
    },
    wsAddress: async () => {
      const page = await (await fetch(`${origin}/`)).text()
      return page.match(/data-ws="([^"]*)"/)?.[1]
    },
  }
  fixtures.push(fixture)
  const deadline = Date.now() + 60 * SECOND
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(text)) {
    if (serve.exitCode !== null) throw new Error(`serve exited before ready: ${text.slice(-500)}`)
    if (Date.now() > deadline) throw new Error('serve ready timeout')
    await new Promise((done) => setTimeout(done, 50))
  }
  return fixture
}

async function stopServe(serve: ChildProcess): Promise<number | null> {
  if (serve.exitCode !== null) return serve.exitCode
  const exited = new Promise<number | null>((done) => serve.once('exit', (code) => done(code)))
  const kill = setTimeout(() => serve.kill('SIGKILL'), 10 * SECOND)
  serve.kill('SIGTERM')
  const code = await exited
  clearTimeout(kill)
  return code
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await stopServe(fixture.serve)
    fixture.daemon('stop')
    await rm(fixture.root, { recursive: true, force: true })
  }
})

it.skipIf(!entry)(
  'serves admin calls again after the daemon is restarted, without restarting serve',
  async () => {
    const f = await start()
    expect((await f.adminList()).status).toBe(200)
    const before = await f.wsAddress()
    expect(before).toMatch(/^ws:\/\/127\.0\.0\.1:\d+/)

    expect(f.daemon('stop').status).toBe(0)
    // Down: a recognisable "backend unavailable" class, never the internal/unconfirmed one.
    const down = await f.adminList()
    expect(down.status).toBe(503)
    expect(down.body.error?.data?.code).toBe('E_HOST_CLOSED')
    expect(down.body.error?.data?.messageKey).toBe('appServer.errors.unavailable')

    expect(f.daemon('start').status).toBe(0)
    const after = await f.adminList()
    expect(after.status).toBe(200)
    // The page is handed the new daemon's address, so its own reconnect banner can clear.
    expect(await f.wsAddress()).not.toBe(before)
    expect(await stopServe(f.serve)).toBe(0)
  },
  180 * SECOND,
)

it.skipIf(!entry)(
  'refuses a replacement daemon that serves another Web origin',
  async () => {
    const f = await start()
    const before = await f.wsAddress()
    expect(f.daemon('stop').status).toBe(0)
    const otherPort = await freePort()
    const other = spawnSync(process.execPath, [resolve(entry as string), 'daemon', 'start'], {
      cwd: f.cwd,
      env: { ...f.env, AGNES_WEB_ORIGIN: `http://127.0.0.1:${otherPort}` },
      encoding: 'utf8',
      timeout: 60 * SECOND,
    })
    expect(other.status).toBe(0)
    const refused = await f.adminList()
    expect(refused.status).toBe(503)
    expect(refused.body.error?.data?.messageKey).toBe('appServer.errors.unavailable')
    expect(await f.wsAddress()).toBe(before)
  },
  180 * SECOND,
)

it.skipIf(!entry)(
  'exits cleanly when asked to stop while it is waiting for the daemon',
  async () => {
    const f = await start()
    expect(f.daemon('stop').status).toBe(0)
    const waiting = f.adminList().catch(() => undefined)
    await new Promise((done) => setTimeout(done, 1 * SECOND))
    const started = Date.now()
    expect(await stopServe(f.serve)).toBe(0)
    expect(Date.now() - started).toBeLessThan(5 * SECOND)
    await waiting
  },
  120 * SECOND,
)
