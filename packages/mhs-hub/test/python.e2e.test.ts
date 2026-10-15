import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { connectDevice, Device } from '@agnes/mhs-device'
import { expect, it, vi } from 'vitest'
import { Hub, South } from '../src/index.js'
import { authority, invocation, MemoryStore } from './fixtures.js'

// Starts a real Python process. Central heavy validation supplies Python + websockets.
it('connects Python to real South, transfers MOS and clips, reconnects without replay and stops on replacement', async () => {
  const hub = new Hub({
    store: new MemoryStore(),
    authority,
    wakes: {
      async enqueue() {
        return { wakeId: 'w', state: 'queued' }
      },
    },
  })
  let south = new South(hub)
  const address = await south.listen(0),
    url = `ws://${address.host}:${address.port}`
  const child = spawn(
    process.env.AGH_TEST_PYTHON ?? 'python3',
    [fileURLToPath(new URL('../../mhs-device/python/tests/south_client.py', import.meta.url)), url],
    {
      env: {
        PATH: process.env.PATH,
        PYTHONPATH: fileURLToPath(new URL('../../mhs-device/python/src', import.meta.url)),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let stderr = ''
  child.stderr.on('data', (data) => {
    stderr = (stderr + String(data)).slice(-4000)
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve)
    child.once('error', reject)
  })
  const replacementAbort = new AbortController()
  let replacing: Promise<void> | undefined
  try {
    await vi.waitFor(() => expect(hub.snapshot()[0]?.available, stderr).toBe(true), { timeout: 5000 })
    const sample = await hub.read('python-sensor', ['camera'])
    expect(sample.items[0]?.bytes).toEqual(new Uint8Array([1, 2]))
    const pcm = new Uint8Array([1, 0, 2, 0])
    await hub.clipLease(
      'python-sensor',
      {
        id: 'speech',
        rate: 24000,
        channels: 1,
        bytes: pcm.length,
        sha256: createHash('sha256').update(pcm).digest('hex'),
      },
      invocation('clip'),
    )
    await hub.sendClip('python-sensor', 'clip', pcm)
    await hub.call('python-sensor', 'echo', { clip: 'speech' }, invocation('echo'))
    await vi.waitFor(async () =>
      expect((await hub.journal.read('echo'))?.outcome).toMatchObject({
        status: 'done',
        data: { pcm: [1, 0, 2, 0] },
      }),
    )
    await hub.call('python-sensor', 'hang', {}, invocation('timeout'))
    await vi.waitFor(async () =>
      expect((await hub.journal.read('timeout'))?.outcome).toMatchObject({
        status: 'error',
        reason: 'timeout',
      }),
    )
    expect((await hub.stop()).state).toBe('settled')
    await south.close()
    south = new South(hub)
    await south.listen(address.port)
    await vi.waitFor(() => expect(hub.snapshot()[0]?.available, stderr).toBe(true), { timeout: 7000 })
    expect((await hub.journal.read('echo'))?.outcome?.status).toBe('done')
    replacing = connectDevice(
      new Device({ protocol: 'mhs/v1', device: { id: 'python-sensor', kind: 'sensor' } }),
      url,
      replacementAbort.signal,
    )
    expect(await exited).not.toBeNull()
  } finally {
    replacementAbort.abort()
    await replacing
    child.kill()
    await exited.catch(() => undefined)
    await hub.shutdown()
    await south.close()
  }
}, 20_000)
