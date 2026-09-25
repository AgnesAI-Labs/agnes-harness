import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvider, type WireEvent } from '@agnes/ai'
import { FakeAdapter, ScriptedProvider } from '@agnes/ai/testkit'
import { fakeSeams, testFsPolicy } from '@agnes/core/testkit'
import type { ModelRecord, RouteDecl } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryPackageLoader, type PackageModule } from '../src/assemble/packages.js'
import type { ProviderBuildOptions } from '../src/assemble/provider.js'
import type { AssembleDeps, Assembled } from '../src/assemble.js'
import { assemble } from '../src/assemble.js'
import { createMemoryAudit } from '../src/audit.js'
import type { PresetDoc } from '../src/presets/types.js'
import { resolveProfile } from '../src/profile/resolve.js'
import type { ResolvedProfile } from '../src/profile/types.js'
import { validateModelSwitch, validatePresetSwitch } from '../src/session-switch.js'
import { attachTestSeamPlugins } from '../testkit/cordis-seams.js'
import { createTestHost, type TestHost, type TestHostOptions } from '../testkit/index.js'

/**
 * Task 27a: the host-level gate daemon's setPreset/setModel handlers must go through before ever
 * calling core's session.setPreset/setModel, and the replay that rebuilds a cross-process resume's
 * last-known switch from the ledger's own audit trail.
 */

const modelRecord = (route: string, id: string): ModelRecord => ({
  id,
  name: id,
  api: 'openai-completions',
  route,
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})

const SEAM_KEYS = [
  'approval',
  'checkpoint',
  'ledger',
  'sandbox',
  'verifier',
  'repair',
  'artifacts',
  'principals',
  'harness',
] as const
const log = { debug() {}, info() {}, warn() {}, error() {} }

const dirs: string[] = []
const unwinds: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const u of unwinds.splice(0)) await u()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agnes-session-switch-'))
  dirs.push(d)
  return d
}

function mods(
  seams: ReturnType<typeof fakeSeams>,
  codePresets: Record<string, PresetDoc>,
): Record<string, PackageModule> {
  const modules: Record<string, PackageModule> = {
    '@agnes/base': {
      id: '@agnes/base',
      seams: Object.fromEntries(SEAM_KEYS.map((n) => [n, async () => seams[n]])),
      operations: {},
      presets: { base: { name: 'base' } },
    },
    '@agnes/code': {
      id: '@agnes/code',
      presets: codePresets,
      operations: {},
    },
    '@agnes/ai': { id: '@agnes/ai' },
  }
  attachTestSeamPlugins(modules['@agnes/base'] as PackageModule)
  return modules
}

async function profileWithRoutes(routes: RouteDecl[]): Promise<ResolvedProfile> {
  return resolveProfile(
    {
      builtin: 'local-dev',
      lock: {
        packages: Object.fromEntries(
          ['@agnes/ai', '@agnes/base', '@agnes/code'].map((id) => [
            id,
            { version: '0.1.0', integrity: 'sha512-x', trust: 'builtin' as const, enabled: true },
          ]),
        ),
      },
      user: {
        name: 'local-dev',
        provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes },
      },
    },
    {
      platform: { os: 'linux', arch: 'x64', capabilities: {} },
      agnesVersion: '0.1.0',
      now: '2026-09-09T00:00:00Z',
    },
  )
}

/**
 * A minimal real assembly: one route selected by the default preset and a second pre-registered
 * route.  The switch gate must allow the latter without requiring a second preset slot. Built as a
 * real `resolveProfile` + `assemble()`, the same technique
 * `seam-deny-paths.test.ts`'s `assembleWithDeny` uses for the same reason: a hand-rolled
 * `Assembled`/`ResolvedProfile` object drifts from what assembly actually produces in ways a test
 * written against the real pipeline cannot.
 */
