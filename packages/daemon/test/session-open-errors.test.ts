import { HostError, WorkspaceDirectoryError } from '@agnes/host'
import { describe, expect, it } from 'vitest'
import { throwSessionOpenRpcError } from '../src/local/methods/acp.js'

const caught = (error: unknown): unknown => {
  try {
    throwSessionOpenRpcError(error)
  } catch (thrown) {
    return thrown
  }
  throw new Error('throwSessionOpenRpcError returned')
}

// A home with no account has no provider routes, and opening a session there used to surface as
// INTERNAL_ERROR: the refusal is not a workspace error, so session/new let it through unmapped.
describe('throwSessionOpenRpcError', () => {
  const unconfigured = {
    code: -32011,
    message: 'SEMANTIC_REJECTED',
    data: { code: 'PROVIDER_UNCONFIGURED' },
  }

  it('maps an in-process no-routes refusal to PROVIDER_UNCONFIGURED', () => {
    const error = new HostError('E_PRESET_UNRESOLVED', 'no-routes: the profile declares no provider.routes', {
      detail: { reason: 'no-routes' },
    })
    expect(caught(error)).toMatchObject(unconfigured)
  })

  it('maps the same refusal as a worker returns it, by reason and without reading the message', () => {
    const error = {
      code: 'E_PRESET_UNRESOLVED',
      message: 'E_PRESET_UNRESOLVED: error message omitted: looks like a secret',
      reason: 'no-routes',
    }
    expect(caught(error)).toMatchObject(unconfigured)
  })

  it('does not map a message that only mentions no-routes without a reason identifier', () => {
    const error = {
      code: 'E_PRESET_UNRESOLVED',
      message: 'E_PRESET_UNRESOLVED: no-routes: the profile declares no provider.routes',
    }
    expect(caught(error)).toBe(error)
  })

  it('leaves other preset refusals and workspace errors to their existing mapping', () => {
    const other = new HostError('E_PRESET_UNRESOLVED', 'model contract is not loaded')
    expect(caught(other)).toBe(other)
    expect(caught(new WorkspaceDirectoryError('not-found'))).toMatchObject({
      code: -32011,
      data: { code: 'WORKSPACE_INVALID', reason: 'not-found' },
    })
  })
})
