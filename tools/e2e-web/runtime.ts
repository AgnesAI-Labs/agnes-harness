import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AGH_DIR, type DiagnosticsEventsResult } from '@agnes/protocol'
import {
  createClient,
  memoryJournal,
  type NodeClient,
  type TransportFactory,
  unixTransport,
  wsTransport,
} from '@agnes/sdk'

const requestedEntry = process.env.AGH_WEB_TEST_ENTRY
const entry = resolve(requestedEntry ?? 'packages/cli/dist/local/agnes.mjs')
const loopback = '127.0.0.1'
const workbenchWebSocket = /data-ws="([^"]+)"/u

async function probePort(port: number): Promise<number> {
  const listener = createServer()
  await new Promise<void>((done, reject) => {
    listener.once('error', reject)
    listener.listen(port, loopback, done)
  })
  const address = listener.address()
  await new Promise<void>((done, reject) => listener.close((error) => (error ? reject(error) : done())))
  if (!address || typeof address === 'string') throw new Error('Missing loopback port')
  return address.port
}

async function workbenchPort(): Promise<number> {
  // Preserve the browser origin across restarts without competing with Linux's default ephemeral ports.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await probePort(randomInt(18_000, 32_000))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error
    }
  }
  return probePort(0)
}

export async function isolatedRuntime(
  launcher: 'root' | 'installed' = 'root',
  options: {
    localExamples?: boolean
    realModel?: boolean
    browserArchive?: string
    /** Extra variables for the runtime and its CLI, beyond the fixed minimum. */
    extraEnv?: Readonly<Record<string, string>>
  } = {},
) {
  const port = await workbenchPort()
  const url = `http://${loopback}:${port}`
  // Short paths avoid macOS Unix socket limits. Never inherit the user's profile or credentials.
  const parent = options.realModel ? join(homedir(), 'agh-real-eval') : sep === '\\' ? tmpdir() : '/tmp'
  await mkdir(parent, { recursive: true })
  // Cache ownership and workspace receipts must agree on macOS /tmp aliases.
  const root = await realpath(await mkdtemp(join(parent, options.realModel ? 'sweep-' : 'agh-e2e-')))
  const home = join(root, 'h')
  const workspace = join(root, 'w')
  await mkdir(workspace)
  // The catalog matrix explicitly owns these public fixtures; the daemon still runs in its isolated workspace.
  if (options.localExamples)
    await cp(resolve('examples/packages'), join(workspace, 'examples/packages'), { recursive: true })
  await writeFile(join(workspace, 'report.md'), '# Synthetic delivery\nOffline E2E evidence.\n')
  await mkdir(join(workspace, AGH_DIR, 'skills/e2e-playbook'), { recursive: true })
  await writeFile(
    join(workspace, AGH_DIR, 'skills/e2e-playbook/SKILL.md'),
    '---\nname: e2e-playbook\ndescription: Synthetic offline test skill\n---\nReply with E2E_SKILL_LOADED.\n',
  )
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    TMPDIR: tmpdir(),
    ...(sep === '\\'
      ? {
          SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
          TEMP: tmpdir(),
          TMP: tmpdir(),
          USERPROFILE: root,
          APPDATA: join(root, 'appdata'),
          LOCALAPPDATA: join(root, 'localappdata'),
        }
      : {}),
    AGH_HOME: home,
    AGNES_PROFILE: 'local-dev',
    AGNES_WEB_ORIGIN: url,
    AGH_TELEMETRY_DISABLED: '1',
    ...options.extraEnv,
  }
  // Seed the reviewed test archive before enabling the default plugin; no startup network race.
  if (options.browserArchive) {
    const { createLauncher } = await import(
      new URL('../../packages/package-manager/bundled-plugins/browser/src/launcher.mjs', import.meta.url).href
    )
    const cacheRoot =
      sep === '\\' ? join(root, 'localappdata/Agnes/browser') : join(root, 'Library/Caches/Agnes/browser')
    const installer = createLauncher({
      cacheRoot,
      fetchArchive: async () => ({ ok: true, body: createReadStream(options.browserArchive!) }),
    })
    const state = {
      enabled: true,
      epoch: 0,
      state: 'stopped',
      error: undefined as string | undefined,
      guard() {},
      notify() {},
    }
    try {
      installer.prepare(state)
      const deadline = Date.now() + 30_000
      while (state.state !== 'ready' && !state.error && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 100))
      if (state.state !== 'ready') throw new Error(state.error ?? 'Test browser cache preparation timed out')
    } finally {
      installer.cancel()
    }
  }
  let web: ChildProcess | undefined
  const starts: { start: number; ready: number }[] = []
  let log = ''
  const clients = new Set<NodeClient>()
  const requests: { method: string; durationMs: number; code?: unknown }[] = []
  const measured =
    (factory: TransportFactory): TransportFactory =>
    async (handlers) => {
      const pending = new Map<string | number, { method: string; started: number }>()
      const transport = await factory({
        ...handlers,
        onClose(info) {
          for (const request of pending.values())
            requests.push({
              method: request.method,
              durationMs: Math.round(performance.now() - request.started),
              code: `transport-${info.reason}`,
            })
          pending.clear()
          handlers.onClose(info)
        },
        onMessage(message) {
          if ('id' in message && !('method' in message)) {
            const request = pending.get(message.id)
            if (request) {
              pending.delete(message.id)
              requests.push({
                method: request.method,
                durationMs: Math.round(performance.now() - request.started),
                ...(message.error ? { code: message.error.data?.code } : {}),
              })
            }
          }
          handlers.onMessage(message)
        },
      })
      return {
        kind: transport.kind,
        close: () => transport.close(),
        send: (message) => {
          if ('id' in message && 'method' in message)
            pending.set(message.id, { method: message.method, started: performance.now() })
          return transport.send(message)
        },
      }
    }
  const cli = (args: string[]) =>
    new Promise<string>((done, reject) => {
      // stopDaemon already waits up to 35s (the daemon drains for 30s). Let that result settle,
      // including CLI startup and identity checks, instead of killing its waiter after 20s.
      const timeout = args.length === 2 && args[0] === 'daemon' && args[1] === 'stop' ? 40_000 : 20_000
      const child = execFile(
        process.execPath,
        [entry, ...args],
        { cwd: workspace, env, timeout, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout, stderr) => {
          log += `CLI ${args[0]}\n${stdout}${stderr}`
          error
            ? reject(
                new Error(
                  `CLI ${args[0]}: ${stderr || stdout} (code=${error.code}, signal=${error.signal})`,
                  {
                    cause: error,
                  },
                ),
              )
            : done(stdout)
        },
      )
      child.stdin?.end()
    })
  const stop = async () => {
    log += `Stopping serve child ${web?.pid ?? 'already exited'}\n`
    const closedClients = await Promise.allSettled([...clients].map((client) => client.close()))
    const failures = closedClients.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    clients.clear()
    const child = web
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const pid = child.pid
      const closed = new Promise<void>((done) => child.once('close', () => done()))
      child.kill('SIGTERM')
      const kill = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return
        if (sep === '\\') child.kill('SIGKILL')
        else {
          // Include the actual server if the POSIX launcher is only a wrapper around it.
          try {
            process.kill(-pid, 'SIGKILL')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL')
          }
        }
      }, 5000)
      await closed
      clearTimeout(kill)
    }
    web = undefined
    await cli(['daemon', 'stop'])
    if (failures.length) throw new AggregateError(failures, 'SDK cleanup failed after stopping the runtime')
  }
  const start = async () => {
    const started = Date.now()
    // Windows termination cannot forward through a launcher. Open the listener-owning entry directly.
    const directEntry = Boolean(requestedEntry) || sep === '\\'
    const installed = launcher === 'installed' && !directEntry
    const command = installed ? resolve('packages/cli/bin/agh') : process.execPath
    const args = [
      ...(installed ? [] : [directEntry ? entry : resolve('agnes.mjs')]),
      'serve',
      '--port',
      String(port),
    ]
    const child = spawn(command, args, {
      cwd: workspace,
      env,
      detached: sep !== '\\',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    web = child
    let childOut = ''
    let listening = false
    child.stdout?.setEncoding('utf8').on('data', (text: string) => {
      log += text
      if (listening) return
      childOut += text
      // `agh serve` prints the URL on its own line after binding the workbench listener.
      listening = `\n${childOut.replaceAll('\r\n', '\n')}`.includes(`\n${url}/\n`)
    })
    child.stderr?.on('data', (data) => {
      log += data.toString()
    })
    let spawnError: Error | undefined
    child.on('error', (error) => {
      spawnError = error
      log += error.message
    })
    const deadline = Date.now() + (sep === '\\' ? 120_000 : 25_000)
    while (Date.now() < deadline) {
      if (web !== child) throw new Error('serve startup was cancelled')
      if (spawnError) throw new Error('serve failed to start', { cause: spawnError })
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`serve exited: ${log}`)
      if (!listening) {
        await delay(100)
        continue
      }
      let html: string | undefined
      try {
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(1000) })
        if (response.ok) html = await response.text()
        else await response.body?.cancel()
      } catch {
        /* Wait for the real daemon and BFF. */
      }
      if (html && workbenchWebSocket.test(html) && child.exitCode === null && child.signalCode === null) {
        if (web !== child) throw new Error('serve startup was cancelled')
        starts.push({ start: started, ready: Date.now() })
        return
      }
      await delay(100)
    }
    throw new Error(`serve readiness timeout: ${log}`)
  }
  const runtime = {
    home,
    workspace,
    url,
    cli,
    start,
    starts: () => starts,
    connect: async (transport: 'local' | 'web' = 'local', registerWorkspace = true) => {
      const deadline = Date.now() + (sep === '\\' ? 120_000 : 25_000)
      let client: ReturnType<typeof createClient> | undefined
      while (!client) {
        let ws = ''
        let socketPath = ''
        let serverIdentity: { pid: number; processStartId: string } | undefined
        try {
          if (transport === 'web') {
            // Discover only the served document's endpoint; administrative operations use SDK RPC.
            const html = await (await fetch(url)).text()
            ws = html.match(workbenchWebSocket)?.[1] ?? ''
            if (!ws) throw new Error('The real workbench did not advertise a daemon WebSocket')
          } else {
            const owner = JSON.parse(await readFile(join(home, 'daemon/owner.json'), 'utf8'))
            if (!owner?.socketPath) throw new Error('daemon owner has no socketPath')
            socketPath = owner.socketPath
            if (sep === '\\') serverIdentity = { pid: owner.pid, processStartId: owner.processStartId }
          }
          const candidate = createClient({
            // Cold Windows Host assembly is measured separately from browser interaction assertions.
            ...(sep === '\\' ? { timeouts: { request: 120_000 } } : {}),
            transport:
              transport === 'local'
                ? { kind: 'unix', path: socketPath }
                : { kind: 'ws', url: ws, protocols: ['agnes-v1'] },
            transportFactories: {
              unix: () =>
                measured(unixTransport({ path: socketPath, ...(serverIdentity ? { serverIdentity } : {}) })),
              ws: (options) => measured(wsTransport({ ...options, url: ws, headers: { Origin: url } })),
            },
            auth: { kind: 'local' },
            journal: memoryJournal(),
          })
          try {
            await candidate.initialize()
            client = candidate
          } catch (error) {
            await candidate.close().catch(() => undefined)
            throw error
          }
        } catch (error) {
          if (transport === 'web' || Date.now() >= deadline) throw error
          await new Promise((done) => setTimeout(done, 50))
        }
      }
      clients.add(client)
      if (registerWorkspace) {
        const registered = await client.workspace.add(workspace)
        if (!registered.workspace.name.trim()) throw new Error('Test workspace must have a display name')
      }
      return client
    },
    restart: async () => {
      await stop()
      const stopped = new Date().toISOString()
      await start()
      // The page is served before the daemon has booted its Host; a page opened then waits for that
      // boot inside its own deadlines. Return once the restarted daemon's boot Host is ready.
      const client = await runtime.connect('local', false)
      try {
        // The same deadline as the first start's serve readiness.
        const deadline = Date.now() + (sep === '\\' ? 120_000 : 25_000)
        const booted = async () => {
          const collected = await client.call<{ logs: Array<{ name: string; text: string }> }>(
            '_agnes/v1/diagnostics.collect',
            {},
          )
          const host = collected.logs.find((log) => log.name === 'host.jsonl')?.text ?? ''
          return host.split('\n').some((line) => {
            try {
              const row = JSON.parse(line) as { at?: string; kind?: string; detail?: { reason?: string } }
              return row.kind === 'host.ready' && row.detail?.reason === 'boot' && (row.at ?? '') >= stopped
            } catch {
              return false
            }
          })
        }
        while (!(await booted())) {
          if (Date.now() > deadline) throw new Error(`restarted daemon Host readiness timeout: ${log}`)
          await new Promise((done) => setTimeout(done, 100))
        }
      } finally {
        clients.delete(client)
        await client.close()
      }
    },
    localTool: async (version: number) => {
      // Publish complete initial files; later editor-style saves replace only code atomically.
      const folder = join(root, 'tool-update')
      const installed = join(home, 'plugins/e2e-version')
      await mkdir(folder, { recursive: true })
      await cp('examples/packages/hot-tool-plugin/index.mjs', join(folder, 'index.mjs'))
      const code = await readFile(join(folder, 'index.mjs'), 'utf8')
      await writeFile(
        join(folder, 'index.mjs'),
        code
          .replace('demo_text_stats', 'e2e_version')
          .replace(
            'const structured = { characters: text.length, words }',
            `const structured = { version: ${version}, words }`,
          ),
      )
      await writeFile(
        join(folder, 'package.json'),
        JSON.stringify({
          name: 'e2e-version',
          version: '1.0.0',
          type: 'module',
          exports: './index.mjs',
          license: 'MIT',
          agnes: {
            plugins: [
              {
                export: 'textStatsTool',
                id: 'ext:e2e-version',
                apiRange: '^5.0.0',
                inject: ['tools', 'hooks', 'self'],
              },
            ],
          },
        }),
      )
      await mkdir(join(home, 'plugins'), { recursive: true })
      if (version === 1) await rename(folder, installed)
      else {
        await rename(join(folder, 'index.mjs'), join(installed, 'index.mjs'))
        await rm(folder, { recursive: true, force: true })
      }
    },
    diagnostics: async () => {
      try {
        const client = await runtime.connect('local', false)
        const collected = await client.call('_agnes/v1/diagnostics.collect', {})
        const sessions = (await client.session.list()).items
        const events = await Promise.all(
          sessions.map(async (session) => {
            try {
              return {
                sessionId: session.sessionId,
                ...(await client.call<DiagnosticsEventsResult>('_agnes/v1/diagnostics.events', {
                  sessionId: session.sessionId,
                  afterSeq: 0,
                  limit: 500,
                  maxBytes: 256_000,
                })),
              }
            } catch (error) {
              return { sessionId: session.sessionId, error: String(error) }
            }
          }),
        )
        return JSON.stringify({ collected, events })
      } catch (error) {
        return JSON.stringify({ error: String(error) })
      }
    },
    logs: () => log,
    requests: () => JSON.stringify(requests, null, 2),
    dispose: async () => {
      try {
        await stop()
      } catch (error) {
        log += `Cleanup failed; retained isolated AGH_HOME: ${home}\n`
        throw error
      }
      if (!options.realModel) await rm(root, { recursive: true, force: true })
    },
  }
  return runtime
}
export type Runtime = Awaited<ReturnType<typeof isolatedRuntime>>
