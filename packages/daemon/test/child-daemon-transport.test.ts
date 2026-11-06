import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultProcessIdentity } from '@agnes/host'
import { afterEach, expect, it } from 'vitest'
import { encodeOwner, type Owner } from '../src/supervisor/owner-record.js'
import { childDaemonTransport } from './child-daemon-transport.js'

const directories: string[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill('SIGKILL')
      })
    }),
  )
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function ownerFixture() {
  const home = await mkdtemp(join(tmpdir(), 'agh-child-identity-'))
  directories.push(home)
  await mkdir(join(home, 'daemon'))
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  if (!child.pid) throw new Error('test child PID unavailable')
  const identity = await defaultProcessIdentity(child.pid)
  if (identity.state !== 'alive') throw new Error('test child identity unavailable')
  const owner: Owner = {
    pid: child.pid,
    processStartId: identity.startId,
    generation: randomUUID(),
    startedAt: new Date().toISOString(),
    socketPath: '\\\\.\\pipe\\identity-discovery-test',
  }
  const publish = (value: Owner) => writeFile(join(home, 'daemon', 'owner.json'), encodeOwner(value))
  await publish(owner)
  return { home, owner, publish }
}

it('discovers the actual process identity and rejects a different expected child', async () => {
  const { home, owner } = await ownerFixture()
  const transport = await childDaemonTransport(home, owner.pid)
  expect(await transport.resolveServerIdentity?.()).toEqual({
    pid: owner.pid,
    processStartId: owner.processStartId,
  })
  expect(owner.pid).not.toBe(process.pid)
  await expect(childDaemonTransport(home, process.pid)).rejects.toThrow('child daemon owner changed')
})

it('rejects a stale process start identity', async () => {
  const { home, owner, publish } = await ownerFixture()
  await publish({ ...owner, processStartId: `${owner.processStartId}-stale` })
  await expect(childDaemonTransport(home, owner.pid)).rejects.toThrow('child daemon identity unavailable')
})

it('rejects generation and socket replacement on reconnect and rediscovers a fresh generation', async () => {
  const { home, owner, publish } = await ownerFixture()
  const transport = await childDaemonTransport(home, owner.pid)
  await publish({ ...owner, generation: randomUUID() })
  await expect(transport.resolveServerIdentity?.()).rejects.toThrow('child daemon owner changed')
  const restarted = await childDaemonTransport(home, owner.pid)
  expect(await restarted.resolveServerIdentity?.()).toEqual({
    pid: owner.pid,
    processStartId: owner.processStartId,
  })
  await publish({ ...owner, socketPath: `${owner.socketPath}-replacement` })
  await expect(restarted.resolveServerIdentity?.()).rejects.toThrow('child daemon owner changed')
})
