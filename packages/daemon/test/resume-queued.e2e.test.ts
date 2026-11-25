import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeHome } from '@agnes/host'
import { createClient, memoryJournal } from '@agnes/sdk'
import { expect, it } from 'vitest'
import { startLoopProvider } from './fixtures/loop-provider.js'
import { sourceTranspileCache } from './source-transpile-cache.js'

const sourceDaemon = fileURLToPath(new URL('./fixtures/source-loop-daemon.ts', import.meta.url))
const STEP_MS = 60_000
const WORKER_STARTUP_MS = 90_000
const MARKER = 'RESUME_QUEUED_PROBE'
const COMMAND_ID = 'resume-queued-follow-up'
// A stable client id: the daemon command journal dedupes per (principal, client, session, commandId).
const CLIENT_ID = 'resume-queued-client'

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), STEP_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function writeProfile(root: string, baseUrl: string) {
  const secretDir = join(root, 'secrets')
  mkdirSync(join(secretDir, 'fixture'), { recursive: true, mode: 0o700 })
  writeFileSync(join(secretDir, 'fixture', 'model'), 'synthetic-loop-fixture', { mode: 0o600 })
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
  writeFileSync(
    join(root, 'profiles', 'local-dev', 'profile.yaml'),
    JSON.stringify({
      name: 'local-dev',
      cacheDir: sourceTranspileCache(),
      computerUse: { enabled: false },
      limits: { 'worker.startup_ms': WORKER_STARTUP_MS },
      adapters: { secrets: { kind: 'file', path: secretDir } },
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

function bootDaemon(root: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', sourceDaemon, root, root], {
    env: { PATH: process.env.PATH, TMPDIR: tmpdir(), AGH_HOME: root },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  const log = { stderr: '' }
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.stderr?.on('data', (data) => {
      log.stderr += String(data)
      if (log.stderr.includes('agnesd listening on ')) resolve()
    })
    child.once('exit', (code) => reject(new Error(`source daemon exited ${code}: ${log.stderr}`)))
  })
  return { child, exited, ready, log }
}

async function stop(child: ChildProcess, exited: Promise<number | null>) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try {
    expect(await bounded(exited, 'daemon shutdown')).toBe(0)
  } catch (error) {
    child.kill('SIGKILL')
    await exited
    throw error
  }
}

function connect(root: string) {
  const owner = JSON.parse(readFileSync(join(root, 'daemon', 'owner.json'), 'utf8')) as { socketPath: string }
  const client = createClient({
    journal: memoryJournal(CLIENT_ID),
    auth: { kind: 'local' },
    transport: { kind: 'unix', path: owner.socketPath },
    timeouts: { request: WORKER_STARTUP_MS },
  })
  return { client, socketPath: owner.socketPath }
}

/** Model requests whose newest user message is the queued follow-up, i.e. turns that ran it. */
function followUpRuns(requests: readonly string[]): number {
  return requests.filter((raw) => {
    if (raw.includes('summarizing a chat')) return false
    const messages = JSON.parse(raw) as Array<{ role: string; content?: unknown }>
    const last = messages.filter((message) => message.role === 'user').at(-1)
    return JSON.stringify(last?.content ?? '').includes(MARKER)
  }).length
}

// A follow-up queued behind a running turn survives a daemon restart in the session inbox, but the
// restarted daemon does not start it on its own. The owning client resumes it by sending the oldest
// pending item now; the command journal keeps a resend of the same commandId from running it twice.
it.skipIf(process.platform === 'win32')(
  'resumes a follow-up queued before a daemon restart when the client sends the oldest pending item now',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-resume-queued-')))
    const provider = await startLoopProvider()
    initializeHome(root, 'local-dev')
    writeProfile(root, provider.baseUrl)
    const failures: unknown[] = []
    const daemons: ReturnType<typeof bootDaemon>[] = []
    const sockets = new Set<string>()
    let sdk: ReturnType<typeof createClient> | undefined
    try {
      const first = bootDaemon(root)
      daemons.push(first)
      await bounded(first.ready, 'first daemon boot')
      const before = connect(root)
      sdk = before.client
      sockets.add(before.socketPath)
      await before.client.initialize()
      const session = await before.client.session.new({ cwd: root })
      const sessionId = session.id

      const blocked = provider.block()
      void session.prompt('Cancel this blocked turn').catch(() => undefined)
      await bounded(blocked.entered, 'running turn')
      const queuedSeq = await session.followUp(MARKER, { commandId: COMMAND_ID })
      expect((await session.projectUI()).pendingInputs).toEqual([
        expect.objectContaining({ preview: expect.stringContaining(MARKER) }),
      ])

      await before.client.close()
      sdk = undefined
      await stop(first.child, first.exited)
      provider.unblock()

      const second = bootDaemon(root)
      daemons.push(second)
      await bounded(second.ready, 'restarted daemon boot')
      const after = connect(root)
      sdk = after.client
      sockets.add(after.socketPath)
      await after.client.initialize()
      const resumed = await after.client.session.load(sessionId, { cwd: root })
      const loaded = await resumed.projectUI()
      // Left alone, the restarted daemon does not start the queued follow-up on its own.
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      const idle = await resumed.projectUI()
      expect(idle.opState, 'no turn started on its own after the restart').toBeNull()
      expect(idle.turns.length, 'no turn started on its own after the restart').toBe(loaded.turns.length)
      expect(followUpRuns(provider.requests), 'nothing ran the follow-up on its own').toBe(0)
      const pending = idle.pendingInputs ?? []
      expect(pending, 'the queued follow-up is still pending after the restart').toHaveLength(1)
      const oldest = pending[0]
      if (!oldest) throw new Error('no pending input after the restart')
      expect(oldest.preview).toContain(MARKER)
      expect(oldest.commandId).toBe(COMMAND_ID)

      const sentAt = Date.now()
      await resumed.sendNow(oldest.itemId)
      let timeline = await resumed.projectUI()
      while (
        (timeline.pendingInputs?.length ?? 0) > 0 ||
        timeline.opState !== null ||
        followUpRuns(provider.requests) === 0
      ) {
        if (Date.now() - sentAt > 10_000)
          throw new Error(`queued follow-up was not taken within 10 s: ${JSON.stringify(timeline.opState)}`)
        await new Promise((resolve) => setTimeout(resolve, 100))
        timeline = await resumed.projectUI()
      }
      expect(Date.now() - sentAt).toBeLessThan(10_000)
      expect(timeline.turns.at(-1)).toMatchObject({ status: 'completed', reason: 'completed' })

      // The same command resent after the restart is a journal replay: original seq, no second turn.
      expect(await resumed.followUp(MARKER, { commandId: COMMAND_ID })).toBe(queuedSeq)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      const settled = await resumed.projectUI()
      expect(settled.pendingInputs ?? []).toEqual([])
      expect(settled.opState).toBeNull()
      expect(settled.turns.length).toBe(timeline.turns.length)
      expect(followUpRuns(provider.requests), 'the follow-up ran exactly once').toBe(1)
    } catch (error) {
      const logs = daemons.map((daemon, index) => `daemon ${index + 1} stderr:\n${daemon.log.stderr}`)
      failures.push(new Error(`${String(error)}\n${logs.join('\n')}`, { cause: error }))
    } finally {
      for (const close of [
        () => sdk?.close(),
        ...daemons.map((daemon) => () => stop(daemon.child, daemon.exited)),
        () => provider.close(),
        () => {
          rmSync(root, { recursive: true, force: true })
          for (const socketPath of sockets) rmSync(dirname(socketPath), { recursive: true, force: true })
        },
      ]) {
        try {
          await close()
        } catch (error) {
          failures.push(error)
        }
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'resume-queued e2e and cleanup failed')
  },
  180_000,
)
