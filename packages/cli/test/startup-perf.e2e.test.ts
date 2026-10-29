import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createClient, memoryJournal } from '@agnes/sdk'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { expect, it } from 'vitest'

// Use the same built-distribution opt-in as shared-local-delivery acceptance. No source/mock Host.
const entry = process.env.AGNES_LOCAL_CLI
it.skipIf(!entry)(
  'keeps fresh-home CLI readiness and the first real Host within startup budgets',
  async () => {
    if (!entry) throw new Error('AGNES_LOCAL_CLI must point to a built distribution')
    const root = await mkdtemp(join(tmpdir(), 'agh-startup-perf-'))
    let child: ChildProcess | undefined
    let owner: { pid: number; processStartId: string; socketPath: string } | undefined
    let client: ReturnType<typeof createClient> | undefined
    try {
      const home = join(root, 'home'),
        cwd = join(root, 'workspace')
      createPrivateDirectorySync(home)
      await mkdir(cwd)
      const listener = createServer()
      await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done))
      const address = listener.address()
      if (!address || typeof address === 'string') throw new Error('missing test port')
      const origin = `http://127.0.0.1:${address.port}`
      await new Promise<void>((done) => listener.close(() => done()))
      const started = performance.now()
      await new Promise<void>((done, reject) => {
        child = spawn(process.execPath, [resolve(entry), 'serve'], {
          cwd,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TMPDIR: tmpdir(),
            TEMP: tmpdir(),
            TMP: tmpdir(),
            LANG: 'en_US.UTF-8',
            HOME: home,
            USERPROFILE: home,
            AGH_HOME: home,
            AGNES_PROFILE: 'local-dev',
            AGNES_WEB_ORIGIN: origin,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let output = ''
        let diagnostic = ''
        const timeout = setTimeout(() => reject(new Error('CLI ready timeout')), 30_000)
        child.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        child.once('close', (code) => {
          clearTimeout(timeout)
          reject(new Error(`CLI exited before ready: ${code}\n${diagnostic}`))
        })
        child.stdout?.on('data', (chunk: Buffer) => {
          output += chunk.toString()
          if (/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
            clearTimeout(timeout)
            done()
          }
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          diagnostic = (diagnostic + chunk.toString()).slice(-4000)
        })
      })
      const readyMs = performance.now() - started
      owner = JSON.parse(await readFile(join(home, 'daemon', 'owner.json'), 'utf8'))
      if (!owner) throw new Error('daemon did not publish ownership')
      client = createClient({
        transport: {
          kind: 'unix',
          path: owner.socketPath,
          ...(owner.socketPath.startsWith('\\\\.\\pipe\\')
            ? { serverIdentity: { pid: owner.pid, processStartId: owner.processStartId } }
            : {}),
        },
        auth: { kind: 'local' },
        journal: memoryJournal(),
      })
      await client.initialize()
      const hostStarted = performance.now()
      const session = await client.session.new({ cwd })
      expect(session.id.length).toBeGreaterThan(0)
      const firstSessionMs = performance.now() - hostStarted
      console.info(
        'STARTUP_PERF',
        JSON.stringify({ readyMs, firstSessionMs, node: process.version, platform: process.platform }),
      )
      // Broad absolute bounds tolerate shared CI scheduling; dedicated same-machine paired runs
      // remain the attribution evidence. These fail substantial loading/assembly regressions.
      expect(readyMs).toBeLessThan(8_000)
      expect(firstSessionMs).toBeLessThan(4_000)
    } finally {
      await client?.close()
      // Stop the launcher and daemon before removing only this fixture's home.
      if (child && child.exitCode === null && child.signalCode === null) {
        const running = child
        const exited = new Promise<void>((done) => running.once('exit', () => done()))
        const kill = setTimeout(() => running.kill('SIGKILL'), 5_000)
        child.kill('SIGTERM')
        await exited
        clearTimeout(kill)
      }
      // The verified stop command drains workers too; killing only the PID can leave their
      // workspace handles open on Windows and hide the timing assertion behind an EBUSY.
      await promisify(execFile)(
        process.execPath,
        [resolve(entry), 'daemon', 'stop', '--home', join(root, 'home'), '--profile', 'local-dev'],
        {
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
          windowsHide: true,
          timeout: 15_000,
        },
      )
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)