async function buildFixture(): Promise<{ assembled: Assembled; profile: ResolvedProfile }> {
  const dataDir = scratch()
  // Named 'gw', not 'default': 'default' is the reserved unresolved-sentinel spelling
  // (profile/templates.ts's RESERVED_ROUTE_NAMES) and resolveProfile refuses a declared route using
  // it, so the plan text's literal `route: 'default'` in these cases is a real route name here
  // instead - deviation noted in the task report.
  const route: RouteDecl = {
    route: 'gw',
    api: 'openai-completions',
    baseUrl: 'https://example.invalid/v1',
    models: [modelRecord('gw', 'm')],
  }
  const seams = fakeSeams()
  seams.sandbox = { ...seams.sandbox, fsPolicy: () => testFsPolicy(realpathSync.native(dataDir)) }
  const alternate: RouteDecl = {
    route: 'alt',
    api: 'openai-completions',
    baseUrl: 'https://alt.example.invalid/v1',
    models: [modelRecord('alt', 'm2')],
  }
  const profile = await profileWithRoutes([route, alternate])
  const codePresets: Record<string, PresetDoc> = {
    standard: {
      name: 'standard',
      extends: 'base',
      disclosure: 'standard',
      model: { route: { primary: 'gw' } },
    },
  }
  const deps: AssembleDeps = {
    dataDir,
    profileDir: join(dataDir, 'profiles', 'local-dev'),
    workspaceRoot: dataDir,
    homeDir: dataDir,
    hostRoot: process.cwd(),
    loader: new MemoryPackageLoader(mods(seams, codePresets)),
    audit: createMemoryAudit(),
    log,
    agnesVersion: '0.1.0',
    env: { ...process.env },
  }
  const assembled = await assemble(profile, deps)
  unwinds.push(() => assembled.rollback.unwind())
  return { assembled, profile }
}

describe('validatePresetSwitch', () => {
  it('resolves a preset that is in presets.allowed and whose routing the host assembled', async () => {
    const { assembled, profile } = await buildFixture()
    const resolved = validatePresetSwitch(profile, assembled, 'standard')
    expect(resolved.view.name).toBe('standard')
  })
  it('refuses a preset presets.allowed never named', async () => {
    const { assembled, profile } = await buildFixture()
    expect(() => validatePresetSwitch(profile, assembled, 'nope')).toThrow(/E_PRESET_UNSUPPORTED/)
  })
})

