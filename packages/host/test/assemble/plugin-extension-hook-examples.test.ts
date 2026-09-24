import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import type { InferenceEvent } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'
import { packageDirs, scratch, settle } from './plugin-extension-fixture.js'

const HOT_TOOL = fileURLToPath(new URL('../../../../examples/packages/hot-tool-plugin', import.meta.url))
const CONTEXT_NOTE = fileURLToPath(
  new URL('../../../../examples/packages/hook-context-note', import.meta.url),
)
const TAKEOVER = fileURLToPath(new URL('../../../../examples/packages/hook-runner-takeover', import.meta.url))

function example(
  directory: string,
  packageId: string,
  snapshotIdFill: string,
): {
  snapshot: Readonly<RuntimePluginSnapshot>
  row: ReturnType<typeof createPluginRow>
} {
  const snapshotId = `sha256-${snapshotIdFill.repeat(64)}`
  const declared = JSON.parse(readFileSync(`${directory}/package.json`, 'utf8')).agnes.plugins[0] as {
    export: string
    id: string
    inject: string[]
  }
  const snapshot: Readonly<RuntimePluginSnapshot> = {
    snapshot: Object.freeze({
      snapshotId,
      profile: 'local-dev',
      packageId,
      version: '1.0.0',
      integrity: `sha256-${'a'.repeat(64)}`,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'capability',
      directory,
      contributions: Object.freeze([]),
    }),
    generation: 1,
    trusted: true,
  }
  const row = createPluginRow({
    id: declared.id,
    plugin: `${packageId}@${snapshotId}/${declared.export}`,
    snapshotDigest: `sha256-${'a'.repeat(64)}`,
    exportName: declared.export,
    entryRevision: snapshotId,
    extrasRevision: 'none',
    mountRevision: 'host-ordinary-row:v1',
    inject: declared.inject,
  })
  return { snapshot, row }
}

const target = (rows: ReturnType<typeof createPluginRow>[]) =>
  buildRuntimeTarget({
    rows,
    resources: { mcp: [], skills: {} },
    resourceRevision: '0'.repeat(64),
    compositeRevision: '0'.repeat(64),
  })

const callDemo = (text: string): InferenceEvent[] => [
  {
    type: 'toolcall_end',
    via: 'native',
    call: { toolUseId: '', name: 'demo_text_stats', args: { text }, ordinal: 0 },
  },
  { type: 'done', reason: 'toolUse' },
]

describe('the hook-context-note example (addition scenario)', () => {
  it('adds its own section to the model-bound context, alongside every built-in contributor', async () => {
    const dataDir = scratch()
    const hotTool = example(HOT_TOOL, '@agnes-examples/hot-tool-plugin', '9')
    const note = example(CONTEXT_NOTE, '@agnes-examples/hook-context-note', '8')
    // A real Provider double, not just `script:`, so the actual RequestBody it receives (sections
    // included, not just the request/header event's hashes) is inspectable afterward.
    const provider = new ScriptedProvider({
      scripts: [
        [
          { type: 'text_delta', delta: 'ok' },
          { type: 'done', reason: 'stop' },
        ],
      ],
    })
    const { host } = await createTestHost({
      dataDir,
      packageDirs,
      provider,
      runtimePluginCatalogue: [hotTool.snapshot, note.snapshot],
      extensionLoader: {
        import: async (file) => (await import(pathToFileURL(file).href)) as Record<string, unknown>,
      },
    })
    await host.applyRuntimeTarget(target([hotTool.row, note.row]))
    await settle()

    const session = await host.createSession({ cwd: dataDir })
    await session.enqueue('next-turn', {
      actor: session.d.actor,
      content: [{ type: 'text', text: 'hello' }],
    })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const sawNote = provider.calls.some((call) =>
      call.system.includes('double-check any destructive shell command'),
    )
    expect(sawNote).toBe(true)
    await session.close()
    await host.close()
  })
})

describe('the hook-runner-takeover example (replacement scenario)', () => {
  it('replaces the builtin agnes/hooks-runner row and its tool_call hook genuinely blocks the marked demo call', async () => {
    const dataDir = scratch()
    const hotTool = example(HOT_TOOL, '@agnes-examples/hot-tool-plugin', '9')
    const takeover = example(TAKEOVER, '@agnes-examples/hook-runner-takeover', '7')
    const { host } = await createTestHost({
      dataDir,
      packageDirs,
      script: [callDemo('BLOCK_ME'), callDemo('allowed text'), [{ type: 'text_delta', delta: 'done' }]],
      runtimePluginCatalogue: [hotTool.snapshot, takeover.snapshot],
      extensionLoader: {
        import: async (file) => (await import(pathToFileURL(file).href)) as Record<string, unknown>,
      },
    })
    await host.applyRuntimeTarget(target([hotTool.row, takeover.row]))
    await settle()
    expect(host.extensions().find((e) => e.id === 'agnes/hooks-runner')?.loaded).toBe(false)

    const session = await host.createSession({ cwd: dataDir })
    await session.enqueue('next-turn', {
      actor: session.d.actor,
      content: [{ type: 'text', text: 'run the demo tool twice' }],
    })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
    const bodies = results.map((r) => JSON.stringify(r.data))
    expect(bodies.some((b) => b.includes('blocked by the hook-runner-takeover demo policy'))).toBe(true)
    expect(bodies.some((b) => b.includes('\\"words\\":2'))).toBe(true)
    await session.close()
    await host.close()
  })
})
