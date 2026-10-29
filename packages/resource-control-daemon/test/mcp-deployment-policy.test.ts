import { expect, it } from 'vitest'
import { deploymentMcpPolicy } from '../src/package-skill-snapshot.js'

it('retains complete Windows paths and filters shell or command text from deployment allowlists', () => {
  const executable = String.raw`C:\Program Files\nodejs\node.exe`
  expect(
    deploymentMcpPolicy({ AGNES_MCP_STDIO_ALLOWLIST: `${executable},node --version,C:/Tools/PWSH.EXE` })
      .allowedExecutables,
  ).toEqual([executable])
  expect(() => deploymentMcpPolicy({ AGNES_MCP_STDIO_ALLOWLIST: `${executable},${executable}` })).toThrow(
    'duplicates',
  )
})

it('allows local development MCPs by default with explicit opt-out and unchanged enterprise policy', () => {
  expect(deploymentMcpPolicy({}, 'local-dev')).toMatchObject({
    allowedExecutables: ['node', 'npx', 'python', 'python3'],
    allowLoopbackHttp: true,
  })
  for (const policy of [
    deploymentMcpPolicy({}, 'enterprise'),
    deploymentMcpPolicy({ AGNES_MCP_LOCAL_DEV_DEFAULTS: '0' }, 'local-dev'),
  ])
    expect(policy).toMatchObject({ allowedExecutables: [], allowLoopbackHttp: false })
  expect(
    deploymentMcpPolicy({ AGNES_MCP_STDIO_ALLOWLIST: '', AGNES_MCP_ALLOW_LOOPBACK_HTTP: '0' }, 'local-dev'),
  ).toMatchObject({ allowedExecutables: [], allowLoopbackHttp: false })
})
