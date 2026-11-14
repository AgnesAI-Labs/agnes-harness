// Starts the daemon the way packages/daemon/test/managed-sessions.e2e.test.ts does: the source daemon
// fixture (`packages/daemon/test/fixtures/source-loop-daemon.ts`) run by tsx, a scripted loopback model in the
// spirit of `packages/daemon/test/fixtures/loop-provider.ts`, and the profile written the same way. The daemon
// fixture is started as a child process by path, so no module of another package is imported.
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient, memoryJournal } from '@agnes/sdk'
import { killTree, trackRoot } from './process-tree.js'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const sourceDaemon = join(repository, 'packages/daemon/test/fixtures/source-loop-daemon.ts')
const PROFILE = 'local-dev'
const STEP_MS = 120_000
/** The whole of `startDaemon`, kept below the test timeout the e2e files use (240 s). */
const START_MS = 180_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until<T>(
  label: string,
  probe: () => T | Promise<T>,
  ms = STEP_MS,
  aborted: () => boolean = () => false,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    if (aborted()) throw new Error(`stopped while waiting for ${label}`)
    const value = await probe()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(100)
  }
}

/** The jiti transpile cache the daemon tests share (same key as packages/daemon/test/source-transpile-cache.ts). */
function transpileCache(): string {
  const loader = createRequire(join(repository, 'packages', 'host-extensions', 'package.json'))
  const jiti = realpathSync(dirname(dirname(loader.resolve('jiti'))))
  const key = createHash('sha256').update(`${jiti}\0${process.version}`).digest('hex').slice(0, 16)
  const directory = join(repository, 'node_modules', '.cache', 'agnes-source-transpile', key)
  mkdirSync(directory, { recursive: true })
  return directory
}

type Message = { role: string; content?: unknown }
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((part) => (typeof part === 'string' ? part : ((part as { text?: string }).text ?? '')))
          .join('')
      : ''

/** One request the model received; `main` is a turn of a session (it offers tools), not a side request without tools. */
export type ModelRequest = { lastRole: string; marker: string; main: boolean; toolResult?: string }

/**
 * A scripted OpenAI-compatible loopback model. The newest user message containing `[[...]]` drives it: a
 * `TOOL{"name":"shell","args":{...}}ENDTOOL` marker makes the next main-loop request call that tool once; anything
 * else is answered with `ACK`. There is no remote fallback.
 */
export async function startScriptedModel() {
  const requests: ModelRequest[] = []
  let calls = 0
  const finish = (response: ServerResponse, delta: Record<string, unknown>, reason: string) => {
    const event = { id: 'scripted', object: 'chat.completion.chunk', created: 0, model: 'loop-script' }
    response.write(
      `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    )
    response.end(
      `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`,
    )
  }
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: Message[]; tools?: unknown[] }
    const all = JSON.stringify(body.messages)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.flushHeaders()
    if (all.includes('<dag-planner-protocol>'))
      return finish(response, { role: 'assistant', content: '[]' }, 'stop')
    if (all.includes('summarizing a chat'))
      return finish(response, { role: 'assistant', content: '{"title":"fixture","keywords":[]}' }, 'stop')
    const last = body.messages[body.messages.length - 1] as Message
    const user = textOf(
      [...body.messages].reverse().find((m) => m.role === 'user' && textOf(m.content).includes('[['))
        ?.content,
    )
    const marker = (user.match(/\[\[(.*?)\]\]/s)?.[1] ?? user.slice(0, 80)).slice(0, 200)
    const main = Array.isArray(body.tools) && body.tools.length > 0
    requests.push({
      lastRole: last.role,
      marker,
      main,
      ...(last.role === 'tool' ? { toolResult: textOf(last.content) } : {}),
    })
    const tool = user.match(/TOOL(\{.*?\})ENDTOOL/s)?.[1]
    if (main && tool && last.role !== 'tool') {
      const { name, args } = JSON.parse(tool) as { name: string; args: unknown }
      const call = {
        index: 0,
        id: `call-${++calls}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      }
      return finish(response, { tool_calls: [call] }, 'tool_calls')
    }
    finish(response, { role: 'assistant', content: `ACK ${marker.slice(0, 40)}` }, 'stop')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('scripted model listener unavailable')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/**
 * Lays out a fresh home with the host's own initializer, which the daemon requires before a profile is
 * written. It runs in the daemon package, the one place that resolves `@agnes/host` for tests, in a child
 * process that ends on its own, or is killed after `STEP_MS`, or by `onSpawn`'s owner.
 */
function initializeHome(aghHome: string, tsx: string, onSpawn: (child: ChildProcess) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [
        '--import',
        tsx,
        '--input-type=module',
        '-e',
        `import { initializeHome } from '@agnes/host'; initializeHome(${JSON.stringify(aghHome)}, ${JSON.stringify(PROFILE)})`,
      ],
      {
        cwd: join(repository, 'packages', 'daemon'),
        env: { PATH: process.env.PATH ?? '', TMPDIR: tmpdir() },
        timeout: STEP_MS,
        killSignal: 'SIGKILL',
      },
      (error, _stdout, stderr) =>
        error ? reject(new Error(`home initialization failed: ${stderr || error}`)) : resolve(),
    )
    onSpawn(child)
  })
}

