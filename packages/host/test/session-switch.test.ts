import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvider, type WireEvent } from '@agnes/ai'
import { FakeAdapter, ScriptedProvider } from '@agnes/ai/testkit'
import { canonicalJson, reserveSessionConfiguration, sha256Hex } from '@agnes/core'
import { fakeSeams, testFsPolicy } from '@agnes/core/testkit'
import type { ModelRecord, RouteDecl } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryPackageLoader, type PackageModule } from '../src/assemble/packages.js'
import type { ProviderBuildOptions } from '../src/assemble/provider.js'
import type { AssembleDeps, Assembled } from '../src/assemble.js'
import { assemble } from '../src/assemble.js'
import { createMemoryAudit } from '../src/audit.js'
import type { PresetDoc } from '../src/presets/types.js'
import { resolveProfile } from '../src/profile/resolve.js'
import type { ResolvedProfile } from '../src/profile/types.js'
import { comparisonPayloadDigest } from '../src/runtime/comparison-config-admission.js'
import { verifyPreparedReceipt } from '../src/runtime/comparison-prepared.js'
import { createComparisonStore } from '../src/runtime/comparison-store.js'
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
    for (const contextWindow of [100, 2047, 8193])
      expect(() =>
        validateModelSwitch(profile, assembled, { slot: 'primary', route: 'gw', model: 'm', contextWindow }),
      ).toThrow(/E_MODEL_UNSUPPORTED/)
    expect(() =>
      validateModelSwitch(profile, assembled, {
        slot: 'primary',
        route: 'gw',
        model: 'm',
        contextWindow: 4096,
      }),
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

describe('prepared configuration source receipt', () => {
  it('does not inherit a parent admission through immutable fork prefixes, including a second-generation fork', async () => {
    const dataDir = scratch()
    const provider = new ScriptedProvider({
      models: TWO_ROUTES.flatMap((route) => route.models ?? []),
      scripts: [],
    })
    const { host } = await createTestHost(twoRouteHostOptions(dataDir, provider))
    unwinds.push(() => host.close())
    const parent = await host.createSession({ key: 'admission-fork-parent', cwd: dataDir })
    const prepared = await host.prepareSessionConfiguration(parent.key)
    const receipt = await host.configurationAdmissions.acquire({
      sessionId: parent.key,
      inputId: 'parent-only',
      payloadDigest: comparisonPayloadDigest([]),
      prepared,
    })
    // Exercise the generic Core history-fork seam without scheduling a new Host publication.
    const child = await host.kernel.session('admission-fork-child', {
      writerRunId: 'fork-child-writer',
      actor: parent.d.actor,
      resolvedProfileHash: parent.d.resolvedProfileHash,
      cwd: dataDir,
      parent: { key: parent.key, boundarySeq: parent.lastSeq },
    })
    const grandchild = await host.kernel.session('admission-fork-grandchild', {
      writerRunId: 'fork-grandchild-writer',
      actor: child.d.actor,
      resolvedProfileHash: child.d.resolvedProfileHash,
      cwd: dataDir,
      parent: { key: child.key, boundarySeq: child.lastSeq },
    })
    expect(child.configurationReserved).toBe(false)
    expect(grandchild.configurationReserved).toBe(false)
    expect(parent.configurationReserved).toBe(true)
    await expect(host.configurationAdmissions.check(child.key, receipt.token)).rejects.toMatchObject({
      code: 'E_RELATION',
    })
    await host.configurationAdmissions.release(parent.key, receipt.token)
  })

  it('persists an exact input fence before a delayed acquisition, survives reopen, and does not inherit it through forks', async () => {
    const dataDir = scratch()
    const provider = new ScriptedProvider({
      models: TWO_ROUTES.flatMap((route) => route.models ?? []),
      scripts: [],
    })
    const options = twoRouteHostOptions(dataDir, provider)
    const first = await createTestHost(options)
    unwinds.push(() => first.host.close())
    const session = await first.host.createSession({ key: 'cancel-acquire-race', cwd: dataDir })
    const prepared = await first.host.prepareSessionConfiguration(session.key)
    let enter!: () => void
    let proceed!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const held = new Promise<void>((resolve) => {
      proceed = resolve
    })
    const scan = session.scan.bind(session)
    const spy = vi.spyOn(session, 'scan').mockImplementation(async (query) => {
      if (query?.fromSeq === prepared.sourceSeq && query?.toSeq === prepared.sourceSeq) {
        enter()
        await held
      }
      return scan(query)
    })
    const acquiring = first.host.configurationAdmissions.acquire({
      sessionId: session.key,
      inputId: 'cancelled-command',
      payloadDigest: comparisonPayloadDigest([]),
      prepared,
    })
    const failed = expect(acquiring).rejects.toMatchObject({ code: 'E_RELATION' })
    await entered
    try {
      expect(
        await first.host.configurationAdmissions.cancel(
          session.key,
          'cancelled-command',
          session.d.actor,
          true,
        ),
      ).toEqual({ inputId: 'cancelled-command' })
    } finally {
      proceed()
    }
    await failed
    spy.mockRestore()
    expect(session.configurationReserved).toBe(false)
    expect(await session.scan({ type: 'turn/start', limit: 10 })).toEqual([])
    await expect(
      session.enqueue('next-turn', {
        actor: session.d.actor,
        commandId: 'cancelled-command',
        content: [{ type: 'text', text: 'fork-local command' }],
      }),
    ).rejects.toMatchObject({ code: 'E_RELATION' })
    const child = await first.host.kernel.session('cancel-fork-child', {
      writerRunId: 'cancel-fork-writer',
      actor: session.d.actor,
      resolvedProfileHash: session.d.resolvedProfileHash,
      cwd: dataDir,
      parent: { key: session.key, boundarySeq: session.lastSeq },
    })
    await child.enqueue('next-turn', {
      actor: child.d.actor,
      commandId: 'cancelled-command',
      content: [{ type: 'text', text: 'fork-local command' }],
    })
    expect(child.latest('inbox')).toMatchObject({ items: [{ commandId: 'cancelled-command' }] })
    await first.host.close()
    const second = await createTestHost(options)
    unwinds.push(() => second.host.close())
    const cold = await second.host.createSession({ key: session.key, cwd: dataDir })
    const refreshed = await second.host.prepareSessionConfiguration(cold.key)
    await expect(
      second.host.configurationAdmissions.acquire({
        sessionId: cold.key,
        inputId: 'cancelled-command',
        payloadDigest: comparisonPayloadDigest([]),
        prepared: refreshed,
      }),
    ).rejects.toMatchObject({ code: 'E_RELATION' })
    const fresh = await second.host.configurationAdmissions.acquire({
      sessionId: cold.key,
      inputId: 'different-command',
      payloadDigest: comparisonPayloadDigest([]),
      prepared: refreshed,
    })
    await second.host.configurationAdmissions.release(cold.key, fresh.token)
    expect(await cold.scan({ type: 'x/core/input-cancelled', limit: 10 })).toMatchObject([
      {
        origin: 'system',
        trust: 'trusted',
        ignorable: true,
        data: { version: 1, sessionId: cold.key, commandId: 'cancelled-command' },
      },
    ])
  })

  it('cold-cancels an already claimed Native admission without dispatching inference or borrowing ordinary step', async () => {
    const dataDir = scratch()
    const provider = new ScriptedProvider({
      models: TWO_ROUTES.flatMap((route) => route.models ?? []),
      scripts: [],
    })
    const options = twoRouteHostOptions(dataDir, provider)
    const first = await createTestHost(options)
    const session = await first.host.createSession({ key: 'admission-claimed', cwd: dataDir })
    const prepared = await first.host.prepareSessionConfiguration(session.key)
    const content = [{ type: 'text' as const, text: 'Claim before interruption' }]
    const held = await reserveSessionConfiguration(
      session,
      { id: 'test-process-local', commandId: 'claimed', payloadDigest: comparisonPayloadDigest(content) },
      () => prepared.configuration,
      () => undefined,
    )
    await held.lease.enqueue({ commandId: 'claimed', content, actor: session.d.actor })
    await expect(session.acceptInput()).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
    await session.step(held.lease)
    await session.abort(session.d.actor)
    expect(await session.scan({ type: 'request/sent', limit: 10 })).toEqual([])
    await first.host.close()
    const second = await createTestHost(options)
    unwinds.push(() => second.host.close())
    const cold = await second.host.createSession({ key: session.key, cwd: dataDir })
    expect(cold.configurationReserved).toBe(true)
    expect(cold.op()).not.toBeNull()
    await second.host.configurationAdmissions.cancel(cold.key, 'claimed', cold.d.actor)
    expect(cold.configurationReserved).toBe(false)
    expect(cold.op()).toBeNull()
    expect(await cold.scan({ type: 'request/sent', limit: 10 })).toEqual([])
    expect((await cold.scan({ type: 'turn/end', limit: 10 })).at(-1)?.data).toMatchObject({
      reason: 'interrupted',
    })
  })

  it('fences execution before the admission append completes and refuses a queued preset writer without deadlock', async () => {
    const dataDir = scratch()
    const provider = new ScriptedProvider({
      models: TWO_ROUTES.flatMap((route) => route.models ?? []),
      scripts: [],
    })
    const { host } = await createTestHost(twoRouteHostOptions(dataDir, provider))
    unwinds.push(() => host.close())
    const left = await host.createSession({ key: 'admission-pending-left', cwd: dataDir })
    const right = await host.createSession({ key: 'admission-pending-right', cwd: dataDir })
    const a = await host.prepareSessionConfiguration(left.key)
    const b = await host.prepareSessionConfiguration(right.key)
    let allowAppend!: () => void
    let appendEntered!: () => void
    const hold = new Promise<void>((resolve) => {
      allowAppend = resolve
    })
    const entered = new Promise<void>((resolve) => {
      appendEntered = resolve
    })
    const append = left.d.log.append.bind(left.d.log)
    vi.spyOn(left.d.log, 'append').mockImplementationOnce(async (...args) => {
      appendEntered()
      await hold
      return append(...args)
    })
    const input = {
      inputId: 'pending',
      payloadDigest: comparisonPayloadDigest([]),
      permissionMode: 'full' as const,
    }
    const acquiring = host.configurationAdmissions.acquire({ ...input, sessionId: left.key, prepared: a })
    await entered
    expect(left.d.approvalMode).toBe('off')
    expect(left.yolo).toBe(false)
    await expect(left.run({ until: 'turn-end', signal: new AbortController().signal })).rejects.toMatchObject(
      { code: 'E_LANE_BUSY' },
    )
    expect(await left.scan({ type: 'turn/start', limit: 10 })).toEqual([])
    allowAppend()
    const receipt = await acquiring
    const presetWriter = right.setPreset(right.preset)
    await Promise.resolve()
    await expect(
      host.configurationAdmissions.acquire({ ...input, sessionId: right.key, prepared: b }),
    ).rejects.toMatchObject({
      code: 'E_LANE_BUSY',
      detail: { reason: 'runtime-publication-pending' },
    })
    await host.configurationAdmissions.release(left.key, receipt.token)
    await presetWriter
    expect(left.configurationReserved).toBe(false)
    expect(right.configurationReserved).toBe(false)
    expect(left.d.approvalMode ?? null).toBe(a.configuration.effective.permission.approvalMode)
  })

  it.each([
    ['native', undefined],
    ['jevloop', undefined],
    ['native', 'full'],
    ['jevloop', 'full'],
  ] as const)(
    'holds exact %s configuration (%s) across enqueue and cold recovery until explicit cancellation',
    async (runtime, permissionMode) => {
      const dataDir = scratch()
      const provider = new ScriptedProvider({
        models: TWO_ROUTES.flatMap((route) => route.models ?? []),
        scripts: [],
      })
      const options = {
        ...twoRouteHostOptions(dataDir, provider),
        jev: {
          decision: {
            backend: 'jev' as const,
            endpoint: 'https://jev.invalid/v1',
            model: 'jev-test',
            transport: {
              invoke: async (): Promise<never> => {
                throw new Error('Admission must not invoke a provider')
              },
            },
          },
        },
      }
      const first = await createTestHost(options)
      const session = await first.host.createSession({ key: `admission-${runtime}`, cwd: dataDir, runtime })
      const prepared = await first.host.prepareSessionConfiguration(session.key)
      const originalApprovalMode = session.d.approvalMode
      const content = [{ type: 'text' as const, text: 'Reserved input' }]
      const receipt = await first.host.configurationAdmissions.acquire({
        sessionId: session.key,
        inputId: 'reserved',
        payloadDigest: comparisonPayloadDigest(content),
        prepared,
        ...(permissionMode === undefined ? {} : { permissionMode }),
      })
      expect(session.configurationReserved).toBe(true)
      expect(session.d.approvalMode).toBe(permissionMode === 'full' ? 'off' : originalApprovalMode)
      expect(session.yolo).toBe(false)
      expect(verifyPreparedReceipt(receipt.prepared, await session.scan({ limit: 100 }))).toBe(true)
      expect(
        JSON.stringify(await session.scan({ type: 'x/core/configuration-admission', limit: 100 })),
      ).not.toContain(receipt.token)
      await expect(session.setModel({ slot: 'primary', route: 'alt', model: 'm2' })).rejects.toMatchObject({
        code: 'E_LANE_BUSY',
      })
      await expect(session.setYolo(true, session.d.actor)).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
      await expect(session.step()).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
      await expect(
        session.run({ until: 'turn-end', signal: new AbortController().signal }),
      ).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
      await expect(
        first.host.configurationAdmissions.enqueue(session.key, receipt.token, {
          actor: session.d.actor,
          commandId: 'wrong',
          content,
        }),
      ).rejects.toMatchObject({ code: 'E_RELATION' })
      await first.host.configurationAdmissions.enqueue(session.key, receipt.token, {
        actor: session.d.actor,
        commandId: 'reserved',
        content,
      })
      await expect(
        first.host.configurationAdmissions.release(session.key, receipt.token),
      ).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
      await first.host.close()
      const reopened = await createTestHost(options)
      unwinds.push(() => reopened.host.close())
      const cold = await reopened.host.createSession({ key: session.key, cwd: dataDir })
      expect(cold.d.approvalMode).toBe(originalApprovalMode)
      expect(cold.yolo).toBe(false)
      expect(await cold.scan({ type: 'x/core/configuration-admission', limit: 100 })).toMatchObject([
        { data: { status: 'held' } },
      ])
      expect(cold.configurationReserved).toBe(true)
      expect((await cold.resume()).phase).toBe('configuration-admission-held')
      expect(await cold.scan({ type: 'user/message', limit: 100 })).toEqual([])
      await expect(
        reopened.host.configurationAdmissions.check(cold.key, receipt.token),
      ).rejects.toMatchObject({ code: 'E_RELATION' })
      await expect(
        cold.run({ until: 'turn-end', signal: new AbortController().signal }),
      ).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
      expect(await reopened.host.configurationAdmissions.cancel(cold.key, undefined, cold.d.actor)).toEqual({
        inputId: 'reserved',
      })
      expect(cold.configurationReserved).toBe(false)
      expect(await reopened.host.prepareSessionConfiguration(cold.key)).toEqual(prepared)
      expect(cold.latest('inbox')).toMatchObject({ items: [] })
      expect(await cold.scan({ type: 'user/message', limit: 100 })).toEqual([])
      await cold.setModel({ slot: 'primary', route: 'alt', model: 'm2' })
    },
  )

  it.each(['capture', 'before-held', 'after-held'] as const)(
    'restores admission-scoped approval after %s failure while preserving any durable fence',
    async (failure) => {
      const dataDir = scratch()
      const provider = new ScriptedProvider({
        models: TWO_ROUTES.flatMap((route) => route.models ?? []),
        scripts: [],
      })
      const { host } = await createTestHost(twoRouteHostOptions(dataDir, provider))
      unwinds.push(() => host.close())
      const session = await host.createSession({ key: `approval-failure-${failure}`, cwd: dataDir })
      const prepared = await host.prepareSessionConfiguration(session.key)
      const originalApprovalMode = session.d.approvalMode
      const currentTools = session.currentTools.bind(session)
      const toolsSpy = vi.spyOn(session, 'currentTools').mockImplementation(() => {
        if (failure === 'capture' && session.d.approvalMode === 'off') throw new Error('capture failure')
        return currentTools()
      })
      const append = session.d.log.append.bind(session.d.log)
      const appendSpy = vi.spyOn(session.d.log, 'append').mockImplementation(async (...args) => {
        if (
          failure !== 'capture' &&
          args[0].some((event) => event.type === 'x/core/configuration-admission')
        ) {
          if (failure === 'after-held') await append(...args)
          throw new Error('held append failure')
        }
        return append(...args)
      })
      const input = {
        sessionId: session.key,
        inputId: 'failed',
        prepared,
        permissionMode: 'full' as const,
        payloadDigest: comparisonPayloadDigest([]),
      }
      await expect(host.configurationAdmissions.acquire(input)).rejects.toThrow()
      toolsSpy.mockRestore()
      appendSpy.mockRestore()
      expect(session.d.approvalMode).toBe(originalApprovalMode)
      expect(session.yolo).toBe(false)
      expect(session.configurationReserved).toBe(failure === 'after-held')
      expect(host.activationBarrier.snapshot().active).toEqual({ turn: 0, tool: 0, service: 0 })
      if (failure === 'after-held') {
        await expect(
          session.run({ until: 'turn-end', signal: new AbortController().signal }),
        ).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
        await host.configurationAdmissions.cancel(session.key, input.inputId, session.d.actor)
      }
      expect(session.configurationReserved).toBe(false)
      const next = await host.configurationAdmissions.acquire({ ...input, inputId: 'fresh' })
      expect(session.d.approvalMode).toBe('off')
      await host.configurationAdmissions.release(session.key, next.token)
      expect(session.d.approvalMode).toBe(originalApprovalMode)
      expect(session.configurationReserved).toBe(false)
      expect(await host.prepareSessionConfiguration(session.key)).toEqual(prepared)
      expect(await session.scan({ type: 'turn/start', limit: 10 })).toEqual([])
    },
  )

  it('freezes actual final model settings and refuses later drift rather than rewriting history', async () => {
    const dataDir = scratch()
    const provider = new ScriptedProvider({
      models: TWO_ROUTES.flatMap((route) => route.models ?? []),
      scripts: [],
    })
    const jev = {
      decision: {
        backend: 'jev' as const,
        endpoint: 'https://jev.invalid/v1',
        model: 'jev-test',
        transport: {
          invoke: async (): Promise<never> => {
            throw new Error('preparation must not invoke a provider')
          },
        },
      },
    }
    const { host } = await createTestHost({ ...twoRouteHostOptions(dataDir, provider), jev })
    unwinds.push(() => host.close())
    const session = await host.createSession({ key: 'prepared-model', cwd: dataDir })
    await session.setPreset({ ...session.preset, model: { ...session.preset.model, maxTokens: 512 } })
    await session.setModel({ slot: 'primary', route: 'alt', model: 'm2', contextWindow: 4096 })
    const prepared = await host.prepareSessionConfiguration(session.key)
    expect(prepared.configuration.effective.mounted).toMatchObject({
      scope: 'active-host-rows-and-selected-preset',
      digest: prepared.configuration.fingerprints.mounted,
    })
    expect(prepared.configuration.fingerprints.mounted).toMatch(/^[a-f0-9]{64}$/)
    const peerRoot = scratch()
    const peer = await createTestHost({ ...twoRouteHostOptions(peerRoot, provider), jev })
    unwinds.push(() => peer.host.close())
    const jevSession = await peer.host.createSession({
      key: 'prepared-jev-peer',
      cwd: peerRoot,
      runtime: 'jevloop',
    })
    await jevSession.setPreset({
      ...jevSession.preset,
      model: { ...jevSession.preset.model, maxTokens: 512 },
    })
    await jevSession.setModel({ slot: 'primary', route: 'alt', model: 'm2', contextWindow: 4096 })
    const peerPrepared = await peer.host.prepareSessionConfiguration(jevSession.key)
    expect(peerPrepared.configuration.runtime.id).toBe('jevloop')
    expect(peerPrepared.configuration.effective.mounted).toEqual(prepared.configuration.effective.mounted)
    expect(peerPrepared.configuration.fingerprints.mounted).toBe(prepared.configuration.fingerprints.mounted)
    expect(prepared.configuration.effective.models.find((model) => model.slot === 'primary')).toEqual({
      slot: 'primary',
      route: 'alt',
      model: 'm2',
      thinking: null,
      contextWindow: 4096,
      maxTokens: 512,
    })
    expect(prepared.configuration.fingerprints.model).toBe(
      sha256Hex(
        canonicalJson(prepared.configuration.effective.models.map(({ maxTokens: _cap, ...model }) => model)),
      ),
    )
    const source = await session.d.log.scan({ fromSeq: prepared.sourceSeq, toSeq: prepared.sourceSeq })
    expect(source).toHaveLength(1)
    expect(source[0]).toMatchObject({
      type: 'x/host/session-prepared',
      origin: 'system',
      trust: 'trusted',
      ignorable: true,
      data: { sessionId: session.key, configuration: prepared.configuration },
    })
    const prefix = await session.d.log.scan({ fromSeq: 1, toSeq: prepared.sourceSeq })
    expect(verifyPreparedReceipt(prepared, prefix)).toBe(true)
    expect(verifyPreparedReceipt(prepared, prefix.slice(0, -1))).toBe(false)
    const corrupt = structuredClone(prefix)
    const changed = corrupt.find((event) => event.seq === prepared.sourceSeq)
    if (!changed) throw new Error('Missing preparation source')
    changed.data = null
    expect(verifyPreparedReceipt(prepared, corrupt)).toBe(false)
    changed.data = source[0]?.data ?? null
    changed.origin = 'principal'
    expect(verifyPreparedReceipt(prepared, corrupt)).toBe(false)
    expect(await host.prepareSessionConfiguration(session.key)).toEqual(prepared)
    const legacySession = await host.createSession({ key: 'prepared-legacy', cwd: dataDir })
    await legacySession.setPreset({
      ...legacySession.preset,
      model: { ...legacySession.preset.model, maxTokens: 512 },
    })
    await legacySession.setModel({ slot: 'primary', route: 'alt', model: 'm2', contextWindow: 4096 })
    const legacyConfiguration = structuredClone(prepared.configuration)
    delete legacyConfiguration.effective.mounted
    delete legacyConfiguration.fingerprints.mounted
    for (const model of legacyConfiguration.effective.models) delete model.maxTokens
    await legacySession.d.log.append([
      legacySession.ev(
        'x/host/session-prepared',
        {
          version: 1,
          sessionId: legacySession.key,
          configuration: legacyConfiguration,
        },
        { ignorable: true },
      ),
    ])
    const legacy = await host.prepareSessionConfiguration(legacySession.key)
    expect(legacy.configuration).toEqual(legacyConfiguration)
    expect(Object.hasOwn(legacy.configuration.effective, 'mounted')).toBe(false)
    expect(legacy.configuration.effective.models.every((model) => !Object.hasOwn(model, 'maxTokens'))).toBe(
      true,
    )
    await legacySession.setPreset({
      ...legacySession.preset,
      model: { ...legacySession.preset.model, maxTokens: 256 },
    })
    await expect(host.prepareSessionConfiguration(legacySession.key)).rejects.toMatchObject({
      code: 'E_RELATION',
    })
    expect(await legacySession.d.log.scan({ type: 'x/host/session-prepared', limit: 2 })).toHaveLength(1)
    expect(JSON.stringify(prepared)).not.toContain(dataDir)
    await session.setModel({ slot: 'primary', route: 'gw', model: 'm1' })
    await expect(host.prepareSessionConfiguration(session.key)).rejects.toMatchObject({ code: 'E_RELATION' })
    expect(await session.d.log.scan({ type: 'x/host/session-prepared', limit: 2 })).toEqual(source)
  })
  it('refuses a generation publication racing the locked capture before publishing a receipt', async () => {
    const dataDir = scratch()
    const provider = new ScriptedProvider({
      models: TWO_ROUTES.flatMap((route) => route.models ?? []),
      scripts: [],
    })
    const { host } = await createTestHost(twoRouteHostOptions(dataDir, provider))
    unwinds.push(() => host.close())
    const session = await host.createSession({ key: 'prepared-generation', cwd: dataDir })
    const original = session.d.currentRuntime
    const priorView = original?.current(session.key)
    if (!original || !priorView) throw new Error('Expected actual published runtime')
    const scan = session.d.log.scan.bind(session.d.log)
    vi.spyOn(session.d.log, 'scan').mockImplementationOnce(async (query) => {
      const rows = await scan(query)
      session.d.currentRuntime = { current: () => ({ ...priorView }) }
      return rows
    })
    try {
      await expect(host.prepareSessionConfiguration(session.key)).rejects.toMatchObject({
        code: 'E_RELATION',
      })
      expect(await scan({ type: 'x/host/session-prepared', limit: 2 })).toEqual([])
    } finally {
      session.d.currentRuntime = original
    }
  })
})

describe('replaySwitchesOnOpen', () => {
  it('snapshots defaults for new sessions and preserves them when the configured defaults change', async () => {
    const dataDir = scratch()
    const provider = (contextWindow: number, thinking: 'high' | 'low') =>
      new ScriptedProvider({
        models: [
          {
            ...modelRecord('gw', 'm1'),
            reasoning: true,
            thinkingLevelMap: { high: 'high', low: 'low' },
            defaultSettings: { thinking, contextWindow },
          },
          modelRecord('alt', 'm2'),
        ],
        scripts: [],
      })
    const first = await createTestHost(twoRouteHostOptions(dataDir, provider(4096, 'high')))
    const original = await first.host.createSession({ cwd: dataDir, key: 'defaults-original' })
    expect(original.preset.model.thinking.primary).toBe('high')
    expect(original.preset.model.contextWindow?.primary).toBe(4096)
    await first.host.close()
    const second = await createTestHost(twoRouteHostOptions(dataDir, provider(6144, 'low')))
    try {
      const restored = await second.host.createSession({ cwd: dataDir, key: 'defaults-original' })
      expect(restored.preset.model.thinking.primary).toBe('high')
      expect(restored.preset.model.contextWindow?.primary).toBe(4096)
      const fresh = await second.host.createSession({ cwd: dataDir, key: 'defaults-new' })
      expect(fresh.preset.model.thinking.primary).toBe('low')
      expect(fresh.preset.model.contextWindow?.primary).toBe(6144)
    } finally {
      await second.host.close()
    }
  })

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
    await s1.setModel({ slot: 'primary', route: 'alt', model: 'm2', thinking: 'high', contextWindow: 4096 })
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
      expect(reopened.preset.model.contextWindow?.primary).toBe(4096)
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

  it.each([
    ['coding', false],
    ['standard', false],
    ['coding', true],
    ['standard', true],
  ] as const)(
    'restores the latest %s preset and its later model settings (override: %s)',
    async (latestPreset, modelAfterPreset) => {
      const dataDir = scratch()
      const coding: PresetDoc = {
        ...TWO_SLOT_PRESET,
        name: 'coding',
        model: { route: { primary: 'gw', escalation: 'alt' }, thinking: { primary: 'low' } },
      }
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
        new ScriptedProvider({
          models: [
            {
              ...modelRecord('gw', 'm1'),
              reasoning: true,
              thinkingLevelMap: { low: 'low', high: 'high' },
              defaultSettings: { thinking: 'high', contextWindow: 4096 },
            },
            modelRecord('alt', 'm2'),
          ],
          scripts: [],
        })
      const first = await createTestHost(options(provider()))
      const s1 = await first.host.createSession({ cwd: dataDir })
      expect(s1.preset.model.thinking.primary).toBe('high')
      expect(s1.preset.model.contextWindow?.primary).toBe(4096)
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
      if (latestPreset === 'standard') {
        const originalPreset = first.host.validatePresetSwitch('standard')
        await s1.setPreset({
          ...originalPreset.view,
          model: {
            ...originalPreset.view.model,
            route: { primary: 'gw', escalation: 'alt' },
            id: { primary: 'm1', escalation: 'm2' },
          },
        })
      }
      expect(s1.preset.model.route.primary).toBe('gw')
      expect(s1.preset.model.id.primary).toBe('m1')
      if (modelAfterPreset)
        await s1.setModel({
          slot: 'primary',
          route: 'gw',
          model: 'm1',
          thinking: 'high',
          contextWindow: 6144,
        })
      const key = s1.key
      const before = (await s1.scan({ type: 'x/core/model-switch', limit: 20 })).length
      const presetsBefore = (await s1.scan({ type: 'x/core/preset-switch', limit: 20 })).length
      await first.host.close()
      const second = await createTestHost(options(provider()))
      const reopened = await second.host.createSession({ cwd: dataDir, key })
      try {
        expect(reopened.preset.name).toBe(latestPreset)
        expect(reopened.preset.model.route.primary).toBe('gw')
        expect(reopened.preset.model.id.primary).toBe('m1')
        expect(reopened.preset.model.thinking.primary).toBe(
          modelAfterPreset ? 'high' : latestPreset === 'coding' ? 'low' : undefined,
        )
        expect(reopened.preset.model.contextWindow?.primary).toBe(modelAfterPreset ? 6144 : undefined)
        const restoredContext = (await reopened.projectUI()).usage?.context
        expect(restoredContext?.window).toBe(modelAfterPreset ? 6144 : 8192)
        expect((await reopened.scan({ type: 'x/core/model-switch', limit: 20 })).length).toBe(before)
        expect((await reopened.scan({ type: 'x/core/preset-switch', limit: 20 })).length).toBe(presetsBefore)
      } finally {
        await second.host.close()
      }
    },
  )

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
      await parent.setModel({ slot: 'primary', route: b.route, model: b.model, contextWindow: 4096 })

      const child = await first.host.createSession({
        cwd: dataDir,
        key: 'fork-model-child',
        parent: { key: parent.key, boundarySeq: completed.seq },
      })
      expect(child.preset.model.id.primary).toBe(b.model)
      expect(child.preset.model.contextWindow?.primary).toBe(4096)
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
      expect(reopened.preset.model.contextWindow?.primary).toBe(4096)
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

describe('Host.resolveSessionSelection', () => {
  it('freezes the materialized primary and configured default preset without opening a session or inferring', async () => {
    const dataDir = scratch()
    const main: ModelRecord = {
      ...modelRecord('gw', 'main-model'),
      slot: 'primary',
      reasoning: true,
      thinkingLevelMap: { low: 'low', high: 'high' },
      defaultSettings: { thinking: 'high', contextWindow: 4096 },
    }
    const alternate: ModelRecord = {
      ...modelRecord('alt', 'alternate-model'),
      reasoning: true,
      thinkingLevelMap: { low: 'low', high: 'high' },
      defaultSettings: { thinking: 'high', contextWindow: 6144 },
    }
    const plain = modelRecord('alt', 'plain-model')
    const models = [
      plain,
      { ...modelRecord('gw', 'first-but-not-primary'), slot: 'fast' as const },
      main,
      alternate,
    ]
    const provider = new ScriptedProvider({ models, scripts: [] })
    const infer = vi.spyOn(provider, 'infer')
    const { host } = await createTestHost({
      dataDir,
      provider,
      disableSessionTitle: true,
      presets: {
        focused: {
          name: 'focused',
          extends: 'base',
          model: { route: { primary: 'default' }, thinking: { primary: 'low' } },
        },
      },
      profileInputs: {
        user: {
          name: 'local-dev',
          presets: { default: 'focused', allowed: ['standard', 'focused'] },
          provider: {
            package: '@agnes/ai',
            adapters: ['@agnes/ai'],
            routes: [
              {
                route: 'gw',
                api: 'openai-completions',
                baseUrl: 'https://example.invalid/v1',
                models: models.filter((model) => model.route === 'gw'),
              },
              {
                route: 'alt',
                api: 'openai-completions',
                baseUrl: 'https://example.invalid/v1',
                models: [alternate, plain],
              },
            ],
          },
        },
      },
    })
    unwinds.push(() => host.close())
    const open = vi.spyOn(host.kernel, 'session')
    expect(host.kernel.sessions.size).toBe(0)
    await expect(host.resolveSessionSelection({})).resolves.toEqual({
      preset: 'focused',
      model: { route: 'gw', model: 'main-model', thinking: 'low', contextWindow: 4096 },
    })
    await expect(host.resolveSessionSelection({ preset: 'standard' })).resolves.toEqual({
      preset: 'standard',
      model: { route: 'gw', model: 'main-model', thinking: 'high', contextWindow: 4096 },
    })
    await expect(
      host.resolveSessionSelection({
        model: { route: 'gw', model: 'main-model', thinking: 'high', contextWindow: 6144 },
      }),
    ).resolves.toEqual({
      preset: 'focused',
      model: { route: 'gw', model: 'main-model', thinking: 'high', contextWindow: 6144 },
    })
    await expect(
      host.resolveSessionSelection({
        model: { route: 'alt', model: 'plain-model' },
      }),
    ).resolves.toEqual({
      preset: 'focused',
      model: { route: 'alt', model: 'plain-model', contextWindow: 8192 },
    })
    // Selecting a different model uses its defaults, not the default preset's primary settings.
    await expect(
      host.resolveSessionSelection({ model: { route: 'alt', model: 'alternate-model' } }),
    ).resolves.toEqual({
      preset: 'focused',
      model: { route: 'alt', model: 'alternate-model', thinking: 'high', contextWindow: 6144 },
    })
    expect(open).not.toHaveBeenCalled()
    expect(infer).not.toHaveBeenCalled()
    expect(host.kernel.sessions.size).toBe(0)
  })

  it('refuses unknown selections and invalid settings before session or provider effects', async () => {
    const dataDir = scratch()
    const provider = new ScriptedProvider({
      models: [modelRecord('gw', 'm1'), modelRecord('alt', 'm2')],
      scripts: [],
    })
    const infer = vi.spyOn(provider, 'infer')
    const { host } = await createTestHost(twoRouteHostOptions(dataDir, provider))
    unwinds.push(() => host.close())
    const open = vi.spyOn(host.kernel, 'session')
    for (const model of [
      { route: 'gw', model: 'unknown' },
      { route: 'unknown', model: 'm1' },
      { route: 'gw', model: 'm1', thinking: 'high' as const },
      { route: 'gw', model: 'm1', contextWindow: 8193 },
    ])
      await expect(host.resolveSessionSelection({ model })).rejects.toMatchObject({
        code: 'E_MODEL_UNSUPPORTED',
      })
    await expect(host.resolveSessionSelection({ preset: 'unknown' })).rejects.toMatchObject({
      code: 'E_PRESET_UNSUPPORTED',
    })
    expect(open).not.toHaveBeenCalled()
    expect(infer).not.toHaveBeenCalled()
    expect(host.kernel.sessions.size).toBe(0)
  })
})

it('retains the comparison-only sandbox floor across preset switches, a history fork, and a new Host', async () => {
  const dataDir = scratch()
  const requested = {
    name: 'standard',
    extends: 'base',
    disclosure: 'standard',
    sandbox: { level: 'L0', required: false, on_unavailable: 'allow' },
  }
  const probeInputs: Array<{ level: string; required: boolean; onUnavailable: string }> = []
  const options: TestHostOptions = {
    dataDir,
    disableSessionTitle: true,
    platformCaps: { 'sandbox.l1': 'full' },
    presets: {
      standard: requested,
      permissive: { ...requested, name: 'permissive', budget: { max_steps: 9 } },
    },
    profileInputs: {
      user: { name: 'test', presets: { default: 'standard', allowed: ['standard', 'permissive'] } },
    },
    packages: {
      '@agnes/base': {
        sandboxWorkspaceProbe: async (input) => {
          probeInputs.push({
            level: input.level,
            required: input.required,
            onUnavailable: input.onUnavailable,
          })
          return {
            name: 'bwrap',
            execBackend: 'l1',
            enforcement: { level: 'full', scope: ['file', 'network', 'process'] },
            degraded: false,
            confine: ({ argv }) => argv,
          }
        },
      },
    },
  }
  const store = createComparisonStore(join(dataDir, 'comparisons', 'index.sqlite'), {
    sessionKeys: () => ({ left: 'reserved-owner', right: 'reserved-peer' }),
  })
  await store.scoped('owner').compareAndSwap('pair', null, {
    id: 'pair',
    revision: 0,
    createPayload: '{}',
    creation: 'preparing',
    lanes: {},
    rounds: [],
    cancellation: {},
    cleanup: { exited: [], released: false },
  })
  const first = await createTestHost(options)
  unwinds.push(() => first.host.close())
  try {
    const ordinary = await first.host.createSession({ key: 'agnes:comparison:spoof:left', cwd: dataDir })
    expect(ordinary.preset.sandbox.onUnavailable).toBe('allow')
    const protectedOwner = await first.host.createSession({ key: 'reserved-owner', cwd: dataDir })
    expect(protectedOwner.preset.name).toBe('standard')
    expect(protectedOwner.preset.sandbox.onUnavailable).toBe('deny')
    expect(probeInputs).toContainEqual({ level: 'L0', required: false, onUnavailable: 'allow' })
    expect(probeInputs).toContainEqual({ level: 'L1', required: true, onUnavailable: 'deny' })
    expect(first.host.presets.standard?.sandbox).toEqual(requested.sandbox)
    await first.host.setSessionPreset(protectedOwner.key, 'permissive')
    expect(protectedOwner.preset.sandbox.onUnavailable).toBe('deny')
    expect(protectedOwner.preset.budget.maxSteps).toBe(9)
    const fork = await first.host.createSession({
      key: 'ordinary-fork-name',
      parent: { key: protectedOwner.key, boundarySeq: protectedOwner.lastSeq },
    })
    expect(fork.preset.sandbox.onUnavailable).toBe('deny')
    await first.host.close()
    const second = await createTestHost(options)
    unwinds.push(() => second.host.close())
    const recovered = await second.host.createSession({ key: 'reserved-owner', cwd: dataDir })
    expect(recovered.preset).toMatchObject({
      name: 'permissive',
      budget: { maxSteps: 9 },
      sandbox: { onUnavailable: 'deny' },
    })
    const recoveredFork = await second.host.createSession({ key: 'ordinary-fork-name', cwd: dataDir })
    expect(recoveredFork.preset.sandbox.onUnavailable).toBe('deny')
    expect(
      (await second.host.createSession({ key: ordinary.key, cwd: dataDir })).preset.sandbox.onUnavailable,
    ).toBe('allow')
  } finally {
    store.close()
  }
})

it.each(['unsupported platform', 'probe failure'])(
  'refuses comparison sandbox admission on %s while preserving an ordinary L0 session',
  async (mode) => {
    const dataDir = scratch()
    const options: TestHostOptions = {
      dataDir,
      disableSessionTitle: true,
      presets: {
        standard: {
          name: 'standard',
          extends: 'base',
          disclosure: 'standard',
          sandbox: { level: 'L0', required: false, on_unavailable: 'allow' },
        },
      },
      platformCaps: { 'sandbox.l1': mode === 'unsupported platform' ? 'unavailable' : 'full' },
      packages: {
        '@agnes/base': {
          sandboxWorkspaceProbe: async (input) => {
            if (input.level === 'L1' && mode === 'probe failure')
              throw Object.assign(new Error('test probe unavailable'), { code: 'E_SANDBOX_UNAVAILABLE' })
            return input.level === 'L1'
              ? {
                  name: 'bwrap',
                  execBackend: 'l1',
                  enforcement: { level: 'full', scope: ['file', 'network', 'process'] },
                  degraded: false,
                  confine: ({ argv }) => argv,
                }
              : {
                  name: 'none',
                  execBackend: 'none',
                  enforcement: { level: 'none', scope: [] },
                  degraded: false,
                  confine: ({ argv }) => argv,
                }
          },
        },
      },
    }
    const store = createComparisonStore(join(dataDir, 'comparisons', 'index.sqlite'), {
      sessionKeys: () => ({ left: 'reserved-owner', right: 'reserved-peer' }),
    })
    try {
      await store.scoped('owner').compareAndSwap('pair', null, {
        id: 'pair',
        revision: 0,
        createPayload: '{}',
        creation: 'preparing',
        lanes: {},
        rounds: [],
        cancellation: {},
        cleanup: { exited: [], released: false },
      })
      const { host } = await createTestHost(options)
      unwinds.push(() => host.close())
      expect((await host.createSession({ key: 'ordinary', cwd: dataDir })).preset.sandbox.onUnavailable).toBe(
        'allow',
      )
      await expect(host.createSession({ key: 'reserved-owner', cwd: dataDir })).rejects.toMatchObject({
        code: mode === 'unsupported platform' ? 'E_PRESET_UNSUPPORTED' : 'E_SANDBOX_WORKSPACE',
      })
      expect(host.kernel.get('reserved-owner')).toBeUndefined()
    } finally {
      store.close()
    }
  },
)