describe('validateModelSwitch', () => {
  it('allows a route/model pair the deployment both declared and published', async () => {
    const { assembled, profile } = await buildFixture()
    expect(() =>
      validateModelSwitch(profile, assembled, { slot: 'primary', route: 'gw', model: 'm' }),
    ).not.toThrow()
  })
  it('refuses a model id the provider never published, even under a declared route', async () => {
    const { assembled, profile } = await buildFixture()
    expect(() =>
      validateModelSwitch(profile, assembled, { slot: 'primary', route: 'gw', model: 'ghost' }),
    ).toThrow(/E_MODEL_UNSUPPORTED/)
  })
  it('allows a declared and published provider route beyond the initial preset route table', async () => {
    const { assembled, profile } = await buildFixture()
    expect(assembled.routes?.primary).toEqual({ route: 'gw', model: 'm' })
    expect(() =>
      validateModelSwitch(profile, assembled, { slot: 'primary', route: 'alt', model: 'm2' }),
    ).not.toThrow()
  })
  // Account routes are named `account-acct-<uuid>`, a run looksLikeSecret reads as key material. A
  // refusal that quoted it came back as a code-less E_HOST_MESSAGE_LEAK and left the daemon only
  // INTERNAL to answer with, instead of the PRESET_SWITCH_REJECTED mapCore gives E_MODEL_UNSUPPORTED.
  it('refuses an account route by code, without quoting the route in its message', async () => {
    const { assembled, profile } = await buildFixture()
    const route = 'account-acct-177e2121-8e3c-4f09-a869-6cfa6ab07602'
    let thrown: unknown
    try {
      validateModelSwitch(profile, assembled, { slot: 'primary', route, model: 'no-such-model' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: 'E_MODEL_UNSUPPORTED', detail: { route, model: 'no-such-model' } })
    expect((thrown as Error).message).not.toContain(route)
  })
  it('refuses a route the provider happens to expose but the profile never declared', async () => {
    const { assembled, profile } = await buildFixture()
    // The provider object carries an extra route (e.g. a test/fallback one) that never made it into
    // the deployment's own RouteTable - minimal-rl means setModel cannot reach it.
    const extra = modelRecord('undeclared', 'sneaky')
    const models = assembled.provider.models()
    Object.assign(assembled.provider, { models: () => [...models, extra] })
    expect(() =>
      validateModelSwitch(profile, assembled, { slot: 'primary', route: 'undeclared', model: 'sneaky' }),
    ).toThrow(/E_MODEL_UNSUPPORTED/)
  })

  it('allows a thinking level the model declares in its thinkingLevelMap', async () => {
    const { assembled, profile } = await buildFixture()
    Object.assign(assembled.provider, {
      models: () => [{ ...modelRecord('gw', 'm'), reasoning: true, thinkingLevelMap: { high: 'high' } }],
    })
    expect(() =>
      validateModelSwitch(profile, assembled, { slot: 'primary', route: 'gw', model: 'm', thinking: 'high' }),
    ).not.toThrow()
  })

  it('refuses a thinking level a non-reasoning model does not support', async () => {
    const { assembled, profile } = await buildFixture()
    // buildFixture's default modelRecord('gw', 'm') has reasoning: false, unmodified here.
    expect(() =>
      validateModelSwitch(profile, assembled, { slot: 'primary', route: 'gw', model: 'm', thinking: 'high' }),
    ).toThrow(/E_MODEL_UNSUPPORTED/)
  })
})

// Two routes wired to two slots (primary/escalation) of the same preset, so the assembled RouteTable
// actually materializes both - the only way `setModel` is allowed to reach the second one at all.
// Named 'gw'/'alt', not 'default'/'alt': 'default' is the reserved sentinel spelling and
// resolveProfile refuses a declared route using it.
const TWO_ROUTES: RouteDecl[] = [
  {
    route: 'gw',
    api: 'openai-completions',
    baseUrl: 'https://example.invalid/v1',
    models: [modelRecord('gw', 'm1')],
  },
  {
    route: 'alt',
    api: 'openai-completions',
    baseUrl: 'https://example.invalid/v1',
    models: [modelRecord('alt', 'm2')],
  },
]
const TWO_SLOT_PRESET: PresetDoc = {
  name: 'standard',
  extends: 'base',
  disclosure: 'standard',
  model: { route: { primary: 'gw', escalation: 'alt' } },
}

function twoRouteHostOptions(
  dataDir: string,
  provider: NonNullable<TestHostOptions['provider']>,
): TestHostOptions {
  return {
    dataDir,
    presets: { standard: TWO_SLOT_PRESET },
    profileInputs: {
      user: {
        name: 'local-dev',
        provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: TWO_ROUTES },
      },
    },
    provider,
  }
}

