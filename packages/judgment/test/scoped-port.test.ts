import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { HookContext, SideCallOptions, SideCallPort } from '@agnes/extension-api'
import { createTestHost, runOnce } from '@agnes/host/testkit'
import { expect, it, vi } from 'vitest'
import { createAnswerCache } from '../src/cache.js'
import { createJudge, type JudgeOutcome } from '../src/judge.js'

vi.mock('../../package-manager/src/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../package-manager/src/index.js')>()
  return {
    ...actual,
    HOST_CAPABILITY_GRANTS: actual.HOST_CAPABILITY_GRANTS.map((grant) =>
      grant.packageId === '@agnes/base'
        ? { ...grant, extensions: { ...grant.extensions, 'agnes/tools-search': { sideCall: true } } }
        : grant,
    ),
  }
})

it('uses local ids for real Core-scoped status and replays both ordinary and long valid identities', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-judgment-scoped-'))
  const base = join(root, 'base'),
    extension = join(base, 'search')
  mkdirSync(extension, { recursive: true })
  writeFileSync(
    join(base, 'package.json'),
    JSON.stringify({ name: '@agnes/base', version: '0.1.0', agnes: { extensions: ['./search'] } }),
  )
  writeFileSync(
    join(extension, 'package.json'),
    JSON.stringify({
      name: '@agnes/tools-search',
      version: '0.1.0',
      exports: './index.js',
      agnes: {
        plugins: [
          {
            id: 'ext:agnes/tools-search',
            export: 'default',
            runtime: 'in-process',
            apiRange: '^5.0.0',
            inject: ['self', 'sideCall', 'hooks'],
            capabilities: { hooks: ['turn_stopping'] },
          },
        ],
      },
    }),
  )
  writeFileSync(join(extension, 'index.js'), 'export default {}')
  const outcomes: JudgeOutcome[] = []
  let hookCalls = 0
  let hookError: unknown
  const preparedIds: string[] = [],
    statusIds: string[] = []
  let provider: ScriptedProvider | undefined
  const request = {
    state: 'synthetic',
    questions: { q: { type: 'noul' as const, instructions: 'complete?' } },
  }
  const check = async (ctx: HookContext) => {
    const real = ctx.sideCall
    if (!real) throw new Error('actual hook sideCall was not authorized')
    const observed: SideCallPort = {
      async prepare(options: SideCallOptions) {
        const prepared = await real.prepare(options)
        preparedIds.push(prepared.invocationId)
        return prepared
      },
      invoke: (prepared, signal) => real.invoke(prepared, signal),
      status(id) {
        statusIds.push(id)
        return real.status(id)
      },
    }
    for (const idPrefix of ['hook:short', 'a'.repeat(100)]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        outcomes.push(
          await createJudge({
            port: observed,
            chain: [{ route: 'gw', model: 'm1', native: true }],
            cache: createAnswerCache(null, { ttlMs: 86400000, maxEntries: 10 }),
            now: Date.now,
          }).judge('judgment.scoped', request, {
            attemptMs: 5000,
            totalMs: 10000,
            signal: ctx.signal,
            idPrefix,
            retry: 'none',
          }),
        )
      }
    }
    expect(provider?.calls.filter((req) => req.payload)).toHaveLength(2)
    const partial = {
      ...request,
      questions: { ...request.questions, other: { type: 'noul' as const, instructions: 'other?' } },
    }
    const warm = createAnswerCache(null, { ttlMs: 86400000, maxEntries: 10 })
    const native = { route: 'gw', model: 'm1', native: true }
    warm.set(partial.state, native, partial.questions.q, { type: 'noul', noul: 0.8 })
    for (const answerCache of [
      warm,
      createAnswerCache(null, { ttlMs: 86400000, maxEntries: 10 }),
      createAnswerCache(null, { ttlMs: 86400000, maxEntries: 10 }),
    ]) {
      outcomes.push(
        await createJudge({ port: observed, chain: [native], cache: answerCache, now: Date.now }).judge(
          'judgment.scoped',
          partial,
          { attemptMs: 5000, totalMs: 10000, signal: ctx.signal, idPrefix: 'p'.repeat(100), retry: 'none' },
        ),
      )
    }
    return { action: 'stop' as const }
  }
  const h = await createTestHost({
    dataDir: join(root, 'home'),
    disableSessionTitle: true,
    packageDirs: { '@agnes/base': base },
    provider(profile) {
      provider = new ScriptedProvider({
        models: profile.provider.routes?.flatMap((route) => route.models ?? []) ?? [],
        scripts: [
          (req) => [
            {
              type: 'text_delta',
              delta: req.payload
                ? JSON.stringify(
                    Object.fromEntries(
                      Object.keys((req.payload as { questions: Record<string, unknown> }).questions).map(
                        (id) => [id, { type: 'noul', noul: 0.9 }],
                      ),
                    ),
                  )
                : 'Complete.',
            },
            {
              type: 'usage',
              tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              credits: 0,
              creditSource: 'estimated',
            },
            { type: 'done', reason: 'stop' },
          ],
        ],
      })
      return provider
    },
    packages: {
      '@agnes/base': {
        ecosystem: {
          'agnes/tools-search': () => (api) => {
            api.registerHook('turn_stopping', async (_payload, ctx) => {
              hookCalls++
              try {
                return await check(ctx)
              } catch (error) {
                hookError = error
                return { action: 'stop' }
              }
            })
          },
        },
      },
    },
  })
  try {
    expect(
      h.host.kernel.hooks
        .snapshot('agnes/tools-search')
        .entries('turn_stopping')
        .map((entry) => entry.meta),
    ).toMatchObject([{ sideCall: true }])
    expect(h.host.extensions().find((entry) => entry.id === 'agnes/tools-search')).toMatchObject({
      loaded: true,
    })
    const turn = await runOnce(h.host, { prompt: 'synthetic replay check', cwd: join(root, 'home') })
    expect(turn.reason).toBe('completed')
    expect(hookCalls).toBe(1)
    expect(hookError).toBeUndefined()
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'])
    expect(outcomes.map((outcome) => outcome.accounting.calls.map((call) => call.replayed))).toEqual([
      [false],
      [true],
      [false],
      [true],
      [false],
      [true, false],
      [true, true],
    ])
    expect(provider?.calls.filter((req) => req.payload)).toHaveLength(4)
    expect(preparedIds.every((id) => /^c[0-9a-f]{8}:/.test(id))).toBe(true)
    expect(statusIds.every((id) => id.length <= 112 && !/^c[0-9a-f]{8}:/.test(id))).toBe(true)
    expect(statusIds.slice(0, 4)).toEqual([
      'hook:short:c0:a0',
      'hook:short:c0:a0',
      `${'a'.repeat(100)}:c0:a0`,
      `${'a'.repeat(100)}:c0:a0`,
    ])
  } finally {
    await h.host.close()
    rmSync(root, { recursive: true, force: true })
  }
})
