import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { defaultLoopPlugin, memoryPlugin, sandboxImplementation, sandboxWorkspaceProbe } from '@agnes/base'
import type { ApprovalRequest } from '@agnes/core'
import { createPlatform } from '@agnes/host-infrastructure/adapters/platform'
import { RequestTraceStore } from '@agnes/host-infrastructure/request-traces'
import { createSandboxSeam } from '@agnes/host-infrastructure/sandbox-seam'
import { observabilityPlugin } from '@agnes/observability'
import { memoryCollector } from '@agnes/observability/testkit'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import type { InferenceEvent, JsonValue } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { baseSeamFactories, createTestHost } from '../testkit/index.js'

const homes: string[] = []
// Windows exercises the real unimplemented-backend path, including the memory exception.
// Other platforms retain the simulated L1 fixture; real OS isolation has separate acceptance tests.
const nativeWindows = process.platform === 'win32'
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})
const call = (name: string, args: Record<string, JsonValue>): InferenceEvent[] => [
  { type: 'toolcall_end', call: { toolUseId: '', name, args, ordinal: 0 }, via: 'native' },
  { type: 'done', reason: 'toolUse' },
]
const done: InferenceEvent[] = [
  { type: 'text_delta', delta: 'done' },
  { type: 'done', reason: 'stop' },
]
const plugins = [
  { export: 'defaultLoopPlugin', id: 'loop:agnes.default', inject: ['loops'], entry: defaultLoopPlugin },
  { export: 'memoryPlugin', id: 'memory:file', inject: ['providers'], entry: memoryPlugin },
].map(({ entry, ...declaration }) => ({
  declaration: {
    ...declaration,
    apiRange: '^4.0.0',
    default: true,
    provide: [],
    runtime: 'in-process' as const,
  },
  entry: normalizePluginExport(entry),
}))

