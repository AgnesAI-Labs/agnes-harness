import { buildRuntimeTarget } from '@agnes/plugin-runtime/host'
import { describe, expect, it, vi } from 'vitest'
import { ResourceGenerationCell } from '../src/resource-generation-cell.js'
import { stageRuntimeTargetResourceCandidate } from '../src/runtime-target-resources.js'

const revision = 'a'.repeat(64)

function target(resources: { mcp: unknown; skills: unknown } = { mcp: [], skills: {} }) {
  return buildRuntimeTarget({
    rows: [],
    resourceRevision: revision,
    compositeRevision: revision,
    resources,
  })
}

describe('runtime target resource candidate', () => {
  it('passes only a canonical complete resource snapshot to an injected Host factory', async () => {
    const reads = vi.fn(() => undefined)
    const cell = new ResourceGenerationCell<{ value: string }>(reads)
    const create = vi.fn(() => ({ value: 'candidate' }))
    const health = vi.fn()
    const candidate = await stageRuntimeTargetResourceCandidate({
      target: target({ mcp: [{ serverId: 'one', transport: 'stdio' }], skills: { enabled: true } }),
      cell,
      factory: { create, health },
    })

    expect(reads).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: { mcp: [{ serverId: 'one', transport: 'stdio' }], skills: { enabled: true } },
        target: expect.objectContaining({ treeHash: expect.any(String) }),
      }),
      expect.anything(),
    )
    expect(health).toHaveBeenCalledOnce()
    expect(Object.isFrozen(candidate.input.resources)).toBe(true)
    await candidate.abort()
  })

  it('uses the RuntimeTarget codec to reject non-JSON resource input with its exact path', async () => {
    const cell = new ResourceGenerationCell(() => undefined)
    const invalid = JSON.parse(JSON.stringify(target())) as {
      resource: { resources: { mcp: unknown; skills: unknown } }
    }
    invalid.resource.resources.mcp = [{ nested: () => undefined }]

    await expect(
      stageRuntimeTargetResourceCandidate({
        target: invalid,
        cell,
        factory: { create: () => ({}) },
      }),
    ).rejects.toThrow('E_RUNTIME_TARGET: resources.mcp[0].nested must contain only JSON values')
  })

  it('rejects unsupported raw resource shapes before invoking the factory', async () => {
    const cell = new ResourceGenerationCell(() => undefined)
    const create = vi.fn(() => ({}))
    const invalid = JSON.parse(JSON.stringify(target())) as {
      resource: { resources: { mcp: unknown; skills: unknown } }
    }
    invalid.resource.resources.mcp = {}

    await expect(
      stageRuntimeTargetResourceCandidate({ target: invalid, cell, factory: { create } }),
    ).rejects.toThrow('E_RUNTIME_TARGET: resources.mcp must be an array')
    expect(create).not.toHaveBeenCalled()
  })

  it('cleans factory-owned resources when an unpublished candidate is aborted', async () => {
    const cleanup = vi.fn()
    const cell = new ResourceGenerationCell(() => undefined)
    const candidate = await stageRuntimeTargetResourceCandidate({
      target: target(),
      cell,
      factory: {
        create(_input, scope) {
          scope.defer(cleanup)
          return { value: 'candidate' }
        },
      },
    })

    await candidate.abort()
    await candidate.abort()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('cleans factory-owned resources if health validation fails before a candidate exists', async () => {
    const cleanup = vi.fn()
    const cell = new ResourceGenerationCell(() => undefined)

    await expect(
      stageRuntimeTargetResourceCandidate({
        target: target(),
        cell,
        factory: {
          create(_input, scope) {
            scope.defer(cleanup)
            return { value: 'candidate' }
          },
          health() {
            throw new Error('unhealthy')
          },
        },
      }),
    ).rejects.toThrow('unhealthy')
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('makes a resource candidate one-shot without exposing a current pointer', async () => {
    const cell = new ResourceGenerationCell(() => undefined)
    const candidate = await stageRuntimeTargetResourceCandidate({
      target: target(),
      cell,
      factory: { create: () => ({ value: 'candidate' }) },
    })

    expect(candidate.consume()).toBeDefined()
    expect(() => candidate.consume()).toThrow('E_RUNTIME_TARGET_RESOURCE_CANDIDATE_FINALIZED')
    await candidate.abort()
  })
})
