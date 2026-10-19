import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readApplicationAsset, readDevelopmentPlugin } from '@agnes/package-manager'
import { createAuthorTestkit } from '@agnes/host/author-testkit'
import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import { expect, it } from 'vitest'
import { tools } from '../src/index.js'
const directory = fileURLToPath(new URL('../', import.meta.url))
it('public package inspection resolves the third-party application, six profile pages, five agents and bounded raster identity', async () => {
  const clean = await mkdtemp(join(tmpdir(), 'agh-aero-inspect-'))
  await cp(directory, clean, { recursive: true, filter: (path) => !path.split('/').includes('node_modules') })
  let inspected
  try {
    inspected = await readDevelopmentPlugin(clean, 'local-dev')
  } finally {
    await rm(clean, { recursive: true, force: true })
  }
  expect(inspected.snapshot.packageId).toBe('@agnes-showcase/aerospace-quality')
  expect(inspected.snapshot.application?.id).toBe('qiongxu-aerospace-quality')
  expect(inspected.snapshot.application?.agents).toHaveLength(5)
  expect(inspected.snapshot.application?.presentation?.navigation?.entries).toHaveLength(6)
  for (const asset of ['assets/mark.png', 'assets/favicon.png']) {
    const bytes = await readApplicationAsset(directory, asset)
    expect(bytes.length).toBeLessThan(131072)
    expect(bytes.subarray(1, 4).toString()).toBe('PNG')
  }
})
it('real Core approval refusal stops the consequential decision before execution and pins the installed generation', async () => {
  const decision = tools.find((t) => t.name === 'aero_decide')!
  const plugin = defineAgnesPlugin({
    inject: ['tools'],
    apply(ctx: Context) {
      ctx.tools.register(decision)
    },
  })
  const kit = await createAuthorTestkit({
    plugin,
    version: '1.0.0',
    approval: async () => ({
      verdict: 'rejected',
      answeredBy: { id: 'synthetic-mrb-reviewer', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    }),
  })
  try {
    const session = await kit.openSession()
    const generation = session.generation
    await session.invoke('aero_decide', { kind: 'mrb', id: 'NCR-018', expectedRevision: 1 })
    await session.assertApproval('rejected')
    await session.assertRefused('aero_decide')
    const next = await kit.reload({ plugin, version: '1.0.1' })
    session.assertPinned(generation!)
    expect(next).not.toBe(generation)
  } finally {
    await kit.dispose()
  }
})
