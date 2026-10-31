import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loopKind } from '@agnes/extension-api'
import { LOCAL_ARTIFACT_READ_MAX_BYTES } from '@agnes/host-artifacts/artifact-read-store'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import {
  capabilityHash,
  emptyLock,
  hashDirectory,
  type RuntimePluginSnapshot,
  writeLock,
} from '@agnes/package-manager'
import { defineAgnesPlugin, defineTool } from '@agnes/plugin-runtime'
import { createPluginRow } from '@agnes/plugin-runtime/host'
import type { InferenceEvent, JsonValue, UiSurface } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { expect, it } from 'vitest'
import { createTestHost } from '../testkit/index.js'

const surface = (revision: number): UiSurface => ({
  id: 'generic-review',
  revision,
  title: 'Review',
  placement: { inline: true, workbench: true },
  data: { status: revision === 1 ? 'Pending' : 'Approved' },
  components: [{ id: 'status', kind: 'status', dataKey: 'status' }],
  actions: [],
})
const call = (name: string, args: Record<string, JsonValue>): InferenceEvent[] => [
  { type: 'toolcall_end', via: 'native', call: { toolUseId: '', name, args, ordinal: 0 } },
  { type: 'done', reason: 'toolUse' },
]

it('retries rejected UI input and updates revision 2 in the same turn after approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-ui-approval-'))
  let approvalAsked!: () => void
  const asked = new Promise<void>((resolve) => {
    approvalAsked = resolve
  })
  let approve!: (answer: 'allowed-once') => void
  const approval = new Promise<'allowed-once'>((resolve) => {
    approve = resolve
  })
  const plugin = defineAgnesPlugin({
    inject: ['tools'],
    apply(ctx) {
      ctx.tools.register(
        defineTool({
          name: 'review_commit',
          description: 'Record a synthetic reviewed change',
          parameters: Type.Object({}),
          meta: {
            isReadOnly: false,
            isDestructive: false,
            isConcurrencySafe: false,
            isOpenWorld: false,
            replay: 'idempotent',
            requiresApproval: 'always',
            deferLoading: false,
            costHint: {},
          },
          execute: async () => ({ content: [{ type: 'text', text: 'Approved change recorded' }] }),
        }),
      )
    },
  })
  const directory = join(root, 'plugin')
  mkdirSync(directory)
  writeFileSync(join(directory, 'index.js'), 'synthetic-review-plugin')
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'fixture/review',
      version: '1.0.0',
      main: './index.js',
      agnes: { plugins: [{ export: 'main', apiRange: '^5.0.0', default: true, inject: ['tools'] }] },
    }),
  )
  const integrity = `sha256-${'a'.repeat(64)}`
  const source: RuntimePluginSnapshot = {
    generation: 1,
    trusted: true,
    snapshot: {
      snapshotId: integrity,
      integrity,
      profile: 'local-dev',
      packageId: 'fixture/review',
      version: '1.0.0',
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: capabilityHash({ dependencies: {} }),
      directory,
      contributions: [],
    },
  }
  const profileDir = join(root, 'profiles/local-dev')
  mkdirSync(profileDir, { recursive: true })
  writeLock(profileDir, {
    ...emptyLock('local-dev', '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(
      ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
        name,
        { provider: 'local' },
      ]),
    ),
    packages: {
      'fixture/review': {
        version: '1.0.0',
        treeIntegrity: source.snapshot.treeIntegrity,
        source: { type: 'file', ref: 'file:fixture' },
        integrity,
        trust: 'trusted',
        license: 'MIT',
        apiRange: '^5.0.0',
        dependencies: {},
        previous: null,
        state: { installed: new Date(0).toISOString(), trusted: new Date(0).toISOString(), enabled: true },
        trustDecision: {
          integrity,
          capabilityHash: source.snapshot.capabilityHash,
          decidedAt: new Date(0).toISOString(),
        },
      },
    },
  })
  const { host } = await createTestHost({
    dataDir: root,
    disableSessionTitle: true,
    presets: {
      standard: {
        name: 'standard',
        extends: 'base',
        tools: { core: ['tool_describe', 'ui_render', 'ui_update', 'review_commit'] },
      },
    },
    packageDirs: {
      '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)),
      'fixture/review': directory,
    },
    runtimePluginSources: async () => [source],
    extensionLoader: {
      async import(file: string) {
        if (readFileSync(file, 'utf8') === 'synthetic-review-plugin') return { main: plugin }
        return (await import(pathToFileURL(file).href)) as Record<string, unknown>
      },
    },
    approval: async () => {
      approvalAsked()
      return {
        verdict: await approval,
        answeredBy: { id: 'reviewer', org: 'local', role: 'user' as const, deptPath: [], attrs: {} },
      }
    },
    script: [
      call('tool_describe', { name: 'ui_render' }),
      call('tool_describe', { name: 'ui_update' }),
      call('ui_render', { surface: { ...surface(1), data: { status: { label: 'Ready' } } } }),
      call('ui_render', { surface: surface(1) }),
      call('review_commit', {}),
      call('ui_update', { surfaceId: 'generic-review', expectedRevision: 1, surface: surface(2) }),
      [
        { type: 'text_delta', delta: 'Updated' },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  const base = host.runtimeTargetSnapshot!()
  await host.applyRuntimeTarget(
    buildCompleteRuntimeTarget({
      rows: [
        ...base.tree.rows,
        createPluginRow({
          id: 'ext:fixture/review/main',
          plugin: `fixture/review@${integrity}/main`,
          snapshotDigest: integrity,
          exportName: 'main',
          entryRevision: integrity,
          extrasRevision: 'none',
          mountRevision: 'v1',
          inject: ['tools'],
        }),
      ],
      resources: base.resource.resources,
    }).target,
  )
  const ac = new AbortController()
  try {
    const session = await host.createSession({ cwd: root })
    await session.enqueue('next-turn', {
      actor: session.d.actor,
      content: [{ type: 'text', text: 'review and update' }],
    })
    const running = session.run({ until: 'turn-end', signal: ac.signal })
    await Promise.race([
      asked,
      running.then(async (out) => {
        throw new Error(
          `ended before approval: ${JSON.stringify(out)} ${JSON.stringify(await session.scan({ type: 'tool/result', toSeq: session.lastSeq }))}`,
        )
      }),
    ])
    expect(
      (await session.intelligentUi!.read({ sessionId: session.key }, ac.signal)).surfaces[0]?.surface
        .revision,
      JSON.stringify(await session.scan({ type: 'tool/result', toSeq: session.lastSeq })),
    ).toBe(1)
    approve('allowed-once')
    await expect(running).resolves.toMatchObject({ reason: 'completed' })
    expect(
      (await session.intelligentUi!.read({ sessionId: session.key }, ac.signal)).surfaces[0]?.surface
        .revision,
    ).toBe(2)
    const calls = await session.scan({ type: 'tool/call', toSeq: session.lastSeq })
    expect(calls.map((row) => (row.data as { name: string }).name)).toEqual([
      'tool_describe',
      'tool_describe',
      'ui_render',
      'ui_render',
      'review_commit',
      'ui_update',
    ])
    const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
    expect(results).toHaveLength(6)
    expect(results[2]?.data).toMatchObject({
      isError: true,
      structured: {
        code: 'UI_INVALID',
        effect: 'none',
        issues: [{ path: '/surface/data/status', expected: expect.stringContaining('string') }],
      },
    })
    expect(results[2]?.data).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('/surface/data/status') }],
    })
    expect(JSON.stringify(results[2]?.data)).not.toContain('TOOL_OUTCOME_UNKNOWN')
    expect(
      results.filter((_, index) => index !== 2).every((row) => !(row.data as { isError?: boolean }).isError),
    ).toBe(true)
    expect(
      await session.scan({ type: 'x/agnes/intelligent-ui/surface.opened', toSeq: session.lastSeq }),
    ).toHaveLength(1)
    expect(
      (await session.scan({ type: 'effect/settled', toSeq: session.lastSeq })).every(
        (row) => (row.data as { outcome: string }).outcome !== 'unknown',
      ),
    ).toBe(true)
    expect(await session.scan({ type: 'turn/start', toSeq: session.lastSeq })).toHaveLength(1)
  } finally {
    ac.abort()
    approve('allowed-once')
    await host.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('updates revision 2 through custom Loop tool ports after approval in one turn', async () => {
  const { createAuthorTestkit } = await import('@agnes/host/author-testkit')
  const { loopCheckpointCodec } = await import('@agnes/extension-api')
  const { defineLoop } = await import('@agnes/plugin-runtime')
  let asked!: () => void
  const pending = new Promise<void>((resolve) => {
    asked = resolve
  })
  let approve!: (answer: 'allowed-once') => void
  const decision = new Promise<'allowed-once'>((resolve) => {
    approve = resolve
  })
  const codec = loopCheckpointCodec(1, (value) => value)
  const loop: import('@agnes/extension-api').LoopFactory = defineLoop({
    id: 'fixture.review',
    version: '1.0.0',
    capabilities: ['tools'],
    codec,
    create(ctx) {
      return {
        async step(signal) {
          if (!(await ctx.input.accept())) return { outcome: 'idle' }
          for (const call of [
            { name: 'ui_render', args: { surface: surface(1) } },
            { name: 'review_commit', args: {} },
            {
              name: 'ui_update',
              args: { surfaceId: 'generic-review', expectedRevision: 1, surface: surface(2) },
            },
          ]) {
            const result = await ctx.tools.execute(call, signal)
            expect(result.isError, JSON.stringify(result)).not.toBe(true)
            if (call.name === 'ui_render') expect(result.details).toMatchObject({ surface: { revision: 1 } })
          }
          await ctx.events.finish('completed')
          return { outcome: 'turn-ended', reason: 'completed' }
        },
        checkpoint: () => codec.encode(null),
        cancel() {},
        dispose() {},
      }
    },
    resume(ctx, _checkpoint, signal) {
      return loop.create(ctx, signal)
    },
  })
  const kit = await createAuthorTestkit({
    version: '1.0.0',
    loop,
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    approval: async () => {
      asked()
      return {
        verdict: await decision,
        answeredBy: { id: 'reviewer', org: 'local', role: 'user' as const, deptPath: [], attrs: {} },
      }
    },
    plugin: defineAgnesPlugin({
      inject: ['tools', 'providers'],
      apply(ctx) {
        ctx.tools.register(
          defineTool({
            name: 'review_commit',
            description: 'Record a synthetic reviewed change',
            parameters: Type.Object({}),
            meta: {
              isReadOnly: false,
              isDestructive: false,
              isConcurrencySafe: false,
              isOpenWorld: false,
              replay: 'idempotent',
              requiresApproval: 'always',
              deferLoading: false,
              costHint: {},
            },
            execute: async () => ({ content: [{ type: 'text', text: 'Approved change recorded' }] }),
          }),
        )
        ctx.providers.registerHost(loopKind, '@author/plugin', loop)
      },
    }),
  })
  const ac = new AbortController()
  try {
    const session = await kit.openSession()
    await session.enqueue('Review and update')
    const running = session.drive(1, ac.signal)
    await Promise.race([
      pending,
      running.then(() => {
        throw new Error('ended before approval')
      }),
    ])
    approve('allowed-once')
    await expect(running).resolves.toMatchObject([{ outcome: 'turn-ended', reason: 'completed' }])
    expect((await session.uiRead()).surfaces[0]?.surface.revision).toBe(2)
    const facts = await session.facts()
    expect(facts.filter((row) => row.type === 'tool/result')).toHaveLength(3)
    expect(facts.filter((row) => row.type === 'turn/start')).toHaveLength(1)
    await session.assertApproval('allowed-once')
  } finally {
    ac.abort()
    approve('allowed-once')
    await kit.dispose()
  }
})

it('lets a generic plugin publish registered artifacts immediately, reuse them, and refuses another session after cold reopen', async () => {
  const { createHash } = await import('node:crypto')
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { createAuthorTestkit } = await import('@agnes/host/author-testkit')
  let dataDir = ''
  const remoteBytes = new Map<string, Uint8Array>()
  let ref!: import('@agnes/protocol').ArtifactRef
  const fileSurface = (id: string, artifact = ref): UiSurface => ({
    id,
    revision: 1,
    title: 'Synthetic file',
    placement: { inline: true, workbench: true },
    components: [{ id: 'file', kind: 'artifact-file', dataKey: 'file' }],
    data: { file: { name: 'demo.html', description: '', artifact } },
    actions: [],
  })
  const kit = await createAuthorTestkit({
    version: '1.0.0',
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    seams: {
      artifacts: {
        put: async (bytes, meta) => {
          const sha256 = createHash('sha256').update(bytes).digest('hex')
          const shard = join(dataDir, 'artifacts', 'sha256', sha256.slice(0, 2))
          // A valid provider may store bytes outside the local Web adapter.
          if (meta?.mime !== 'application/x-remote-fixture') {
            await mkdir(shard, { recursive: true })
            await writeFile(join(shard, sha256), bytes)
          } else {
            remoteBytes.set(sha256, bytes.slice())
          }
          return { sha256, size: bytes.byteLength, mime: meta?.mime ?? 'application/octet-stream' }
        },
        get: async (ref) => {
          const bytes = remoteBytes.get(ref.sha256)
          if (!bytes) throw new Error('synthetic remote object missing')
          return bytes.slice()
        },
      },
    },
    plugin: defineAgnesPlugin({
      inject: ['tools'],
      apply(ctx) {
        ctx.tools.register(
          defineTool({
            name: 'publish_fixture',
            description: 'Publish synthetic plugin output',
            parameters: Type.Object({}),
            meta: {
              isReadOnly: true,
              isDestructive: false,
              isConcurrencySafe: false,
              isOpenWorld: false,
              replay: 'idempotent',
              requiresApproval: 'never',
              deferLoading: false,
              costHint: {},
            },
            async execute(_args, context) {
              dataDir = context.session.workspaceRoot
              const large = await context.artifacts.put(new Uint8Array(LOCAL_ARTIFACT_READ_MAX_BYTES + 1))
              expect(large.size).toBe(LOCAL_ARTIFACT_READ_MAX_BYTES + 1)
              const remote = await context.artifacts.put(new TextEncoder().encode('remote fixture'), {
                mime: 'application/x-remote-fixture',
              })
              expect(await context.artifacts.get(remote)).toEqual(new TextEncoder().encode('remote fixture'))
              const parameterized = await context.artifacts.put(
                new TextEncoder().encode('parameter fixture'),
                {
                  mime: 'text/plain; charset=utf-8',
                },
              )
              expect(parameterized.mime).toBe('text/plain; charset=utf-8')
              for (const [id, artifact] of [
                ['large', large],
                ['remote', remote],
                ['parameterized', parameterized],
              ] as const) {
                expect(
                  await context.tools.invoke('ui_render', { surface: fileSurface(id, artifact) }),
                ).toMatchObject({
                  isError: true,
                  structured: { code: 'UI_ARTIFACT_UNAVAILABLE', published: false },
                })
              }
              const bytes = new TextEncoder().encode('<h1>合成交付物</h1>')
              ref = await context.artifacts.put(bytes, {
                mime: 'text/html',
              })
              const rendered = await context.tools.invoke('ui_render', {
                surface: fileSurface('plugin-file'),
              })
              expect(rendered.isError, JSON.stringify(rendered)).not.toBe(true)
              const alias = await context.artifacts.put(bytes, { mime: 'text/plain' })
              expect(alias).toEqual({ ...ref, mime: 'text/plain' })
              expect(
                await context.tools.invoke('ui_render', { surface: fileSurface('plugin-alias', alias) }),
              ).not.toMatchObject({ isError: true })
              return { content: [{ type: 'ref', ref }] }
            },
          }),
        )
      },
    }),
  })
  try {
    const session = await kit.openSession()
    const published = await session.invoke('publish_fixture', {})
    expect(published.isError, JSON.stringify(published)).not.toBe(true)
    expect((await session.uiRead()).surfaces.map((row) => row.artifacts)).toEqual([
      { file: 'available' },
      { file: 'available' },
    ])
    expect((await session.invoke('ui_render', { surface: fileSurface('plugin-reuse') })).isError).not.toBe(
      true,
    )
    const other = await kit.openSession()
    const refused = await other.invoke('ui_render', { surface: fileSurface('other-session') })
    expect(refused).toMatchObject({
      isError: true,
      structured: { code: 'UI_ARTIFACT_NOT_FOUND', published: false },
    })
    expect((await other.uiRead()).surfaces).toHaveLength(0)
    await session.close()
    const resumed = await kit.openSession({ key: session.key })
    expect((await resumed.uiRead()).surfaces.map((row) => row.artifacts)).toEqual([
      { file: 'available' },
      { file: 'available' },
      { file: 'available' },
    ])
    const bad = fileSurface('bad-size')
    bad.data.file = { name: 'demo.html', description: '', artifact: { ...ref, size: ref.size - 1 } }
    expect(await resumed.invoke('ui_render', { surface: bad })).toMatchObject({
      isError: true,
      structured: { code: 'UI_ARTIFACT_IDENTITY_MISMATCH', published: false },
    })
    expect(
      (await resumed.facts()).filter((row) => row.type === 'x/agnes/intelligent-ui/surface.opened'),
    ).toHaveLength(3)
  } finally {
    await kit.dispose()
  }
})
