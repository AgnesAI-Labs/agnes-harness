import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const entry = process.env.AGNES_LOCAL_CLI ? resolve(process.env.AGNES_LOCAL_CLI) : undefined
const node = process.env.AGNES_LOCAL_NODE ?? process.execPath

type CliResult = { code: number; stdout: string; stderr: string }
type Owner = { generation: string; pid: number; socketPath: string }

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('acceptance port allocation failed')
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return port
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(check: () => Promise<boolean>, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await wait(50)
  }
  throw new Error(`${label} timed out`)
}

async function waitForWebLaunch(child: ChildProcess, expectedOrigin: string): Promise<URL> {
  if (!child.stdout) throw new Error('Web launcher stdout is unavailable')
  return new Promise((resolve, reject) => {
    let output = ''
    let diagnostic = ''
    child.stderr?.on('data', (chunk) => {
      diagnostic = (diagnostic + String(chunk)).slice(-2000)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (error: Error | undefined, url?: URL): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error) reject(error)
      else if (url) resolve(url)
      else reject(new Error('Web launcher produced no URL'))
    }
    const onData = (chunk: Buffer | string): void => {
      output += String(chunk)
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/[#][A-Za-z0-9_-]+/u)
      if (!match) return
      let url: URL
      try {
        url = new URL(match[0])
      } catch {
        finish(new Error('Web launcher produced an invalid URL'))
        return
      }
      if (
        url.origin !== expectedOrigin ||
        url.pathname !== '/' ||
        url.search !== '' ||
        url.hash.length <= 1
      ) {
        finish(new Error('Web launcher origin or URL shape did not match the selected origin'))
        return
      }
      // `url.hash` remains in this process only. It is never included in a failure or diagnostic.
      finish(undefined, url)
    }
    const onError = (): void => finish(new Error('Web launcher failed before readiness'))
    const onExit = (): void => {
      const safe = diagnostic
        .replace(/(agnes-bearer\.|\/#)[^\s]+/g, '$1[redacted]')
        .replace(/[A-Za-z0-9_-]{32,}/g, '[opaque]')
      finish(new Error(`Web launcher exited before readiness: ${safe}`))
    }
    child.stdout.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
    timer = setTimeout(() => finish(new Error('Web launcher readiness timed out')), 30_000)
  })
}

async function waitForHttp(origin: string): Promise<string> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1_000)
    try {
      const response = await fetch(origin, { signal: controller.signal })
      if (response.status === 200) return await response.text()
    } catch {
      // The launcher may have emitted its URL just before the listener is observable here.
    } finally {
      clearTimeout(timer)
    }
    await wait(50)
  }
  throw new Error('Web HTTP listener did not become ready')
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let hardTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (hardTimer !== undefined) clearTimeout(hardTimer)
      child.off('exit', finish)
      child.off('close', finish)
      child.off('error', finish)
      resolve()
    }
    child.once('exit', finish)
    child.once('close', finish)
    child.once('error', finish)
    try {
      child.kill('SIGTERM')
    } catch {
      finish()
      return
    }
    timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        finish()
        return
      }
      try {
        child.kill('SIGKILL')
      } catch {
        finish()
        return
      }
      hardTimer = setTimeout(finish, 2_000)
    }, 5_000)
  })
}

async function readOwner(path: string): Promise<Owner> {
  return JSON.parse(await readFile(path, 'utf8')) as Owner
}

async function expectGone(path: string): Promise<void> {
  await waitUntil(async () => {
    try {
      await readFile(path)
      return false
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return true
      throw error
    }
  }, 'daemon record cleanup')
}

