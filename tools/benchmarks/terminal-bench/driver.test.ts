import { describe, expect, it, vi } from 'vitest'
import {
  applyModelConfiguration,
  assertNoBenchmarkSkillPaths,
  boundConfig,
  completePrefix,
  disableBenchmarkSkills,
  fixtureProfile,
  outputSanitizer,
  parseRequest,
  recoverTerminalSequence,
  runTurn,
  validateFixtureProfile,
} from './driver.js'

const request = {
  schemaVersion: 1,
  runtime: 'jevloop',
  distributionDir: '/opt/agh',
  home: '/tmp/agh-home',
  profile: 'local-dev',
  cwd: '/app',
  prompt: 'Solve the task.',
  deadlineMs: 1000,
}
const completed = { reason: 'completed' as const, stopReason: 'end_turn' as const, lastSeq: 4 }

describe('Terminal-Bench driver contract', () => {
  it('requires an explicit supported runtime and isolated home rather than silently defaulting', () => {
    expect(parseRequest(request).runtime).toBe('jevloop')
    expect(parseRequest({ ...request, runtime: 'native' }).runtime).toBe('native')
    for (const runtime of [undefined, '', 'other'])
      expect(() => parseRequest({ ...request, runtime })).toThrow('REQUEST_INVALID')
    expect(() => parseRequest({ ...request, home: '/app/.agh' })).toThrow('HOME_OVERLAPS_TASK')
    expect(
      parseRequest({
        ...request,
        jevStages: { arbitration: { route: 'gateway', model: 'deepseek-v4-pro' }, answer: null },
      }).jevStages?.answer,
    ).toBeNull()
    for (const jevStages of [
      { wrong: null },
      { arbitration: { route: 'gateway', model: 'pro', contextWindow: 4096 } },
      { parameters: { route: 'gateway', model: 'flash', thinking: 'invalid' } },
    ])
      expect(() => parseRequest({ ...request, jevStages })).toThrow('REQUEST_INVALID')
    expect(() =>
      parseRequest({
        ...request,
        runtime: 'native',
        jevStages: { arbitration: { route: 'gateway', model: 'pro' } },
      }),
    ).toThrow('NATIVE_JEV_STAGES_UNSUPPORTED')
    expect(
      parseRequest({
        ...request,
        deadlineMs: 28_800_000,
        exportTimeoutMs: 60_000,
        exportMaxBytes: 128 * 1024 * 1024,
      }),
    ).toMatchObject({ deadlineMs: 28_800_000, exportTimeoutMs: 60_000, exportMaxBytes: 128 * 1024 * 1024 })
    for (const change of [
      { exportTimeoutMs: 0 },
      { exportTimeoutMs: 60_001 },
      { exportTimeoutMs: Infinity },
      { exportMaxBytes: 0 },
      { exportMaxBytes: 128 * 1024 * 1024 + 1 },
      { exportMaxBytes: 1.5 },
    ])
      expect(() => parseRequest({ ...request, ...change })).toThrow('REQUEST_INVALID')
  })

  it('applies independent slot/stage configuration and verifies public model state without running a prompt', async () => {
    const state: SessionModelSlotsResult = {
      sessionId: 'test-session',
      runtime: { id: 'jevloop', version: '1' },
      languageSlots: { parameters: 'fast', arbitration: 'escalation', answer: 'primary' },
      slots: [],
      languageBindings: { parameters: null, arbitration: null, answer: null },
    }
    const session = {
      id: state.sessionId,
      setModel: async (input: NonNullable<ReturnType<typeof parseRequest>['models']>[number]) => {
        state.slots.push({
          ...input,
          thinking: input.thinking ?? null,
          contextWindow: input.contextWindow ?? null,
        })
        return {} as never
      },
      setJevStages: async (stages: NonNullable<ReturnType<typeof parseRequest>['jevStages']>) => {
        if (!state.languageBindings) throw new Error('Missing fake stage state')
        for (const stage of ['parameters', 'arbitration', 'answer'] as const)
          if (Object.hasOwn(stages, stage)) state.languageBindings[stage] = stages[stage] ?? null
        return { effectiveFromSeq: 1 }
      },
      modelSlots: async () => structuredClone(state),
    }
    const recipe = parseRequest({
      ...request,
      models: [
        { slot: 'primary', route: 'gateway', model: 'deepseek-v4-flash' },
        { slot: 'escalation', route: 'gateway', model: 'deepseek-v4-flash' },
      ],
      jevStages: {
        parameters: { route: 'gateway', model: 'deepseek-v4-flash' },
        arbitration: { route: 'gateway', model: 'deepseek-v4-pro' },
        answer: { route: 'gateway', model: 'deepseek-v4-flash' },
      },
    })
    const observed = await applyModelConfiguration(session, recipe)
    expect(observed.languageBindings?.arbitration?.model).toBe('deepseek-v4-pro')
    expect(observed.slots.find((slot) => slot.slot === 'escalation')?.model).toBe('deepseek-v4-flash')
    await expect(
      applyModelConfiguration(
        {
          ...session,
          modelSlots: async () => ({
            ...state,
            languageBindings: { parameters: null, arbitration: null, answer: null },
          }),
        },
        recipe,
      ),
    ).rejects.toThrow('JEV_STAGE_READBACK_MISMATCH')
    await expect(
      applyModelConfiguration(
        { ...session, modelSlots: async () => ({ ...state, slots: [] }) },
        { ...recipe, models: [{ slot: 'fast', route: 'other', model: 'other' }] },
      ),
    ).rejects.toThrow('MODEL_READBACK_MISMATCH')
    await expect(applyModelConfiguration(session, { ...recipe, runtime: 'native' })).rejects.toThrow(
      'NATIVE_JEV_STAGES_UNSUPPORTED',
    )
  })

  it('rejects Skill filesystem discovery entrances and disables existing resources without removing hooks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agh-tb-skill-policy-'))
    try {
      const paths = { home: join(root, 'agh'), cwd: join(root, 'task') }
      const env = { HOME: join(root, 'user') }
      expect(await assertNoBenchmarkSkillPaths(paths, env)).toMatchObject({ filesystemRootsAbsent: true })
      await mkdir(join(env.HOME, '.agents', 'skills'), { recursive: true })
      await expect(assertNoBenchmarkSkillPaths(paths, env)).rejects.toThrow('BENCHMARK_SKILL_PATH_PRESENT')
      const roster = [
        {
          kind: 'skill',
          resourceId: 'skill/user/user-agents/test',
          revision: 'test',
          desired: 'disabled',
          actual: 'disabled',
        },
        {
          kind: 'skill',
          resourceId: 'skill/package/package/test',
          revision: 'test',
          desired: 'enabled',
          actual: 'ready',
        },
      ]
      const resources = {
        list: async () => ({ items: structuredClone(roster) }),
        desiredSet: async ({ resourceId, state }: { resourceId: string; state: string }) => {
          const resource = roster.find((entry) => entry.resourceId === resourceId)
          if (!resource) throw new Error('Missing fake resource')
          resource.desired = state
          resource.actual = 'disabled'
          return {} as never
        },
        operation: { get: async () => ({}) as never, cancel: async () => ({}) as never },
      } as unknown as Parameters<typeof disableBenchmarkSkills>[0]
      const policy = await disableBenchmarkSkills(resources, 'local-dev')
      expect(
        policy.resources.every(
          (resource) => resource.desired === 'disabled' && resource.actual === 'disabled',
        ),
      ).toBe(true)
      expect(policy.hooksPreserved).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('records an agent completion without asserting a benchmark score', async () => {
    const result = await runTurn({ prompt: async () => completed, cancel: async () => {} }, 'task', 1000, 10)
    expect(result).toMatchObject({
      status: 'settled',
      reason: 'completed',
      lastSeq: 4,
      requiresHardKill: false,
    })
    expect(result).not.toHaveProperty('pass')
    expect(result).not.toHaveProperty('reward')
    const terminalFailure = await runTurn(
      {
        prompt: async () => {
          throw { data: { code: 'TURN_ERROR', error: 'secret-body' } }
        },
        cancel: async () => {},
      },
      'task',
      1000,
      10,
    )
    expect(terminalFailure).toMatchObject({ status: 'settled', reason: 'error', errorCode: 'TURN_ERROR' })
    expect(JSON.stringify(terminalFailure)).not.toContain('secret-body')
    const events = Array.from({ length: 120 }, (_, index) => ({
      seq: index + 1,
      type: index === 118 ? 'turn/end' : index === 119 ? 'x/host/session-title' : 'x/test/record',
      lane: 'main',
      data: index === 118 ? { reason: 'error' } : {},
    })) as never
    const exported = { events, throughSeq: 120, complete: true }
    expect(recoverTerminalSequence(terminalFailure, exported).lastSeq).toBe(119)
    expect(recoverTerminalSequence(result, exported)).toBe(result)
    for (const evidence of [
      { ...exported, complete: false },
      { ...exported, events: [] },
      {
        ...exported,
        events: (events as Array<Record<string, unknown>>).map((event) => ({
          ...event,
          data: event.type === 'turn/end' ? { reason: 'completed' } : event.data,
        })) as never,
      },
      {
        ...exported,
        events: (events as Array<Record<string, unknown>>).map((event) => ({
          ...event,
          type: event.seq === 120 ? 'turn/end' : event.type,
          data: event.seq === 120 ? { reason: 'error' } : event.data,
        })) as never,
      },
    ])
      expect(recoverTerminalSequence(terminalFailure, evidence).lastSeq).toBeNull()
  })

  it('uses an independent profile with CU, external packages, and subagent admission disabled', () => {
    const profile = fixtureProfile('local-dev')
    expect(() => validateFixtureProfile(profile, 'local-dev')).not.toThrow()
    expect(() => validateFixtureProfile({ ...profile, computerUse: { enabled: true } }, 'local-dev')).toThrow(
      'FIXTURE_PROFILE_UNSAFE',
    )
    expect(() =>
      validateFixtureProfile(
        { ...profile, policy: { workspacePackages: 'deny', capabilityCeiling: ['tools', 'subagent'] } },
        'local-dev',
      ),
    ).toThrow('FIXTURE_PROFILE_UNSAFE')
  })

  it('waits for cancellation settlement and requires watchdog intervention when only the send succeeds', async () => {
    vi.useFakeTimers()
    try {
      const result = runTurn({ prompt: () => new Promise(() => {}), cancel: async () => {} }, 'task', 100, 50)
      await vi.advanceTimersByTimeAsync(150)
      expect(await result).toMatchObject({
        status: 'timeout',
        deadlineExceeded: true,
        requiresHardKill: true,
        errorCode: 'CANCEL_NOT_SETTLED',
      })
      let settle!: (value: typeof completed) => void
      const converged = runTurn(
        {
          prompt: () =>
            new Promise((done) => {
              settle = done
            }),
          cancel: async () => {
            settle({ ...completed, reason: 'aborted' as never, stopReason: 'cancelled' as never })
          },
        },
        'task',
        100,
        50,
      )
      await vi.advanceTimersByTimeAsync(100)
      expect(await converged).toMatchObject({ status: 'timeout', reason: 'aborted', requiresHardKill: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not expose environment or bound configuration credentials through echoed content or errors', async () => {
    const sanitize = outputSanitizer(
      { AGNES_JEV_API_KEY: 'jev-private', BENCH_RELAY_TOKEN: 'relay-private' },
      { apiKey: 'llm-private' },
    )
    expect(
      JSON.stringify(
        sanitize({
          content: 'jev-private relay-private llm-private',
          apiKey: 'new-secret',
          error: 'Bearer unknown-private',
        }),
      ),
    ).not.toMatch(/jev-private|relay-private|llm-private|new-secret|unknown-private/)
    const result = await runTurn(
      {
        prompt: async () => {
          throw new Error('provider body llm-private')
        },
        cancel: async () => {},
      },
      'task',
      1000,
      10,
    )
    expect(JSON.stringify(result)).not.toContain('llm-private')
    expect(result.errorCode).toBe('RPC_OR_PROCESS_ERROR')
    const capacity = { contextWindow: 1_000_000, maxTokens: 393216, compat: { maxTokensField: 'max_tokens' } }
    const scrub = outputSanitizer(
      { BENCH_RELAY_TOKEN: 'relay-private' },
      { custom: { maxTokensField: 'max_tokens' }, apiKey: 'llm-private' },
    )
    expect(scrub(capacity)).toEqual(capacity)
    expect(scrub({ max_tokens_field: 'max_tokens', token: 'relay-private', apiKey: 'llm-private' })).toEqual({
      max_tokens_field: 'max_tokens',
      token: '[REDACTED]',
      apiKey: '[REDACTED]',
    })
  })

  it('binds environment configuration without accepting conflicting sources or printing bad JSON', () => {
    const parsed = parseRequest(request)
    expect(
      boundConfig(parsed, { AGH_TB_CONFIG_JSON: '{"providerId":"custom-openai","apiKey":"scoped-secret"}' })
        .config?.apiKey,
    ).toBe('scoped-secret')
    expect(
      boundConfig(parsed, {
        AGH_TB_CONFIG_SECRET_JSON: '{"apiKey":"scoped-secret"}',
        AGH_TB_CONFIG_JSON: 'invalid',
      }).config?.apiKey,
    ).toBe('scoped-secret')
    expect(() => boundConfig({ ...parsed, config: {} as never }, { AGH_TB_CONFIG_JSON: '{}' })).toThrow(
      'CONFIG_SOURCE_CONFLICT',
    )
    expect(() => boundConfig(parsed, { AGH_TB_CONFIG_JSON: 'scoped-secret' })).toThrow('CONFIG_INVALID')
  })

  it('does not claim a complete export from a suffix or from a gapped stream', () => {
    const event = (seq: number) => ({ seq }) as never
    expect(completePrefix([event(1), event(2), event(3)], 3)).toBe(true)
    expect(completePrefix([event(3)], 3)).toBe(false)
    expect(completePrefix([event(1), event(3)], 3)).toBe(false)
  })
})

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionModelSlotsResult } from '@agnes/protocol'
