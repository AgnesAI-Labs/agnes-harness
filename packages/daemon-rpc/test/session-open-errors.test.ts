import { HostError, WorkspaceDirectoryError } from '@agnes/host'
import { normalizeRpcError, type RpcError } from '@agnes/protocol'
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

  it.each(['unknown', 'invalid', 'incompatible', 'unavailable', 'duplicate'] as const)(
    'keeps the %s provider cause across in-process and worker session initialization failures',
    (cause) => {
      const reason = `provider-${cause}`
      for (const error of [
        new HostError('E_SEAM_INIT', 'private-message-and-token', { detail: { reason, extra: 'drop-me' } }),
        { code: 'E_SEAM_INIT', message: 'private-message-and-token', reason },
      ]) {
        expect(caught(error)).toEqual({
          code: -32603,
          message: 'INTERNAL_ERROR',
          data: { code: `E_PROVIDER_${cause.toUpperCase()}`, reason },
        })
      }
    },
  )

  it('returns a fixed initialization error without trusting arbitrary reasons or message text', () => {
    expect(
      caught({ code: 'E_SEAM_INIT', message: 'E_PROVIDER_UNKNOWN sk-secret', reason: 'sk-secret' }),
    ).toEqual({
      code: -32603,
      message: 'INTERNAL_ERROR',
      data: { code: 'E_SEAM_INIT', reason: 'session-initialization-failed' },
    })
  })

  it('leaves other preset refusals and workspace errors to their existing mapping', () => {
    const other = new HostError('E_PRESET_UNRESOLVED', 'model contract is not loaded')
    expect(caught(other)).toBe(other)
    const sandbox = caught({ code: 'E_SANDBOX_WORKSPACE', message: 'private path or token' })
    expect(sandbox).toEqual({
      code: -32011,
      message: 'SEMANTIC_REJECTED',
      data: { code: 'E_SANDBOX_WORKSPACE' },
    })
    expect(normalizeRpcError(sandbox as RpcError).data).toMatchObject({
      code: 'E_SANDBOX_WORKSPACE',
      cause: { code: 'E_SANDBOX_WORKSPACE' },
      messageKey: 'appServer.errors.unavailable',
    })
    expect(caught(new WorkspaceDirectoryError('not-found'))).toMatchObject({
      code: -32011,
      data: { code: 'WORKSPACE_INVALID', reason: 'not-found' },
    })
  })

  it.each(['E_SANDBOX_WORKSPACE', 'SANDBOX_UNAVAILABLE'])(
    'maps %s from the Host or worker to a fixed sandbox refusal without exception prose',
    (code) => {
      for (const error of [
        Object.assign(new Error('private-path-and-token'), { code }),
        { code, message: 'private-path-and-token', reason: 'private-reason', detail: { token: 'secret' } },
      ])
        expect(caught(error)).toEqual({
          code: -32011,
          message: 'SEMANTIC_REJECTED',
          data: { code: 'SANDBOX_UNAVAILABLE' },
        })
      const unknown = { code: 'E_UNKNOWN', message: `${code}: unavailable` }
      expect(caught(unknown)).toBe(unknown)
    },
  )
})