describe('replaySwitchesOnOpen', () => {
  // Two Hosts and a reopen, and the file's first session open: 2 to 6 s on the Windows runner.
  it('reopening a session with a recorded model switch lands on the switched model, not the preset default', async () => {
    const dataDir = scratch()
    const provider = () =>
      new ScriptedProvider({ models: [modelRecord('gw', 'm1'), modelRecord('alt', 'm2')], scripts: [] })
    const first = await createTestHost(twoRouteHostOptions(dataDir, provider()))
    const s1 = await first.host.createSession({ cwd: dataDir })
    await s1.setModel({ slot: 'primary', route: 'alt', model: 'm2' })
    const key = s1.key
    // Forces a fresh open against the same backing storage - `dataDir` - rather than the cached
    // in-process session, the same two-process technique replay.test.ts's `reopen` fixtures use:
    // close the first host, then `createTestHost` again with the identical `dataDir`.
    await first.host.close()
    const second = await createTestHost(twoRouteHostOptions(dataDir, provider()))
    const reopened = await second.host.createSession({ cwd: dataDir, key })
    try {
      expect(reopened.preset.model.route.primary).toBe('alt')
      expect(reopened.preset.model.id.primary).toBe('m2')
    } finally {
      await second.host.close()
    }
  }, 30_000)

  it('preserves an unavailable recorded model on reopen so the user can choose a replacement', async () => {
    const dataDir = scratch()
    const wide = () =>
      new ScriptedProvider({ models: [modelRecord('gw', 'm1'), modelRecord('alt', 'm2')], scripts: [] })
    const first = await createTestHost(twoRouteHostOptions(dataDir, wide()))
    const s1 = await first.host.createSession({ cwd: dataDir })
    await s1.setModel({ slot: 'primary', route: 'alt', model: 'm2' })
    const key = s1.key
    await first.host.close()
    // Same ledger, same declared routes - but this open's provider fixture no longer publishes the
    // recorded model (simulating a package/provider change between restarts): `declared` still
    // holds (the profile still names route 'alt'), `published` does not.
    const narrow = () => new ScriptedProvider({ models: [modelRecord('gw', 'm1')], scripts: [] })
    const second = await createTestHost(twoRouteHostOptions(dataDir, narrow()))
    try {
      const reopened = await second.host.createSession({ cwd: dataDir, key })
      expect(reopened.preset.model.id.primary).toBe('m2')
      await expect(reopened.setModel({ slot: 'primary', route: 'alt', model: 'm2' })).rejects.toThrow()
      await reopened.setModel({ slot: 'primary', route: 'gw', model: 'm1' })
      expect(reopened.preset.model.id.primary).toBe('m1')
    } finally {
      await second.host.close()
    }
  })

  it('reopening a session after a later switch omits thinking still carries forward the earlier level', async () => {
    const dataDir = scratch()
    const provider = () =>
      new ScriptedProvider({
        models: [
          modelRecord('gw', 'm1'),
          { ...modelRecord('alt', 'm2'), reasoning: true, thinkingLevelMap: { high: 'high' } },
        ],
        scripts: [],
      })
    const first = await createTestHost(twoRouteHostOptions(dataDir, provider()))
    const s1 = await first.host.createSession({ cwd: dataDir })
    await s1.setModel({ slot: 'primary', route: 'alt', model: 'm2', thinking: 'high' })
    // A second switch on the same slot, re-issuing the same route/model but omitting `thinking` -
    // the effective thinking level is still 'high' in memory, and the ledger's `to` for this call
    // must record that too, or the replay below (which trusts the single latest row per slot as
    // complete state) would land the reopened session with thinking unset.
    await s1.setModel({ slot: 'primary', route: 'alt', model: 'm2' })
    const key = s1.key
    await first.host.close()
    const second = await createTestHost(twoRouteHostOptions(dataDir, provider()))
    const reopened = await second.host.createSession({ cwd: dataDir, key })
    try {
      expect(reopened.preset.model.route.primary).toBe('alt')
      expect(reopened.preset.model.id.primary).toBe('m2')
      expect(reopened.preset.model.thinking.primary).toBe('high')
    } finally {
      await second.host.close()
    }
  })

  it('a later switch to a non-reasoning model clears thinking, so reopening does not brick the session', async () => {
    // The exact 3-step sequence the finding describes: set thinking on a reasoning model, then
    // switch the same slot to a model that doesn't support thinking at all while omitting `thinking`
    // on that call, then close and reopen in a fresh process. Before the clamp, step 2's ledger `to`
    // would still carry the stale `thinking: 'high'` forward onto a non-reasoning model, and replay
    // on reopen would re-validate that snapshot against the catalogue and throw `E_MODEL_UNSUPPORTED`
    // from inside `createSession` itself — with no live session handle left to issue a corrective
    // `setModel` from. This test actually runs the sequence and asserts reopen succeeds.
    const dataDir = scratch()
    const provider = () =>
      new ScriptedProvider({
        models: [
          modelRecord('gw', 'm1'),
          { ...modelRecord('alt', 'm2'), reasoning: true, thinkingLevelMap: { high: 'high' } },
        ],
        scripts: [],
      })
    const first = await createTestHost(twoRouteHostOptions(dataDir, provider()))
    const s1 = await first.host.createSession({ cwd: dataDir })
    await s1.setModel({ slot: 'primary', route: 'alt', model: 'm2', thinking: 'high' })
    // Same slot, a non-reasoning model, `thinking` omitted entirely.
    await s1.setModel({ slot: 'primary', route: 'gw', model: 'm1' })
    const key = s1.key
    await first.host.close()
    const second = await createTestHost(twoRouteHostOptions(dataDir, provider()))
    // The whole point of this test: this must not throw E_MODEL_UNSUPPORTED.
    const reopened = await second.host.createSession({ cwd: dataDir, key })
    try {
      expect(reopened.preset.model.route.primary).toBe('gw')
      expect(reopened.preset.model.id.primary).toBe('m1')
      expect(reopened.preset.model.thinking.primary).toBeUndefined()
    } finally {
      await second.host.close()
    }
  })

  it('a later preset switch wins over an earlier model switch on reopen, without writing a new model-switch', async () => {
    const dataDir = scratch()
    const coding: PresetDoc = { ...TWO_SLOT_PRESET, name: 'coding' }
    const options = (provider: NonNullable<TestHostOptions['provider']>): TestHostOptions => ({
      ...twoRouteHostOptions(dataDir, provider),
      allowed: ['standard', 'coding'],
      presets: { standard: TWO_SLOT_PRESET, coding },
      profileInputs: {
        user: {
          name: 'local-dev',
          presets: { default: 'standard', allowed: ['standard', 'coding'] },
          provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: TWO_ROUTES },
        },
      },
    })
    const provider = () =>
      new ScriptedProvider({ models: [modelRecord('gw', 'm1'), modelRecord('alt', 'm2')], scripts: [] })
    const first = await createTestHost(options(provider()))
    const s1 = await first.host.createSession({ cwd: dataDir })
    await s1.setModel({ slot: 'primary', route: 'alt', model: 'm2' })
    const resolved = first.host.validatePresetSwitch('coding')
    await s1.setPreset({
      ...resolved.view,
      model: {
        ...resolved.view.model,
        route: { primary: 'gw', escalation: 'alt' },
        id: { primary: 'm1', escalation: 'm2' },
      },
    })
    expect(s1.preset.model.route.primary).toBe('gw')
    expect(s1.preset.model.id.primary).toBe('m1')
    const key = s1.key
    const before = (await s1.scan({ type: 'x/core/model-switch', limit: 20 })).length
    await first.host.close()
    const second = await createTestHost(options(provider()))
    const reopened = await second.host.createSession({ cwd: dataDir, key })
    try {
      expect(reopened.preset.name).toBe('coding')
      expect(reopened.preset.model.route.primary).toBe('gw')
      expect(reopened.preset.model.id.primary).toBe('m1')
      expect((await reopened.scan({ type: 'x/core/model-switch', limit: 20 })).length).toBe(before)
    } finally {
      await second.host.close()
    }
  })

  it('reopening still restores a quiet slot after 200 later switches on another slot', async () => {
    const dataDir = scratch()
    const provider = () =>
      new ScriptedProvider({ models: [modelRecord('gw', 'm1'), modelRecord('alt', 'm2')], scripts: [] })
    const first = await createTestHost(twoRouteHostOptions(dataDir, provider()))
    const s1 = await first.host.createSession({ cwd: dataDir })
    await s1.setModel({ slot: 'escalation', route: 'gw', model: 'm1' })
    for (let i = 0; i < 200; i++) {
      const useAlt = i % 2 === 0
      await s1.setModel({ slot: 'primary', route: useAlt ? 'alt' : 'gw', model: useAlt ? 'm2' : 'm1' })
    }
    expect(s1.preset.model.route.escalation).toBe('gw')
    expect(s1.preset.model.id.escalation).toBe('m1')
    const key = s1.key
    const before = (await s1.scan({ type: 'x/core/model-switch', limit: 500 })).length
    await first.host.close()
    const second = await createTestHost(twoRouteHostOptions(dataDir, provider()))
    const reopened = await second.host.createSession({ cwd: dataDir, key })
    try {
      expect(reopened.preset.model.route.escalation).toBe('gw')
      expect(reopened.preset.model.id.escalation).toBe('m1')
      expect((await reopened.scan({ type: 'x/core/model-switch', limit: 500 })).length).toBe(before)
    } finally {
      await second.host.close()
    }
  })
})

