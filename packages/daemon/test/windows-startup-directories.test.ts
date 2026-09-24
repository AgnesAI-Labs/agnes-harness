import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCredentialStore } from '@agnes/host'
import { hasPrivateDaclSync } from '@agnes/system-node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAgnesd } from '../src/supervisor/supervisor.js'

describe.runIf(process.platform === 'win32')('Windows daemon startup directories', () => {
  let parent: string
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'agnes-win-boot-'))
  })
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true })
  })

  it('prepares private home and separate data directories before supervisor startup', async () => {
    const home = join(parent, 'new', 'home'),
      dataDir = join(parent, 'data')
    const boundary = new Error('verified startup boundary')
    let reached = false
    await expect(
      runAgnesd(
        { home, dataDir, workspace: parent, profile: 'local-dev' },
        {
          startProduction: async () => {
            reached = true
            for (const dir of [home, dataDir, join(home, 'profiles'), join(home, 'profiles', 'local-dev')])
              expect(hasPrivateDaclSync(dir)).toBe(true)
            const credentials = createCredentialStore({ root: home })
            await credentials.putApiKey('secret://openai/default', 'test-value')
            expect(await credentials.read('secret://openai/default')).toMatchObject({ value: 'test-value' })
            throw boundary
          },
        },
      ),
    ).rejects.toBe(boundary)
    expect(reached).toBe(true)
  })

  it('refuses a broad home before creating package or daemon state', async () => {
    const home = join(parent, 'home')
    mkdirSync(home)
    const systemRoot = process.env.SystemRoot
    if (!systemRoot) throw new Error('SystemRoot missing')
    const icacls = join(systemRoot, 'System32', 'icacls.exe')
    execFileSync(icacls, [home, '/grant', '*S-1-1-0:R'], { windowsHide: true })
    const before = execFileSync(icacls, [home], { windowsHide: true })
    let reached = false
    await expect(
      runAgnesd(
        { home, dataDir: home, workspace: parent, profile: 'local-dev' },
        {
          startProduction: async () => {
            reached = true
            throw new Error('unexpected supervisor startup')
          },
        },
      ),
    ).rejects.toThrow()
    expect(reached).toBe(false)
    expect(readdirSync(home)).toEqual([])
    expect(execFileSync(icacls, [home], { windowsHide: true })).toEqual(before)
  })

  it('removes the published generation and closes when a listener fails during publication', async () => {
    const failure = new Error('injected listener failure')
    let fail!: (error: Error) => void
    const failed = new Promise<Error>((resolve) => {
      fail = resolve
    })
    const events: string[] = []
    await expect(
      runAgnesd(
        {
          home: join(parent, 'home'),
          dataDir: join(parent, 'data'),
          workspace: parent,
          profile: 'local-dev',
        },
        {
          startProduction: async () =>
            ({
              socketPath: '\\\\.\\pipe\\startup-failure-test',
              owner: { pid: process.pid, generation: 7 },
              failed,
              close: async () => {
                events.push('close')
              },
            }) as never,
          publishDiscovery: async (scope, input) => {
            fail(failure)
            await new Promise<void>((resolve) => setImmediate(resolve))
            events.push('published')
            return {
              protocol: 'agnesd-discovery',
              version: 1,
              capabilities: [],
              ready: true,
              scopeID: scope.scopeID,
              profile: scope.profile,
              dataDir: scope.dataDir,
              profileHash: input.profileHash,
              socketPath: input.socketPath,
              owner: input.owner,
            }
          },
          removeDiscovery: async (_scope, generation) => {
            expect(generation).toBe(7)
            events.push('remove')
          },
        },
      ),
    ).rejects.toBe(failure)
    expect(events).toEqual(['published', 'remove', 'close'])
  })
})
