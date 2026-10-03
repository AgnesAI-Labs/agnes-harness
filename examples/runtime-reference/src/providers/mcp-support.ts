import type { ActionContext, CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'

export type ReferenceMcpEndpoint = {
  resource: Wire.ResourceRef
  transport: 'stdio' | 'streamable-http'
  executable?: string
  args?: readonly string[]
  target?: Wire.NetworkTarget
  credential: Wire.SecretConsumerBinding | null
  staticClientId?: string
  methods: Readonly<Record<string, Wire.SchemaRef>>
}
export type ReferenceMcpOptions = {
  directory: string
  tenantId: string
  scope: Wire.ScopeRef
  ownerId: string
  endpoints: readonly ReferenceMcpEndpoint[]
  allowedExecutables: readonly string[]
  authorize(endpoint: ReferenceMcpEndpoint, call: CallContext): boolean | Promise<boolean>
  toolsAdmission(
    endpoint: ReferenceMcpEndpoint,
    input: Wire.McpCallRequest,
    call: CallContext,
  ): boolean | Promise<boolean>
  identity: {
    resolve(
      input: Wire.IdentityResolveRequest,
      call: CallContext,
    ): Promise<Outcome<Wire.AuthenticatedIdentity>>
  }
  secrets: {
    resolve(input: Wire.SecretsResolveRequest, call: CallContext): Promise<Outcome<Wire.SecretHandle>>
    use(
      handle: Wire.SecretHandle,
      binding: Wire.SecretConsumerBinding,
      call: CallContext,
      work: (value: string, signal: AbortSignal) => void | Promise<void>,
    ): Promise<Outcome<void>>
  }
  network: {
    request(
      input: Wire.NetworkRequest,
      call: CallContext,
      signal?: AbortSignal,
    ): Promise<Outcome<Wire.NetworkRequestResult>>
  }
  content: {
    retain(value: Uint8Array, call: CallContext): Promise<Wire.BytesRef>
    read(ref: Wire.BytesRef, call: CallContext): Promise<Uint8Array>
  }
  attempt(call: CallContext): Wire.AttemptRef
  timeoutMs?: number
}
export interface ReferenceMcp {
  readonly binding: Wire.BindingRef
  readonly providerDigest: string
  readonly features: readonly string[]
  connect(input: unknown, call: CallContext): Promise<Outcome<Wire.McpConnectResult>>
  prepareConnection(input: unknown, action: ActionContext): Promise<Outcome<Wire.McpConnectRequest>>
  call(input: unknown, call: CallContext): Promise<Outcome<Wire.McpCallResult>>
  read(input: unknown, call: CallContext): Promise<Outcome<Wire.McpReadResult>>
  /** Internal owner controls, excluded from the public operation table. */
  retain(ref: Wire.DomainObjectRef, owner: string, call: CallContext): Promise<Outcome<void>>
  release(ref: Wire.DomainObjectRef, owner: string, call: CallContext): Promise<Outcome<void>>
  close(): Promise<void>
}
export function referenceData(value: Wire.JsonValue, typeId = 'agh.mcp/content@1'): Wire.DataRef {
  return {
    kind: 'inline',
    schema: { typeId, revision: 1, digest: canonicalJsonDigest({ $id: typeId }) },
    value,
    bytes: Buffer.byteLength(JSON.stringify(value)),
    digest: canonicalJsonDigest(value),
  }
}
export class ReferenceMcpError extends Error {
  constructor(
    readonly code: Wire.RuntimeError['code'],
    readonly detail: string,
    readonly safe?: Wire.CredentialRefreshNeeded,
  ) {
    super('MCP operation refused')
  }
}
export function refuseMcp(reason: unknown): Outcome<never> {
  const fault =
    reason instanceof ReferenceMcpError ? reason : new ReferenceMcpError('unknown_effect', 'mcp_unknown')
  return {
    ok: false,
    error: {
      diagnosticId: 'mcp-provider',
      retryAdvice: { kind: 'never' },
      message: 'MCP operation refused',
      code: fault.code,
      detailCode: fault.detail,
      ...(fault.safe ? { safeDetail: fault.safe } : {}),
    },
  }
}
