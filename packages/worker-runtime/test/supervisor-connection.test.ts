import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { windowsProcessStartTimeSync } from '@agnes/system-node'
import { listenWindowsPipe } from '@agnes/system-node/windows-pipe'
import { describe, expect, it } from 'vitest'
import { connectSupervisor } from '../src/supervisor-connection.js'

const windows = process.platform === 'win32' // guards-allow-platform: real Windows supervisor pipe verification.

it.each([
  {},
  { AGNES_SUPERVISOR_PID: '1' },
  {
    AGNES_SUPERVISOR_PID: '1e2',
    AGNES_SUPERVISOR_START_ID: '123',
  },
  { AGNES_SUPERVISOR_PID: '4294967296', AGNES_SUPERVISOR_START_ID: '123' },
])('rejects incomplete or malformed identity before connecting: %j', async (env) => {
  await expect(connectSupervisor('\\\\.\\pipe\\no-connect', env)).rejects.toThrow('identity')
})

describe.skipIf(!windows)('native supervisor identity', () => {
  it.each(['correct', 'pid', 'start'] as const)('checks %s identity before sending hello', async (mode) => {
    const path = `\\\\.\\pipe\\worker-identity-${randomUUID()}`
    let received = ''
    const listener = await listenWindowsPipe(path, 4, (stream) => {
      stream.on('data', (bytes: Buffer) => {
        received += bytes.toString()
        stream.write(bytes)
      })
      stream.on('error', () => undefined)
    })
    try {
      const start = windowsProcessStartTimeSync(process.pid)
      if (!start) throw new Error('Current process identity unavailable')
      const connection = connectSupervisor(path, {
        AGNES_SUPERVISOR_PID: String(mode === 'pid' ? 0xffffffff : process.pid),
        AGNES_SUPERVISOR_START_ID: mode === 'start' ? '1' : start,
      })
      if (mode === 'correct') {
        const stream = await connection
        try {
          const echoed = once(stream, 'data')
          stream.write('hello-token\n')
          expect(String((await echoed)[0])).toBe('hello-token\n')
        } finally {
          const closed = once(stream, 'close')
          stream.destroy()
          await closed
        }
      } else await expect(connection).rejects.toThrow()
    } finally {
      await listener.close()
    }
    expect(received).toBe(mode === 'correct' ? 'hello-token\n' : '')
  })
})
