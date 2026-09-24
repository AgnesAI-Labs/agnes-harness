import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

it('does not register an intrinsic MCP tool without an installed plugin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agh-mcp-tool-'))
  const bridge = vi.fn(async () => ({ host: 'Agnes Harness', items: [] }))
  const h = await createTestHost({ dataDir: dir, mcpManage: bridge })
  try {
    expect(h.host.kernel.tools.list().map((t) => t.name)).not.toContain('mcp_manage')
    expect(h.host.extensionRows.current().map((r) => r.id)).not.toContain('ext:agnes/mcp-manage')
  } finally {
    await h.host.close()
    await rm(dir, { recursive: true, force: true })
  }
})