it.each([
  'rejected',
  'allowed-session',
  'allowed-permanent',
  'missing-human',
  'pending',
  'agent',
  'no-handler',
  'policy_denied',
  'subagent_scope',
  'cas-conflict',
  'metadata-failure',
] as const)(
  'settles an initial %s memory write without losing revision or approval facts',
  async (initialAnswer) => {
    const home = await mkdtemp(join(tmpdir(), 'agh-host-memory-'))
    homes.push(home)
    const asked: ApprovalRequest[] = []
    const collector = await memoryCollector()
    let allowed = false
    let provider: ScriptedProvider | undefined
    const { host } = await createTestHost({
      dataDir: home,
      ...(nativeWindows ? { platform: createPlatform(), sandboxSeam: createSandboxSeam() } : {}),
      disableSessionTitle: true,
      allowed: ['standard', 'full-access'],
      presets: {
        'full-access': {
          name: 'full-access',
          extends: 'standard',
          providers: { 'tool-policy': { provider: 'full-access' } },
          sandbox: { level: 'L0', required: false, on_unavailable: 'allow' },
        },
      },
      packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
      packages: {
        '@agnes/base': {
          ...(nativeWindows ? { sandboxImplementation, sandboxWorkspaceProbe } : {}),
          plugins: [
            ...plugins,
            {
              declaration: {
                export: 'observabilityPlugin',
                id: 'observability:otel',
                inject: ['providers'],
                provide: [],
                apiRange: '^4.0.0',
                default: true,
                runtime: 'in-process',
                config: { enabled: true, redaction: 'content', endpoint: collector.endpoint },
              },
              entry: normalizePluginExport(observabilityPlugin),
            },
          ],
          seams: { checkpoint: baseSeamFactories.checkpoint },
        },
      },
      approval: async (request) => {
        if (request.scope.startsWith('memory:')) {
          asked.push(request)
          if (initialAnswer === 'cas-conflict') {
            if (!memory) throw new Error('missing memory')
            const before = await memory.readFile('MEMORY.md')
            await memory.editFile('MEMORY.md', 'Human concurrent revision', before.hash)
          }
          if (initialAnswer === 'metadata-failure') {
            if (!memory) throw new Error('missing memory')
            await mkdir(join(memory.root, 'writer.json'))
          }
          if (allowed || initialAnswer === 'cas-conflict' || initialAnswer === 'metadata-failure')
            return {
              verdict: 'allowed-once',
              answeredBy: { id: 'reviewer', org: 'local', role: 'user', deptPath: [], attrs: {} },
            }
          if (initialAnswer === 'pending') return { ticket: 'memory-pending', expiresAt: request.deadline }
          if (initialAnswer === 'missing-human') return 'allowed-once'
          if (initialAnswer === 'no-handler') return { verdict: 'unavailable', reason: 'no-handler' }
          if (initialAnswer === 'policy_denied' || initialAnswer === 'subagent_scope')
            return { verdict: 'rejected', reason: initialAnswer }
          return {
            verdict: initialAnswer === 'agent' ? 'allowed-once' : initialAnswer,
            answeredBy: {
              id: 'reviewer',
              org: 'local',
              role: initialAnswer === 'agent' ? 'agent' : 'user',
              deptPath: [],
              attrs: {},
            },
          }
        }
        return {
          verdict: 'allowed-once',
          answeredBy: { id: 'reviewer', org: 'local', role: 'user', deptPath: [], attrs: {} },
        }
      },
      provider: (profile) => {
        const memory = hostMemoryRoot(home)
        provider = new ScriptedProvider({
          models: profile.provider.routes?.[0]?.models ?? [],
          scripts: [
            call('write', { path: memory, content: 'Prefer short answers.' }),
            done,
            call('write', { path: memory, content: 'Prefer short answers.' }),
            done,
            call('read', { path: memory }),
            done,
            call('edit', { path: memory, edits: [{ oldText: 'short', newText: 'precise' }] }),
            done,
            call('read', { path: memory }),
            call('write', { path: memory, content: 'Bypass off' }),
            call('edit', { path: memory, edits: [{ oldText: 'precise', newText: 'long' }] }),
            done,
          ],
        })
        return provider
      },
    })
    const memory = host.memory(home, 'human')
    if (!memory || !provider) throw new Error('missing memory or provider')
    await memory.configure({ mode: 'ask' })
    async function turn(key: string) {
      const session = await host.createSession({ key, cwd: home, preset: 'full-access' })
      if (nativeWindows)
        expect(host.sessionRuntime?.(key).policy?.sandbox.enforcement).toEqual({
          level: 'partial',
          scope: ['file'],
        })
      const before = session.lastSeq
      await session.enqueue('next-turn', {
        actor: session.d.actor,
        content: [{ type: 'text', text: 'exercise ordinary memory file tools' }],
      })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        initialAnswer === 'cas-conflict' || initialAnswer === 'metadata-failure' ? 'parked' : 'completed',
      )
      const request = provider?.calls.at(-1)
      const revision = /Revision: ([a-f0-9]+)/.exec(request?.system ?? '')?.[1]
      expect(request?.traceContext?.memoryRevision).toBe(revision)
      return { session, results: await session.scan({ fromSeq: before + 1, type: 'tool/result', limit: 20 }) }
    }
    try {
      const rejected = await turn('rejected')
      if (initialAnswer === 'cas-conflict' || initialAnswer === 'metadata-failure') {
        expect(rejected.results[0]?.data).toMatchObject({ isError: true, code: 'TOOL_OUTCOME_UNKNOWN' })
        expect((await memory.readFile('MEMORY.md')).content).toBe(
          initialAnswer === 'cas-conflict' ? 'Human concurrent revision' : 'Prefer short answers.',
        )
        const rows = await rejected.session.scan({ type: ['decision/state', 'effect/settled'], limit: 100 })
        expect(
          rows.some(
            (row) =>
              row.type === 'decision/state' &&
              (row.data as { request: { spec: { purpose: string } } }).request.spec.purpose ===
                'unknown-outcome',
          ),
        ).toBe(true)
        expect(
          rows.some(
            (row) =>
              row.type === 'effect/settled' && (row.data as { outcome?: string }).outcome === 'unknown',
          ),
        ).toBe(true)
        return
      }
      expect(rejected.results[0]?.data).toMatchObject({
        isError: true,
        code: 'TOOL_REJECTED_BEFORE_EFFECT',
        structured: { effect: 'none' },
      })
      expect(
        (await rejected.session.decisions.list()).some(
          (value) => value.request.spec.purpose === 'unknown-outcome',
        ),
      ).toBe(false)
      expect((await rejected.session.decisions.list()).at(-1)?.result).toMatchObject(
        initialAnswer === 'rejected'
          ? { reason: 'answered', response: { option: 'rejected' } }
          : {
              reason: 'unavailable',
              code: ['no-handler', 'policy_denied', 'subagent_scope'].includes(initialAnswer)
                ? initialAnswer
                : 'invalid-answer',
            },
      )
      expect(
        await rejected.session.scan({ type: ['approval/asked', 'approval/decided'], limit: 100 }),
      ).toEqual([])
      const memoryDecision = (await rejected.session.decisions.list()).at(-1)
      expect(memoryDecision?.request.spec).toMatchObject({
        purpose: 'memory',
        options: ['allowed-once', 'rejected'],
      })
      if (initialAnswer === 'pending' && memoryDecision)
        await expect(
          rejected.session.decideApproval({
            command: {
              handle: memoryDecision.handle,
              revision: memoryDecision.revision,
              commandId: 'late-candidate',
              response: { option: 'allowed-once', value: null },
            },
            context: { actor: rejected.session.d.actor, category: 'human', authorize() {} },
          }),
        ).rejects.toThrow('NOT_PENDING')
      expect((await memory.readFile('MEMORY.md')).content).toBe('')
      allowed = true
      const accepted = await turn('accepted')
      expect(accepted.results[0]?.data).not.toMatchObject({ isError: true })
      expect((await memory.readFile('MEMORY.md')).content).toBe('Prefer short answers.')
      expect(asked).toHaveLength(2)
      expect(asked[1]).toMatchObject({
        options: ['allowed-once', 'rejected'],
        tool: {
          args: {
            path: join(memory.root, 'MEMORY.md'),
            baseHash: expect.any(String),
            newHash: expect.any(String),
            diff: expect.stringContaining('+Prefer short answers.'),
            source: { sessionKey: 'accepted', turn: 1 },
          },
        },
      })
      const read = await turn('read')
      expect(JSON.stringify(read.results[0]?.data)).toContain('Memory revision:')
      expect(JSON.stringify(provider.calls.at(-1)?.system)).toContain('Prefer short answers.')
      const edited = read.session
      await edited.enqueue('next-turn', {
        actor: edited.d.actor,
        content: [{ type: 'text', text: 'edit remembered preference' }],
      })
      expect((await edited.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      expect((await memory.readFile('MEMORY.md')).content).toBe('Prefer precise answers.')
      await memory.configure({ mode: 'off' })
      const off = await turn('off')
      expect(off.results).toHaveLength(3)
      for (const result of off.results) expect(result.data).toMatchObject({ isError: true })
      expect(JSON.stringify(provider.calls.at(-1)?.system)).not.toContain('Agent memory')
      expect((await memory.readFile('MEMORY.md')).content).toBe('Prefer precise answers.')
    } finally {
      await host.close()
      await collector.close()
    }
    expect(collector.requests.length).toBeGreaterThan(0)
    const telemetry = JSON.stringify(collector.requests)
    for (const privateText of [
      'Prefer short answers.',
      'Prefer precise answers.',
      'Bypass off',
      'exercise ordinary memory',
    ])
      expect(telemetry).not.toContain(privateText)
  },
)

it('pins index and topic revisions across tool requests and a model retry, then refreshes next turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agh-memory-turn-'))
  homes.push(home)
  let provider: ScriptedProvider | undefined
  const { host } = await createTestHost({
    dataDir: home,
    ...(nativeWindows ? { platform: createPlatform(), sandboxSeam: createSandboxSeam() } : {}),
    disableSessionTitle: true,
    presets: {
      standard: {
        name: 'standard',
        extends: 'base',
        model: { route: { primary: 'default' }, retry: { max_attempts: 2, base_delay_ms: 1 } },
        sandbox: { level: 'L1', required: false, on_unavailable: 'allow-if-unimplemented' },
      },
    },
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    packages: {
      '@agnes/base': {
        plugins,
        seams: { checkpoint: baseSeamFactories.checkpoint },
        ...(nativeWindows ? { sandboxImplementation, sandboxWorkspaceProbe } : {}),
      },
    },
    provider: (profile) => {
      provider = new ScriptedProvider({
        models: profile.provider.routes?.[0]?.models ?? [],
        scripts: [
          call('read', { path: join(hostMemoryRoot(home), '..', 'topic.md') }),
          [
            {
              type: 'error',
              reason: 'error',
              code: 'TRANSPORT',
              message: 'synthetic lost response',
              retryable: true,
            },
          ],
          done,
          done,
        ],
        onExhausted: 'error',
      })
      const infer = provider.infer.bind(provider)
      provider.infer = async function* (request, options) {
        if (this.calls.length === 0) {
          const memory = host.memory(home, 'human')
          if (!memory) throw new Error('missing memory')
          for (const [file, content] of [
            ['topic.md', 'New topic'],
            ['MEMORY.md', 'New preference [topic](topic.md)'],
          ] as const) {
            const prior = await memory.readFile(file)
            await memory.editFile(file, content, prior.hash)
          }
        }
        yield* infer(request, options)
      }
      return provider
    },
  })
  try {
    const memory = host.memory(home, 'human')
    if (!memory || !provider) throw new Error('missing memory or provider')
    await memory.configure({ mode: 'auto' })
    for (const [file, content] of [
      ['topic.md', 'Old topic'],
      ['MEMORY.md', 'Old preference [topic](topic.md)'],
    ] as const) {
      const prior = await memory.readFile(file)
      await memory.editFile(file, content, prior.hash)
    }
    const session = await host.createSession({ key: 'turn-snapshot', cwd: home })
    if (nativeWindows)
      expect(host.sessionRuntime?.(session.key).policy?.sandbox.enforcement).toEqual({
        level: 'partial',
        scope: ['file'],
      })
    const turn = async () => {
      await session.enqueue('next-turn', {
        actor: session.d.actor,
        content: [{ type: 'text', text: 'use memory' }],
      })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
    }
    await turn()
    expect(provider.calls).toHaveLength(3)
    for (const request of provider.calls) {
      expect(JSON.stringify(request.system)).toContain('Old preference')
      expect(JSON.stringify(request.system)).not.toContain('New preference')
    }
    const results = await session.scan({ type: 'tool/result', limit: 10 })
    expect(results).toHaveLength(1)
    expect(JSON.stringify(results[0]?.data)).toContain('Old topic')
    expect(JSON.stringify(results[0]?.data)).not.toContain('New topic')
    const revision = /Revision: ([a-f0-9]+)/.exec(JSON.stringify(provider.calls[0]?.system))?.[1]
    expect(revision).toBeTruthy()
    const traces = new RequestTraceStore(home, 'memory-revision')
    for (const request of provider.calls) {
      expect(JSON.stringify(request.system)).toContain(`Revision: ${revision}.`)
      expect(request.traceContext?.memoryRevision).toBe(revision)
      const capture = await traces.begin(request)
      await capture.finish()
      expect((await traces.get('turn-snapshot', capture.id)).snapshot?.memoryRevision).toBe(revision)
    }
    await turn()
    expect(provider.calls).toHaveLength(4)
    expect(JSON.stringify(provider.calls.at(-1)?.system)).toContain('New preference')
    expect(JSON.stringify(provider.calls.at(-1)?.system)).not.toContain(`Revision: ${revision}.`)
    const refreshed = /Revision: ([a-f0-9]+)/.exec(JSON.stringify(provider.calls.at(-1)?.system))?.[1]
    expect(provider.calls.at(-1)?.traceContext?.memoryRevision).toBe(refreshed)
  } finally {
    await host.close()
  }
})

// The same public provider path as Host, rather than a machine-specific fixture directory.
import { fileMemoryRoots } from '@agnes/base'

function hostMemoryRoot(home: string) {
  return join(fileMemoryRoots(home, home).root, 'MEMORY.md')
}
