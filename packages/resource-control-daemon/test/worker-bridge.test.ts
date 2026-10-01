import { describe, expect, it } from 'vitest'
import { resourceWorkerEnvironment, resourceWorkerObservation } from '../src/worker-bridge.js'

describe('daemon resource worker bridge', () => {
  it('creates a target-only short-lived MCP test generation without leaking service selectors', () => {
    const environment = resourceWorkerEnvironment(
      { resourceControl: true, resourceTestServerId: 'mcp-a' },
      {
        snapshotPath: '/daemon/private/snapshot.json',
        skillLkgDirectory: '/daemon/private/lkg',
        packageSkillSnapshotPath: '/daemon/private/packages.json',
        mcpPolicy: { allowedExecutables: ['example-mcp'], allowLoopbackHttp: false, localDaemon: true },
      },
    )
    expect(environment).toMatchObject({
      AGNES_RESOURCE_CONTROL: '1',
      AGNES_RESOURCE_TEST_SERVER: 'mcp-a',
      AGNES_RESOURCE_SNAPSHOT: '/daemon/private/snapshot.json',
    })
    expect(environment.AGNES_RESOURCE_MCP_SERVER).toBeUndefined()
    expect(JSON.parse(environment.AGNES_RESOURCE_MCP_POLICY ?? '')).toEqual({
      allowedExecutables: ['example-mcp'],
      allowLoopbackHttp: false,
      localDaemon: true,
    })
  })

  it('keeps the MCP candidate selector independent of resource control', () => {
    const mcp = resourceWorkerEnvironment({ resourceControl: true, resourceMcpServerId: 'mcp-b' }, undefined)
    expect(mcp).toEqual({ AGNES_RESOURCE_CONTROL: '1', AGNES_RESOURCE_MCP_SERVER: 'mcp-b' })
  })

  it('keeps a worker report whose ready MCP status lists the tools it skipped', () => {
    const ready = {
      serverId: 'mcp-a',
      connectionState: 'ready',
      observedRevision: 'a'.repeat(64),
      catalogRevision: 'b'.repeat(64),
      toolCount: 2,
      observedAt: '2026-09-26T00:00:00.000Z',
      skippedToolCount: 40,
      skippedTools: [
        { code: 'description-too-long', name: 'long' },
        { code: 'malformed' },
        ...Array.from({ length: 30 }, (_v, i) => ({ code: 'invalid-schema', name: `s${i}` })),
      ],
    }
    const report = (mcp: unknown) =>
      resourceWorkerObservation({
        workerKind: 'session',
        resources: { snapshotRevision: 'c'.repeat(64), skills: [], mcp: [mcp] },
      })
    expect(report(ready)?.report.mcp).toEqual([ready])
    expect(report({ ...ready, skippedTools: [...ready.skippedTools, { code: 'malformed' }] })).toBeUndefined()
    expect(report({ ...ready, skippedTools: [{ code: 'unknown' }] })).toBeUndefined()
  })
})
