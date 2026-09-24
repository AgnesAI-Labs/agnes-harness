import { fileURLToPath } from 'node:url'
import { createPluginRow } from '@agnes/plugin-runtime/host'
import type { InferenceEvent } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { EXT_ROW_EXTENSION_IDS, MIGRATED_EXTENSION_IDS } from '../../src/assemble/ext-rows.js'
import { OBSERVE_HOOK_EVENTS } from '../../src/ext-host/row-extension-api.js'
import { createTestHost } from '../../testkit/index.js'
import {
  auditKinds,
  pluginHost,
  pluginRow,
  pluginSource,
  pluginSourceWith,
  scratch,
  settle,
  targetOf,
  toolNames,
} from './plugin-extension-fixture.js'

const packageDirs = {
  '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)),
  '@agnes/code': fileURLToPath(new URL('../../../code', import.meta.url)),
}

const NOT_MIGRATED: string[] = []
const say = (text: string): InferenceEvent[] => [{ type: 'text_delta', delta: text }]

/** Every builtin id that a default test host supplies through its own ext: row, with its registrations. */
const SUPPLIED: Record<string, string[]> = {
  'agnes/tools-core': ['tool:read', 'tool:write', 'tool:edit', 'tool:shell', 'tool:todo'],
  'agnes/tools-search': ['tool:grep', 'tool:find', 'tool:ls'],
  'agnes/tools-web': ['tool:web_fetch'],
  'agnes/compaction': ['tool:compact'],
  'agnes/refine': ['tool:harness_propose', 'hook:compact'],
  'agnes/subagent': [
    'tool:subagent_fork',
    'tool:subagent_spawn',
    'tool:subagent_collect',
    'tool:subagent_cancel',
  ],
  'agnes/code-mode': ['tool:run_code', 'hook:session_start'],
  'agnes/privacy': ['hook:session_start', 'hook:shutdown'],
  'agnes/mcp-search': ['tool:tool_search', 'tool:tool_describe'],
  'agnes/hooks-runner': [
    'hook:session_start',
    'hook:shutdown',
    'hook:before_step',
    'hook:context',
    'hook:tool_call',
    'hook:tool_result',
    'hook:turn_stopping',
    'hook:subagent_start',
    'hook:subagent_end',
    'hook:before_compact',
    'hook:compact',
    'hook:approval_request',
  ],
}

const listed = (h: { host: { extensions(): { id: string; loaded: boolean }[] } }, id: string) =>
  h.host.extensions().find((e) => e.id === id)

describe('the builtin extensions that moved to the shared row host', () => {
  it('moved every builtin extension, including skills', () => {
    for (const id of EXT_ROW_EXTENSION_IDS)
      expect(MIGRATED_EXTENSION_IDS.has(id)).toBe(!NOT_MIGRATED.includes(id))
    expect([...MIGRATED_EXTENSION_IDS].sort()).toEqual(
      [...EXT_ROW_EXTENSION_IDS].filter((id) => !NOT_MIGRATED.includes(id)).sort(),
    )
    expect(MIGRATED_EXTENSION_IDS.has('agnes/skills')).toBe(true)
  })

  it('lists each one loaded with the registrations it always had, in the same order as before', async () => {
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    const ids = h.host.extensions().map((e) => e.id)
    expect(ids).toEqual([
      'agnes/tools-core',
      'agnes/tools-search',
      'agnes/tools-web',
      'agnes/compaction',
      'agnes/refine',
      'agnes/subagent',
      'agnes/computer-use',
      'agnes/code-mode',
      'agnes/hooks-runner',
      'agnes/privacy',
      'agnes/mcp-search',
      'agnes/skills',
    ])
    for (const [id, registrations] of Object.entries(SUPPLIED)) {
      expect(listed(h, id)?.loaded, id).toBe(true)
      expect(h.host.kernel.registrations(id), id).toEqual(registrations)
    }
    expect(auditKinds(h as never, 'extension.failed')).toEqual([])
    await h.host.close()
  })

  it('keeps the relative order of compact hooks: refine runs before hooks-runner, also after a rebuild', async () => {
    const h = await pluginHost(
      pluginSource(`agnes.registerTool(tool('unrelated_tool'))`, 'plugin', 'ext:acme/x'),
    )
    const order = () =>
      h.host.kernel.hooks
        .snapshot()
        .entries('compact')
        .map((entry) => entry.meta.source)
    expect(order()).toEqual(['agnes/refine', 'agnes/computer-use', 'agnes/hooks-runner'])
    await h.host.applyRuntimeTarget(targetOf([pluginRow('ext:acme/x')]))
    await settle()
    expect(order()).toEqual(['agnes/refine', 'agnes/computer-use', 'agnes/hooks-runner'])
    await h.host.close()
  })

  it('unloads each one exactly once, with nothing left behind, when the host closes', async () => {
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    await h.host.close()
    for (const id of Object.keys(SUPPLIED)) {
      expect(
        auditKinds(h as never, 'extension.revoked').filter((e) => e.detail?.id === id),
        id,
      ).toHaveLength(1)
      expect(h.host.kernel.registrations(id), id).toEqual([])
    }
    expect(auditKinds(h as never, 'extension.revoke_failed')).toEqual([])
  })

  it('still serves session_start to code-mode: the hook runs and writes its event, with no envelope error', async () => {
    const dataDir = scratch()
    const h = await createTestHost({ dataDir, packageDirs, script: [say('hello')] })
    const session = await h.host.createSession({ cwd: dataDir })
    await session.enqueue('next-turn', { actor: session.d.actor, content: [{ type: 'text', text: 'hi' }] })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const events = await session.scan({ toSeq: session.lastSeq })
    const types = events.map((e) => e.type)
    expect(types).toContain('x/agnes/code-mode/kernel')
    expect(types).not.toContain('hook/error')
    await session.close()
    await h.host.close()
  })
})

