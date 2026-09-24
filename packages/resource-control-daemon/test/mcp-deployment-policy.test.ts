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
