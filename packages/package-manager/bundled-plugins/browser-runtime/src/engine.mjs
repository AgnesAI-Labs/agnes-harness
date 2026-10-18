import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { browserPayload, installBrowser, installedBrowser } from './install.mjs'
import { request } from './protocol.mjs'

export function binaryName(platform = process.platform, arch = process.arch) {
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch))
    throw new Error(`Unsupported browser platform: ${platform}/${arch}`)
  const cpu = platform === 'win32' && arch === 'arm64' ? 'x64' : arch
  return `agent-browser-${platform}-${cpu}${platform === 'win32' ? '.exe' : ''}`
}

export function privateEnvironment(root, cache) {
  // Host openProcess supplies a small OS environment floor, not process.env.
  // Direct daemon mode never reads user/project CLI configuration or auto-connect options.
  return {
    HOME: cache,
    USERPROFILE: cache,
    AGENT_BROWSER_DAEMON: '1',
    AGENT_BROWSER_SESSION: 'owned',
    AGENT_BROWSER_SOCKET_DIR: root,
    AGENT_BROWSER_PROFILE: join(root, 'profile'),
    AGENT_BROWSER_HEADED: 'false',
    AGENT_BROWSER_ENGINE: 'chrome',
    AGENT_BROWSER_IDLE_TIMEOUT_MS: '900000',
  }
}

export class BrowserEngine {
  constructor({ binary, transport = request } = {}) {
    this.binary = binary ?? fileURLToPath(new URL(`../dist/bin/${binaryName()}`, import.meta.url))
    this.transport = transport
    this.cache = homedir()
  }

  async ensureChrome(ctx) {
    const payload = browserPayload(this.cache)
    if (await installedBrowser(payload)) return payload.executable
    if (this.installing) {
      await this.installing
      return this.ensureChrome(ctx)
    }
    this.installing = this.install(ctx)
    try {
      await this.installing
    } finally {
      this.installing = undefined
    }
    if (!(await installedBrowser(payload))) throw new Error('Headless browser installation is incomplete')
    return payload.executable
  }

  async install(ctx) {
    return installBrowser(ctx, this.cache)
  }

  async start(ctx) {
    if (!ctx.sandbox?.openProcess) throw new Error('Browser requires the Host-owned process service')
    await access(this.binary).catch(() => {
      throw new Error('Browser runtime payload is missing; rebuild/install the AGH browser runtime')
    })
    const executable = await this.ensureChrome(ctx)
    ctx.signal.throwIfAborted()
    const root = await mkdtemp(join(tmpdir(), 'agh-b-'))
    let child, off, exit
    let startupOutput = ''
    try {
      child = await ctx.sandbox.openProcess({
        argv: [this.binary],
        // Host checks cwd against the session's workspace policy. State stays private;
        // the daemon never reads CLI configuration from this working directory.
        ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
        signal: ctx.signal,
        env: { ...privateEnvironment(root, this.cache), AGENT_BROWSER_EXECUTABLE_PATH: executable },
      })
      off = child.onOutput(({ text }) => {
        startupOutput = (startupOutput + text).slice(-4096)
      })
      let exited = false
      void child.exited.then((result) => {
        exited = true
        exit = result
      })
      let endpoint
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        ctx.signal.throwIfAborted()
        if (exited) throw new Error('Owned browser daemon exited during startup')
        if (process.platform === 'win32') {
          const port = Number(await readFile(join(root, 'owned.port'), 'utf8').catch(() => ''))
          if (Number.isInteger(port) && port > 0 && port < 65536) endpoint = { host: '127.0.0.1', port }
        } else if (
          await access(join(root, 'owned.sock')).then(
            () => true,
            () => false,
          )
        )
          endpoint = { path: join(root, 'owned.sock') }
        if (endpoint) break
        await delay(50, undefined, { signal: ctx.signal })
      }
      if (!endpoint) throw new Error('Owned browser daemon did not become ready')
      const call = (command, signal, timeoutMs) => this.transport(endpoint, command, signal, timeoutMs)
      await call(
        {
          action: 'launch',
          headless: true,
          executablePath: executable,
          profile: join(root, 'profile'),
          engine: 'chrome',
        },
        ctx.signal,
      )
      await call({ action: 'viewport', width: 1280, height: 800, deviceScaleFactor: 1 }, ctx.signal)
      const streaming = await call({ action: 'stream_status' }, ctx.signal)
      if (
        !streaming.enabled ||
        !Number.isInteger(streaming.port) ||
        streaming.port < 1 ||
        streaming.port > 65535
      )
        throw new Error('Owned browser stream is unavailable')
      let closing
      return {
        call: async (command, signal, timeoutMs) => {
          if (command.action !== 'screenshot') return call(command, signal, timeoutMs)
          const path = join(root, 'screen.png')
          await call({ ...command, path }, signal, timeoutMs)
          if ((await stat(path)).size > 8 * 1024 * 1024) throw new Error('Screenshot exceeds 8 MiB')
          return { bytes: await readFile(path) }
        },
        port: streaming.port,
        exited: child.exited,
        close: () =>
          (closing ??= (async () => {
            // Kill only the process handle created above. No PID discovery, personal browser or port scanning.
            await call({ action: 'close' }, undefined, 2000).catch(() => {})
            await child.close()
            await rm(root, { recursive: true, force: true })
          })()),
      }
    } catch (error) {
      if (child) await child.close()
      await rm(root, { recursive: true, force: true })
      if (ctx.signal.aborted || !child) throw error
      // Startup never opens a user URL. Keep a bounded diagnostic, without private paths
      // or upstream's suggestion to disable Chrome's sandbox on failure.
      const detail = startupOutput
        .split(/\r?\n/)
        .filter((line) => !line.includes('--no-sandbox'))
        .join('\n')
        .replaceAll(root, '<browser-state>')
        .replaceAll(this.cache, '<browser-cache>')
        .trim()
        .slice(-2000)
      const status = exit ? ` (daemon exit: ${exit.code ?? exit.signal ?? 'unknown'})` : ''
      throw new Error(`BROWSER_START_FAILED${status}: ${error.message}${detail ? `\n${detail}` : ''}`, {
        cause: error,
      })
    } finally {
      off?.()
    }
  }
}
