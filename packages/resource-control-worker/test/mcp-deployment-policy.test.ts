import { expect, it } from 'vitest'
import { deploymentMcpPolicy } from '../src/skill-bootstrap.js'

it('preserves an approved Windows executable without splitting or normalizing it', () => {
  const executable = String.raw`C:\Program Files\nodejs\node.exe`
  const policy = { allowedExecutables: [executable], allowLoopbackHttp: false, localDaemon: true }
  expect(deploymentMcpPolicy({ AGNES_RESOURCE_MCP_POLICY: JSON.stringify(policy) })).toEqual(policy)
})

it.each(['node --version', 'C:/Tools/PWSH.EXE', 'node\u0007', 123])(
  'rejects invalid executable %j',
  (executable) => {
    expect(() =>
      deploymentMcpPolicy({
        AGNES_RESOURCE_MCP_POLICY: JSON.stringify({ allowedExecutables: [executable] }),
      }),
    ).toThrow('invalid deployment MCP policy')
  },
)