// R1's own acceptance line: "两个已装配 route 各对应独立脚本 wire adapter；A→B 后只有 B 收到下一请求，账本
// 模型/费用/count一致；另一会话仍用 A。" Neither Task32a's single-session fake-provider test nor the two
// cases above (resume-only) cover this on their own: it needs a real assembled host with two
// genuinely different scripted wire adapters behind two routes, two separate sessions, and a switch
// on only one of them.
const WIRE_USAGE: WireEvent = {
  type: 'usage',
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  creditSource: 'estimated',
}

/**
 * Two independently scripted `FakeAdapter`s, one per route, combined through the real `createProvider`
 * registry dispatch - the same technique replay.test.ts's `wireProvider()` uses for one adapter,
 * doubled so each route is answered by its own adapter rather than one adapter ignoring which route
 * was asked.
 */
function twoIndependentWireAdapters(cfg: {
  a: { route: string; model: string }
  b: { route: string; model: string }
}): (p: ResolvedProfile, built: ProviderBuildOptions) => ReturnType<typeof createProvider> {
  const adapterFor = (route: string, model: string, text: string): FakeAdapter =>
    new FakeAdapter({
      id: `wire-${route}`,
      routes: [
        {
          route,
          api: 'openai-completions',
          baseUrl: 'https://example.invalid/v1',
          models: [modelRecord(route, model)],
        },
      ],
      models: { [route]: [modelRecord(route, model)] },
      script: () => [{ type: 'text_delta', delta: text }, WIRE_USAGE, { type: 'done', reason: 'stop' }],
    })
  const adapterA = adapterFor(cfg.a.route, cfg.a.model, 'from-a')
  const adapterB = adapterFor(cfg.b.route, cfg.b.model, 'from-b')
  return (_p, built) =>
    createProvider({
      adapters: [adapterA, adapterB],
      routes: { primary: { route: cfg.a.route, model: cfg.a.model } },
      contract: built.contractStore,
      secrets: () => 'unused: neither route declares a credentialRef',
      clock: () => Date.now(),
      ...built,
    })
}

