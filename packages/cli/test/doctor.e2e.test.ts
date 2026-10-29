import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultProcessIdentity } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { type DoctorCommandDeps, doctorCommand } from '../src/commands/doctor.js'
import { TEST_LOCK } from './boot-host.js'

// Real native probes belong in the heavy tier and own their clean-checkout prerequisites.
// Build missing products rather than substituting a fabricated process identity or fake Host.
beforeAll(() => {
  const products = [
    ['system-node', 'agnes-system.node'],
    ...(process.platform === 'darwin' ? [['host-infrastructure', 'macos-process-identity']] : []),
  ]
  for (const [owner, product] of products) {
    if (existsSync(new URL(`../../${owner}/dist/native/${product}`, import.meta.url))) continue
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL(`../../${owner}/scripts/build-native.mjs`, import.meta.url))],
      { stdio: 'inherit', timeout: 120_000 },
    )
  }
}, 180_000)
const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function deps(): DoctorCommandDeps {
  const home = mkdtempSync(join(tmpdir(), 'agnes-doctor-real-'))
  cleanup.push(home)
  return {
    env: {},
    home,
    cwd: home,
    agnesVersion: '0',
    log: () => undefined,
    lock: TEST_LOCK,
    createHostImpl: async () => (await createTestHost({ dataDir: home })).host,
  }
}

describe('doctor real native probes', () => {
  it('uses one real Host for extensions and reports an absent daemon as a warning', async () => {
    const d = deps()
    let hostBuilds = 0
    d.createHostImpl = async () => {
      hostBuilds++
      return (await createTestHost({ dataDir: d.home })).host
    }

    const extensions = await doctorCommand(parseArgs(['doctor', 'extensions']), d)
    expect(extensions.json).toEqual([
      { name: 'extensions', status: 'ok', detail: ['no extensions declared'] },
    ])
    expect(hostBuilds).toBe(1)

    const daemon = await doctorCommand(parseArgs(['doctor', 'daemon']), d)
    expect(daemon).toEqual({
      text: '! daemon\n    not running',
      exitCode: 0,
      json: [{ name: 'daemon', status: 'warn', detail: ['not running'] }],
    })
    expect(hostBuilds).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('probes the real daemon owner and unix socket', async () => {
    const d = deps()
    const daemonDir = join(d.home, 'daemon')
    const socketPath = join(daemonDir, 'agnesd.sock')
    mkdirSync(daemonDir, { recursive: true })
    const identity = await defaultProcessIdentity(process.pid)
    if (identity.state !== 'alive') throw new Error('test process identity is unavailable')
    writeFileSync(
      join(daemonDir, 'owner.json'),
      JSON.stringify({
        pid: process.pid,
        processStartId: identity.startId,
        generation: randomUUID(),
        startedAt: new Date().toISOString(),
        socketPath,
      }),
    )
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    try {
      await expect(doctorCommand(parseArgs(['doctor', 'daemon']), d)).resolves.toEqual({
        text: '✓ daemon\n    lock: ok\n    socket: ok',
        exitCode: 0,
        json: [{ name: 'daemon', status: 'ok', detail: ['lock: ok', 'socket: ok'] }],
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
})
