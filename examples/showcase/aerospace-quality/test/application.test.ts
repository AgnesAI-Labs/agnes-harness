import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAuthorTestkit } from '@agnes/host/author-testkit'
import { developmentPluginRows, readApplicationAsset, readDevelopmentPlugin } from '@agnes/package-manager'
import { type Context, defineAgnesPlugin, toolPolicyKind } from '@agnes/plugin-runtime'
import { assertPublishableRows } from '@agnes/plugin-runtime/host'
import { DSH_SLOT_CATALOG_VERSION } from '@agnes/web-client'
import { expect, it } from 'vitest'
import { tools } from '../src/index.js'
import { humanReviewPolicy } from '../src/policy.js'

const directory = fileURLToPath(new URL('../', import.meta.url))
it('public package inspection resolves the third-party application, eight profile pages, five agents and bounded raster identity', async () => {
  const clean = await mkdtemp(join(tmpdir(), 'agh-aero-inspect-'))
  await cp(directory, clean, { recursive: true, filter: (path) => !path.split('/').includes('node_modules') })
  let inspected: Awaited<ReturnType<typeof readDevelopmentPlugin>>
  try {
    inspected = await readDevelopmentPlugin(clean, 'local-dev')
    expect(() => assertPublishableRows(developmentPluginRows(inspected, []))).not.toThrow()
  } finally {
    await rm(clean, { recursive: true, force: true })
  }
  expect(inspected.snapshot.packageId).toBe('@agnes-showcase/aerospace-quality')
  expect(inspected.snapshot.version).toBe('1.1.4')
  expect(tools.find((tool) => tool.name === 'aero_report')?.meta.attestsHistory).toBe(true)
  expect(inspected.snapshot.application?.id).toBe('qiongxu-aerospace-quality')
  expect(inspected.snapshot.application?.agents).toHaveLength(5)
  expect(inspected.snapshot.application?.presentation?.navigation?.entries).toHaveLength(2)
  const pageIcons = inspected.snapshot.contributions.flatMap((row) =>
    'client' in row ? (row.client?.homeEntries ?? []).map((page) => page.navigation?.icon) : [],
  )
  const pages = inspected.snapshot.contributions.flatMap((row) =>
    'client' in row ? (row.client?.homeEntries ?? []) : [],
  )
  expect(pages.filter((page) => page.placement === 'primary').map((page) => page.id)).toEqual([
    'aero-home',
    'aero-tasks',
  ])
  expect(new Set(pageIcons).size).toBe(7)
  expect(inspected.snapshot.application?.workbench?.tabs).toHaveLength(3)
  expect(inspected.snapshot.application?.workbench?.actions).toHaveLength(4)
  expect(pageIcons).not.toContain('plugin')
  const card = inspected.snapshot.contributions.find(
    (contribution) => 'client' in contribution && contribution.client?.slots?.includes('tool.call.toolview'),
  )
  expect(card && 'client' in card ? card.client?.slotCatalogVersion : undefined).toBe(
    DSH_SLOT_CATALOG_VERSION,
  )
  for (const asset of ['assets/mark.png', 'assets/favicon.png']) {
    const bytes = await readApplicationAsset(directory, asset)
    expect(bytes.length).toBeLessThan(131072)
    expect(bytes.subarray(1, 4).toString()).toBe('PNG')
  }
})
it('ordinary Core tool permission refuses before execution and preserves the installed generation pin', async () => {
  const decision = tools.find((t) => t.name === 'aero_decide')!
  const plugin = defineAgnesPlugin({
    inject: ['tools', 'providers'],
    apply(ctx: Context) {
      ctx.providers.register(toolPolicyKind, humanReviewPolicy)
      ctx.tools.register({
        ...decision,
        execute: async (_input, context) => ({
          content: [{ type: 'text', text: JSON.stringify(context.approval ?? null) }],
          structured: { revision: 1, data: context.approval ?? null },
        }),
      })
    },
  })
  let allowed = false
  const kit = await createAuthorTestkit({
    plugin,
    version: '1.0.0',
    preset: 'quality-review',
    presets: {
      'quality-review': {
        name: 'quality-review',
        extends: 'standard',
        providers: { 'tool-policy': { provider: 'aero-human-review' } },
      },
    },
    approval: async () => ({
      verdict: allowed ? 'allowed-once' : 'rejected',
      answeredBy: { id: 'synthetic-mrb-reviewer', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    }),
  })
  try {
    const session = await kit.openSession()
    const generation = session.generation
    await session.invoke('aero_decide', { kind: 'mrb', id: 'NCR-018', expectedRevision: 1 })
    await session.assertApproval('rejected')
    await session.assertRefused('aero_decide')
    allowed = true
    const input = { kind: 'mrb' as const, id: 'NCR-018', expectedRevision: 1 }
    const result = await session.invoke('aero_decide', input)
    expect(result.isError).not.toBe(true)
    await session.assertApproval('allowed-once')
    // Ordinary permission admits invocation; it is deliberately not a business signature proof.
    expect((result.structured as { data: unknown }).data).toBeNull()
    const next = await kit.reload({ plugin, version: '1.0.1' })
    session.assertPinned(generation!)
    expect(next).not.toBe(generation)
  } finally {
    await kit.dispose()
  }
})
