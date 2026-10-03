import type { ActionContext, CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'

/** Trusted deployment input, keyed by the exact resource version retained by its consumer. */
export interface McpEndpoint {
  readonly resource: W.ResourceRef
  readonly transport: 'stdio' | 'streamable-http'
  readonly executable?: string
  readonly args?: readonly string[]
  readonly target?: W.NetworkTarget
  readonly credential: W.SecretConsumerBinding | null
  readonly staticClientId?: string
  readonly methods: Readonly<Record<string, W.SchemaRef>>
}
export interface McpDependencies {
  readonly directory: string
  readonly tenantId: string
  readonly scope: W.ScopeRef
  readonly ownerId: string
  readonly endpoints: readonly McpEndpoint[]
  readonly allowedExecutables: readonly string[]
  readonly authorize: (endpoint: McpEndpoint, context: CallContext) => boolean | Promise<boolean>
  readonly toolsAdmission: (
    endpoint: McpEndpoint,
    input: W.McpCallRequest,
    context: CallContext,
  ) => boolean | Promise<boolean>
  readonly identity: {
    resolve(input: W.IdentityResolveRequest, context: CallContext): Promise<Outcome<W.AuthenticatedIdentity>>
  }
  readonly secrets: {
    resolve(input: W.SecretsResolveRequest, context: CallContext): Promise<Outcome<W.SecretHandle>>
    use(
      handle: W.SecretHandle,
      binding: W.SecretConsumerBinding,
      context: CallContext,
      consume: (material: string, signal: AbortSignal) => Promise<void> | void,
    ): Promise<Outcome<void>>
  }
  /** Selected network companion: it owns authenticated child request contexts and body storage. */
  readonly network: {
    request(
      input: W.NetworkRequest,
      context: CallContext,
      signal?: AbortSignal,
    ): Promise<Outcome<W.NetworkRequestResult>>
  }
  readonly content: {
    retain(bytes: Uint8Array, context: CallContext): Promise<W.BytesRef>
    read(ref: W.BytesRef, context: CallContext): Promise<Uint8Array>
  }
  readonly attempt: (context: CallContext) => W.AttemptRef
  readonly timeoutMs?: number
}
export interface McpService {
  readonly binding: W.BindingRef
  readonly providerDigest: string
  readonly features: readonly string[]
  prepareConnection(input: unknown, context: ActionContext): Promise<Outcome<W.McpConnectRequest>>
  connect(input: unknown, context: CallContext): Promise<Outcome<W.McpConnectResult>>
  call(input: unknown, context: CallContext): Promise<Outcome<W.McpCallResult>>
  read(input: unknown, context: CallContext): Promise<Outcome<W.McpReadResult>>
  /** Assembly lifecycle controls, outside Agent dispatch. Release survives cancellation/revocation. */
  retain(ref: W.DomainObjectRef, ownerId: string, context: CallContext): Promise<Outcome<void>>
  release(ref: W.DomainObjectRef, ownerId: string, context: CallContext): Promise<Outcome<void>>
  close(): Promise<void>
}
export function mcpData(value: W.JsonValue, typeId: string): W.DataRef {
  const digest = canonicalJsonDigest(value)
  return {
    kind: 'inline',
    value,
    digest,
    bytes: Buffer.byteLength(JSON.stringify(value)),
    schema: { typeId, digest: canonicalJsonDigest({ $id: typeId }), revision: 1 },
  }
}
export class McpFault extends Error {
  constructor(
    readonly code: W.RuntimeError['code'],
    readonly detailCode: string,
    readonly safeDetail?: W.CredentialRefreshNeeded,
  ) {
    super('MCP operation refused')
  }
}
export function mcpRefusal(error: McpFault): Outcome<never> {
  return {
    ok: false,
    error: {
      code: error.code,
      detailCode: error.detailCode,
      message: 'MCP operation refused',
      diagnosticId: 'mcp-provider',
      retryAdvice: { kind: 'never' },
      ...(error.safeDetail ? { safeDetail: error.safeDetail } : {}),
    },
  }
}
