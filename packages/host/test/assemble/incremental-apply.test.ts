import { describe, expect, it } from 'vitest'
import { RuntimePluginCatalogue } from '../../src/runtime-plugin-catalogue.js'
import {
  livePluginHost,
  pluginRow,
  pluginSourceWith,
  settle,
  targetOf,
  toolNames,
} from './plugin-extension-fixture.js'

const A = '@acme/a'
const B = '@acme/b'
const V1 = `sha256-${'1'.repeat(64)}`
const V2 = `sha256-${'2'.repeat(64)}`
const V3 = `sha256-${'3'.repeat(64)}`
const counter = (name: string) =>
  `globalThis.__runs ??= {}; globalThis.__runs['${name}'] = (globalThis.__runs['${name}'] ?? 0) + 1`
const runs = (name: string): number => (globalThis as { __runs?: Record<string, number> }).__runs?.[name] ?? 0

function source(vendor: string, snapshotId: string, body: string, trusted = true) {
  return {
    ...pluginSourceWith([{ exportName: 'plugin', rowId: `ext:${vendor.slice(1)}`, body }], {
      vendor,
      snapshotId,
    }),
    trusted,
  }
}
const rowOf = (vendor: string, snapshotId: string) =>
  pluginRow(`ext:${vendor.slice(1)}`, 'plugin', false, { vendor, snapshotId })

