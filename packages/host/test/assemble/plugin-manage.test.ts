import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

it('does not register an intrinsic plugin tool without an installed plugin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agh-plugin-tool-'))
  const bridge = vi.fn(async () => ({ host: 'Agnes Harness', items: [] }))
  const h = await createTestHost({ dataDir: dir, pluginManage: bridge })
  try {
    expect(h.host.kernel.tools.list().map((t) => t.name)).not.toContain('plugin_helper_install')
    expect(h.host.extensionRows.current().map((r) => r.id)).not.toContain('ext:plugin-helper/main')
  } finally {
    await h.host.close()
    await rm(dir, { recursive: true, force: true })
  }
})
