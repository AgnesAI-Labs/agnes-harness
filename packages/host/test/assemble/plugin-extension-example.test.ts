import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import type { InferenceEvent } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'
import {
  packageDirs,
  pluginHost,
  pluginRow,
  pluginSource,
  targetOf as pluginTarget,
  scratch,
  settle,
} from './plugin-extension-fixture.js'

const EXAMPLE = fileURLToPath(new URL('../../../../examples/packages/hot-tool-plugin', import.meta.url))
const PACKAGE = '@agnes-examples/hot-tool-plugin'
const SNAPSHOT_ID = `sha256-${'9'.repeat(64)}`

const source = (): Readonly<RuntimePluginSnapshot> => ({
  snapshot: Object.freeze({
    snapshotId: SNAPSHOT_ID,
    profile: 'local-dev',
    packageId: PACKAGE,
    version: '1.0.0',
    integrity: `sha256-${'a'.repeat(64)}`,
    treeIntegrity: hashDirectory(EXAMPLE, { exclude: [] }),
    capabilityHash: 'capability',
    directory: EXAMPLE,
    contributions: Object.freeze([]),
  }),
  generation: 1,
  trusted: true,
})

const declared = JSON.parse(readFileSync(join(EXAMPLE, 'package.json'), 'utf8')).agnes.plugins[0] as {
  export: string
  id: string
  inject: string[]
}

const row = () =>
  createPluginRow({
    id: declared.id,
    plugin: `${PACKAGE}@${SNAPSHOT_ID}/${declared.export}`,
    snapshotDigest: `sha256-${'a'.repeat(64)}`,
    exportName: declared.export,
    entryRevision: SNAPSHOT_ID,
    extrasRevision: 'none',
    mountRevision: 'host-ordinary-row:v1',
    inject: declared.inject,
  })

const target = (rows: ReturnType<typeof row>[]) =>
  buildRuntimeTarget({
    rows,
    resources: { mcp: [], skills: {} },
    resourceRevision: '0'.repeat(64),
    compositeRevision: '0'.repeat(64),
  })

const callStats: InferenceEvent[] = [
  {
    type: 'toolcall_end',
    via: 'native',
    call: { toolUseId: '', name: 'demo_text_stats', args: { text: 'one two  three' }, ordinal: 0 },
  },
  { type: 'done', reason: 'toolUse' },
]

describe('the hot-tool-plugin example', () => {
  it('declares one plugin entry that asks for tools and extension services', () => {
    expect(declared).toMatchObject({ export: 'textStatsTool', inject: ['tools', 'hooks', 'self'] })
  })

  it('gives the model a tool, and takes it away with the row', async () => {
    const dataDir = scratch()
    const { host } = await createTestHost({
      dataDir,
      packageDirs,
      script: [callStats, [{ type: 'text_delta', delta: 'three words' }]],
      runtimePluginCatalogue: [source()],
      extensionLoader: {
        import: async (file) => (await import(pathToFileURL(file).href)) as Record<string, unknown>,
      },
    })
    await host.applyRuntimeTarget(target([row()]))
    await settle()
    expect(host.kernel.tools.list().map((t) => t.name)).toContain('demo_text_stats')

    const session = await host.createSession({ cwd: dataDir })
    await session.enqueue('next-turn', {
      actor: session.d.actor,
      content: [{ type: 'text', text: 'count the words' }],
    })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
    expect(JSON.stringify(results.map((r) => r.data))).toContain('\\"words\\":3')
    await session.close()

    await host.applyRuntimeTarget(target([]))
    await settle()
    expect(host.kernel.tools.list().map((t) => t.name)).not.toContain('demo_text_stats')
    await host.close()
  })
})

it('preserves request availability through the production ordinary plugin bridge', async () => {
  const plugin = pluginSource(`
    ctx.tools.register({ ...tool('availability_probe'), async execute(_, context) {
      const states = ['availability_probe', 'later', 'image_only', 'outside'].map(name => [name, context.tools.availability?.(name)])
      return { content: [{ type: 'text', text: JSON.stringify(states) }] }
    } })
    ctx.tools.register({ ...tool('later'), meta: { ...tool('later').meta, deferLoading: true } })
    ctx.tools.register({ ...tool('image_only'), meta: { ...tool('image_only').meta, requiresImageInput: true } })
  `)
  const { host, dataDir } = await pluginHost(plugin, {
    script: [
      [
        {
          type: 'toolcall_end',
          via: 'native',
          call: { toolUseId: '', name: 'availability_probe', args: {}, ordinal: 0 },
        },
        { type: 'done', reason: 'toolUse' },
      ],
      [
        { type: 'text_delta', delta: 'done' },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  try {
    await host.applyRuntimeTarget(pluginTarget([pluginRow()]))
    const session = await host.createSession({ cwd: dataDir })
    try {
      await session.enqueue('check-availability', {
        actor: session.d.actor,
        content: [{ type: 'text', text: 'check' }],
      })
      await session.run({ until: 'turn-end', signal: new AbortController().signal })
      const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
      const text = JSON.stringify(results.map((r) => r.data))
      expect(text).toContain('offered')
      expect(text).toContain('deferred')
      expect(text).toContain('model_capability')
      expect(text).toContain('catalog')
      expect(text).not.toContain('snapshot unavailable')
    } finally {
      await session.close()
    }
  } finally {
    await host.close()
  }
})