async function scenario(options: { simultaneous: boolean }): Promise<void> {
  if (!entry) throw new Error('AGNES_LOCAL_CLI is required')
  // Stay inside the Unix socket path limit even when macOS expands /var to /private/var.
  const root = await mkdtemp(join(tmpdir(), 'ao-'))
  const home = join(root, 'home')
  const workspace = join(root, 'foreign-workspace')
  await mkdir(workspace, { recursive: true })
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    AGH_HOME: home,
    AGNES_PROFILE: 'local-dev',
    AGNES_WEB_ORIGIN: origin,
  }
  const children = new Set<ChildProcess>()
  const ownerPath = join(home, 'data', 'daemon', 'owner.json')
  const discoveryPath = join(home, 'data', 'daemon', 'discovery.json')
  const credentialPath = join(home, 'data', 'daemon', 'web-credential.json')

  const runCli = (args: string[], cwd = workspace): Promise<CliResult> =>
    new Promise((resolve) => {
      const child = execFile(
        node,
        [entry as string, ...args],
        { cwd, env, timeout: 30_000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          const code =
            error === null ? 0 : typeof error.code === 'number' ? error.code : (child.exitCode ?? 1)
          resolve({ code, stdout, stderr })
        },
      )
      children.add(child)
      child.once('close', () => children.delete(child))
      // Every CLI command is a complete one-shot process; an open stdin must never keep it waiting.
      child.stdin?.end()
    })

  const web = spawn(node, [entry, 'serve'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(web)
  web.once('close', () => children.delete(web))

  try {
    const webLaunch = waitForWebLaunch(web, origin)
    if (options.simultaneous) {
      const cliRuns = Array.from({ length: 5 }, () => runCli(['sessions', '--json']))
      const [webResult, ...cliResults] = await Promise.allSettled([webLaunch, ...cliRuns])
      if (webResult.status === 'rejected') throw webResult.reason
      const html = await waitForHttp(origin)
      expect(html).toContain('data-ws=')
      for (const result of cliResults) {
        if (result.status === 'rejected') throw new Error('CLI cold start did not complete')
        expect(result.value.code, 'CLI cold start exit code').toBe(0)
        expect(JSON.parse(result.value.stdout).items).toEqual([])
      }
      const concurrentOwner = await readOwner(ownerPath)
      expect(concurrentOwner.generation).toMatch(/^[0-9a-f-]{36}$/u)
      expect(concurrentOwner.pid).toBeGreaterThan(0)
    } else {
      // No --port: the launcher must honor AGNES_WEB_ORIGIN and select this nondefault origin.
      const webUrl = await webLaunch
      expect(webUrl.origin).toBe(origin)
      const html = await waitForHttp(origin)
      expect(html).toContain('data-ws=')

      const first = await runCli(['sessions', '--json'])
      expect(first.code).toBe(0)
      expect(JSON.parse(first.stdout).items).toEqual([])
      const owner = await readOwner(ownerPath)

      // A different workspace reuses the same home/profile/data scope and must not replace the owner.
      const secondWorkspace = join(root, 'second-workspace')
      await mkdir(secondWorkspace)
      const second = await runCli(['sessions', '--json'], secondWorkspace)
      expect(second.code).toBe(0)
      expect(JSON.parse(second.stdout).items).toEqual([])
      expect((await readOwner(ownerPath)).generation).toBe(owner.generation)
    }

    // All CLI clients have exited, while the Web launcher remains alive; the shared daemon must
    // continue serving its owner and endpoint.
    const status = await runCli(['daemon', 'status'])
    expect(status.code).toBe(0)
    expect(JSON.parse(status.stdout)).toMatchObject({ running: true })
    const stableOwner = await readOwner(ownerPath)
    expect(stableOwner.generation).toMatch(/^[0-9a-f-]{36}$/u)
    if (options.simultaneous) {
      const concurrentOwner = await readOwner(ownerPath)
      expect(concurrentOwner.generation).toBe(stableOwner.generation)
    }

    const stop = await runCli(['daemon', 'stop'])
    expect(stop.code).toBe(0)
    expect(stop.stdout.trim()).toBe('stopped')
    await expectGone(ownerPath)
    await expectGone(discoveryPath)
    await expectGone(credentialPath)

    const afterStop = await runCli(['daemon', 'status'])
    expect(afterStop.code).toBe(1)
    expect(JSON.parse(afterStop.stdout)).toMatchObject({ running: false })
  } finally {
    // A failed assertion can occur after the CLI has detached the shared daemon. Reclaim that
    // process before removing its temporary home; an already-completed stop simply returns 1.
    await runCli(['daemon', 'stop'])
    await Promise.allSettled([...children].map((child) => terminate(child)))
    await rm(root, { recursive: true, force: true })
  }
}

it.skipIf(!entry)(
  'accepts Web-first shared startup, client exit, stable ownership and explicit stop',
  async () => {
    await scenario({ simultaneous: false })
  },
  180_000,
)

it.skipIf(!entry)(
  'accepts simultaneous Web and multi-CLI cold start on one owner',
  async () => {
    await scenario({ simultaneous: true })
  },
  180_000,
)
