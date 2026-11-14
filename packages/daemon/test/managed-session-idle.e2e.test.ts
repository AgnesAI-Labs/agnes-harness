import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeHome } from '@agnes/host'
import type { SessionViewResult } from '@agnes/protocol'
import { createClient, memoryJournal } from '@agnes/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startLoopProvider } from './fixtures/loop-provider.js'
import {
  bounded,
  installProbe,
  PACKAGE,
  type PluginReply,
  pluginCaller,
  STEP_MS,
  spawnDaemon,
  stopDaemon,
  writePlugin,
  writeProfile,
} from './fixtures/managed-probe.js'

const fixture = fileURLToPath(new URL('./fixtures/idle-signal-daemon.ts', import.meta.url))
type Row = { kind: 'idle' | 'startup'; sessionId?: string; connected?: boolean; opened?: string; at: number }

describe.skipIf(process.platform === 'win32')('managed session idle signal on a real daemon', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-idle-signal-')))
  const exchange = join(root, 'exchange')
  const workspace = join(root, 'managed-workspace')
  const pluginDirectory = join(root, 'plugin')
  const log = join(root, 'idle.log')
  const probe = join(root, 'probe-session')
  let provider: Awaited<ReturnType<typeof startLoopProvider>>
  let daemon: ReturnType<typeof spawnDaemon> | undefined
  let client: ReturnType<typeof createClient> | undefined
  let socketPath: string | undefined
  let managedId = ''
  const asPlugin = pluginCaller(exchange)

  const rows = (): Row[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Row)
      : []
  const idles = (sessionId: string) =>
    rows().filter((row) => row.kind === 'idle' && row.sessionId === sessionId)
  const until = async <T>(read: () => T | Promise<T>, done: (value: T) => boolean, label: string) => {
    const deadline = Date.now() + STEP_MS
    for (;;) {
      const value = await read()
      if (done(value)) return value
      if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(value)}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  /** Long enough for a stray report from the same turn boundary to land in the log. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1_000))
  const turns = async (sessionId: string) =>
    (await sdk().call<SessionViewResult>('_agnes/v1/session.view', { sessionId, maxNodes: 5000 })).timeline
      .turns
  const managedTurns = async (sessionId: string) =>
    ((await asPlugin('events', sessionId)).value?.events ?? []).filter((event) => event.kind === 'turn')
  const boot = async () => {
    daemon = spawnDaemon(fixture, [root, root, log, probe], root)
    await bounded(daemon.ready, 'source daemon boot')
    const owner = JSON.parse(readFileSync(join(root, 'daemon', 'owner.json'), 'utf8'))
    socketPath = owner.socketPath
    client = createClient({
      journal: memoryJournal(),
      auth: { kind: 'local' },
      transport: { kind: 'unix', path: owner.socketPath },
      timeouts: { request: STEP_MS },
    })
    await client.initialize()
  }
  const sdk = () => {
    if (!client) throw new Error('no client connected')
    return client
  }
  const failWith = (error: unknown) =>
    new Error(`${String(error)}\nSource daemon stderr:\n${daemon?.output.stderr ?? ''}`, { cause: error })

  beforeAll(async () => {
    provider = await startLoopProvider()
    initializeHome(root, 'local-dev')
    mkdirSync(exchange)
    mkdirSync(workspace)
    writeProfile(root, provider.baseUrl)
    writePlugin(pluginDirectory, exchange)
    try {
      await boot()
      await sdk().workspace.add(workspace)
      await installProbe(sdk(), pluginDirectory)
      await sdk().request('_agnes/v1/admin.managedWorkspaces.grant', { packageId: PACKAGE, workspace })
    } catch (error) {
      throw failWith(error)
    }
  }, 180_000)

  afterAll(async () => {
    const failures: unknown[] = []
    for (const close of [
      () => client?.close(),
      () => daemon && stopDaemon(daemon.child, daemon.exited),
      () => provider?.close(),
      () => {
        rmSync(root, { recursive: true, force: true })
        if (socketPath) rmSync(dirname(socketPath), { recursive: true, force: true })
      },
    ]) {
      try {
        await close()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, 'idle signal e2e cleanup failed')
  }, 60_000)

  it('onIdle fires after a managed turn completes', async () => {
    const started: PluginReply = await asPlugin('start', {
      bundle: `${PACKAGE}#worker`,
      workspace,
      input: 'Summarize the refund window.',
      startKey: 'idle-task',
      retention: 'task',
    })
    expect(started.ok, JSON.stringify(started.error)).toBe(true)
    managedId = started.value?.sessionId ?? ''
    await until(
      () => managedTurns(managedId),
      (all) => all.some((turn) => turn.status === 'completed'),
      'managed turn',
    )
    await until(
      () => idles(managedId),
      (found) => found.length > 0,
      'idle after the managed turn',
    )
    await settle()
    expect(idles(managedId), 'one turn reports idle once').toHaveLength(1)
  }, 120_000)

  it('onIdle fires after an owner Web prompt turn completes', async () => {
    const session = await sdk().session.new({ cwd: workspace, sessionKey: 'idle-owner-prompt' })
    await session.prompt('An owner prompt from the Web.')
    await until(
      () => idles(session.id),
      (found) => found.length > 0,
      'idle after the owner prompt',
    )
    await settle()
    expect(idles(session.id), 'one owner prompt reports idle once').toHaveLength(1)
  }, 120_000)

  it('onIdle fires after a cancelled turn and after a failed turn', async () => {
    const before = idles(managedId).length
    const blocked = provider.block()
    const sent = await asPlugin('send', managedId, {
      text: 'Cancel this blocked turn',
      idempotencyKey: 'cancel-1',
    })
    expect(sent.value).toEqual({ state: 'started' })
    await bounded(blocked.entered, 'blocked turn')
    expect(await asPlugin('interrupt', managedId)).toMatchObject({ ok: true })
    provider.unblock()
    await until(
      () => idles(managedId),
      (found) => found.length > before,
      'idle after the cancelled turn',
    )
    expect((await managedTurns(managedId)).at(-1)?.status, 'the managed turn was cancelled').toBe('cancelled')
    await settle()
    expect(idles(managedId)).toHaveLength(before + 1)

    const owner = await sdk().session.new({ cwd: workspace, sessionKey: 'idle-owner-failure' })
    await expect(owner.prompt('FAIL_THIS_TURN')).rejects.toBeDefined()
    await until(
      () => idles(owner.id),
      (found) => found.length > 0,
      'idle after the failed owner turn',
    )
    expect((await turns(owner.id)).at(-1)?.status, 'the owner turn failed').toBe('failed')
    await settle()
    expect(idles(owner.id)).toHaveLength(1)

    const afterCancel = idles(managedId).length
    const failed = await asPlugin('send', managedId, { text: 'FAIL_THIS_TURN', idempotencyKey: 'fail-1' })
    expect(failed.value).toEqual({ state: 'started' })
    await until(
      () => idles(managedId),
      (found) => found.length > afterCancel,
      'idle after the failed managed turn',
    )
    expect((await managedTurns(managedId)).at(-1)?.status, 'the managed turn failed').toBe('failed')
    await settle()
    expect(idles(managedId)).toHaveLength(afterCancel + 1)
  }, 180_000)

  it('onIdle does not fire between turns of one follow-up chain', async () => {
    const session = await sdk().session.new({ cwd: workspace, sessionKey: 'idle-owner-chain' })
    const held = provider.hold()
    const prompt = session.prompt('HOLD_THIS_TURN and then answer.')
    await bounded(held.entered, 'held owner turn')
    await session.followUp('Follow-up one.')
    await session.followUp('Follow-up two.')
    held.release()
    await prompt
    await until(
      () => turns(session.id),
      (all) => all.filter((turn) => turn.status === 'completed').length === 3,
      'three chained turns',
    )
    await until(
      () => idles(session.id),
      (found) => found.length > 0,
      'idle after the chain',
    )
    await settle()
    expect(idles(session.id), 'a chain of three turns reports idle once, after its last turn').toHaveLength(1)
  }, 120_000)

  it('startup sweep after restart', async () => {
    writeFileSync(probe, managedId)
    await sdk().close()
    client = undefined
    if (!daemon) throw new Error('no daemon running')
    await stopDaemon(daemon.child, daemon.exited)
    const restartedAt = Date.now()
    await boot()
    const startup = await until(
      () => rows().filter((row) => row.kind === 'startup' && row.at >= restartedAt),
      (found) => found.length > 0,
      'startup after restart',
    )
    expect(startup, 'startup fires once, after the daemon accepts connections, and opens a session').toEqual([
      expect.objectContaining({ connected: true, opened: managedId }),
    ])
  }, 180_000)
})