describe('setModel end to end through a real assembly', () => {
  it('keeps the parent current model when a child from an older cutoff is closed and reopened', async () => {
    const dataDir = scratch()
    const a = { route: 'route-a', model: 'model-a' }
    const b = { route: 'route-b', model: 'model-b' }
    const options = (): TestHostOptions => ({
      dataDir,
      presets: {
        standard: {
          name: 'standard',
          extends: 'base',
          disclosure: 'standard',
          model: { route: { primary: a.route } },
        },
      },
      profileInputs: {
        user: {
          name: 'local-dev',
          provider: {
            package: '@agnes/ai',
            adapters: ['@agnes/ai'],
            routes: [
              {
                route: a.route,
                api: 'openai-completions',
                baseUrl: 'https://example.invalid/v1',
                models: [modelRecord(a.route, a.model)],
              },
              {
                route: b.route,
                api: 'openai-completions',
                baseUrl: 'https://example.invalid/v1',
                models: [modelRecord(b.route, b.model)],
              },
            ],
          },
        },
      },
      provider: twoIndependentWireAdapters({ a, b }),
    })
    const first = await createTestHost(options())
    let firstOpen = true
    let second: TestHost | undefined
    try {
      const parent = await first.host.createSession({ cwd: dataDir, key: 'fork-model-parent' })
      await parent.enqueue('next-turn', {
        content: [{ type: 'text', text: 'establish the cutoff' }],
        actor: parent.d.actor,
        kind: 'prompt',
      })
      await parent.run({ until: 'turn-end', signal: new AbortController().signal })
      const [completed] = await parent.scan({ type: 'turn/end', order: 'desc', limit: 1 })
      if (!completed) throw new Error('missing completed turn')
      await parent.setModel({ slot: 'primary', route: b.route, model: b.model })

      const child = await first.host.createSession({
        cwd: dataDir,
        key: 'fork-model-child',
        parent: { key: parent.key, boundarySeq: completed.seq },
      })
      expect(child.preset.model.id.primary).toBe(b.model)
      const childKey = child.key
      await first.host.close()
      firstOpen = false

      second = await createTestHost(options())
      const reopened = await second.host.createSession({
        cwd: dataDir,
        key: childKey,
        preset: parent.preset.name,
      })
      expect(reopened.preset.model.id.primary).toBe(b.model)
      await reopened.enqueue('next-turn', {
        content: [{ type: 'text', text: 'continue on the branch' }],
        actor: reopened.d.actor,
        kind: 'prompt',
      })
      await reopened.run({ until: 'turn-end', signal: new AbortController().signal })
      const [childCost] = await reopened.scan({ type: 'cost/ledger', order: 'desc', limit: 1 })
      expect((childCost?.data as { model?: string } | undefined)?.model).toBe(b.model)
    } finally {
      if (firstOpen) await first.host.close()
      if (second) await second.host.close()
    }
  })

  it('switches one session to route B; only B gets the next request; the other session stays on A; cost/model on the ledger matches whichever adapter actually answered', async () => {
    const dataDir = scratch()
    const a = { route: 'route-a', model: 'model-a' }
    const b = { route: 'route-b', model: 'model-b' }
    const { host } = await createTestHost({
      dataDir,
      presets: {
        standard: {
          name: 'standard',
          extends: 'base',
          disclosure: 'standard',
          model: { route: { primary: a.route } },
        },
      },
      profileInputs: {
        user: {
          name: 'local-dev',
          provider: {
            package: '@agnes/ai',
            adapters: ['@agnes/ai'],
            routes: [
              {
                route: a.route,
                api: 'openai-completions',
                baseUrl: 'https://example.invalid/v1',
                models: [modelRecord(a.route, a.model)],
              },
            ],
          },
        },
      },
      provider: twoIndependentWireAdapters({ a, b }),
    })
    try {
      // Distinct `key`s: two createSession calls with the same actor/cwd/preset/writerRunId would
      // resolve to the same sessionKey and Kernel.session() would hand back one cached instance -
      // these must be two genuinely separate sessions.
      const sessionOnA = await host.createSession({ cwd: dataDir, key: 'session-a' })
      const sessionSwitching = await host.createSession({ cwd: dataDir, key: 'session-switching' })
      await sessionSwitching.setModel({ slot: 'primary', route: b.route, model: b.model })

      // Each session's own resolved opener actor (host minted it from the 'local' credential at
      // open time) - not a separately constructed one, since enqueue's actor has to be a principal
      // this session actually recognizes.
      await sessionSwitching.enqueue('next-turn', {
        content: [{ type: 'text', text: 'go' }],
        actor: sessionSwitching.d.actor,
        kind: 'prompt',
      })
      await sessionSwitching.run({ until: 'turn-end', signal: new AbortController().signal })
      const switchedCost = (await sessionSwitching.scan({ type: 'cost/ledger', limit: 5 }))[0]?.data as {
        model: string
      }
      expect(switchedCost.model).toBe(b.model)

      await sessionOnA.enqueue('next-turn', {
        content: [{ type: 'text', text: 'go' }],
        actor: sessionOnA.d.actor,
        kind: 'prompt',
      })
      await sessionOnA.run({ until: 'turn-end', signal: new AbortController().signal })
      const untouchedCost = (await sessionOnA.scan({ type: 'cost/ledger', limit: 5 }))[0]?.data as {
        model: string
      }
      expect(untouchedCost.model).toBe(a.model)
    } finally {
      await host.close()
    }
  })
})

describe('Host.validatePresetSwitch / Host.validateModelSwitch', () => {
  // Assembled never leaves session-switch.ts's module scope; daemon only ever has a `Host`, so these
  // two thin wrappers are the only way a caller outside host can reach the validators at all.
  it('delegates to the real validators, throwing the same way they do', async () => {
    const dataDir = scratch()
    const { host } = await createTestHost({ dataDir })
    try {
      const session = await host.createSession({ cwd: dataDir })
      const route = session.preset.model.route.primary as string
      const model = session.preset.model.id.primary as string
      expect(() => host.validateModelSwitch({ slot: 'primary', route, model })).not.toThrow()
      expect(() => host.validateModelSwitch({ slot: 'primary', route, model: 'ghost' })).toThrow(
        /E_MODEL_UNSUPPORTED/,
      )
      expect(host.validatePresetSwitch(session.preset.name).view.name).toBe(session.preset.name)
      expect(() => host.validatePresetSwitch('no-such-preset')).toThrow(/E_PRESET_UNSUPPORTED/)
    } finally {
      await host.close()
    }
  })
})
