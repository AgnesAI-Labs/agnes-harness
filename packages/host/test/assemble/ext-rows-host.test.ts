import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRuntimeTarget } from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

// Package directories, not imports: host does not depend on @agnes/base, it loads what the profile
// names off disk. Precedent: packages/host/test/ext-host/base-tools.test.ts:16.
const packageDirs = {
  '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)),
  '@agnes/code': fileURLToPath(new URL('../../../code', import.meta.url)),
}
const TOOLS_CORE = ['read', 'write', 'edit', 'shell', 'todo']
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agnes-ext-rows-'))
  dirs.push(d)
  return d
}
type H = Awaited<ReturnType<typeof createTestHost>>
// Audit events are shaped { kind, detail }, not { event, data }.
const audits = (h: H, kind: string, id: string) =>
  h.audit.events.filter((e) => e.kind === kind && (e.detail as { id?: string } | undefined)?.id === id)
const toolNames = (h: H) => h.host.kernel.tools.list().map((t) => t.name)
// Retirement of the previous tree runs AFTER applyRuntimeTarget resolves, so every post-apply
// observation has to let the timer queue drain first. Measured fact, not taste.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('ext: rows on the tree', () => {
  it('tools-core mounts as ext:agnes/tools-core and is supplied exactly once', async () => {
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    expect(h.host.ordinaryConvergence().rows.find((r) => r.id === 'ext:agnes/tools-core')).toMatchObject({
      state: 'active',
    })
    expect(h.host.extensions().find((e) => e.id === 'agnes/tools-core')?.loaded).toBe(true)
    // The whole point of the suppression: one supply side per id.
    expect(audits(h, 'extension.loaded', 'agnes/tools-core')).toHaveLength(1)
    for (const name of TOOLS_CORE) expect(toolNames(h)).toContain(name)
    await h.host.close()
  })

  // Stage 2a (D98): hooks-runner and privacy left the resource slots for ordinary ext: rows.
  it.each(['agnes/hooks-runner', 'agnes/privacy'])(
    '%s mounts as an ext: row in the tree and is supplied exactly once',
    async (extensionId) => {
      const h = await createTestHost({ dataDir: scratch(), packageDirs })
      expect(h.host.ordinaryConvergence().rows.find((r) => r.id === `ext:${extensionId}`)).toMatchObject({
        state: 'active',
      })
      expect(h.host.extensions().find((e) => e.id === extensionId)?.loaded).toBe(true)
      expect(audits(h, 'extension.loaded', extensionId)).toHaveLength(1)
      // The row is driven through the same surface as every other builtin ext: row.
      expect(h.host.extensionRows.current().map((r) => r.id)).toContain(`ext:${extensionId}`)
      await h.host.close()
    },
  )

  it('the ext: row is exposed through the Host driver surface, in tree order', async () => {
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    expect(h.host.extensionRows.current().map((r) => r.id)).toContain('ext:agnes/tools-core')
    await h.host.close()
  })

  it('a target that omits the row unmounts the extension and drops its tools', async () => {
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    const report = await h.host.extensionRows.apply([])
    expect(report.ok).toBe(true)
    expect(report.rows.find((r) => r.id === 'ext:agnes/tools-core')).toBeUndefined()
    await settle()
    expect(h.host.extensions().find((e) => e.id === 'agnes/tools-core')?.loaded).toBe(false)
    expect(audits(h, 'extension.revoked', 'agnes/tools-core')).toHaveLength(1)
    expect(audits(h, 'extension.revoke_failed', 'agnes/tools-core')).toHaveLength(0)
    for (const name of TOOLS_CORE) expect(toolNames(h)).not.toContain(name)
    await h.host.close()
  })

  it('a new entryRevision hot-swaps in place and the tools survive the cutover', async () => {
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    const next = h.host.extensionRows.prepare({
      extensionId: 'agnes/tools-core',
      entryRevision: 'ext-rows-test-r2',
    })
    const report = await h.host.extensionRows.apply([next])
    expect(report.rows.find((r) => r.id === 'ext:agnes/tools-core')).toMatchObject({ state: 'active' })
    await settle()
    expect(h.host.extensions().find((e) => e.id === 'agnes/tools-core')?.loaded).toBe(true)
    // Unload + load, not an in-place update: applyRuntimeTarget never diffs, it rebuilds the tree.
    expect(audits(h, 'extension.loaded', 'agnes/tools-core')).toHaveLength(2)
    for (const name of TOOLS_CORE) expect(toolNames(h)).toContain(name)
    await h.host.close()
  })

  it('changing only the config is a full unload+load, not an in-place update', async () => {
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    await h.host.extensionRows.apply([
      h.host.extensionRows.prepare({ extensionId: 'agnes/tools-core', config: { note: 'two' } }),
    ])
    await settle()
    expect(audits(h, 'extension.loaded', 'agnes/tools-core')).toHaveLength(2)
    for (const name of TOOLS_CORE) expect(toolNames(h)).toContain(name)
    await h.host.close()
  })

  it('closing the host revokes each ext: row once and reports no failed revoke', async () => {
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    await h.host.close()
    // The tree goes down before the extension host does, so every row's disposer still finds its
    // extension to revoke. Torn down the other way round, each one fails with "not available".
    expect(h.audit.events.filter((e) => e.kind === 'extension.revoke_failed')).toHaveLength(0)
    expect(audits(h, 'extension.revoked', 'agnes/tools-core')).toHaveLength(1)
  })

  it('the driver surface is fail-closed once the host is closed', async () => {
    // `Host.applyRuntimeTarget` refuses a closed host at the Host boundary; `extensionRows` must not
    // be a way around that guard. `prepare` has no lower guard at all - without this it would still
    // mutate the assembly's builtin-claim catalogue on a closed Host - and `apply` must be refused
    // at the same boundary, not several layers down inside the publication gate.
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    await h.host.close()
    expect(() => h.host.extensionRows.prepare({ extensionId: 'agnes/tools-core' })).toThrowError(
      'E_HOST_CLOSED: host is closed',
    )
    await expect(h.host.extensionRows.apply([])).rejects.toMatchObject({
      code: 'E_HOST_CLOSED',
      message: 'E_HOST_CLOSED: host is closed',
    })
  })

  it('computer-use gets no backend provider on a host where it is disabled, and the row still mounts', async () => {
    // The local-dev template enables computerUse, so this case names a user profile that disables
    // it: no row is built for it at all and no privileged value is delivered. Nothing must fail
    // because of that.
    const h = await createTestHost({
      dataDir: scratch(),
      packageDirs,
      profileInputs: { user: { name: 'local-dev', computerUse: { enabled: false } } },
    })
    expect(h.host.extensionRows.current().map((r) => r.id)).not.toContain('ext:agnes/computer-use')
    expect(h.host.ordinaryConvergence().ok).toBe(true)
    await h.host.close()
  })

  it('mounts computer-use on the local-dev profile and still converges', async () => {
    // local-dev enables Computer Use, so the row is built. Convergence must still succeed.
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    expect(h.host.extensionRows.current().map((r) => r.id)).toContain('ext:agnes/computer-use')
    expect(h.host.ordinaryConvergence().ok).toBe(true)
    await h.host.close()
  })

  it('a daemon target that carries no ext: rows keeps the builtin extensions and their tools', async () => {
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    // The daemon builds its desired tree from installed packages only, so it never names ext: rows.
    await h.host.applyRuntimeTarget(
      buildRuntimeTarget({
        rows: [],
        resources: { mcp: [], skills: {} },
        resourceRevision: '0'.repeat(64),
        compositeRevision: '0'.repeat(64),
      }),
    )
    await settle()
    expect(h.host.extensions().find((e) => e.id === 'agnes/tools-core')?.loaded).toBe(true)
    for (const name of TOOLS_CORE) expect(toolNames(h)).toContain(name)
    // Removing the row through the Host's own ext: row surface still unmounts it.
    await h.host.extensionRows.apply([])
    await settle()
    expect(h.host.extensions().find((e) => e.id === 'agnes/tools-core')?.loaded).toBe(false)
    for (const name of TOOLS_CORE) expect(toolNames(h)).not.toContain(name)
    await h.host.close()
  })

  it('an ext: row apply is built from the published target, not from the boot rows', async () => {
    const h = await createTestHost({ dataDir: scratch(), packageDirs })
    const ids = () => h.host.ordinaryConvergence().rows.map((r) => r.id)
    const bootIds = ids()
    expect(bootIds.length).toBeGreaterThan(1)
    // A post-boot composite target that drops every boot row: the shape the daemon publishes when it
    // owns the rows (the existing seam-facade tests apply the same empty target).
    await h.host.applyRuntimeTarget(
      buildRuntimeTarget({
        rows: [],
        resources: { mcp: [], skills: {} },
        resourceRevision: '0'.repeat(64),
        compositeRevision: '0'.repeat(64),
      }),
    )
    await settle()
    // The four resource-owned slots are always reported; the boot rows are what must be gone.
    const dropped = ids()
    expect(dropped.length).toBeLessThan(bootIds.length)
    // Driving only the ext: rows must not resurrect what the published target dropped.
    await h.host.extensionRows.apply([])
    await settle()
    expect(ids()).toEqual(dropped)
    await h.host.close()
  })
})
