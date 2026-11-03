import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type HostModule, loadMemoryModule, prepareHome, prepareMemory } from './launch.js'
import { aghProfile, EVAL_MEMORY, PROFILE } from './run-agh.js'

const cfg = {
  provider: 'eval',
  api: 'anthropic-messages',
  upstream: 'https://api.example.test',
  model: 'model-x',
  keyEnv: 'RSI_TEST_API_KEY',
  prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  proxyPort: 4555,
  sessionTimeoutMs: 20_000,
}

// The real host pieces: the home layout, its data dir and the store the settings panel saves through.
const host = async () => (await import('@agnes/host')) as unknown as HostModule

describe('prepareHome', () => {
  let dir: string
  let savedHome: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rsi-agh-home-'))
    savedHome = process.env.AGH_HOME
    // Point AGH_HOME somewhere else: the run's switch must never land there.
    process.env.AGH_HOME = join(dir, 'user-home')
    mkdirSync(process.env.AGH_HOME)
  })
  afterEach(() => {
    if (savedHome === undefined) delete process.env.AGH_HOME
    else process.env.AGH_HOME = savedHome
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const input = (name: string, on: boolean) => ({
    home: join(dir, name, 'home'),
    profile: PROFILE,
    profileDocument: aghProfile(cfg, `${name}.r1`),
    refinement: on ? ({ enabled: true, mode: 'auto' } as const) : undefined,
  })

  it('saves the switch in the run home for an on run only, and writes the route to the profile file', async () => {
    const h = await host()
    const onData = await prepareHome(input('on', true), h)
    const offData = await prepareHome(input('off', false), h)
    expect(onData).toBe(h.dataDir(join(dir, 'on', 'home')))
    expect(new h.RefinementSettingsStore(onData, PROFILE).read().settings).toEqual({
      enabled: true,
      mode: 'auto',
    })
    expect(new h.RefinementSettingsStore(offData, PROFILE).read().settings.enabled).toBe(false)
    // Nothing reached the user's home.
    expect(
      new h.RefinementSettingsStore(h.dataDir(process.env.AGH_HOME as string), PROFILE).read().settings
        .enabled,
    ).toBe(false)
    const profile = JSON.parse(
      readFileSync(join(dir, 'on', 'home', 'profiles', PROFILE, 'profile.yaml'), 'utf8'),
    )
    expect(profile).toEqual(aghProfile(cfg, 'on.r1'))
  })

  it('saves the same memory settings for every workspace, where the memory provider reads them', async () => {
    const memory = await loadMemoryModule()
    const workspaces = [join(dir, 'ws-a'), join(dir, 'ws-b')]
    for (const ws of workspaces) mkdirSync(ws)
    const settingsOf = async (home: string) =>
      Promise.all(
        workspaces.map(async (workspaceRoot) => {
          const session = memory.openMemory({ home, workspaceRoot, sessionKey: 'read' })
          return (await session.inspect()).settings
        }),
      )
    for (const name of ['on', 'off']) {
      const run = input(name, name === 'on')
      await prepareHome(run, await host())
      // Before: the defaults, memory off and no user memory.
      expect((await settingsOf(run.home)).map((s) => [s.mode, s.userEnabled])).toEqual([
        ['off', false],
        ['off', false],
      ])
      await prepareMemory({ home: run.home, workspaces, memory: EVAL_MEMORY }, memory)
      for (const settings of await settingsOf(run.home)) expect(settings).toMatchObject(EVAL_MEMORY)
    }
    // Nothing reached the user's home.
    const elsewhere = memory.openMemory({
      home: process.env.AGH_HOME as string,
      workspaceRoot: workspaces[0] as string,
      sessionKey: 'read',
    })
    expect((await elsewhere.inspect()).settings.mode).toBe('off')
  })

  it('refuses a home that already exists', async () => {
    mkdirSync(join(dir, 'used', 'home'), { recursive: true })
    await expect(prepareHome(input('used', true), await host())).rejects.toThrow(/already exists/)
  })
})
