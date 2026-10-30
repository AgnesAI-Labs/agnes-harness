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

  it('preserves the safe native GLIBC cause from both host and worker', () => {
    for (const error of [
      new HostError('E_SEAM_INIT', 'private loader path', {
        detail: { reason: 'native-glibc-incompatible' },
      }),
      { code: 'E_SEAM_INIT', reason: 'native-glibc-incompatible' },
    ]) {
      const normalized = normalizeRpcError(caught(error) as RpcError)
      expect(normalized.data.publicReason).toContain('system-node native addon failed to load')
      expect(normalized.data.publicReason).toContain('GLIBC')
      expect(JSON.stringify(normalized)).not.toContain('private loader path')
    }
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

  it('names an unavailable session bundle and a preset outside the session allow-list', () => {
    for (const error of [
      new HostError('E_PRESET_UNSUPPORTED', 'composition: unknown bundle acme/x#y', {
        detail: { reason: 'bundle-unavailable' },
      }),
      { code: 'E_PRESET_UNSUPPORTED', message: 'omitted', reason: 'bundle-unavailable' },
    ]) {
      const failure = caught(error)
      expect(failure).toMatchObject({
        code: -32011,
        message: 'SEMANTIC_REJECTED',
        data: { code: 'BUNDLE_UNAVAILABLE' },
      })
      expect(normalizeRpcError(failure as RpcError).data).toMatchObject({
        cause: { code: 'BUNDLE_UNAVAILABLE' },
        publicReason: 'The selected agent bundle is unavailable.',
        userAction: 'Install, enable and trust the bundle, or choose another agent.',
      })
    }
    expect(
      caught({ code: 'E_PRESET_UNSUPPORTED', message: 'omitted', reason: 'preset-not-allowed' }),
    ).toMatchObject({ code: -32008, message: 'PRESET_SWITCH_REJECTED' })
    const other = new HostError('E_PRESET_UNSUPPORTED', 'composition: invalid tools')
    expect(caught(other)).toBe(other)
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
    for (const reason of ['workspace-ancestor-not-directory', 'workspace-ancestor-unavailable'])
      for (const error of [
        { code: 'E_SANDBOX_WORKSPACE', reason },
        { code: 'E_SANDBOX_WORKSPACE', detail: { reason, path: 'private-path' } },
      ])
        expect(caught(error)).toEqual({
          code: -32011,
          message: 'SEMANTIC_REJECTED',
          data: { code: 'E_SANDBOX_WORKSPACE', reason, cause: { code: 'E_SANDBOX_WORKSPACE' } },
        })
    expect(caught(new WorkspaceDirectoryError('not-found'))).toMatchObject({
      code: -32011,
      data: { code: 'WORKSPACE_INVALID', reason: 'not-found' },
    })
  })

  it('gives safe new-session guidance for missing or incompatible execution records', () => {
    const error = caught({
      code: 'E_SANDBOX_WORKSPACE',
      reason: 'session-execution-record-invalid',
      message: 'private path',
    })
    expect(normalizeRpcError(error as RpcError).data).toMatchObject({
      messageKey: 'appServer.errors.sessionSandbox',
    })
    expect(JSON.stringify(error)).not.toContain('private path')
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
          data: { code },
        })
      const unknown = { code: 'E_UNKNOWN', message: `${code}: unavailable` }
      expect(caught(unknown)).toBe(unknown)
    },
  )
})

