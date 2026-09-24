import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { type McpCatalogHub, mcpCatalogHubFor } from '@agnes/base'
import { API_VERSION, defineExtension, type ExtensionAPI, type ExtensionManifest } from '@agnes/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'
import { fixtureTool } from '../fixtures/tool.js'
import { pluginRow, pluginSourceWith, targetOf } from './plugin-extension-fixture.js'

const packageDirs = {
  '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)),
  '@agnes/code': fileURLToPath(new URL('../../../code', import.meta.url)),
}
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agnes-ext-rows-dynamic-'))
  dirs.push(d)
  return d
}
type H = Awaited<ReturnType<typeof createTestHost>>
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))
const toolNames = (h: H) => h.host.kernel.tools.list().map((t) => t.name)
const audits = (h: H, kind: string, id: string) =>
  h.audit.events.filter((e) => e.kind === kind && (e.detail as { id?: string } | undefined)?.id === id)

/** A resource-style extension: one instance per resource id, each owning something it must close. */
function resourceExtension(name: string, log: string[], options: { failOpen?: boolean } = {}) {
  // An extension id is exactly `scope/name`, both [a-z0-9-]: `agnes/test/alpha` is refused.
  const id = `agnes/test-${name}`
  const manifest: ExtensionManifest = {
    id,
    version: '0.1.0',
    apiRange: `^${API_VERSION.split('.')[0]}.0`,
    entry: './index.mjs',
    capabilities: { tools: { prefix: `${name}_` } },
  } as ExtensionManifest
  return {
    extensionId: id,
    spec: {
      id,
      package: '@agnes/test-resources',
      packageVersion: '0.0.0',
      dir: tmpdir(),
      trust: 'builtin' as const,
      enabled: true,
      revision: 'r1',
    },
    manifest,
    factory: () =>
      defineExtension(async (agnes) => {
        log.push(`open:${name}`)
        if (options.failOpen) throw new Error(`cannot open ${name}`)
        const dispose = agnes.registerTool(fixtureTool(`${name}_ping`))
        return () => {
          dispose()
          log.push(`close:${name}`)
        }
      }),
  }
}

