import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { createChannelClient } from '../../packages/channels/src/runner/client.js'
import { readDaemonDiscovery, resolveDaemonScope } from '../../packages/daemon/src/index.js'
import { startProviderFixture } from './provider-fixture.js'

const entry = process.env.AGNES_LOCAL_CLI
const windows = process.platform === 'win32' // guards-allow-platform: built Windows daemon reconnect acceptance.

it.skipIf(!windows || !entry)(
  'one channel client reconnects after an actual daemon crash and verifies its new owner',
  async () => {
    if (!entry) throw new Error('AGNES_LOCAL_CLI is required')
    const root = await mkdtemp(join(tmpdir(), 'agnes-channel-restart-中文 '))
    const home = join(root, 'home')
    const scope = await resolveDaemonScope({ home, workspace: root, profile: 'local-dev' })
    const children: ChildProcess[] = []
    const provider = await startProviderFixture('渠道恢复回复')
    let client: ReturnType<typeof createChannelClient> | undefined
    const stop = async (child: ChildProcess) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) })
      child.kill('SIGKILL')
      await exited
    }
    const start = async () => {
      const child = spawn(
        process.env.AGNES_LOCAL_NODE ?? process.execPath,
        [
          join(dirname(resolve(entry)), 'daemon.mjs'),
          '--home',
          home,
          '--workspace',
          root,
          '--profile',
          'local-dev',
        ],
        {
          cwd: root,
          env: { ...process.env, AGH_HOME: home, AGNES_PROFILE: 'local-dev' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )
      children.push(child)
      let diagnostic = ''
      child.stderr?.on('data', (bytes: Buffer) => {
        diagnostic = (diagnostic + bytes.toString()).slice(-4096)
      })
      child.stdout?.resume()
      let descriptor: Awaited<ReturnType<typeof readDaemonDiscovery>> = null
      await vi.waitFor(
        async () => {
          if (child.exitCode !== null) throw new Error(`daemon exited ${child.exitCode}: ${diagnostic}`)
          descriptor = await readDaemonDiscovery(scope)
          expect(descriptor?.owner.pid).toBe(child.pid)
        },
        { timeout: 15000, interval: 100 },
      )
      if (!descriptor) throw new Error('missing daemon discovery')
      return { child, descriptor, diagnostic: () => diagnostic }
    }
    try {
      const first = await start()
      client = createChannelClient({
        channel: 'acceptance',
        connect: { kind: 'unix', path: first.descriptor.socketPath },
        localDaemon: { home, profile: 'local-dev' },
        workspace: root,
        tenant: 'acceptance',
        agent: 'acceptance',
        credentialsFile: join(root, 'unused'),
        allowFrom: [],
        requireMention: false,
        ackReaction: 'off',
        outbound: { costLine: false },
        directory: { sync: false },
        healthz: { enabled: false, port: 0 },
      })
      await client.initialize()
      expect((await client.session.list({})).items).toEqual([])
      await client.config.save({
        providerId: 'deepseek',
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: 'deepseek-v4-flash',
        expectedRevision: 0,
      })
      const session = await client.session.new({ cwd: root })
      await session.attach()
      expect((await session.prompt('重启前的渠道消息')).reason).toBe('completed')
      const lease = () => {
        const db = new DatabaseSync(join(scope.dataDir, 'sessions.db'), { readOnly: true })
        try {
          return db
            .prepare('SELECT run_id, until, ttl_ms FROM writer_claims WHERE session_key = ?')
            .get(session.id)
        } finally {
          db.close()
        }
      }
      const initialLease = lease()
      expect(initialLease?.ttl_ms).toBe(30000)
      if (typeof initialLease?.until !== 'number') throw new Error('missing test writer lease deadline')
      const reconnected = vi.fn()
      const recoveryErrors: string[] = []
      const recover = session.recover.bind(session)
      vi.spyOn(session, 'recover').mockImplementation(async () => {
        try {
          await recover()
        } catch (error) {
          recoveryErrors.push(JSON.stringify(error, Object.getOwnPropertyNames(error)))
          throw error
        }
      })
      client.on('reconnected', reconnected)
      await stop(first.child)
      const second = await start()
      expect(second.descriptor.owner.generation).not.toBe(first.descriptor.owner.generation)
      expect(second.descriptor.owner.processStartId).not.toBe(first.descriptor.owner.processStartId)
      expect(second.descriptor.socketPath).toBe(first.descriptor.socketPath)
      await vi
        .waitFor(
          () =>
            expect(
              reconnected,
              JSON.stringify({ recoveryErrors, stderr: second.diagnostic() }),
            ).toHaveBeenCalledOnce(),
          // A killed writer can leave its durable lease until expiry. Include the SDK's
          // maximum retry delay (5s + 20% jitter) and handshake time, without changing product TTLs.
          { timeout: Math.max(15000, initialLease.until - Date.now() + 10000) },
        )
        .catch((error) => {
          console.info('test lease snapshots', { initialLease, after: lease(), now: Date.now() })
          throw error
        })
      expect((await client.session.list({})).items.some((item) => item.sessionId === session.id)).toBe(true)
      expect((await session.prompt('重启后的渠道消息')).reason).toBe('completed')
      expect(lease()?.run_id).not.toBe(initialLease.run_id)
      const lastRequest = JSON.stringify(provider.requests.at(-1)?.messages)
      expect(lastRequest).toContain('重启前的渠道消息')
      expect(lastRequest).toContain('重启后的渠道消息')
    } finally {
      await client?.close()
      await Promise.all(children.map(stop))
      await provider.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  60000,
)
