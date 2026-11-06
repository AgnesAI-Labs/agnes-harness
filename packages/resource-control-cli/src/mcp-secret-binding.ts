import type { McpServerDefinitionInput } from '@agnes/protocol'

/** Resource parser failures remain typed without importing the outer CLI command layer. */
export class ResourceUsageError extends Error {
  override readonly name = 'UsageError'
}

/** The credential flags of `agh mcp add` / `update`, already read from the command line. */
export type McpSecretFlags = Readonly<{
  secretEnv: readonly string[]
  bearer?: string | undefined
  header?: string | undefined
  oauth: boolean
  oauthClientId?: string | undefined
  oauthClientSecretRef?: string | undefined
}>

type StdioSecretBinding = Extract<McpServerDefinitionInput, { transport: { kind: 'stdio' } }>['secretBinding']
type RemoteSecretBinding = Extract<McpServerDefinitionInput, { transport: { kind: 'http' } }>['secretBinding']

const PROTECTED_ENV = ['PATH', 'HOME', 'SHELL', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']

export function secretRef(value: string, flag: string): string {
  if (!/^secret:\/\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(value))
    throw new ResourceUsageError(`${flag} must use secret://<id>; raw secret values are rejected`)
  return value
}

function usesOAuth(flags: McpSecretFlags): boolean {
  return flags.oauth || flags.oauthClientId !== undefined || flags.oauthClientSecretRef !== undefined
}

/** A local (stdio) server takes secrets only as environment references. */
export function stdioSecretBinding(flags: McpSecretFlags): StdioSecretBinding {
  if (usesOAuth(flags)) throw new ResourceUsageError('OAuth flags need an HTTP or SSE server')
  if (flags.bearer || flags.header)
    throw new ResourceUsageError('stdio only accepts --secret-env NAME=secret://<id>')
  if (!flags.secretEnv.length) return { kind: 'none' }
  const env: Record<string, string> = {}
  for (const item of flags.secretEnv) {
    const at = item.indexOf('=')
    const name = item.slice(0, at)
    const value = item.slice(at + 1)
    if (at < 1 || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name) || PROTECTED_ENV.includes(name))
      throw new ResourceUsageError('--secret-env name must be a permitted uppercase environment name')
    env[name] = secretRef(value, '--secret-env')
  }
  return { kind: 'stdio-env', env }
}

/**
 * A remote (HTTP or SSE) server takes one of: a bearer reference, a header reference, or OAuth
 * sign-in. OAuth may name a client ID it already has, and that client's secret only as a
 * reference.
 */
export function remoteSecretBinding(flags: McpSecretFlags): RemoteSecretBinding {
  if (flags.secretEnv.length || (flags.bearer && flags.header))
    throw new ResourceUsageError(
      'HTTP/SSE accepts one of --bearer-ref, --header-ref x-api-key|x-api-token=secret://<id>, or no credential',
    )
  if (usesOAuth(flags)) {
    if (flags.bearer || flags.header)
      throw new ResourceUsageError('OAuth flags cannot be combined with --bearer-ref or --header-ref')
    if (flags.oauthClientSecretRef !== undefined && flags.oauthClientId === undefined)
      throw new ResourceUsageError('--oauth-client-secret-ref needs --oauth-client-id')
    return {
      kind: 'oauth',
      ...(flags.oauthClientId !== undefined ? { staticClientId: flags.oauthClientId } : {}),
      ...(flags.oauthClientSecretRef !== undefined
        ? { clientSecretRef: secretRef(flags.oauthClientSecretRef, '--oauth-client-secret-ref') }
        : {}),
    }
  }
  if (flags.bearer) return { kind: 'http-bearer', credentialRef: secretRef(flags.bearer, '--bearer-ref') }
  if (flags.header) {
    const at = flags.header.indexOf('=')
    const headerName = flags.header.slice(0, at)
    if ((headerName !== 'x-api-key' && headerName !== 'x-api-token') || at < 1)
      throw new ResourceUsageError(
        '--header-ref must be x-api-key=secret://<id> or x-api-token=secret://<id>',
      )
    return {
      kind: 'http-header',
      headerName,
      credentialRef: secretRef(flags.header.slice(at + 1), '--header-ref'),
    }
  }
  return { kind: 'none' }
}