function writeProfile(aghHome: string, baseUrl: string): void {
  const secrets = join(aghHome, 'secrets')
  mkdirSync(join(secrets, 'fixture'), { recursive: true, mode: 0o700 })
  writeFileSync(join(secrets, 'fixture', 'model'), 'synthetic-loop-fixture', { mode: 0o600 })
  const model = {
    id: 'loop-script',
    name: 'Scripted loop fixture',
    route: 'loop-fixture',
    api: 'openai-completions',
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    toolCallFormats: ['native'],
    thinkingReplay: 'drop',
    contract_id: null,
  }
  mkdirSync(join(aghHome, 'profiles', PROFILE), { recursive: true })
  writeFileSync(
    join(aghHome, 'profiles', PROFILE, 'profile.yaml'),
    JSON.stringify({
      name: PROFILE,
      cacheDir: transpileCache(),
      computerUse: { enabled: false },
      adapters: { secrets: { kind: 'file', path: secrets } },
      provider: {
        package: '@agnes/ai',
        catalog: { include: [] },
        routes: [
          {
            route: model.route,
            api: 'openai-completions',
            baseUrl,
            credentialRef: 'secret://fixture/model',
            models: [model],
          },
        ],
      },
    }),
  )
}

type DaemonClient = ReturnType<typeof createClient>

/** The stop handle `startDaemon` gives its caller before anything is started. */
export interface DaemonHandle {
  /** Ends whatever has started so far, at any stage, and makes a pending `startDaemon` reject. Safe to repeat. */
  stop(): Promise<void>
}

const handles = new Set<DaemonHandle>()
/** Stops every daemon started by this module that is still running (for an `afterAll`). */
export async function stopAllDaemons(): Promise<void> {
  for (const handle of [...handles]) await handle.stop()
}

/**
 * Starts the source daemon on `aghHome` with the process environment reduced to what is given: `HOME` and `PATH`
 * exactly as passed (plus `TMPDIR` and `AGH_HOME`), nothing else of the caller's environment. `plugins` are plugin
 * source directories; each is installed, trusted and enabled once, before the first start returns.
 *
 * Stopping is possible from the first moment: `onHandle` receives a `stop()` before anything is spawned, so a
 * caller can register its cleanup before the (slow) start, and `stopAllDaemons()` covers the rest. The whole start
 * is capped at `startTimeoutMs` (default 180 s); on the cap, on `stop()` or on any failure every process the start
 * created (the home initializer, the daemon, and the processes below it) is killed by pid and the start rejects.
 *
 * `client` is the live client; read it again after `restart()`, which replaces it (same client id). A `restart()`
 * that fails leaves nothing running. `stop()` ends the daemon, the client and the scripted model and removes the
 * socket directory it may have created in /tmp; `aghHome` stays the caller's to remove. `shell(command, cwd)` runs
 * one shell tool call in a fresh full-access session and returns its output, which is how a test sees the
 * environment the session shell inherits.
 */