it('carries real Host permission-axis and revoked full-access denials through worker framing to the SDK', async () => {
  const { resolvePreset } = await import('@agnes/host')
  const { LocalEndpoint } = await import('@agnes/daemon-foundation/local/endpoint')
  const { createClient, JsonRpcError } = await import('@agnes/sdk')
  const { encodeFrame, JsonlDecoder, workerDomainFailure } = await import('@agnes/worker-runtime')
  const { assertCurrentPermission, withPermissionContext } = await import('../src/local/permission-scope.js')
  const { publicErrorHelp } = await import('@agnes/protocol')
  const refusals = [
    {
      code: 'E_PRESET_UNSUPPORTED',
      reason: 'clean-home-required',
      raise: () =>
        resolvePreset('full-access', { 'full-access': { name: 'full-access' } }, { permission: 'read-only' }),
    },
    {
      code: 'E_PERMISSION_REVOKED',
      reason: undefined,
      raise: () =>
        withPermissionContext(
          {
            policy: 'full-access',
            sessionKey: 'synthetic',
            sessionId: 'synthetic',
            epoch: 1,
            actor: { id: 'synthetic', org: 'local', role: 'owner', deptPath: [], attrs: {} },
          },
          () => {},
          assertCurrentPermission,
          async () => undefined,
        ),
    },
    {
      code: 'E_PACKAGE_INTEGRITY',
      reason: 'clean-home-required',
      raise: async () => {
        const { assertCurrentPackageFormat } = await import('@agnes/package-manager')
        assertCurrentPackageFormat({ metadata: { category: 'private authoring log' } })
      },
    },
    {
      code: 'E_PACKAGE_BLOCKED',
      reason: undefined,
      raise: async () => {
        const { PackageError } = await import('@agnes/package-manager')
        throw new PackageError('E_CEILING_EXCEEDED', 'private publication policy log', {
          detail: { token: 'private' },
        })
      },
    },
    {
      code: 'INTERNAL',
      reason: undefined,
      raise: () => {
        throw Object.assign(new Error('private authoring log'), { code: 'UNKNOWN_DENIED_private' })
      },
    },
  ]
  for (const code of [
    'E_BUDGET',
    'BUDGET_EXCEEDED',
    'APPROVAL_REJECTED',
    'APPROVAL_GRANT_UNAVAILABLE',
    'PLUGIN_PUBLICATION_UNANSWERED',
  ]) {
    refusals.push({
      code,
      reason: undefined,
      raise: () => {
        throw Object.assign(new Error('private native or authoring log'), {
          code,
          detail: { token: 'private' },
        })
      },
    })
  }
  for (const row of refusals) {
    const endpoint = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    endpoint.register('initialize', async (_params, cx) => {
      cx.conn.initialized = true
      return { protocolVersion: 1, agentCapabilities: {} }
    })
    endpoint.register('session/new', async () => {
      try {
        await row.raise()
      } catch (raised) {
        const failure = workerDomainFailure(raised)
        const [frame] = new JsonlDecoder().feed(
          encodeFrame({ kind: 'reply', requestId: 'synthetic', error: failure }),
        )
        expect(JSON.stringify(frame)).not.toContain('private authoring log')
        throw (frame as { error: unknown }).error
      }
      throw new Error('Expected a refusal')
    })
    const client = createClient({ transport: { kind: 'inproc', endpoint } })
    try {
      const error = await client.session.new({ cwd: '/tmp' }).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(JsonRpcError)
      const rpc = error as InstanceType<typeof JsonRpcError>
      expect(rpc.data).toMatchObject({ code: row.code, diagnosticId: expect.any(String) })
      expect(rpc.data).not.toHaveProperty('cause.detail')
      expect(JSON.stringify(rpc.data)).not.toMatch(
        /"token"|private (?:authoring|native or authoring|publication policy) log/,
      )
      if (row.code === 'INTERNAL') {
        expect(rpc.code).toBe(-32603)
        expect(rpc.data).not.toHaveProperty('cause')
        expect(publicErrorHelp(rpc)).toBeUndefined()
      } else {
        expect(rpc.data).toMatchObject({
          cause: { code: row.code },
          publicReason: expect.any(String),
          userAction: expect.any(String),
        })
        if (row.reason) expect(rpc.data.reason).toBe(row.reason)
        for (const locale of ['en', 'zh-CN']) {
          const help = publicErrorHelp(rpc, locale)
          expect(help?.code).toBe(row.code)
          expect(help?.action.length).toBeGreaterThan(10)
        }
      }
    } finally {
      await client.close()
      await endpoint.close()
    }
  }
})
