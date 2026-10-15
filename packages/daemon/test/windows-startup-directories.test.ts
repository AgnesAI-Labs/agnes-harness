import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getApiKeyProvider } from '@agnes/ai'
import { createConfigurationService, createCredentialStore, initializeHomeLocked } from '@agnes/host'
import { hasPrivateDaclSync } from '@agnes/system-node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('prepares older private directories before scope resolution reads saved credentials', async () => {
    const home = join(parent, 'home')
    await initializeHomeLocked(home)
    const provider = getApiKeyProvider('openai')
    if (!provider) throw new Error('missing provider fixture')
    const model = (await provider.createAdapter()).models(provider.route)[0]?.id
    if (!model) throw new Error('missing model fixture')
    const configuration = createConfigurationService({
      home,
      profile: 'local-dev',
      request: async () =>
        new Response(JSON.stringify({ data: [{ id: model }] }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    })
    await configuration.save({ providerId: 'openai', apiKey: 'synthetic-key', model, expectedRevision: 0 })
    const ref = (await configuration.profileInput()).provider?.routes?.[0]?.credentialRef
    if (!ref) throw new Error('missing credential fixture')
    const secretDirectory = join(home, 'secrets')
    execFileSync(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
      [secretDirectory, '/inheritance:e'],
      { windowsHide: true },
    )
    expect(hasPrivateDaclSync(secretDirectory)).toBe(false)
    const boundary = new Error('legacy credentials resolved')
    await expect(
      runAgnesd(
        { home, workspace: parent },
        {
          startProduction: async () => {
            expect(hasPrivateDaclSync(secretDirectory)).toBe(true)
            expect(await createCredentialStore({ root: home }).read(ref)).toMatchObject({
              value: 'synthetic-key',
            })
            throw boundary
          },
        },
      ),
    ).rejects.toBe(boundary)
  })

  it.each(['home', 'dataDir'])(
    'refuses a broad %s before loading credentials or creating business state',
    async (target) => {
      const home = join(parent, 'home')
      const dataDir = join(parent, 'data')
      const unsafe = target === 'home' ? home : dataDir
      mkdirSync(unsafe)
      const systemRoot = process.env.SystemRoot
      if (!systemRoot) throw new Error('SystemRoot missing')
      const icacls = join(systemRoot, 'System32', 'icacls.exe')
      execFileSync(icacls, [unsafe, '/grant', '*S-1-1-0:R'], { windowsHide: true })
      const before = execFileSync(icacls, [unsafe], { windowsHide: true })
      const resolveProfile = vi.fn(() => {
        throw new Error('unexpected profile loading')
      })
      let reached = false
      await expect(
        runAgnesd(
          { home, dataDir, workspace: parent, profile: 'local-dev' },
          {
            resolveProfile,
            startProduction: async () => {
              reached = true
              throw new Error('unexpected supervisor startup')
            },
          },
        ),
      ).rejects.toThrow()
      expect(reached).toBe(false)
      expect(resolveProfile).not.toHaveBeenCalled()
      expect(readdirSync(unsafe)).toEqual([])
      expect(execFileSync(icacls, [unsafe], { windowsHide: true })).toEqual(before)
    },
  )

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