describe('incremental apply on the live tree', () => {
  it('catalogue get returns the source by package and snapshot', () => {
    const s = source(A, V1, '')
    const catalogue = new RuntimePluginCatalogue([s])
    expect(catalogue.get(A, V1)).toBe(s)
    expect(catalogue.get(A, V2)).toBeUndefined()
    expect(catalogue.get(B, V1)).toBeUndefined()
  })

  it('a newly installed version is importable', async () => {
    let installed = [source(A, V1, `agnes.registerTool(tool('a_tool'))`)]
    const h = await livePluginHost(() => installed)
    await h.host.applyRuntimeTarget(targetOf([rowOf(A, V1)]))
    installed = [source(A, V2, `agnes.registerTool(tool('a_tool'))`), ...installed]
    await h.host.applyRuntimeTarget(targetOf([rowOf(A, V2)]))
    await settle()
    expect(toolNames(h)).toContain('a_tool')
    await h.host.close()
  })

  it('upgrading A leaves B untouched', async () => {
    let installed = [
      source(A, V1, `${counter('a')}; agnes.registerTool(tool('a_tool'))`),
      source(B, V1, `${counter('b')}; agnes.registerTool(tool('b_tool'))`),
    ]
    const h = await livePluginHost(() => installed)
    await h.host.applyRuntimeTarget(targetOf([rowOf(A, V1), rowOf(B, V1)]))
    await settle()
    const before = runs('b')
    installed = [source(A, V2, `${counter('a')}; agnes.registerTool(tool('a_tool'))`), ...installed]
    await h.host.applyRuntimeTarget(targetOf([rowOf(A, V2), rowOf(B, V1)]))
    await settle()
    expect(runs('b')).toBe(before)
    expect(toolNames(h)).toEqual(expect.arrayContaining(['a_tool', 'b_tool']))
    await h.host.close()
  })

  it('a failed upgrade rolls back to the old version of A', async () => {
    let installed = [source(A, V1, `agnes.registerTool(tool('a_v1'))`)]
    const h = await livePluginHost(() => installed)
    await h.host.applyRuntimeTarget(targetOf([rowOf(A, V1)]))
    await settle()
    installed = [source(A, V3, `throw new Error('v3 does not start')`), ...installed]
    await expect(h.host.applyRuntimeTarget(targetOf([rowOf(A, V3)]))).rejects.toThrow()
    await settle()
    expect(toolNames(h)).toContain('a_v1')
    await h.host.close()
  })

  it('rebuilds the whole tree when compensation itself fails, instead of silently losing the row', async () => {
    // Succeeds on mount 1 (the initial delivery) and on mount 4+ (rebuildLiveTree's fresh
    // full-candidate rebuild, which does not go through the poisoned live tree); fails on
    // mounts 2 and 3 (EntryTree's own internal compensation attempt, then the Host's one
    // explicit retry) so both compensation attempts fail and the transaction reports
    // 'recovery-required' rather than compensating cleanly.
    const flakyBody = `
      globalThis.__runs ??= {}
      globalThis.__runs['a_v1'] = (globalThis.__runs['a_v1'] ?? 0) + 1
      if (globalThis.__runs['a_v1'] === 2 || globalThis.__runs['a_v1'] === 3)
        throw new Error('a_v1 compensation attempt fails')
      agnes.registerTool(tool('a_v1'))
    `
    let installed = [source(A, V1, flakyBody)]
    const h = await livePluginHost(() => installed)
    await h.host.applyRuntimeTarget(targetOf([rowOf(A, V1)]))
    await settle()
    expect(runs('a_v1')).toBe(1)
    expect(toolNames(h)).toContain('a_v1')
    installed = [source(A, V3, `throw new Error('v3 does not start')`), ...installed]
    await expect(h.host.applyRuntimeTarget(targetOf([rowOf(A, V3)]))).rejects.toThrow('recovery failed')
    await settle()
    // Both compensation attempts (runs 2 and 3) failed, leaving the tree not tainted (no hang,
    // just ordinary rejections) but no longer self-consistent without help. `rebuildLiveTree`
    // must have fired and remounted A through a fresh candidate (run 4) rather than leaving it
    // silently vanished from the plugin table.
    expect(runs('a_v1')).toBeGreaterThanOrEqual(4)
    expect(toolNames(h)).toContain('a_v1')
    await h.host.close()
  })

  it('rebuilds the whole tree when compensation itself hangs and taints it, instead of losing the row silently', async () => {
    // v1's body hangs on runs 2 and 3 — EntryTree's own internal compensation attempt, then the
    // Host's one explicit retry, remounting it after v3 fails to start. Both time out and taint
    // the tree, unlike the throwing-compensation case above; the rebuild guard must still fire in
    // this case, not only when the tree is merely inconsistent-but-not-tainted. Run 1 (initial
    // delivery) and run 4+ (rebuildLiveTree's fresh full-candidate rebuild, which does not go
    // through the poisoned live tree) must still succeed.
    const hangDuringCompensation = `
      globalThis.__runs ??= {}
      globalThis.__runs['a_v1_hang'] = (globalThis.__runs['a_v1_hang'] ?? 0) + 1
      if (globalThis.__runs['a_v1_hang'] === 2 || globalThis.__runs['a_v1_hang'] === 3)
        await new Promise(() => undefined)
      else agnes.registerTool(tool('a_v1'))
    `
    let installed = [source(A, V1, hangDuringCompensation)]
    const h = await livePluginHost(() => installed, { startTimeoutMs: 200 })
    await h.host.applyRuntimeTarget(targetOf([rowOf(A, V1)]))
    await settle()
    expect(toolNames(h)).toContain('a_v1')
    installed = [source(A, V3, `throw new Error('v3 does not start')`), ...installed]
    await expect(h.host.applyRuntimeTarget(targetOf([rowOf(A, V3)]))).rejects.toThrow('recovery failed')
    await settle()
    // The hung compensation timed out and tainted the tree; rebuildLiveTree must still repair it
    // through a fresh candidate rather than leaving a_v1 silently vanished from the plugin table.
    expect(toolNames(h)).toContain('a_v1')
    // Close must not wait on the still-hung compensation fiber.
    await h.host.close()
  }, 20_000)

  it('an untrusted package is not remounted when the delivery that removes it is rejected', async () => {
    const a = source(A, V1, `agnes.registerTool(tool('a_tool'))`)
    let installed = [a]
    const h = await livePluginHost(() => installed)
    await h.host.applyRuntimeTarget(targetOf([rowOf(A, V1)]))
    await settle()
    expect(toolNames(h)).toContain('a_tool')
    // The same delivery drops A (just untrusted) and hands ext:agnes/hooks-runner to a row that
    // registers none of its hooks, so the governance check rejects it after the transaction ran.
    const replacement = {
      ...pluginSourceWith([{ exportName: 'plugin', rowId: 'ext:agnes/hooks-runner', body: '' }], {
        vendor: '@acme/hooks',
        snapshotId: V1,
      }),
      trusted: true,
    }
    installed = [{ ...a, trusted: false }, replacement]
    const replacementRow = pluginRow('ext:agnes/hooks-runner', 'plugin', false, {
      vendor: '@acme/hooks',
      snapshotId: V1,
    })
    await expect(h.host.applyRuntimeTarget(targetOf([replacementRow]))).rejects.toThrow()
    await settle()
    expect(toolNames(h)).not.toContain('a_tool')
    expect(h.host.extensions().find((e) => e.id === 'agnes/hooks-runner')?.loaded).toBe(true)
    await h.host.close()
  })

  it('a hung mount times out, and a later builtin change and Host close do not hang', async () => {
    let installed = [source(A, V1, `agnes.registerTool(tool('a_v1'))`)]
    const h = await livePluginHost(() => installed, { startTimeoutMs: 200 })
    await h.host.applyRuntimeTarget(targetOf([rowOf(A, V1)]))
    await settle()
    installed = [source(A, V2, `await new Promise(() => undefined)`), ...installed]
    await expect(h.host.applyRuntimeTarget(targetOf([rowOf(A, V2)]))).rejects.toThrow()
    expect(toolNames(h)).toContain('a_v1')
    // A builtin config change still retires the whole tree; the tainted tree must not block it.
    await h.host.extensionRows.apply([
      h.host.extensionRows.prepare({ extensionId: 'agnes/tools-core', config: { note: 'after-stuck' } }),
    ])
    await h.host.close()
  }, 20_000)

  it('boot mounts the builtin ext rows through the transaction on the second assembly', async () => {
    const h = await livePluginHost(() => [])
    await settle()
    const loaded = h.host
      .extensions()
      .filter((e) => e.loaded)
      .map((e) => e.id)
    expect(loaded).toEqual(
      expect.arrayContaining(['agnes/tools-core', 'agnes/privacy', 'agnes/hooks-runner']),
    )
    await h.host.close()
  })

  it('a failed delivery does not restart the rows it never touched', async () => {
    let installed = [
      source(A, V1, `agnes.registerTool(tool('a_v1'))`),
      source(B, V1, `${counter('b_failed')}; agnes.registerTool(tool('b_tool'))`),
    ]
    const h = await livePluginHost(() => installed)
    await h.host.applyRuntimeTarget(targetOf([rowOf(A, V1), rowOf(B, V1)]))
    await settle()
    const before = runs('b_failed')
    installed = [source(A, V3, `throw new Error('v3 does not start')`), ...installed]
    await expect(h.host.applyRuntimeTarget(targetOf([rowOf(A, V3), rowOf(B, V1)]))).rejects.toThrow()
    await settle()
    // The transaction compensated on the live tree, so nothing is rebuilt behind it.
    expect(runs('b_failed')).toBe(before)
    expect(toolNames(h)).toEqual(expect.arrayContaining(['a_v1', 'b_tool']))
    await h.host.close()
  })
})
