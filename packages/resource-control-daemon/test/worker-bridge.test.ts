import { describe, expect, it } from 'vitest'
import { resourceWorkerEnvironment } from '../src/worker-bridge.js'

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
})
