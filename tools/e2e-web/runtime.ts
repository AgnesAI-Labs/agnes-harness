import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { AGH_DIR, type DiagnosticsEventsResult } from '@agnes/protocol'
import { createClient, memoryJournal, type NodeClient, wsTransport } from '@agnes/sdk'

const entry = resolve('packages/cli/dist/local/agnes.mjs')
export async function isolatedRuntime() {
  // Short paths avoid macOS Unix socket limits. Never inherit the user's profile or credentials.
  const root = await mkdtemp('/tmp/agh-e2e-')
  const home = join(root, 'h')
  const workspace = join(root, 'w')
  await mkdir(workspace)
  await writeFile(join(workspace, 'report.md'), '# Synthetic delivery\nOffline E2E evidence.\n')
  await mkdir(join(workspace, AGH_DIR, 'skills/e2e-playbook'), { recursive: true })
  await writeFile(
    join(workspace, AGH_DIR, 'skills/e2e-playbook/SKILL.md'),
    '---\nname: e2e-playbook\ndescription: Synthetic offline test skill\n---\nReply with E2E_SKILL_LOADED.\n',
  )
  const listener = createServer()
  await new Promise<void>((done, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', done)
  })
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback port')
  const url = `http://127.0.0.1:${address.port}`
  await new Promise<void>((done) => listener.close(() => done()))
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    TMPDIR: '/tmp',
    AGH_HOME: home,
    AGNES_PROFILE: 'local-dev',
    AGNES_WEB_ORIGIN: url,
  }
  let web: ChildProcess | undefined
  let log = ''
  const clients = new Set<NodeClient>()
  const cli = (args: string[]) =>
    new Promise<string>((done, reject) => {
      const child = execFile(
        process.execPath,
        [entry, ...args],
        { cwd: process.cwd(), env, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
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
    if (web && web.exitCode === null && web.signalCode === null) {
      const closed = new Promise<void>((done) => web?.once('exit', () => done()))
      web.kill('SIGTERM')
      const kill = setTimeout(() => web?.kill('SIGKILL'), 5000)
      await closed
      clearTimeout(kill)
    }
    web = undefined
    await cli(['daemon', 'stop'])
    if (failures.length) throw new AggregateError(failures, 'SDK cleanup failed after stopping the runtime')
  }
  const start = async () => {
    web = spawn(process.execPath, [entry, 'serve', '--port', String(address.port)], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    web.stdout?.on('data', (data) => {
      log += data.toString()
    })
    web.stderr?.on('data', (data) => {
      log += data.toString()
    })
    web.on('error', (error) => {
      log += error.message
    })
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      if (web.exitCode !== null) throw new Error(`serve exited: ${log}`)
      try {
        if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return
      } catch {
        /* Wait for the real daemon and BFF. */
      }
      await new Promise((done) => setTimeout(done, 100))
    }
    throw new Error(`serve readiness timeout: ${log}`)
  }
  const runtime = {
    home,
    workspace,
    url,
    cli,
    start,
    connect: async (transport: 'local' | 'web' = 'local', registerWorkspace = true) => {
      let ws = ''
      let socketPath = ''
      if (transport === 'web') {
        // Discover only the served document's endpoint; administrative operations use SDK RPC.
        const html = await (await fetch(url)).text()
        ws = html.match(/data-ws="([^"]+)"/)?.[1] ?? ''
        if (!ws) throw new Error('The real workbench did not advertise a daemon WebSocket')
      } else {
        const owner = JSON.parse(await readFile(join(home, 'data/daemon/owner.json'), 'utf8'))
        socketPath = owner.socketPath
      }
      const client = createClient({
        transport:
          transport === 'local'
            ? { kind: 'unix', path: socketPath }
            : { kind: 'ws', url: ws, protocols: ['agnes-v1'] },
        transportFactories: {
          ws: (options) => wsTransport({ ...options, url: ws, headers: { Origin: url } }),
        },
        auth: { kind: 'local' },
        journal: memoryJournal(),
      })
      await client.initialize()
      clients.add(client)
      if (registerWorkspace) await client.workspace.add(workspace)
      return client
    },
    restart: async () => {
      await stop()
      await start()
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
              { export: 'textStatsTool', id: 'ext:e2e-version', apiRange: '^1.4.0', inject: ['extension'] },
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
    dispose: async () => {
      try {
        await stop()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  }
  return runtime
}
export type Runtime = Awaited<ReturnType<typeof isolatedRuntime>>
