import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { InferenceEvent } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { EXT_ROW_EXTENSION_IDS, MIGRATED_EXTENSION_IDS } from '../../src/assemble/ext-rows.js'
import { createTestHost } from '../../testkit/index.js'
import {
  auditKinds,
  pluginHost,
  pluginRow,
  pluginSource,
  rowState,
  scratch,
  settle,
  targetOf,
  toolNames,
} from './plugin-extension-fixture.js'

const ROW = 'ext:agnes/tools-search'
const ID = 'agnes/tools-search'
const SEARCH_TOOLS = ['find', 'grep', 'ls']
const REPLACEMENT = `
  agnes.registerTool(tool('grep'))
  agnes.registerTool(tool('find'))
  agnes.registerTool(tool('ls'))
`
const packageDirs = {
  '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)),
  '@agnes/code': fileURLToPath(new URL('../../../code', import.meta.url)),
}

const search = (h: { host: { extensions(): { id: string }[] } }) =>
  h.host.extensions().find((e) => e.id === ID) as
    | { id: string; loaded: boolean; replacedBy?: string; error?: { code: string }; isolation?: unknown }
    | undefined

describe('tools-search is supplied through the shared row host', () => {
  it('is one of the ids that moved', () => {
    expect(MIGRATED_EXTENSION_IDS.has(ID)).toBe(true)
    for (const id of MIGRATED_EXTENSION_IDS) expect(EXT_ROW_EXTENSION_IDS.has(id)).toBe(true)
  })

  it('lists exactly as the managed host listed it, in the same place', async () => {
    const h = await pluginHost(pluginSource(REPLACEMENT, 'plugin', ROW))
    const listed = h.host.extensions()
    expect(listed.find((e) => e.id === ID)).toMatchObject({
      package: '@agnes/base',
      trust: 'builtin',
      loaded: true,
      isolation: { mode: 'off', backend: 'in-process', fallback: false },
    })
    expect(listed.find((e) => e.id === ID)?.lease).toBeDefined()
    const position = (id: string) => listed.findIndex((e) => e.id === id)
    const declared = [...EXT_ROW_EXTENSION_IDS].filter((id) => position(id) >= 0)
    expect(declared.map(position)).toEqual([...declared.map(position)].sort((a, b) => a - b))
    for (const name of SEARCH_TOOLS) expect(toolNames(h)).toContain(name)
    expect(h.host.kernel.registrations(ID).sort()).toEqual(SEARCH_TOOLS.map((n) => `tool:${n}`))
    await h.host.close()
  })

  it('unloads once, with an audit line and its tools gone, when the host closes', async () => {
    const h = await pluginHost(pluginSource(REPLACEMENT, 'plugin', ROW))
    await h.host.close()
    expect(auditKinds(h, 'extension.revoked').filter((e) => e.detail?.id === ID)).toHaveLength(1)
    expect(h.host.kernel.registrations(ID)).toEqual([])
  })

  it('does not bring the host down when the row cannot be supplied', async () => {
    const dataDir = scratch()
    const h = {
      dataDir,
      ...(await createTestHost({
        dataDir,
        packageDirs,
        profileInputs: { user: { extensionIsolation: { extensions: { [ID]: 'required' } } } } as never,
      })),
    }
    expect(search(h)).toMatchObject({ loaded: false, error: { code: 'E_EXT_ISOLATION_UNAVAILABLE' } })
    expect(auditKinds(h, 'extension.failed').some((e) => e.detail?.id === ID)).toBe(true)
    for (const name of SEARCH_TOOLS) expect(h.host.kernel.tools.list().map((t) => t.name)).not.toContain(name)
    expect(h.host.extensions().find((e) => e.id === 'agnes/tools-core')?.loaded).toBe(true)
    await h.host.close()
  })
})

