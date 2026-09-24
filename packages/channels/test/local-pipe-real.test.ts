import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishDaemonDiscovery, resolveDaemonScope } from '@agnes/daemon'
import { listenWindowsPipe } from '@agnes/system-node/windows-pipe'
import { expect, it, vi } from 'vitest'
import { acquireOwnerLock } from '../../daemon/src/supervisor/owner-lock.js'
import { defaultProcessIdentity } from '../../host/src/adapters/process-identity-default.js'
import { channelPipeTransport } from '../src/runner/client.js'

const windows = process.platform === 'win32' // guards-allow-platform: real Windows channel pipe verification.

it.runIf(windows).each(['owner', 'other-process'] as const)(
  'verifies a real %s pipe against private discovery before sending channel data',
  async (peer) => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-channel-中文 '))
    const path = `\\\\.\\pipe\\agnes-channel-${randomUUID()}`
    const scope = await resolveDaemonScope({
      home: root,
      dataDir: root,
      workspace: root,
      profile: 'local-dev',
    })
    const lock = await acquireOwnerLock(root, { socketPath: path, processIdentity: defaultProcessIdentity })
    let listener: Awaited<ReturnType<typeof listenWindowsPipe>> | undefined
    let child: ReturnType<typeof spawn> | undefined
    let transport: Awaited<ReturnType<ReturnType<typeof channelPipeTransport>>> | undefined
    try {
      if (peer === 'owner') {
        listener = await listenWindowsPipe(path, 2, (stream) => {
          stream.on('error', () => {})
          stream.on('data', (bytes: Buffer) => stream.write(bytes))
        })
      } else {
        child = spawn(
          process.execPath,
          [
            '-e',
            "require('node:net').createServer(s=>s.on('error',()=>{})).listen(process.argv[1],()=>process.stdout.write('ready'));setTimeout(()=>process.exit(),8000)",
            path,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
        )
        if (!child.stdout) throw new Error('missing child output pipe')
        expect(String((await once(child.stdout, 'data', { signal: AbortSignal.timeout(2000) }))[0])).toBe(
          'ready',
        )
      }
      await publishDaemonDiscovery(scope, {
        owner: lock.owner,
        socketPath: path,
        profileHash: 'channel-test',
      })
      const factory = channelPipeTransport({
        connect: { kind: 'unix', path },
        workspace: root,
        localDaemon: { home: root, dataDir: root, profile: 'local-dev' },
      })
      const onMessage = vi.fn()
      const connecting = factory({ onMessage, onClose: vi.fn() })
      if (peer === 'other-process') {
        await expect(connecting).rejects.toMatchObject({
          name: 'TransportClosed',
          info: { reason: 'error' },
        })
        expect(onMessage).not.toHaveBeenCalled()
      } else {
        transport = await connecting
        const frame = { jsonrpc: '2.0' as const, id: 1, result: { text: '渠道中文' } }
        await transport.send(frame)
        await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith(frame))
      }
    } finally {
      await transport?.close()
      await listener?.close()
      if (child && child.exitCode === null) {
        const exited = once(child, 'exit')
        child.kill()
        await exited
      }
      await lock.release()
      await rm(root, { recursive: true, force: true })
    }
  },
  10000,
)