export async function startDaemon(opts: {
  aghHome: string
  home: string
  path: string
  plugins: string[]
  onHandle?: (handle: DaemonHandle) => void
  startTimeoutMs?: number
}) {
  const model = await startScriptedModel()
  const clientId = randomUUID()
  let child: ChildProcess | undefined
  let initializer: ChildProcess | undefined
  let socketDir: string | undefined
  let current: DaemonClient | undefined
  let stderr = ''
  let shells = 0
  let stopped = false
  let failStartup: (error: Error) => void = () => {}
  const workspaces = new Set<string>()
  const tsx = pathToFileURL(createRequire(join(repository, 'package.json')).resolve('tsx')).href

  const launch = async () => {
    if (stopped) throw new Error('stopped before the daemon was spawned')
    stderr = ''
    const spawned = spawn(process.execPath, ['--import', tsx, sourceDaemon, opts.aghHome, opts.aghHome], {
      cwd: repository,
      env: { PATH: opts.path, HOME: opts.home, TMPDIR: tmpdir(), AGH_HOME: opts.aghHome },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    child = spawned
    trackRoot(spawned)
    let spawnError: Error | undefined
    spawned.on('error', (error) => {
      spawnError = error
    })
    spawned.stderr?.on('data', (data) => {
      stderr += String(data)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`daemon boot timed out:\n${stderr.slice(-2000)}`)),
          STEP_MS,
        )
        const check = () => {
          if (!stderr.includes('agnesd listening on ')) return
          clearTimeout(timer)
          resolve()
        }
        spawned.stderr?.on('data', check)
        spawned.once('error', (error) => {
          clearTimeout(timer)
          reject(new Error(`daemon could not be spawned: ${error.message}`))
        })
        spawned.once('exit', (code) => {
          clearTimeout(timer)
          reject(new Error(`daemon exited ${code} during boot:\n${stderr.slice(-2000)}`))
        })
        if (spawnError) reject(spawnError)
      })
      if (stopped) throw new Error('stopped during daemon boot')
      const owner = JSON.parse(readFileSync(join(opts.aghHome, 'daemon', 'owner.json'), 'utf8')) as {
        socketPath: string
      }
      if (!owner.socketPath.startsWith(opts.aghHome)) socketDir = dirname(owner.socketPath)
      current = createClient({
        journal: memoryJournal(clientId),
        auth: { kind: 'local' },
        transport: { kind: 'unix', path: owner.socketPath },
        timeouts: { request: STEP_MS },
      })
      await current.initialize()
    } catch (error) {
      await terminate()
      throw error
    }
  }

  /** The client first, then the daemon and everything below it by pid (SIGTERM, then SIGKILL). */
  const terminate = async () => {
    const process_ = child
    child = undefined
    try {
      await current?.close()
    } catch {
      /* the connection is going away with the daemon */
    }
    current = undefined
    if (process_) await killTree(process_)
  }

  const installPlugins = async (client: DaemonClient) => {
    const command = async () => ({
      profile: PROFILE,
      clientId: await client.clientId(),
      commandId: randomUUID(),
    })
    const finished = async (receipt: { profile: string; operationId: string }) =>
      until(
        `package operation ${receipt.operationId}`,
        async () => {
          const result = await client.packages.operation.get({
            profile: receipt.profile,
            operationId: receipt.operationId,
          })
          if (['failed', 'cancelled', 'rolled-back'].includes(result.state))
            throw new Error(`package ${result.operation}: ${JSON.stringify(result.error)}`)
          return result.state === 'completed' ? result : undefined
        },
        STEP_MS,
        () => stopped,
      )
    for (const directory of opts.plugins) {
      const source = { type: 'file' as const, ref: `file:${directory}` }
      const preview = (await finished(await client.packages.inspect({ ...(await command()), source })))
        .preview
      if (!preview?.capabilityHash) throw new Error(`plugin ${directory} has no capability hash`)
      if (preview.blockers.length > 0)
        throw new Error(`plugin ${directory} is blocked: ${JSON.stringify(preview.blockers)}`)
      await finished(
        await client.packages.install({ ...(await command()), source, expectedIntegrity: preview.integrity }),
      )
      const id = preview.id
      await finished(
        await client.packages.trust({
          ...(await command()),
          id,
          expectedIntegrity: preview.integrity,
          capabilityHash: preview.capabilityHash,
        }),
      )
      await finished(await client.packages.enable({ ...(await command()), id }))
    }
  }

  const handle: DaemonHandle = {
    async stop() {
      stopped = true
      failStartup(new Error('daemon stopped during startup'))
      handles.delete(handle)
      await terminate()
      if (initializer) await killTree(initializer, 'SIGKILL', 5_000)
      initializer = undefined
      await model.close()
      if (socketDir) rmSync(socketDir, { recursive: true, force: true })
    },
  }
  handles.add(handle)
  opts.onHandle?.(handle)

  const cap = opts.startTimeoutMs ?? START_MS
  let capTimer: ReturnType<typeof setTimeout> | undefined
  const failure = new Promise<never>((_, reject) => {
    failStartup = reject
    capTimer = setTimeout(() => reject(new Error(`daemon startup exceeded ${cap} ms and was stopped`)), cap)
  })
  failure.catch(() => {})
  const startup = (async () => {
    await initializeHome(opts.aghHome, tsx, (spawned) => {
      initializer = spawned
      trackRoot(spawned)
      if (stopped) void killTree(spawned, 'SIGKILL', 5_000)
    })
    if (stopped) throw new Error('daemon stopped during startup')
    writeProfile(opts.aghHome, model.baseUrl)
    await launch()
    await installPlugins(current as DaemonClient)
  })()
  startup.catch(() => {})
  try {
    await Promise.race([startup, failure])
  } catch (error) {
    await handle.stop()
    throw error
  } finally {
    clearTimeout(capTimer)
  }

  return {
    get client(): DaemonClient {
      if (!current) throw new Error('the daemon is not running')
      return current
    },
    get socketDir() {
      return socketDir
    },
    /** What the scripted model has been asked so far. */
    modelRequests: () => model.requests.map((request) => ({ ...request })),
    stderr: () => stderr,
    async restart(): Promise<void> {
      try {
        await terminate()
        await launch()
      } catch (error) {
        await terminate()
        throw error
      }
    },
    stop: () => handle.stop(),
    async shell(command: string, cwd: string): Promise<string> {
      const client = this.client
      if (!workspaces.has(cwd)) {
        await client.workspace.add(cwd)
        workspaces.add(cwd)
      }
      const id = `shell-${++shells}-${randomUUID().slice(0, 8)}`
      const session = await client.session.new({ cwd, sessionKey: id, permission: 'full-access' })
      await session.followUp(`[[${id} TOOL${JSON.stringify({ name: 'shell', args: { command } })}ENDTOOL]]`)
      const answered = await until(`shell result ${id}`, () =>
        model.requests.find((request) => request.lastRole === 'tool' && request.marker.includes(id)),
      )
      return (answered.toolResult ?? '').replace(/<\/?untrusted[^>]*>/g, '').trim()
    },
  }
}
