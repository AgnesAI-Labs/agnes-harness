import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { type DaemonConfig, DEFAULT_LIMITS } from '../src/config.js'
import { WorkerRegistry } from '../src/supervisor/registry.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { WorkerPool } from '../src/supervisor/worker-pool.js'
import { workspaceBinding } from './workspace-authority.js'

const fakeWorker = fileURLToPath(new URL('./fake-worker.ts', import.meta.url))
const workerSocket = (dir: string): string =>
  process.platform === 'win32' ? `\\\\.\\pipe\\${basename(dir)}-workers` : join(dir, 'w.sock')

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for shared worker recovery')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

it('recovers every open session together after the shared worker crashes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-shared-recovery-'))
  const profileFile = join(dir, 'profile.json')
  writeFileSync(profileFile, JSON.stringify({ name: 'p', hash: 'h1' }))
  const config: DaemonConfig = {
    profileName: 'p',
    dataDir: dir,
    socketPath: join(dir, 'a.sock'),
    workersSocketPath: workerSocket(dir),
    limits: { ...DEFAULT_LIMITS, workerStartupMs: 10_000 },
  }
  let registry!: WorkerRegistry
  const pool = new WorkerPool({
    config,
    profile: { name: 'p', hash: 'h1' } as never,
    profileFile,
    execPath: process.execPath,
    workerEntry: fakeWorker,
    execArgv: ['--import', 'tsx'],
    clock: () => Date.now(),
    onEvent: (sessionKey, event) => registry?.deliver(sessionKey, event),
    onRequest: async () => undefined,
    notices: { emit() {} },
  })
  registry = new WorkerRegistry(pool)
  const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
  const a = 'agnes:t:a:x:dm:recover-a'
  const b = 'agnes:t:a:x:dm:recover-b'
  try {
    const bindingA = await workspaceBinding(a, dir)
    const bindingB = await workspaceBinding(b, dir)
    const [firstA, firstB] = await Promise.all([
      registry.open({ key: a, cwd: dir, binding: bindingA }),
      registry.open({ key: b, cwd: dir, binding: bindingB }),
    ])
    const firstWorkerGeneration = pool.businessWorker()?.generation
    const observedA: number[] = []
    const observedB: number[] = []
    const unsubscribeA = registry.subscribe(a, (event) => observedA.push(event.seq))
    const unsubscribeB = registry.subscribe(b, (event) => observedB.push(event.seq))
    expect(firstWorkerGeneration).toBeDefined()
    expect(pool.links().filter(({ sessionKey }) => sessionKey === '@shared')).toHaveLength(1)

    const firstAChannel = await pool.acquire(a, { cwd: dir, binding: bindingA })
    const firstBChannel = await pool.acquire(b, { cwd: dir, binding: bindingB })
    const testCommand = (channel: typeof firstAChannel, seq: number): Promise<unknown> => {
      const unchecked = channel.command.bind(channel) as unknown as (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>
      return unchecked('emit-test-event', { seq })
    }
    await Promise.all([testCommand(firstAChannel, 3), testCommand(firstBChannel, 5)])
    await waitFor(() => observedA.includes(3) && observedB.includes(5))

    const crash = async (): Promise<void> => {
      const link = pool.businessWorker()?.link
      if (!link) return
      const uncheckedCommand = link.command.bind(link) as unknown as (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>
      await uncheckedCommand('crash', {}).catch(() => undefined)
    }
    await crash()

    await waitFor(() => {
      const worker = pool.businessWorker()
      return (
        worker !== undefined &&
        worker.generation !== firstWorkerGeneration &&
        registry.get(a) !== undefined &&
        registry.get(b) !== undefined
      )
    })

    const recoveredA = registry.require(a)
    const recoveredB = registry.require(b)
    expect(recoveredA).not.toBe(firstA)
    expect(recoveredB).not.toBe(firstB)
    expect(await recoveredA.session.status()).toMatchObject({ lastSeq: 3 })
    expect(await recoveredB.session.status()).toMatchObject({ lastSeq: 5 })
    expect(pool.links().filter(({ sessionKey }) => sessionKey === '@shared')).toHaveLength(1)
    const [recoveredChannelA, recoveredChannelB] = await Promise.all([
      pool.acquire(a, { cwd: dir, binding: bindingA, resume: true }),
      pool.acquire(b, { cwd: dir, binding: bindingB, resume: true }),
    ])
    await Promise.all([testCommand(recoveredChannelA, 7), testCommand(recoveredChannelB, 9)])
    await waitFor(() => observedA.includes(7) && observedB.includes(9))
    unsubscribeA()

    await registry.close(a)
    const secondWorkerGeneration = pool.businessWorker()?.generation
    await crash()
    await waitFor(() => {
      const worker = pool.businessWorker()
      return (
        worker !== undefined && worker.generation !== secondWorkerGeneration && registry.get(b) !== undefined
      )
    })
    expect(registry.get(a)).toBeUndefined()
    // B is still subscribed here: crash recovery reopens only a session somebody watches.
    unsubscribeB()
  } finally {
    await registry.closeAll()
    await pool.closeAll(2_000)
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)
