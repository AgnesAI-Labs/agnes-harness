import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { defaultLoopPlugin, memoryPlugin, sandboxImplementation, sandboxWorkspaceProbe } from '@agnes/base'
import { loadPreset } from '@agnes/code'
import type { ApprovalRequest } from '@agnes/core'
import { createPlatform } from '@agnes/host-infrastructure/adapters/platform'
import { RequestTraceStore } from '@agnes/host-infrastructure/request-traces'
import { createSandboxSeam } from '@agnes/host-infrastructure/sandbox-seam'
import { observabilityPlugin } from '@agnes/observability'
import { memoryCollector } from '@agnes/observability/testkit'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import type { InferenceEvent, JsonValue, RequestBody } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { baseSeamFactories, createTestHost } from '../testkit/index.js'

const homes: string[] = []
const memoryIndex = (request: RequestBody | undefined): string =>
  request?.messages
    .flatMap((message) =>
      message.content.flatMap((block) =>
        block.type === 'text' &&
        block.text.startsWith('[live context ') &&
        block.text.includes('\nmemory:index\n')
          ? [block.text]
          : [],
      ),
    )
    .at(-1) ?? ''
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
    apiRange: '^5.0.0',
    default: true,
    provide: [],
    runtime: 'in-process' as const,
  },
  entry: normalizePluginExport(entry),
}))

const memoryCases = [
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
] as const
it.each(
  ['standard', 'memory-write', 'memory-full'].flatMap((preset) =>
    (preset === 'memory-full' ? ['rejected' as const] : memoryCases).map((initialAnswer) => ({
      preset,
      initialAnswer,
    })),
  ),
)(
  'settles an initial $initialAnswer memory write under $preset without losing revision or approval facts',
  // This contract runs several real Host turns and flushes the telemetry collector.
  { timeout: 60_000 },
  async ({ initialAnswer, preset }) => {
    const home = await mkdtemp(join(tmpdir(), 'agh-host-memory-'))
    homes.push(home)
    const workspace = join(home, 'workspace')
    const extra = join(home, 'extra')
    await Promise.all([mkdir(workspace), mkdir(extra)])
    const asked: ApprovalRequest[] = []
    const collector = await memoryCollector()
    let allowed = false
    let provider: ScriptedProvider | undefined
    const { host } = await createTestHost({
      dataDir: home,
      workspaceRoot: workspace,
      ...(nativeWindows ? { platform: createPlatform(), sandboxSeam: createSandboxSeam() } : {}),
      disableSessionTitle: true,
      allowed: ['standard', 'memory-write', 'memory-full'],
      presets: {
        standard: {
          name: 'standard',
          extends: 'base',
          sandbox: { extra_paths: [extra] },
          approval: {
            command_policy: [{ tool: 'edit|write', argv: '^/.*$', action: 'allow' }],
          },
        },
        'memory-write': { name: 'memory-write', extends: 'standard' },
        'memory-full': { name: 'memory-full', extends: 'base' },
        'permission-full-access': loadPreset('permission-full-access'),
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
                apiRange: '^5.0.0',
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
        const memory = hostMemoryRoot(home, workspace)
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
            call('write', { path: memory, content: 'Prefer precise answers.' }),
            done,
            ...(initialAnswer === 'rejected'
              ? [
                  call('write', { path: join(extra, 'created.txt'), content: 'Explicit extra root' }),
                  done,
                  call('read', { path: join(extra, 'created.txt') }),
                  done,
                ]
              : []),
            call('read', { path: memory }),
            call('write', { path: memory, content: 'Bypass off' }),
            call('edit', { path: memory, edits: [{ oldText: 'precise', newText: 'long' }] }),
            done,
          ],
        })
        return provider
      },
    })
    const memory = host.memory(workspace, 'human')
    if (!memory || !provider) throw new Error('missing memory or provider')
    await memory.configure({ mode: 'ask' })
    async function turn(key: string) {
      const session = await host.createSession({
        key,
        cwd: workspace,
        preset,
        permission: preset === 'memory-full' ? 'full-access' : 'default',
      })
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
      // An uncertain memory write asks whether it happened; the approver answers at once, so the
      // answer is consumed with the result and the turn completes rather than parking.
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      const request = provider?.calls.at(-1)
      const revision = /Revision: ([a-f0-9]+)/.exec(memoryIndex(request))?.[1]
      expect(request?.traceContext?.memoryRevision).toBe(revision)
      return { session, results: await session.scan({ fromSeq: before + 1, type: 'tool/result', limit: 20 }) }
    }
    try {
      const rejected = await turn('rejected')
      if (preset === 'memory-full') {
        expect(rejected.results[0]?.data).toMatchObject({ isError: false })
        expect((await memory.readFile('MEMORY.md')).content).toBe('Prefer short answers.')
        expect(asked).toEqual([])
        const decisions = await rejected.session.decisions.list()
        expect(decisions.find((value) => value.request.spec.purpose === 'memory')).toMatchObject({
          result: {
            reason: 'answered',
            code: 'full-access',
            response: { option: 'allowed-once' },
            answeredBy: { role: 'system' },
          },
          consumption: expect.any(Object),
        })
        return
      }
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
          (await rejected.session.decisions.list()).find(
            (value) => value.request.spec.purpose === 'unknown-outcome',
          ),
        ).toMatchObject({ result: { reason: 'answered' }, consumption: expect.any(Object) })
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
      expect(memoryIndex(provider.calls.at(-1))).toContain('Prefer short answers.')
      const edited = read.session
      await edited.enqueue('next-turn', {
        actor: edited.d.actor,
        content: [{ type: 'text', text: 'edit remembered preference' }],
      })
      expect((await edited.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      expect((await memory.readFile('MEMORY.md')).content).toBe('Prefer precise answers.')
      await memory.configure({ mode: 'auto' })
      const beforeAuto = asked.length
      const automatic = await turn('auto')
      expect(automatic.results.every((row) => !(row.data as { isError?: boolean }).isError)).toBe(true)
      expect(asked).toHaveLength(beforeAuto)
      if (initialAnswer === 'rejected') {
        expect((await turn('extra-write')).results[0]?.data).toMatchObject({ isError: false })
        expect((await turn('extra-read')).results[0]?.data).toMatchObject({ isError: false })
      }
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
      expect(memoryIndex(request)).toContain('Old preference')
      expect(memoryIndex(request)).not.toContain('New preference')
      expect(request.system).not.toContain('Agent memory')
    }
    const results = await session.scan({ type: 'tool/result', limit: 10 })
    expect(results).toHaveLength(1)
    expect(JSON.stringify(results[0]?.data)).toContain('Old topic')
    expect(JSON.stringify(results[0]?.data)).not.toContain('New topic')
    const revision = /Revision: ([a-f0-9]+)/.exec(memoryIndex(provider.calls[0]))?.[1]
    expect(revision).toBeTruthy()
    const traces = new RequestTraceStore(home, 'memory-revision')
    for (const request of provider.calls) {
      expect(memoryIndex(request)).toContain(`Revision: ${revision}.`)
      expect(request.traceContext?.memoryRevision).toBe(revision)
      const capture = await traces.begin(request)
      await capture.finish()
      expect((await traces.get('turn-snapshot', capture.id)).snapshot?.memoryRevision).toBe(revision)
    }
    await turn()
    expect(provider.calls).toHaveLength(4)
    expect(memoryIndex(provider.calls.at(-1))).toContain('New preference')
    expect(memoryIndex(provider.calls.at(-1))).not.toContain(`Revision: ${revision}.`)
    expect(new Set(provider.calls.map((request) => request.system)).size).toBe(1)
    const refreshed = /Revision: ([a-f0-9]+)/.exec(memoryIndex(provider.calls.at(-1)))?.[1]
    expect(provider.calls.at(-1)?.traceContext?.memoryRevision).toBe(refreshed)
  } finally {
    await host.close()
  }
})

