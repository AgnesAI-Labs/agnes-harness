import { expect, it } from 'vitest'
import { mcpPreparationDiagnostics } from './mcp-preparation-diagnostics.js'

it('retains a safe preparation phase and errno without exposing runtime paths or credentials', async () => {
  const error = Object.assign(new Error('PRIVATE-CREDENTIAL'), {
    cmd: '/usr/bin/otool -L /private/runtime-secret',
    code: 'ETIMEDOUT',
    signal: 'SIGTERM',
    killed: true,
    stdout: 'STDOUT-SECRET',
    stderr: 'STDERR-SECRET',
  })
  const result = await mcpPreparationDiagnostics(
    { id: 'fixture', transport: 'stdio', cmd: ['node'], defer: false },
    { dataDir: '/synthetic/data' },
    async () => {
      throw error
    },
  )
  expect(result).toEqual({
    probe: 'mcp-sandbox-prepare',
    state: 'failed',
    stage: 'runtime-inspection',
    code: 'ETIMEDOUT',
    signal: 'SIGTERM',
    killed: true,
  })
  expect(JSON.stringify(result)).not.toMatch(/SECRET|CREDENTIAL|\/private/)
})
