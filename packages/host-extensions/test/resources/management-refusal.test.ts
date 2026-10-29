import { expect, it } from 'vitest'
import { refusedForParameters } from '../../src/resources/management-refusal.js'

it('reads only the daemon parameter refusal as proof that nothing happened', () => {
  const judge = refusedForParameters('mcp_manage')
  expect(judge({ code: 'INVALID_PARAMS', message: 'anything' })).toMatchObject({
    code: 'INVALID_PARAMS',
    message: expect.stringContaining('mcp_manage refused the request before changing anything'),
  })
  for (const other of [
    { code: 'HELPER_MANAGEMENT_FAILED' },
    { code: 'MCP_REQUEST_NOT_FOUND' },
    new Error('INVALID_PARAMS'),
    'INVALID_PARAMS',
    null,
    undefined,
  ])
    expect(judge(other)).toBeUndefined()
})