describe('a third party replaces a migrated builtin and gives way', () => {
  const cases: [string, string[]][] = [
    ['agnes/tools-web', ['web_fetch']],
    ['agnes/compaction', ['compact']],
    ['agnes/refine', ['harness_propose']],
    ['agnes/code-mode', ['run_code']],
    ['agnes/tools-core', ['read', 'todo']],
    ['agnes/subagent', ['subagent_fork', 'subagent_spawn', 'subagent_collect', 'subagent_cancel']],
  ]
  for (const [id, tools] of cases) {
    it(`swaps ${id} for a plugin row and back`, async () => {
      const row = `ext:${id}`
      const body = tools.map((n) => `agnes.registerTool(tool('${n}'))`).join('\n')
      const h = await pluginHost(pluginSource(body, 'plugin', row))
      const before = h.host.kernel.tools.resolve(tools[0] as string)?.source.source
      expect(before).toBe(id)
      const report = await h.host.applyRuntimeTarget(targetOf([pluginRow(row)]))
      await settle()
      expect(report.ok).toBe(true)
      for (const n of tools) expect(h.host.kernel.tools.resolve(n)?.source.source).toMatch(/^plugin\//)
      expect(listed(h, id)?.loaded).toBe(false)
      await h.host.applyRuntimeTarget(targetOf([pluginRow(row, 'plugin', true)]))
      await settle()
      expect(listed(h, id)?.loaded).toBe(true)
      for (const n of tools) expect(h.host.kernel.tools.resolve(n)?.source.source).toBe(id)
      expect(toolNames(h)).toContain(tools[0])
      await h.host.close()
    })
  }

  it('refuses to replace privacy: a plugin row cannot register the hooks it declares', async () => {
    const row = 'ext:agnes/privacy'
    const h = await pluginHost(pluginSource(`agnes.registerTool(tool('unrelated_tool'))`, 'plugin', row))
    await expect(h.host.applyRuntimeTarget(targetOf([pluginRow(row)]))).rejects.toThrow(
      /replacement of ext:agnes\/privacy must register hooks/,
    )
    await settle()
    // The refused candidate had already taken the row over; the live tree is put back as it was.
    expect(listed(h, 'agnes/privacy')?.loaded).toBe(true)
    expect(h.host.kernel.registrations('agnes/privacy')).toEqual(SUPPLIED['agnes/privacy'])
    await h.host.close()
  })

  it('refuses to replace hooks-runner even by a plugin that listens to every event it may', async () => {
    const row = 'ext:agnes/hooks-runner'
    const listenToAll = OBSERVE_HOOK_EVENTS.map((event) => `agnes.on('${event}', () => {})`).join('; ')
    const h = await pluginHost(pluginSourceWith([{ exportName: 'plugin', rowId: row, body: listenToAll }]))
    await expect(h.host.applyRuntimeTarget(targetOf([pluginRow(row)]))).rejects.toThrow(
      /replacement of ext:agnes\/hooks-runner must register hooks/,
    )
    await settle()
    expect(listed(h, 'agnes/hooks-runner')?.loaded).toBe(true)
    expect(h.host.kernel.registrations('agnes/hooks-runner')).toEqual(SUPPLIED['agnes/hooks-runner'])
    await h.host.close()
  })

  it('refuses a replacement of privacy that never asked for the facade, whatever the previous one held', async () => {
    const row = 'ext:agnes/privacy'
    const other = { vendor: '@acme/silent-tools', snapshotId: `sha256-${'6'.repeat(64)}` }
    const good = pluginSourceWith([
      {
        exportName: 'plugin',
        rowId: row,
        body: `agnes.on('session_start', () => {}); agnes.on('shutdown', () => {})`,
      },
    ])
    // Its own package, so that the target change is a whole new tree rather than a row swap.
    const silent = pluginSourceWith([{ exportName: 'plugin', rowId: row, body: '', facade: false }], other)
    const h = await pluginHost([good, silent])
    expect((await h.host.applyRuntimeTarget(targetOf([pluginRow(row)]))).ok).toBe(true)
    await settle()
    const holders = () =>
      h.host.kernel.hooks
        .snapshot()
        .entries('session_start')
        .map((e) => e.meta.source)
    const held = holders()
    expect(held.filter((s) => s.startsWith('plugin/'))).toHaveLength(1)

    await expect(
      h.host.applyRuntimeTarget(targetOf([pluginRow(row, 'plugin', false, other)])),
    ).rejects.toThrow(/replacement of ext:agnes\/privacy must register hooks/)
    await settle()
    // The plugin that did register the hooks is still the one holding them.
    expect(holders()).toEqual(held)
    await h.host.close()
  })

  it('leaves the live tree alone when a target fails before any of its rows mounts', async () => {
    const h = await pluginHost(
      pluginSource(`agnes.registerTool(tool('unrelated_tool'))`, 'plugin', 'ext:acme/x'),
    )
    await h.host.applyRuntimeTarget(targetOf([pluginRow('ext:acme/x')]))
    await settle()
    const revoked = auditKinds(h, 'extension.revoked').length
    const loaded = auditKinds(h, 'extension.loaded').length
    const ghost = createPluginRow({
      id: 'ext:acme/ghost',
      plugin: `@acme/not-installed@sha256-${'9'.repeat(64)}/plugin`,
      snapshotDigest: `sha256-${'8'.repeat(64)}`,
      exportName: 'plugin',
      entryRevision: `sha256-${'9'.repeat(64)}`,
      extrasRevision: 'none',
      mountRevision: 'host-ordinary-row:v1',
      inject: [],
    })

    await expect(h.host.applyRuntimeTarget(targetOf([pluginRow('ext:acme/x'), ghost]))).rejects.toThrow()
    await settle()

    // Nothing was mounted, so nothing was taken over and nothing has to be put back.
    expect(auditKinds(h, 'extension.revoked')).toHaveLength(revoked)
    expect(auditKinds(h, 'extension.loaded')).toHaveLength(loaded)
    expect(toolNames(h)).toContain('unrelated_tool')
    await h.host.close()
  })

  it('keeps a working plugin and the builtins when a later candidate is rejected', async () => {
    const source = pluginSourceWith([
      { exportName: 'good', rowId: 'ext:acme/good', body: `agnes.registerTool(tool('good_tool'))` },
      { exportName: 'bad', rowId: 'ext:acme/bad', body: `throw new Error('plugin failed to start')` },
    ])
    const h = await pluginHost(source)
    await h.host.applyRuntimeTarget(targetOf([pluginRow('ext:acme/good', 'good')]))
    await settle()
    expect(toolNames(h)).toContain('good_tool')
    const before = h.host.extensions().map((e) => `${e.id}:${e.loaded}`)

    await expect(
      h.host.applyRuntimeTarget(
        targetOf([pluginRow('ext:acme/good', 'good'), pluginRow('ext:acme/bad', 'bad')]),
      ),
    ).rejects.toThrow()
    await settle()

    expect(toolNames(h)).toContain('good_tool')
    for (const id of Object.keys(SUPPLIED)) expect(listed(h, id)?.loaded, id).toBe(true)
    const after = h.host.extensions().map((e) => `${e.id}:${e.loaded}`)
    // The rejected plugin stays listed as not loaded; everything that worked still lists as before.
    expect(after.filter((entry) => before.includes(entry))).toEqual(before)
    expect(after.filter((entry) => !before.includes(entry))).toEqual([
      expect.stringMatching(/^plugin\/.*:false$/),
    ])
    for (const [id, registrations] of Object.entries(SUPPLIED))
      expect(h.host.kernel.registrations(id), id).toEqual(registrations)
    await h.host.close()
  })

  it('keeps refine single-instance when unrelated rows come and go around it', async () => {
    const h = await pluginHost(
      pluginSource(`agnes.registerTool(tool('unrelated_tool'))`, 'plugin', 'ext:acme/x'),
    )
    for (const disabled of [false, true, false]) {
      const report = await h.host.applyRuntimeTarget(targetOf([pluginRow('ext:acme/x', 'plugin', disabled)]))
      await settle()
      expect(report.ok).toBe(true)
      expect(h.host.kernel.registrations('agnes/refine')).toEqual(SUPPLIED['agnes/refine'])
    }
    expect(auditKinds(h, 'extension.failed')).toEqual([])
    // Every row was remounted by those target changes; handing over to a successor is a clean unload.
    expect(auditKinds(h, 'extension.revoke_failed')).toEqual([])
    for (const event of auditKinds(h, 'extension.revoked')) expect(event.detail?.cleanupPending).toBe(false)
    await h.host.close()
  })
})