describe('dynamic ext: rows (stage 2b, D107)', () => {
  it('keeps late registration on the row and rejects it after unmount', async () => {
    const dataDir = scratch()
    const provider = new ScriptedProvider({
      scripts: [
        (request) => {
          expect(request.tools.some((tool) => tool.name === 'late_ping')).toBe(true)
          return [
            { type: 'text_delta', delta: 'registered' },
            { type: 'done', reason: 'stop' },
          ]
        },
        (request) => {
          expect(request.tools.some((tool) => tool.name === 'late_ping')).toBe(false)
          return [
            { type: 'text_delta', delta: 'removed' },
            { type: 'done', reason: 'stop' },
          ]
        },
      ],
    })
    const h = await createTestHost({ dataDir, packageDirs, provider, disableSessionTitle: true })
    const base = resourceExtension('late', [])
    let captured: ExtensionAPI | undefined
    const dynamic = {
      ...base,
      factory: () =>
        defineExtension((api) => {
          captured = api
        }),
    }
    await h.host.extensionRows.apply([
      ...h.host.extensionRows.current(),
      h.host.extensionRows.prepare({ extensionId: dynamic.extensionId, dynamic }),
    ])
    expect(captured).toBeDefined()
    const session = await h.host.createSession({ cwd: dataDir, key: 'dynamic-late' })
    const release = captured?.registerTool(fixtureTool('late_ping'))
    expect(toolNames(h)).toContain('late_ping')
    await Promise.resolve()
    await session.enqueue('next-turn', { actor: session.d.actor, content: [{ type: 'text', text: 'one' }] })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    release?.()
    expect(toolNames(h)).not.toContain('late_ping')
    await Promise.resolve()
    await session.enqueue('next-turn', { actor: session.d.actor, content: [{ type: 'text', text: 'two' }] })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    captured?.registerTool(fixtureTool('late_again'))
    await h.host.extensionRows.apply(
      h.host.extensionRows.current().filter((row) => row.id !== `ext:${dynamic.extensionId}`),
    )
    expect(toolNames(h)).not.toContain('late_again')
    expect(() => captured?.registerTool(fixtureTool('late_after'))).toThrow()
    expect(provider.calls).toHaveLength(2)
    await session.close()
    await h.host.close()
  })

  it('mounts a row that only exists at runtime, and unmounts it again', async () => {
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    const log: string[] = []
    const dynamic = resourceExtension('alpha', log)

    const row = h.host.extensionRows.prepare({ extensionId: dynamic.extensionId, dynamic })
    const report = await h.host.extensionRows.apply([...h.host.extensionRows.current(), row])
    expect(report.rows.find((r) => r.id === `ext:${dynamic.extensionId}`)).toMatchObject({ state: 'active' })
    await settle()
    expect(h.host.extensions().find((e) => e.id === dynamic.extensionId)?.loaded).toBe(true)
    expect(toolNames(h)).toContain('alpha_ping')
    expect(log).toEqual(['open:alpha'])

    await h.host.extensionRows.apply(
      h.host.extensionRows.current().filter((r) => r.id !== `ext:${dynamic.extensionId}`),
    )
    await settle()
    expect(h.host.extensions().find((e) => e.id === dynamic.extensionId)?.loaded).toBe(false)
    expect(toolNames(h)).not.toContain('alpha_ping')
    // The row owned the resource: unmounting it closed it.
    expect(log).toEqual(['open:alpha', 'close:alpha'])
    await h.host.close()
  })

  it('applying a dynamic row keeps the static builtin rows', async () => {
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    const staticBefore = h.host.extensionRows.current().map((r) => r.id)
    const dynamic = resourceExtension('alpha', [])
    await h.host.extensionRows.apply([
      ...h.host.extensionRows.current(),
      h.host.extensionRows.prepare({ extensionId: dynamic.extensionId, dynamic }),
    ])
    await settle()
    expect(h.host.extensions().find((e) => e.id === 'agnes/tools-core')?.loaded).toBe(true)
    for (const id of staticBefore) expect(h.host.extensionRows.current().map((r) => r.id)).toContain(id)
    await h.host.close()
  })

  it('two dynamic rows are independent: removing one leaves the other running', async () => {
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    const log: string[] = []
    const alpha = resourceExtension('alpha', log)
    const beta = resourceExtension('beta', log)
    await h.host.extensionRows.apply([
      ...h.host.extensionRows.current(),
      h.host.extensionRows.prepare({ extensionId: alpha.extensionId, dynamic: alpha }),
      h.host.extensionRows.prepare({ extensionId: beta.extensionId, dynamic: beta }),
    ])
    await settle()
    expect(toolNames(h)).toEqual(expect.arrayContaining(['alpha_ping', 'beta_ping']))

    await h.host.extensionRows.apply(
      h.host.extensionRows.current().filter((r) => r.id !== `ext:${alpha.extensionId}`),
    )
    await settle()
    expect(toolNames(h)).not.toContain('alpha_ping')
    expect(toolNames(h)).toContain('beta_ping')
    // Design §6 flagged this as the expected cost until incremental apply landed: every apply used
    // to rebuild the whole tree, restarting beta even though only alpha's row went. Verified
    // 2026-09-22 against current main: the underlying incremental-apply machinery
    // (`EntryTree.hostTransaction`, landed by a separate workstream) already reuses beta's row on a
    // row-removal apply -- beta is not restarted, which is the whole point of one-row-per-resource.
    expect(log.filter((line) => line.endsWith(':beta'))).toEqual(['open:beta'])
    await h.host.close()
  })

  it('a new entryRevision swaps the row in place: the old instance closes and a new one opens', async () => {
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    const log: string[] = []
    const dynamic = resourceExtension('alpha', log)
    await h.host.extensionRows.apply([
      ...h.host.extensionRows.current(),
      h.host.extensionRows.prepare({ extensionId: dynamic.extensionId, dynamic }),
    ])
    await settle()
    const rest = h.host.extensionRows.current().filter((r) => r.id !== `ext:${dynamic.extensionId}`)
    await h.host.extensionRows.apply([
      ...rest,
      h.host.extensionRows.prepare({ extensionId: dynamic.extensionId, dynamic, entryRevision: 'r2' }),
    ])
    await settle()
    expect(log).toEqual(['open:alpha', 'close:alpha', 'open:alpha'])
    expect(toolNames(h)).toContain('alpha_ping')
    await h.host.close()
  })

  it('a dynamic extension that fails to open does not fail the tree, and leaves the other rows alone (D100)', async () => {
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    const bad = resourceExtension('bad', [], { failOpen: true })
    const good = resourceExtension('good', [])
    const report = await h.host.extensionRows.apply([
      ...h.host.extensionRows.current(),
      h.host.extensionRows.prepare({ extensionId: bad.extensionId, dynamic: bad }),
      h.host.extensionRows.prepare({ extensionId: good.extensionId, dynamic: good }),
    ])
    expect(report.ok).toBe(true)
    await settle()
    expect(h.host.extensions().find((e) => e.id === bad.extensionId)?.loaded).toBe(false)
    expect(audits(h, 'extension.failed', bad.extensionId)).toHaveLength(1)
    expect(toolNames(h)).toContain('good_ping')
    expect(h.host.extensions().find((e) => e.id === 'agnes/tools-core')?.loaded).toBe(true)
    await h.host.close()
  })

  it('a row applied later without the dynamic extension being re-registered is not resurrected', async () => {
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    const log: string[] = []
    const dynamic = resourceExtension('alpha', log)
    await h.host.extensionRows.apply([
      ...h.host.extensionRows.current(),
      h.host.extensionRows.prepare({ extensionId: dynamic.extensionId, dynamic }),
    ])
    await h.host.extensionRows.apply(
      h.host.extensionRows.current().filter((r) => r.id !== `ext:${dynamic.extensionId}`),
    )
    await settle()
    // Another apply of only the remaining rows must not bring the removed extension back.
    await h.host.extensionRows.apply(h.host.extensionRows.current())
    await settle()
    expect(toolNames(h)).not.toContain('alpha_ping')
    expect(log.filter((line) => line === 'open:alpha')).toHaveLength(1)
    await h.host.close()
  })

  it('cleans up the dynamic extension entry when its row is removed, so a later prepare without dynamic finds nothing', async () => {
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    const log: string[] = []
    const dynamic = resourceExtension('alpha', log)
    await h.host.extensionRows.apply([
      ...h.host.extensionRows.current(),
      h.host.extensionRows.prepare({ extensionId: dynamic.extensionId, dynamic }),
    ])
    await settle()
    await h.host.extensionRows.apply(
      h.host.extensionRows.current().filter((r) => r.id !== `ext:${dynamic.extensionId}`),
    )
    await settle()
    // Re-`prepare` the SAME extensionId, this time without `dynamic`: if the Map entry from the
    // first registration were still there, `extRowLoader.load` would resurrect the old factory
    // (a second 'open:alpha') even though this call never supplied one.
    await h.host.extensionRows.apply([
      ...h.host.extensionRows.current(),
      h.host.extensionRows.prepare({ extensionId: dynamic.extensionId }),
    ])
    await settle()
    // The re-registered row's factory came back empty because the Map entry for this extensionId
    // was cleared, not because the underlying factory failed -- `open:alpha` staying at 1 confirms
    // that.
    expect(toolNames(h)).not.toContain('alpha_ping')
    expect(log.filter((line) => line === 'open:alpha')).toHaveLength(1)
    await h.host.close()
  })

  it('an extensionRows.apply issued while a daemon target is still applying builds on that target, not on the tree before it', async () => {
    // Stage 2b step 3 makes this reachable: a worker's MCP reload calls extensionRows.apply at a turn
    // boundary, and the daemon's runtime.stale (a package change) can be in flight at that moment.
    // Host applies are serialized, but if the ext-row target were composed from the live tree at
    // call time, it would be built from the tree BEFORE the daemon's target and, published after
    // it, silently drop the daemon's rows.
    const acme = pluginSourceWith([
      {
        exportName: 'plugin',
        rowId: 'ext:acme/plugin-tools',
        body: "  agnes.registerTool(tool('acme_ping'))",
      },
    ])
    const h = await createTestHost({
      dataDir: scratch(),
      packageDirs,
      runtimePluginCatalogue: [acme],
      extensionLoader: {
        import: async (file) => (await import(pathToFileURL(file).href)) as Record<string, unknown>,
      },
    })
    const alpha = resourceExtension('alpha', [])
    const daemon = h.host.applyRuntimeTarget(targetOf([...h.host.extensionRows.current(), pluginRow()]))
    const rows = h.host.extensionRows.apply([
      ...h.host.extensionRows.current(),
      h.host.extensionRows.prepare({ extensionId: alpha.extensionId, dynamic: alpha }),
    ])
    await Promise.all([daemon, rows])
    await settle()
    expect(toolNames(h)).toEqual(expect.arrayContaining(['acme_ping', 'alpha_ping']))
    await h.host.close()
  })

  it('hands each dynamic row its Host-scoped context, so every MCP row reaches one McpCatalogHub per Host', async () => {
    // Stage 2b, D110': the hub is created once per Host and shared by every MCP row and
    // agnes/mcp-search, without Host core importing @agnes/base (host/test/boundary.test.ts). What
    // makes that work is Host handing a dynamic row the same `SeamInitContext` a bundled factory
    // gets -- `mcpCatalogHubFor(ctx)` keys on its `signal`. This goes through real assembly and real
    // storage, not the fakes in base/extensions/mcp-server/test/catalog-hub.test.ts.
    const hubProbe = (name: string, seen: Map<string, McpCatalogHub>) => {
      const id = `agnes/test-hub-${name}`
      return {
        extensionId: id,
        spec: {
          id,
          // The hub binds to the first caller's storage scope; MCP rows are @agnes/base-owned.
          package: '@agnes/base',
          packageVersion: '0.0.0',
          dir: tmpdir(),
          trust: 'builtin' as const,
          enabled: true,
          revision: 'r1',
        },
        manifest: {
          id,
          version: '0.1.0',
          apiRange: `^${API_VERSION.split('.')[0]}.0`,
          entry: './index.mjs',
          capabilities: {},
        } as ExtensionManifest,
        factory: (ctx: Parameters<typeof mcpCatalogHubFor>[0]) => {
          seen.set(name, mcpCatalogHubFor(ctx))
          return defineExtension(() => undefined)
        },
      }
    }
    const mount = async (h: H, probes: ReturnType<typeof hubProbe>[]) => {
      await h.host.extensionRows.apply([
        ...h.host.extensionRows.current(),
        ...probes.map((dynamic) =>
          h.host.extensionRows.prepare({ extensionId: dynamic.extensionId, dynamic }),
        ),
      ])
      await settle()
    }

    const one = await createTestHost({ dataDir: scratch(), packageDirs })
    const seenOne = new Map<string, McpCatalogHub>()
    await mount(one, [hubProbe('a', seenOne), hubProbe('b', seenOne)])
    const two = await createTestHost({ dataDir: scratch(), packageDirs })
    const seenTwo = new Map<string, McpCatalogHub>()
    await mount(two, [hubProbe('a', seenTwo)])
    try {
      expect(seenOne.get('a')).toBeDefined()
      // Two rows in one Host: one hub, so cross-server duplicate-name claims are seen by both.
      expect(seenOne.get('b')).toBe(seenOne.get('a'))
      // Another Host in the same process: its own hub.
      expect(seenTwo.get('a')).toBeDefined()
      expect(seenTwo.get('a')).not.toBe(seenOne.get('a'))
      // And it is a working, storage-backed index, not just an object identity.
      seenOne.get('a')?.upsert('server-a', [{ name: 'mcp_a_ping', description: 'ping', schema: '{}' }])
      expect(seenOne.get('b')?.get('mcp_a_ping')?.description).toBe('ping')
      expect(seenTwo.get('a')?.get('mcp_a_ping')).toBeUndefined()
    } finally {
      await one.host.close()
      await two.host.close()
    }
  })

  describe('probe (design doc §6 "整树重建的代价"): today\'s incremental-apply gate, ahead of MCP rows landing on it', () => {
    // `runtime-target-publisher.ts`'s `incrementalSafe` gate requires `canReuseRowImporter(current,
    // desired)` to hold for EVERY row in the desired target, not just the one that changed. For a
    // `builtin:`-prefixed row (what an ext: row's `plugin` id always is -- see
    // ext-rows.ts:buildExtensionRow) that function additionally requires `config` to be
    // byte-identical to the live row's, or that one row disqualifies the whole apply from the
    // incremental path -- forcing `assembleRuntimeTargetOrdinaryCandidate`'s full rebuild for every
    // row in the tree, not just the row whose config changed. MCP server rows are ext: rows too
    // (stage 2b step 3 will mount them through the same DynamicExtension path this file already
    // exercises), so "change one MCP server's config" will hit exactly this gate. This probe pins
    // today's actual behavior with a synthetic dynamic row standing in for an MCP row, so a future
    // rerun against a landed incremental-apply widening has a concrete before/after to compare.
    it("changing one dynamic row's config today restarts an unrelated dynamic row too", async () => {
      const h = await createTestHost({ dataDir: scratch(), packageDirs })
      const log: string[] = []
      const alpha = resourceExtension('alpha', log)
      const beta = resourceExtension('beta', log)
      await h.host.extensionRows.apply([
        ...h.host.extensionRows.current(),
        h.host.extensionRows.prepare({ extensionId: alpha.extensionId, dynamic: alpha, config: { v: 1 } }),
        h.host.extensionRows.prepare({ extensionId: beta.extensionId, dynamic: beta }),
      ])
      await settle()
      expect(log.filter((line) => line.endsWith(':beta'))).toEqual(['open:beta'])

      // Only alpha's config changes; beta's own prepare() call is byte-identical to before.
      await h.host.extensionRows.apply([
        ...h.host.extensionRows.current().filter((r) => r.id !== `ext:${alpha.extensionId}`),
        h.host.extensionRows.prepare({ extensionId: alpha.extensionId, dynamic: alpha, config: { v: 2 } }),
      ])
      await settle()
      // Beta gets torn down and rebuilt purely because alpha's config changed under an unchanged
      // identity: the builtin: config-equality gate in canReuseRowImporter sends the whole apply down
      // the full-rebuild path. MCP rows never take this shape -- they carry no config, an edit changes
      // their identity instead (next probe) -- and worker-runtime/test/mcp-row-runtime.test.ts pins
      // that they are prepared without one. This probe stays as the record of why.
      expect(log.filter((line) => line.endsWith(':beta'))).toEqual(['open:beta', 'close:beta', 'open:beta'])
      await h.host.close()
    })

    // The shape step 3 actually produces. mcpServerRowsFromDefinitions (worker-runtime) never puts
    // anything in a row's `config`: an edited MCP definition surfaces as a new `spec.revision`, i.e.
    // a new entryRevision, i.e. a new mountIdentity (plugin-runtime's buildMountIdentity hashes
    // entryRevision). canReuseRowImporter returns true for an identity change before it ever reaches
    // the builtin: config-equality check, so this goes through the live-tree transaction -- which is
    // what incremental apply (2026-09-21-runtime-target-incremental-apply-design.md, started for
    // exactly this) delivers. The probe above covers the other, config-only shape, which MCP rows
    // deliberately never produce.
    it("changing one dynamic row's entryRevision swaps only that row; an unrelated dynamic row keeps running", async () => {
      const h = await createTestHost({ dataDir: scratch(), packageDirs })
      const log: string[] = []
      const alpha = resourceExtension('alpha', log)
      const beta = resourceExtension('beta', log)
      await h.host.extensionRows.apply([
        ...h.host.extensionRows.current(),
        h.host.extensionRows.prepare({ extensionId: alpha.extensionId, dynamic: alpha, entryRevision: 'r1' }),
        h.host.extensionRows.prepare({ extensionId: beta.extensionId, dynamic: beta }),
      ])
      await settle()

      await h.host.extensionRows.apply([
        ...h.host.extensionRows.current().filter((r) => r.id !== `ext:${alpha.extensionId}`),
        h.host.extensionRows.prepare({ extensionId: alpha.extensionId, dynamic: alpha, entryRevision: 'r2' }),
      ])
      await settle()
      expect(log.filter((line) => line.endsWith(':alpha'))).toEqual([
        'open:alpha',
        'close:alpha',
        'open:alpha',
      ])
      expect(log.filter((line) => line.endsWith(':beta'))).toEqual(['open:beta'])
      expect(toolNames(h)).toEqual(expect.arrayContaining(['alpha_ping', 'beta_ping']))
      await h.host.close()
    })

    // What the worker's MCP row runtime actually does on every reload: derive every server's row
    // afresh from the snapshot -- a new DynamicExtension object and factory closure each time, even
    // for a server that did not change -- and prepare them all again. Only an identity change may
    // remount a row; a fresh factory with the same revision must not.
    it('re-preparing an unchanged dynamic row with a fresh factory does not remount it', async () => {
      const h = await createTestHost({ dataDir: scratch(), packageDirs })
      const log: string[] = []
      const derive = (revision: string) => ({
        alpha: {
          ...resourceExtension('alpha', log),
          spec: { ...resourceExtension('alpha', log).spec, revision },
        },
        beta: resourceExtension('beta', log),
      })
      const applyAll = async (rows: ReturnType<typeof derive>) => {
        const mine = new Set([rows.alpha, rows.beta].map((d) => `ext:${d.extensionId}`))
        await h.host.extensionRows.apply([
          ...h.host.extensionRows.current().filter((r) => !mine.has(r.id)),
          ...[rows.alpha, rows.beta].map((dynamic) =>
            h.host.extensionRows.prepare({ extensionId: dynamic.extensionId, dynamic }),
          ),
        ])
        await settle()
      }
      await applyAll(derive('r1'))
      await applyAll(derive('r1'))
      expect(log).toEqual(['open:alpha', 'open:beta'])
      await applyAll(derive('r2'))
      expect(log.filter((line) => line.endsWith(':alpha'))).toEqual([
        'open:alpha',
        'close:alpha',
        'open:alpha',
      ])
      expect(log.filter((line) => line.endsWith(':beta'))).toEqual(['open:beta'])
      await h.host.close()
    })

    // Design §6: "候选树先建、旧树后拆的既有隐患...会在 MCP 行上暴露，落地前应先探针验证候选树失败后旧树的
    // MCP 行是否已被吊销" (未实测). A dynamic ext: row stands in for an MCP row; a real third-party
    // plugin whose module body throws is the only way to make `applyRuntimeTarget` reject the whole
    // candidate rather than isolate one failed extension (an ext: row's own open() failing is caught
    // per-row -- see the D100 test above -- and never reaches this path).
    it('a dynamic row already mounted survives a later candidate that gets rejected outright', async () => {
      const bad = pluginSourceWith([
        { exportName: 'bad', rowId: 'ext:acme/bad', body: "throw new Error('plugin failed to start')" },
      ])
      const h = await createTestHost({
        dataDir: scratch(),
        packageDirs,
        runtimePluginCatalogue: [bad],
        extensionLoader: {
          import: async (file) => (await import(pathToFileURL(file).href)) as Record<string, unknown>,
        },
      })
      const log: string[] = []
      const alpha = resourceExtension('alpha', log)
      await h.host.extensionRows.apply([
        ...h.host.extensionRows.current(),
        h.host.extensionRows.prepare({ extensionId: alpha.extensionId, dynamic: alpha }),
      ])
      await settle()
      expect(toolNames(h)).toContain('alpha_ping')

      // Driven through applyRuntimeTarget directly with the full current row set plus the bad
      // plugin -- the shape a real package-driven candidate takes. Routing this same row mix through
      // `extensionRows.apply` instead is not a supported combination: that API composes Host-owned
      // rows onto the live target itself (composeExtensionRowTarget), it does not accept an arbitrary
      // third-party plugin row as part of its own `rows` input, and doing so anyway was observed to
      // corrupt what "live" means for the *next* apply -- a misuse artifact of that probe, not a
      // reproduction of design §6's concern, so it is not asserted here.
      await expect(
        h.host.applyRuntimeTarget(
          targetOf([...h.host.extensionRows.current(), pluginRow('ext:acme/bad', 'bad')]),
        ),
      ).rejects.toThrow()
      await settle()

      // The rejected candidate took nothing from the live tree: alpha is still mounted and its tool
      // still registered, exactly as before the rejected apply.
      expect(h.host.extensions().find((e) => e.id === alpha.extensionId)?.loaded).toBe(true)
      expect(toolNames(h)).toContain('alpha_ping')
      expect(h.host.extensions().find((e) => e.id === 'agnes/tools-core')?.loaded).toBe(true)
      await h.host.close()
    })
  })
})
