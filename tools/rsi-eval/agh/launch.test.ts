import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  loadMemoryModule,
  prepareHome,
  prepareMemory,
  seedUserMemory,
  seedWorkspaceMemory,
} from './launch.js'
import { aghProfile, EVAL_MEMORY, PROFILE, REVIEW_KEY_ENV, REVIEW_MODEL_ENV } from './run-agh.js'

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
const host = () => import('@agnes/host')
const reviewKey = 'synthetic-eval-review-key'
const reviewModel = 'company/review-model'

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
    env: on ? { [REVIEW_KEY_ENV]: reviewKey, [REVIEW_MODEL_ENV]: reviewModel } : {},
  })

  it('saves the switch in the run home for an on run only, and writes the route to the profile file', async () => {
    const h = await host()
    const on = input('on', true)
    const off = input('off', false)
    const preparedOn = await prepareHome(on, h)
    const preparedOff = await prepareHome(off, h)
    expect(preparedOn.data).toBe(h.dataDir(on.home))
    const store = new h.RefinementSettingsStore(preparedOn.data, PROFILE, on.home)
    const { settings } = store.read()
    if (!settings.enabled) throw new Error('Expected the run to enable refinement')
    expect(settings).toEqual({
      enabled: true,
      mode: 'auto',
      model: reviewModel,
      baseUrl: 'https://api.llm.sg/v1',
      credentialRef: expect.stringMatching(/^secret:\/\/generic\//),
    })
    expect(store.serviceKey(settings.credentialRef)).toBe(reviewKey)
    expect(new h.RefinementSettingsStore(preparedOff.data, PROFILE).read().settings.enabled).toBe(false)
    expect(await h.createCredentialStore({ root: off.home }).listGeneric()).toEqual([])
    // Nothing reached the user's home.
    expect(
      new h.RefinementSettingsStore(h.dataDir(process.env.AGH_HOME as string), PROFILE).read().settings
        .enabled,
    ).toBe(false)
    const profile = readFileSync(join(on.home, 'profiles', PROFILE, 'profile.yaml'), 'utf8')
    expect(JSON.parse(profile)).toEqual(aghProfile(cfg, 'on.r1'))
    expect(profile).not.toContain(reviewKey)
    await preparedOn.close()
    expect(store.serviceKey(settings.credentialRef)).toBeUndefined()
    expect(store.read().settings.enabled).toBe(false)
  })

  it.each([REVIEW_KEY_ENV, REVIEW_MODEL_ENV])('requires %s for the on arm', async (name) => {
    const run = input('missing', true)
    await expect(
      prepareHome({ ...run, env: { ...run.env, [name]: undefined } }, await host()),
    ).rejects.toThrow(name)
  })

  it('removes the staged key when the review settings are invalid', async () => {
    const h = await host()
    const run = input('invalid-review', true)
    await expect(
      prepareHome({ ...run, env: { ...run.env, [REVIEW_MODEL_ENV]: 'two model ids' } }, h),
    ).rejects.toThrow('CONFIG_INVALID_INPUT')
    expect(await h.createCredentialStore({ root: run.home }).listGeneric()).toEqual([])
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
      const prepared = await prepareHome(run, await host())
      // Before: the defaults, memory off and no user memory.
      expect((await settingsOf(run.home)).map((s) => [s.mode, s.userEnabled])).toEqual([
        ['off', false],
        ['off', false],
      ])
      await prepareMemory({ home: run.home, workspaces, memory: EVAL_MEMORY }, memory)
      for (const settings of await settingsOf(run.home)) expect(settings).toMatchObject(EVAL_MEMORY)
      await prepared.close()
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

  it('seeds a paragraph into the workspace memory the way a person edits it, and the agent sees it', async () => {
    const memory = await loadMemoryModule()
    const run = input('seed', false)
    const workspace = join(dir, 'ws-seed')
    mkdirSync(workspace)
    const other = join(dir, 'ws-other')
    mkdirSync(other)
    await prepareHome(run, await host())
    await prepareMemory({ home: run.home, workspaces: [workspace, other], memory: EVAL_MEMORY }, memory)
    const open = (root: string) =>
      memory.openMemory({ home: run.home, workspaceRoot: root, sessionKey: 'read' })

    const note = 'studio/build.sh uses ../parts, so it must be run with studio/ as the working directory.'
    await seedWorkspaceMemory({ home: run.home, workspace, text: note }, memory)
    expect((await open(workspace).readFile('MEMORY.md')).content).toContain(note)
    // What the agent is shown at the start of a turn.
    expect((await open(workspace).snapshot(1))?.content).toContain(note)
    // Only that workspace.
    expect((await open(other).snapshot(1))?.content ?? '').not.toContain(note)

    // Memory the workspace already holds is kept, and the paragraph is added after it.
    const second = 'A second paragraph.'
    await seedWorkspaceMemory({ home: run.home, workspace, text: second }, memory)
    const content = (await open(workspace).readFile('MEMORY.md')).content
    expect(content.indexOf(note)).toBeGreaterThanOrEqual(0)
    expect(content.indexOf(second)).toBeGreaterThan(content.indexOf(note))
  })

  it('seeds a paragraph into the user memory, which every workspace of the run then shows the agent', async () => {
    const memory = await loadMemoryModule()
    const run = input('user', false)
    const workspaces = [join(dir, 'ws-1'), join(dir, 'ws-2')]
    for (const ws of workspaces) mkdirSync(ws)
    await prepareHome(run, await host())
    await prepareMemory({ home: run.home, workspaces, memory: EVAL_MEMORY }, memory)
    const text = 'The shared bin/acme tool needs ACME_PROFILE=dev in every project.'
    seedUserMemory({ home: run.home, workspace: workspaces[0] as string, text }, memory)
    for (const workspaceRoot of workspaces) {
      const shown = await memory.openMemory({ home: run.home, workspaceRoot, sessionKey: 'read' }).snapshot(1)
      expect(shown?.content, workspaceRoot).toContain(text)
    }
    // A second paragraph is added after the first.
    seedUserMemory({ home: run.home, workspace: workspaces[1] as string, text: 'Second.' }, memory)
    const shown = await memory
      .openMemory({ home: run.home, workspaceRoot: workspaces[0] as string, sessionKey: 'read' })
      .snapshot(1)
    expect(shown?.content.indexOf('Second.')).toBeGreaterThan(shown?.content.indexOf(text) ?? -1)
  })
})
