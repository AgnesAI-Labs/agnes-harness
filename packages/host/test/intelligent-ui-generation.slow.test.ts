import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import {
  capabilityHash,
  emptyLock,
  hashDirectory,
  type LockEntry,
  RuntimeGenerationSnapshotStore,
  type RuntimePluginSnapshot,
  writeLock,
} from '@agnes/package-manager'
import { defineAgnesPlugin } from '@agnes/plugin-runtime'
import { createPluginRow } from '@agnes/plugin-runtime/host'
import type { InferenceEvent, ToolCall } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { readUiComponentDeclarations } from '../src/runtime/sessions/ui-component-declarations.js'
import { createTestHost } from '../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../base', import.meta.url))
const marker = 'iu-generation-plugin'
const packageId = 'acme/iu-generation'
const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const say = (text: string): InferenceEvent[] => [
  { type: 'text_delta', delta: text },
  { type: 'done', reason: 'stop' },
]
const callTool = (name: string, args: ToolCall['args']): InferenceEvent[] => [
  { type: 'toolcall_end', call: { toolUseId: '', name, args, ordinal: 0 }, via: 'native' },
  { type: 'done', reason: 'toolUse' },
]

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing intelligent UI generation fixture')
  return value
}

it('keeps a pending action on the old generation and delivers its result once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-iu-generation-'))
  dirs.push(root)
  const directory = join(root, 'package')
  mkdirSync(directory)
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: packageId,
      version: '1.0.0',
      main: './index.js',
      agnes: { plugins: [{ export: 'main', apiRange: '^1.4.0', inject: ['extension'] }] },
    }),
  )
  writeFileSync(join(directory, 'index.js'), marker)
  const integrity = `sha256-${'a'.repeat(64)}`
  const source: RuntimePluginSnapshot = {
    snapshot: {
      snapshotId: integrity,
      profile: 'local-dev',
      packageId,
      version: '1.0.0',
      integrity,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: capabilityHash({ dependencies: {} }),
      directory,
      contributions: [],
    },
    generation: 1,
    trusted: true,
  }
  const profileDir = join(root, 'profiles/local-dev')
  mkdirSync(profileDir, { recursive: true })
  const entry: LockEntry = {
    version: source.snapshot.version,
    source: { type: 'file', ref: 'file:fixture' },
    integrity: source.snapshot.integrity,
    trust: 'trusted',
    license: 'MIT',
    apiRange: '^1.4.0',
    dependencies: {},
    previous: null,
    state: { installed: new Date(0).toISOString(), trusted: new Date(0).toISOString(), enabled: false },
    trustDecision: {
      integrity: source.snapshot.integrity,
      capabilityHash: source.snapshot.capabilityHash,
      decidedAt: new Date(0).toISOString(),
    },
  }
  const trust = () =>
    writeLock(profileDir, {
      ...emptyLock('local-dev', '0.1.0'),
      resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
      seams: Object.fromEntries(
        [
          'approval',
          'checkpoint',
          'ledger',
          'sandbox',
          'verifier',
          'repair',
          'artifacts',
          'principals',
          'platform',
          'harness',
        ].map((name) => [name, '@agnes/base']),
      ),
      packages: { [packageId]: entry },
    })
  trust()
  vi.stubEnv('AGH_HOME', root)
  const provider = new ScriptedProvider({
    models: [fakeModel({ route: 'gw', id: 'm1' })],
    scripts: [
      () =>
        callTool('ask_user_question', {
          timeoutMs: 25,
          questions: [{ id: 'choice', question: 'Choose a route', options: ['A', 'B'] }],
        }),
      say('Continuing independent work.'),
      say('The invalid answer leaves the question open.'),
      say('You chose B.'),
    ],
    onExhausted: 'error',
  })
  const hostOptions = {
    dataDir: root,
    packageDirs: { '@agnes/base': baseDir },
    disableSessionTitle: true,
    runtimePluginSources: async () => [source],
    extensionLoader: {
      async import(file: string) {
        if (readFileSync(file, 'utf8') === marker) {
          return {
            main: defineAgnesPlugin({
              inject: ['extension'],
              apply() {},
            }),
          }
        }
        return (await import(pathToFileURL(file).href)) as Record<string, unknown>
      },
    },
  }
  let host = (await createTestHost({ ...hostOptions, provider })).host
  let closed = false
  try {
    const session = await host.createSession({ cwd: root })
    const prompt = async (text: string) => {
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text }],
        actor: session.d.actor,
        kind: 'prompt',
      })
      return session.run({ until: 'turn-end', signal: new AbortController().signal })
    }
    expect(await prompt('Ask me')).toMatchObject({ reason: 'completed' })
    const service = session.intelligentUi
    if (!service) throw new Error('missing Intelligent UI service')
    const surface = (await service.read({ sessionId: session.key }, new AbortController().signal)).surfaces[0]
    if (!surface) throw new Error('missing question surface')
    expect(surface.status).toBe('open')
    const pin = session.pluginGenerationId
    const declarations = readUiComponentDeclarations(profileDir, session.key)
    const snapshot = required(host.runtimeTargetSnapshot?.())
    trust()
    const published = await host.applyRuntimeTarget(
      buildCompleteRuntimeTarget({
        rows: [
          ...snapshot.tree.rows,
          createPluginRow({
            id: `ext:${packageId}/main`,
            plugin: `${packageId}@${source.snapshot.snapshotId}/main`,
            snapshotDigest: source.snapshot.integrity,
            exportName: 'main',
            entryRevision: source.snapshot.integrity,
            extrasRevision: 'none',
            mountRevision: 'v1',
            inject: ['extension'],
          }),
        ],
        resources: snapshot.resource.resources,
      }).target,
    )
    expect(published.ok).toBe(true)
    expect(session.pluginGenerationId).toBe(pin)
    expect(host.pluginGenerationStatus?.().currentGenerationId).not.toBe(pin)
    const submit = (commandId: string, choice: string) =>
      service.action(
        {
          sessionId: session.key,
          surfaceId: surface.surface.id,
          revision: surface.surface.revision,
          actionId: 'submit',
          commandId,
          input: { answers: { choice } },
          selection: {},
        },
        session.d.actor,
        new AbortController().signal,
      )
    expect(await submit('invalid', 'C')).toMatchObject({ status: 'rejected' })
    expect(await session.run({ until: 'turn-end', signal: new AbortController().signal })).toMatchObject({
      reason: 'completed',
    })
    expect(await submit('late', 'B')).toMatchObject({ status: 'received' })
    expect(await session.run({ until: 'turn-end', signal: new AbortController().signal })).toMatchObject({
      reason: 'completed',
    })
    await service.read(
      { sessionId: session.key, surfaceId: surface.surface.id },
      new AbortController().signal,
    )
    const delivered = async (current: typeof session) =>
      (await current.scan({ type: 'user/message', toSeq: current.lastSeq })).filter((event) =>
        JSON.stringify(event).includes('ui-result:late'),
      )
    expect(await delivered(session)).toHaveLength(1)
    const sessionKey = session.key
    await session.close()
    await host.close()
    closed = true
    host = (
      await createTestHost({
        ...hostOptions,
        provider: new ScriptedProvider({
          models: [fakeModel({ route: 'gw', id: 'm1' })],
          scripts: [],
          onExhausted: 'error',
        }),
      })
    ).host
    closed = false
    const resumed = await host.createSession({ key: sessionKey, cwd: root })
    expect(resumed.pluginGenerationId).toBe(pin)
    expect(readUiComponentDeclarations(profileDir, sessionKey)).toEqual(declarations)
    expect(new RuntimeGenerationSnapshotStore(profileDir).session(sessionKey)?.generationId).toBe(pin)
    const resumedView = resumed.intelligentUi
    if (!resumedView) throw new Error('missing Intelligent UI service after resume')
    expect(
      (
        await resumedView.read(
          { sessionId: resumed.key, surfaceId: surface.surface.id },
          new AbortController().signal,
        )
      ).surfaces[0]?.status,
    ).toBe('closed')
    expect(await delivered(resumed)).toHaveLength(1)
    await resumed.close()
  } finally {
    if (!closed) await host.close()
  }
})
