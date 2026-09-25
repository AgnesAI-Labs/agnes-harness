import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import type { InferenceEvent, ModelRecord } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { Prompter } from '../src/index.js'
import { ASSEMBLY_STEPS, crashAtEveryStep, createTestHost, runOnce } from '../testkit/index.js'

/** One scripted turn: ScriptedProvider prepends `sent`, so an answer and a stop are all it needs. */
const say = (text: string): InferenceEvent[] => [
  { type: 'text_delta', delta: text },
  { type: 'done', reason: 'stop' },
]

describe('testkit', () => {
  const dirs: string[] = []
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'agnes-tk-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('boots a host with faux seams and a scripted provider', async () => {
    const { host, profile } = await createTestHost({ dataDir: tmp() })
    expect(profile.hash).toMatch(/^sha256-/)
    expect(host.extensions()).toEqual([])
    await host.close()
  })
  it('loads the default template and enforces its allowed presets on real session creation', async () => {
    const dataDir = tmp()
    const { host, profile } = await createTestHost({
      dataDir,
      presets: { claw: { name: 'claw', extends: 'standard' } },
      script: [say('default-template')],
    })
    try {
      expect(profile.chain).toEqual(['builtin:local-dev', 'user:local-dev'])
      expect(profile.presets).toEqual({ default: 'standard', allowed: ['standard'] })
      expect(await runOnce(host, { prompt: 'hi', cwd: dataDir })).toMatchObject({
        reason: 'completed',
        finalText: 'default-template',
      })
      await expect(host.createSession({ cwd: dataDir, preset: 'claw' })).rejects.toThrow(/presets.allowed/)
    } finally {
      await host.close()
    }
  })
  it('applies an explicit allowed list to actual session creation', async () => {
    for (const allowed of [['standard', 'claw'], []]) {
      const dataDir = tmp()
      const { host } = await createTestHost({
        dataDir,
        allowed,
        presets: { claw: { name: 'claw', extends: 'standard' } },
      })
      try {
        if (allowed.length) {
          const session = await host.createSession({ cwd: dataDir, preset: 'claw' })
          expect(session.key).toBeDefined()
        } else {
          await expect(host.createSession({ cwd: dataDir })).rejects.toThrow(/presets.allowed/)
        }
      } finally {
        await host.close()
      }
    }
  })
  it('honors explicit package lock enablement; an empty lock resolves the builtin set', async () => {
    const dataDir = tmp()
    const initial = await createTestHost({ dataDir })
    const packages = Object.fromEntries(
      initial.profile.packages.map((p) => [
        p.id,
        {
          version: p.version,
          integrity: p.integrity,
          trust: p.trust,
          enabled: p.enabled,
        },
      ]),
    )
    await initial.host.close()
    // An empty lock is no longer a refusal for a builtin-only template: builtin packages ship with
    // the build, so resolve stamps them from it. A non-builtin package still needs a lock entry.
    const unlocked = await createTestHost({ dataDir, lock: { packages: {} } })
    try {
      expect(unlocked.profile.packages.map((p) => [p.id, p.version, p.integrity, p.trust])).toEqual([
        ['@agnes/ai', '0.1.0', 'builtin:0.1.0', 'builtin'],
        ['@agnes/base', '0.1.0', 'builtin:0.1.0', 'builtin'],
        ['@agnes/code', '0.1.0', 'builtin:0.1.0', 'builtin'],
      ])
    } finally {
      await unlocked.host.close()
    }
    await expect(
      createTestHost({
        dataDir,
        lock: { packages: {} },
        profileInputs: { user: { name: 'x', packages: [{ id: '@acme/x', source: 'npm' }] } },
      }),
    ).rejects.toMatchObject({ code: 'E_DEP_MISSING', detail: { id: '@acme/x' } })
    const base = packages['@agnes/base']
    if (!base) throw new Error('default lock is missing base')
    base.enabled = false
    await expect(createTestHost({ dataDir, lock: { packages } })).rejects.toMatchObject({
      code: 'E_DEP_MISSING',
      detail: { package: '@agnes/base' },
    })
  })
  it('resolves explicit user inputs and applies them to real session selection', async () => {
    const dataDir = tmp()
    const { host, profile } = await createTestHost({
      dataDir,
      presets: { other: { name: 'other', extends: 'standard' } },
      profileInputs: { user: { name: 'fixture-profile', presets: { default: 'other', allowed: ['other'] } } },
      script: [say('user-layer')],
    })
    try {
      expect(await runOnce(host, { cwd: dataDir, prompt: 'hi' })).toMatchObject({
        reason: 'completed',
        finalText: 'user-layer',
        events: expect.arrayContaining([
          expect.objectContaining({
            type: 'session/start',
            data: expect.objectContaining({ preset: 'other' }),
          }),
        ]),
      })
      expect(profile.chain).toEqual(['builtin:local-dev', 'user:fixture-profile'])
      await expect(host.createSession({ cwd: dataDir, preset: 'standard' })).rejects.toThrow(
        /presets.allowed/,
      )
    } finally {
      await host.close()
    }
  })
  it('selects the requested template and exposes unmet non-builtin dependencies instead of using local-dev', async () => {
    // The enterprise template's connectors are all in the builtin set, so since the builtin
    // exemption they no longer count as unmet; what is still refused is a package the build does
    // not ship.
    await expect(
      createTestHost({
        dataDir: tmp(),
        template: 'enterprise',
        profileInputs: { user: { name: 'x', packages: [{ id: '@acme/x', source: 'npm' }] } },
      }),
    ).rejects.toMatchObject({ code: 'E_DEP_MISSING', detail: { id: '@acme/x' } })
    await expect(createTestHost({ dataDir: tmp(), template: 'missing-template' })).rejects.toThrow(
      /no builtin template missing-template/,
    )
  })
  // One Host assembly per step: about 0.1 s alone, past the 5 s default on the Windows runner.
  it('crash injection at every step rolls back', async () => {
    const r = await crashAtEveryStep((crashAt) => createTestHost({ dataDir: tmp(), crashAt }))
    expect(r).toEqual(Object.fromEntries(ASSEMBLY_STEPS.map((s) => [s, 'rolled-back'])))
  }, 30_000)
  // The classifier must tell a rollback from an unrelated failure, or the crash matrix reports a
  // green row for a run that never reached the step it was injecting into.
  it('reports an unrelated failure as wrong-error, not as rolled-back or leaked', async () => {
    const r = await crashAtEveryStep(async () => {
      throw new Error('E_DEP_MISSING: something else broke')
    })
    expect(new Set(Object.values(r))).toEqual(new Set(['wrong-error']))
  })
  it('reports a run that did not fail at all as leaked', async () => {
    const r = await crashAtEveryStep(async () => undefined)
    expect(new Set(Object.values(r))).toEqual(new Set(['leaked']))
  })
  it('accepts an approval override and a provider script (ERRATA B19)', async () => {
    const dataDir = tmp()
    const asked: unknown[] = []
    const { host } = await createTestHost({
      dataDir,
      approval: async (req) => {
        asked.push(req)
        return 'rejected'
      },
      script: [],
    })
    const s = await host.createSession({ cwd: dataDir })
    expect(s.key).toBeDefined()
    // The override is reachable through the seam the session was assembled with, so it is called
    // rather than merely stored.
    const seam = (host.kernel as unknown as { o: { seams: { approval: { ask: (r: unknown) => unknown } } } })
      .o.seams.approval
    await seam.ask({ requestId: 'r' })
    expect(asked).toHaveLength(1)
    await host.close()
  })
  it('a package overlay reaches the assembly; an overlay for a package nobody loads is refused', async () => {
    const dataDir = tmp()
    const contributed: string[] = []
    const { host } = await createTestHost({
      dataDir,
      packages: {
        '@agnes/code': {
          operations: {
            probe: () => ({
              name: 'probe',
              slot: 'before-inference',
              replay: 'safe',
              applicable: async () => 'applied',
              run: async () => ({}),
              contribute: () => {
                contributed.push('probe')
                return { promptSections: [{ id: 'persona', order: 100, text: 'x', source: 'probe' }] }
              },
            }),
          },
        },
      },
      script: [say('ok')],
    })
    try {
      // On the kernel, not merely stored on the module: it contributes to a request that is sent.
      const r = await runOnce(host, { prompt: 'hi', cwd: dataDir })
      expect(r.reason).toBe('completed')
      expect(contributed).toEqual(['probe'])
    } finally {
      await host.close()
    }
    await expect(createTestHost({ dataDir: tmp(), packages: { '@agnes/nope': {} } })).rejects.toThrow(
      /@agnes\/nope/,
    )
  })
  // Merged by seam name, not replaced: a case wanting one real seam factory would otherwise have to
  // restate the other eight fakes, and a restated fake is one that drifts from the shared one.
  it('a seams overlay replaces only the seam it names and leaves the rest faked', async () => {
    const dataDir = tmp()
    let asked = 0
    const { host } = await createTestHost({
      dataDir,
      packages: {
        '@agnes/base': {
          seams: {
            approval: async () => {
              const fitted = {
                forWorkspace: async () => fitted,
                ask: async () => {
                  asked++
                  return 'rejected' as const
                },
                resume: async () => null,
              }
              return fitted
            },
          },
        },
      },
      script: [say('ok')],
    })
    try {
      // It assembled at all, which means the eight seams this overlay did not name were still there.
      const r = await runOnce(host, { prompt: 'hi', cwd: dataDir })
      expect(r.reason).toBe('completed')
      expect(asked).toBe(0)
    } finally {
      await host.close()
    }
  })

  // The prompter reaches a seam through the assembly's adapters, which is the only route a real
  // approval seam has to a connected operator. Checked at the factory, not inside ask(): a turn with
  // no tool call never asks anything, so a check inside ask() would never run and would prove
  // nothing while looking like it did.
  it('hands a prompter to the seam that asks for one, and none when none was given', async () => {
    const reached: string[] = []
    const seamNeedingPrompter = {
      '@agnes/base': {
        seams: {
          approval: async (ctx: { adapters: { prompter?: unknown } }) => {
            if (!ctx.adapters.prompter) throw new Error('no prompter reached the seam')
            reached.push('prompter')
            return { ask: async () => 'rejected' as const, resume: async () => null }
          },
        },
      },
    }
    const dataDir = tmp()
    const { host } = await createTestHost({
      dataDir,
      prompter: async () => 'allowed-once',
      packages: seamNeedingPrompter as never,
      script: [say('ok')],
    })
    try {
      expect(reached).toEqual(['prompter'])
    } finally {
      await host.close()
    }
    await expect(
      createTestHost({ dataDir: tmp(), packages: seamNeedingPrompter as never, script: [say('ok')] }),
    ).rejects.toThrow(/no prompter reached the seam/)
  })

  it('forwards the exact prompter signal through the real Host adapter', async () => {
    let adapter: Prompter | undefined
    let received: AbortSignal | undefined
    const { host } = await createTestHost({
      dataDir: tmp(),
      script: [say('unused')],
      prompter: async (_request, opts) => {
        received = opts.signal
        return 'rejected'
      },
      packages: {
        '@agnes/base': {
          seams: {
            approval: async (ctx) => {
              adapter = ctx.adapters.prompter
              return { ask: async () => 'rejected' as const, resume: async () => null }
            },
          },
        },
      },
    })
    try {
      if (!adapter) throw new Error('missing assembled prompter')
      const ac = new AbortController()
      await adapter.ask({} as Parameters<Prompter['ask']>[0], { signal: ac.signal })
      expect(received).toBe(ac.signal)
      ac.abort()
      expect(received?.aborted).toBe(true)
    } finally {
      await host.close()
    }
  })

  it('runOnce reports the tool calls and the answer from the ledger', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({ dataDir, script: [say('just words')] })
    try {
      const r = await runOnce(host, { prompt: 'say something', cwd: dataDir })
      expect(r.toolCalls).toEqual([])
      expect(r.finalText).toBe('just words')
      expect(r.events.some((e) => e.type === 'turn/end')).toBe(true)
    } finally {
      await host.close()
    }
  })
  it('the fake platform answers the capability levels it was given, and full otherwise', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({ dataDir, platformCaps: { 'sandbox.l1': 'partial' } })
    const platform = (
      host.kernel as unknown as {
        o: { seams: { platform: { capability: (id: string) => { level: string } } } }
      }
    ).o.seams.platform
    expect(platform.capability('sandbox.l1').level).toBe('partial')
    expect(platform.capability('fs.symlink').level).toBe('full')
    await host.close()
  })

  it('an ordinary Host text turn completes without a tree budget', async () => {
    const dataDir = tmp()
    const { host, profile } = await createTestHost({ dataDir, script: [say('plain')] })
    try {
      expect(profile.provider.routes?.[0]?.route).toBe('gw')
      expect(await runOnce(host, { prompt: 'hi', cwd: dataDir })).toMatchObject({
        reason: 'completed',
        finalText: 'plain',
      })
    } finally {
      await host.close()
    }
  })

  it('an explicit tree budget with the profile catalogue completes a legal turn', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({
      dataDir,
      treeBudgetCredits: 100,
      script: [say('capped')],
    })
    try {
      expect(await runOnce(host, { prompt: 'hi', cwd: dataDir })).toMatchObject({
        reason: 'completed',
        finalText: 'capped',
      })
    } finally {
      await host.close()
    }
  })

  it('keeps a caller-supplied provider, admits a tree-budget turn with no catalogue, and refuses a genuinely over-cap one', async () => {
    const dataDir = tmp()
    const kept = new ScriptedProvider({
      scripts: [say('kept')],
      models: [fakeModel({ id: 'm1', route: 'gw' })],
    })
    const missing = new ScriptedProvider({ scripts: [say('sent-anyway')], models: [] })
    const priced: ModelRecord = {
      ...fakeModel({ id: 'm1', route: 'gw' }),
      cost: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 8192,
    }
    const expensive = new ScriptedProvider({ scripts: [say('too-expensive')], models: [priced] })
    const aligned = await createTestHost({
      dataDir,
      provider: kept,
      script: [say('ignored')],
      disableSessionTitle: true,
    })
    try {
      expect(await runOnce(aligned.host, { prompt: 'hi', cwd: dataDir })).toMatchObject({
        reason: 'completed',
        finalText: 'kept',
      })
      expect(kept.calls).toHaveLength(1)
    } finally {
      await aligned.host.close()
    }
    // A model resolved by a pinned id may legitimately never appear in the local catalogue
    // snapshot (remote catalogues publish ids only). Missing catalogue data means "no
    // conservative upper bound available", not "refuse the turn": the request is still admitted,
    // holding against the ledger's own projectedCredits alone.
    const missingDir = tmp()
    const noCatalogue = await createTestHost({
      dataDir: missingDir,
      treeBudgetCredits: 100,
      provider: missing,
      disableSessionTitle: true,
    })
    try {
      expect(await runOnce(noCatalogue.host, { prompt: 'hi', cwd: missingDir })).toMatchObject({
        reason: 'completed',
        finalText: 'sent-anyway',
      })
      expect(missing.calls).toHaveLength(1)
    } finally {
      await noCatalogue.host.close()
    }
    const overDir = tmp()
    const overCap = await createTestHost({
      dataDir: overDir,
      treeBudgetCredits: 0.0001,
      provider: expensive,
      disableSessionTitle: true,
    })
    try {
      expect(await runOnce(overCap.host, { prompt: 'hi', cwd: overDir })).toMatchObject({ reason: 'budget' })
      expect(expensive.calls).toHaveLength(0)
    } finally {
      await overCap.host.close()
    }
  })
})