// The same public provider path as Host, rather than a machine-specific fixture directory.
import { fileMemoryRoots } from '@agnes/base'

function hostMemoryRoot(home: string, workspace = home) {
  return join(fileMemoryRoots(home, workspace).root, 'MEMORY.md')
}

it('i01: turning full access off in a workspace session prevents a fresh automatic memory write', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agh-i01-memory-off-'))
  homes.push(home)
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const target = hostMemoryRoot(home, workspace)
  const { host } = await createTestHost({
    dataDir: home,
    workspaceRoot: workspace,
    disableSessionTitle: true,
    allowed: ['standard'],
    presets: {
      'permission-full-access': loadPreset('permission-full-access'),
      'permission-workspace-write': loadPreset('permission-workspace-write'),
    },
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    packages: { '@agnes/base': { plugins } },
    approval: async () => ({ verdict: 'rejected' }),
    script: [() => call('write', { path: target, content: 'I01_UNAUTHORIZED_MEMORY' }), () => done],
  })
  try {
    const inspection = host.memory(workspace, 'human')
    if (!inspection) throw new Error('Memory unavailable')
    await inspection.configure({ mode: 'ask' })
    const session = await host.createSession({
      cwd: workspace,
      preset: 'standard',
      permission: 'workspace-write',
    })
    await session.setYolo(true, session.d.actor)
    expect(session.yolo).toBe(true)
    await session.setYolo(false, session.d.actor)
    const off = await session.scan({ type: 'x/core/yolo-switch', order: 'desc', limit: 1 })
    expect(off[0]?.data).toMatchObject({ to: false })
    expect.soft(session.yolo).toBe(false)
    await session.enqueue('next-turn', {
      actor: session.d.actor,
      content: [{ type: 'text', text: 'Write the preference after disabling full access' }],
    })
    await session.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
    const decision = (await session.decisions.list()).find((row) => row.request.spec.purpose === 'memory')
    expect.soft(decision?.result).not.toEqual(expect.objectContaining({ code: 'full-access' }))
    expect((await inspection.readFile('MEMORY.md')).content).toBe('')
  } finally {
    await host.close()
  }
})

