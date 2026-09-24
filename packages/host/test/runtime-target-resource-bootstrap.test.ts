import { describe, expect, it } from 'vitest'
import { buildCompleteRuntimeTarget } from '../src/runtime-target-builder.js'
import { createHostRuntimeTargetResourceFactory } from '../src/runtime-target-resource-bootstrap.js'

const revision = 'b'.repeat(64)

describe('host runtime target resource factory', () => {
  it('converts canonical MCP/Skills snapshots into a generation that revokes after cleanup', async () => {
    const target = buildCompleteRuntimeTarget({
      rows: [],
      resources: { mcp: [{ id: 'mcp-a' }], skills: { a: { name: 'a' } } },
      resourceRevision: revision,
      compositeRevision: revision,
    }).target
    const factory = createHostRuntimeTargetResourceFactory({
      mcp: { list: () => [{ config: { id: 'live' } } as never] },
    })
    const cleanups: Array<() => void | Promise<void>> = []
    const resources = await factory.create(target.resource, {
      defer(cleanup) {
        cleanups.push(cleanup)
      },
    })
    expect(resources.input.resources.mcp).toEqual([{ id: 'mcp-a' }])
    expect(resources.mcp.list()).toEqual([{ config: { id: 'live' } }])
    for (const cleanup of [...cleanups].reverse()) void cleanup()
    expect(() => resources.mcp.list()).toThrow('E_RESOURCE_GENERATION_UNAVAILABLE')
  })
})