describe('a plugin replaces tools-search and gives way again', () => {
  it('registers the very tools the builtin held, and the builtin lists as replaced', async () => {
    const h = await pluginHost(pluginSource(REPLACEMENT, 'plugin', ROW))
    const report = await h.host.applyRuntimeTarget(targetOf([pluginRow(ROW)]))
    await settle()

    expect(report.ok).toBe(true)
    expect(rowState(h, ROW)).toBe('active')
    for (const name of SEARCH_TOOLS) {
      expect(toolNames(h)).toContain(name)
      expect(h.host.kernel.tools.resolve(name)?.source.source).not.toBe(ID)
    }
    expect(h.host.kernel.registrations(ID)).toEqual([])
    const listed = search(h)
    expect(listed?.loaded).toBe(false)
    expect(listed?.replacedBy).toMatch(/^plugin\/[0-9a-f]{16}$/)
    expect(h.host.extensions().find((e) => e.id === listed?.replacedBy)?.loaded).toBe(true)
    expect(auditKinds(h, 'extension.failed')).toEqual([])
    // Handing the row over is one revocation of the builtin, not one per tree that mentioned it.
    expect(auditKinds(h, 'extension.revoked').filter((e) => e.detail?.id === ID)).toHaveLength(1)
    await h.host.close()
  })

  it('brings the builtin back with its tools when the replacement is disabled', async () => {
    const h = await pluginHost(pluginSource(REPLACEMENT, 'plugin', ROW))
    await h.host.applyRuntimeTarget(targetOf([pluginRow(ROW)]))
    await settle()
    const report = await h.host.applyRuntimeTarget(targetOf([pluginRow(ROW, 'plugin', true)]))
    await settle()

    expect(report.ok).toBe(true)
    expect(search(h)).toMatchObject({ loaded: true })
    expect(search(h)?.replacedBy).toBeUndefined()
    for (const name of SEARCH_TOOLS) expect(h.host.kernel.tools.resolve(name)?.source.source).toBe(ID)
    expect(auditKinds(h, 'extension.failed')).toEqual([])
    await h.host.close()
  })

  it('takes over again when the replacement returns, however often the target is applied', async () => {
    const h = await pluginHost(pluginSource(REPLACEMENT, 'plugin', ROW))
    for (const disabled of [false, true, false, false]) {
      const report = await h.host.applyRuntimeTarget(targetOf([pluginRow(ROW, 'plugin', disabled)]))
      await settle()
      expect(report.ok).toBe(true)
      for (const name of SEARCH_TOOLS) expect(toolNames(h)).toContain(name)
      expect(search(h)?.loaded).toBe(disabled)
    }
    await h.host.close()
  })

  it('keeps a replacement to the names of what it replaces', async () => {
    const h = await pluginHost(
      pluginSource(`${REPLACEMENT}\n  agnes.registerTool(tool('read'))`, 'plugin', ROW),
    )
    await expect(h.host.applyRuntimeTarget(targetOf([pluginRow(ROW)]))).rejects.toThrow()
    await settle()
    // The dropped candidate neither kept `read` nor left the live tree without it.
    expect(h.host.kernel.tools.resolve('read')?.source.source).toBe('agnes/tools-core')
    await h.host.close()
  })

  it('refuses to reload a migrated builtin through the resource path', async () => {
    const h = await pluginHost(pluginSource(REPLACEMENT, 'plugin', ROW))
    await expect(h.host.reloadEcosystemExtension(ID, {})).rejects.toThrow(/not a reloadable/)
    expect(search(h)?.loaded).toBe(true)
    await h.host.close()
  })
})

const callTool = (name: string, args: Record<string, string>): InferenceEvent[] => [
  { type: 'toolcall_end', via: 'native', call: { toolUseId: '', name, args, ordinal: 0 } },
  { type: 'done', reason: 'toolUse' },
]
const say = (text: string): InferenceEvent[] => [{ type: 'text_delta', delta: text }]

describe('the model reaches tools-search through the row it is supplied by', () => {
  it('runs the builtin tool, then the replacement after the row is handed over', async () => {
    const dataDir = scratch()
    const source = pluginSource(
      `const schema = { [Symbol.for('TypeBox.Kind')]: 'Object', type: 'object', properties: {}, additionalProperties: false }
       for (const name of ['grep', 'find', 'ls'])
         agnes.registerTool({ ...tool(name), parameters: schema, async execute() { return { content: [{ type: 'text', text: 'replaced:' + name }] } } })`,
      'plugin',
      ROW,
    )
    const { host } = await createTestHost({
      dataDir,
      packageDirs,
      script: [
        callTool('ls', { path: realpathSync.native(dataDir) }),
        say('first'),
        callTool('ls', {}),
        say('second'),
      ],
      runtimePluginCatalogue: [source],
      extensionLoader: {
        import: async (file) => (await import(pathToFileURL(file).href)) as Record<string, unknown>,
      },
    })
    const turn = async (text: string) => {
      const session = await host.createSession({ cwd: dataDir })
      await session.enqueue('next-turn', { actor: session.d.actor, content: [{ type: 'text', text }] })
      await session.run({ until: 'turn-end', signal: new AbortController().signal })
      const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
      await session.close()
      return JSON.stringify(results.map((r) => r.data))
    }

    const before = await turn('list the directory')
    expect(before).not.toContain('replaced:')
    expect(before).toContain('"isError":false')

    await host.applyRuntimeTarget(targetOf([pluginRow(ROW)]))
    await settle()
    expect(await turn('list it again')).toContain('replaced:ls')
    await host.close()
  })
})