it('round4: a memory file awaiting its approved response cannot write after the session is narrowed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agh-memory-permission-review-'))
  homes.push(home)
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const target = hostMemoryRoot(home, workspace)
  const { host } = await createTestHost({
    dataDir: home,
    workspaceRoot: workspace,
    allowed: ['standard'],
    presets: { 'permission-workspace-write': loadPreset('permission-workspace-write') },
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    packages: { '@agnes/base': { plugins } },
    approval: async () => {
      throw new Error('Unexpected human approval')
    },
    script: [() => call('write', { path: target, content: 'Reviewed preference.' }), () => done],
  })
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  let run: Promise<unknown> | undefined
  try {
    const inspection = host.memory(workspace, 'human')
    if (!inspection) throw new Error('Memory unavailable')
    await inspection.configure({ mode: 'ask' })
    const session = await host.createSession({
      cwd: workspace,
      preset: 'standard',
      permission: 'workspace-write',
    })
    await session.setYolo(true, session.d.actor)
    expect(session.permissionContext.policy).toBe('full-access')
    const memory = session.d.memory
    if (!memory) throw new Error('Session memory unavailable')
    const wrapped: typeof memory = {
      ...memory,
      files: (fallback, source, signal, approve) =>
        memory.files(fallback, source, signal, async (proposal) => {
          const result = await approve(proposal)
          if (result.status === 'approved') {
            entered()
            await gate
          }
          return result
        }),
    }
    Object.assign(session.d, { memory: wrapped })
    await session.enqueue('next-turn', {
      actor: session.d.actor,
      content: [{ type: 'text', text: 'Review memory commit' }],
    })
    run = session.run({ until: 'turn-end', signal: new AbortController().signal })
    await reached
    const decision = (await session.decisions.list()).find((row) => row.request.spec.purpose === 'memory')
    expect(decision?.result).toMatchObject({ code: 'full-access' })
    expect(decision?.consumption).not.toBeNull()
    // Use the live permission switch used by Web/TUI; a preset cannot refit Host isolation.
    await session.setYolo(false, session.d.actor)
    expect(session.permissionContext.policy).toBe('workspace-write')
    release()
    await run
    expect((await inspection.readFile('MEMORY.md')).content).toBe('')
  } finally {
    release()
    await run?.catch(() => undefined)
    await host.close()
  }
})

it('i01: a consumed automatic memory grant cannot commit after a workspace permission switch', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agh-memory-permission-review-'))
  homes.push(home)
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const target = hostMemoryRoot(home, workspace)
  const { host } = await createTestHost({
    dataDir: home,
    workspaceRoot: workspace,
    allowed: ['standard'],
    presets: {
      'permission-full-access': loadPreset('permission-full-access'),
      'permission-workspace-write': loadPreset('permission-workspace-write'),
    },
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    packages: { '@agnes/base': { plugins } },
    approval: async () => {
      throw new Error('Unexpected human approval')
    },
    script: [() => call('write', { path: target, content: 'Reviewed preference.' }), () => done],
  })
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  let run: Promise<unknown> | undefined
  try {
    const inspection = host.memory(workspace, 'human')
    if (!inspection) throw new Error('Memory unavailable')
    await inspection.configure({ mode: 'ask' })
    const session = await host.createSession({
      cwd: workspace,
      preset: 'standard',
      permission: 'workspace-write',
    })
    await session.setYolo(true, session.d.actor)
    const memory = session.d.memory
    if (!memory) throw new Error('Session memory unavailable')
    const wrapped: typeof memory = {
      ...memory,
      files: (fallback, source, signal, approve) =>
        memory.files(fallback, source, signal, async (proposal) => {
          const result = await approve(proposal)
          if (result.status === 'approved') {
            entered()
            await gate
          }
          return result
        }),
    }
    Object.assign(session.d, { memory: wrapped })
    await session.enqueue('next-turn', {
      actor: session.d.actor,
      content: [{ type: 'text', text: 'Review memory commit' }],
    })
    run = session.run({ until: 'turn-end', signal: new AbortController().signal })
    await reached
    const decision = (await session.decisions.list()).find((row) => row.request.spec.purpose === 'memory')
    expect(decision?.result).toMatchObject({ code: 'full-access' })
    expect(decision?.consumption).not.toBeNull()
    await session.setYolo(false, session.d.actor)
    expect(session.permissionContext.policy).toBe('workspace-write')
    release()
    await run
    expect((await inspection.readFile('MEMORY.md')).content).toBe('')
  } finally {
    release()
    await run?.catch(() => undefined)
    await host.close()
  }
})
