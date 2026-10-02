import type { DatabaseSync } from 'node:sqlite'
import type {
  AuthorSchema,
  CallContext,
  EmptyAuthorConfig,
  Outcome,
  ProviderFactory,
  ServiceProvider,
  TrustedIngressContext,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  type BindingRef,
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type IdentityAuthenticateRequest,
  type ProviderDescriptor,
  RuntimeIdentityLegacySchemas,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  type RuntimeWireTypes,
  type SchemaRef,
  type ScopeRef,
  type ServiceOperation,
  type TransportAuthenticationEvidence,
  type TransportCredentialEnvelope,
  validateIdentityTransportRequest,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { ReferenceCurrentIdentity, ReferenceIdentityAuthority } from './identity/authority.js'
import {
  createReferenceCredentialVerifier,
  type ReferenceCredential,
  type ReferenceVerification,
  referenceJwt,
} from './identity/verify.js'

export type ReferenceIdentityPorts = Readonly<{
  database: DatabaseSync
  config: AuthorSchema<EmptyAuthorConfig>
  packageVersion: string
  packageDigest: string
  binding: BindingRef
  ingress: {
    inspect(
      operation: ServiceOperation,
      context: TrustedIngressContext,
    ): Readonly<{
      input: IdentityAuthenticateRequest
      scope: ScopeRef
      tenantRef: string
      connectionId: string
      bindingId: string
    }> | null
  }
  authority: ReferenceIdentityAuthority
  sessions: {
    authenticate(
      credential: TransportCredentialEnvelope,
      evidence: TransportAuthenticationEvidence,
      tenantRef: string,
      scope: ScopeRef,
    ): ReferenceCredential | null
    known(token: string): boolean
  }
  verification(signal: AbortSignal): Promise<ReferenceVerification | null>
  principal(key: string, tenantRef: string): Promise<string | null>
  control(context: CallContext): boolean
  authenticated(context: TrustedIngressContext, instance: ReferenceCurrentIdentity): void
  now(): number
}>

function read<K extends keyof RuntimeWireTypes>(
  ref: DataRef,
  name: K,
  schema: SchemaRef,
): RuntimeWireTypes[K] | null {
  if (ref.kind !== 'inline' || jcs(ref.schema) !== jcs(schema)) return null
  const input = boundedCanonicalJson(ref.value, { maxBytes: 65536, maxDepth: 64, maxMembers: 10000 })
  if (!input.ok || input.value.bytes !== ref.bytes || canonicalJsonDigest(input.value.json) !== ref.digest)
    return null
  const value = validateRuntime(name, input.value.json)
  return value.ok ? value.value : null
}
function write<K extends keyof RuntimeWireTypes>(
  value: RuntimeWireTypes[K],
  name: K,
  schema: SchemaRef,
): DataRef {
  const decoded = validateRuntime(name, value)
  const bounded = decoded.ok
    ? boundedCanonicalJson(decoded.value, { maxBytes: 65536, maxDepth: 64, maxMembers: 10000 })
    : null
  if (!bounded?.ok) throw new Error('invalid reference identity output')
  return Object.freeze({
    kind: 'inline',
    schema,
    value: bounded.value.json,
    bytes: bounded.value.bytes,
    digest: canonicalJsonDigest(bounded.value.json),
  })
}
function denied(): Outcome<never> {
  return {
    ok: false,
    error: {
      code: 'denied',
      detailCode: 'identity_reference_denied',
      message: 'Identity request refused',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'reference-identity',
    },
  }
}
function principalKey(value: ReferenceCredential): string {
  switch (value.authKind) {
    case 'local':
      return 'machine-owner'
    case 'jwt':
      return `jwt:${value.subject}`
    case 'portal-identity':
      return `portal:${value.subject}`
    case 'source-auth':
      return `source-auth:${value.sourceKeyId}`
    case 'surface':
      return `surface:${value.sourceId}:${value.credentialKind === 'jwt' ? 'jwt' : 'portal'}:${value.subject}`
  }
}

/** Independent reference factory; credentials use WebCrypto and a distinct current-instance journal. */
export function createReferenceIdentityProviderFactory(
  ports: ReferenceIdentityPorts,
): ProviderFactory<ServiceProvider> {
  const methods = RuntimeMethodSchemaRefs['agh.identity']
  const authenticateCredential = createReferenceCredentialVerifier(ports.database)
  const descriptor: ProviderDescriptor = {
    providerId: ports.binding.providerId,
    contract: 'agh.identity',
    major: 1,
    logicalName: ports.binding.logicalName,
    packageVersion: ports.packageVersion,
    packageDigest: ports.packageDigest,
    scope: 'runtime',
    configSchema: ports.config.ref,
    features: [RuntimeIdentityLegacySchemas.requiredFeature],
    requires: [],
    capabilities: [],
    recovery: 'R1',
    isolation: ['trusted-in-process'],
    activationMode: 'eager',
    stateCodecs: [],
    operations: [
      {
        method: 'authenticate',
        kind: 'ingress',
        inputSchema: methods.authenticate.input,
        outputSchema: methods.authenticate.output,
        requiredCapabilities: [],
        retrySafety: 'never',
      },
      {
        method: 'resolve',
        kind: 'query',
        inputSchema: methods.resolve.input,
        outputSchema: methods.resolve.output,
        requiredCapabilities: [],
        retrySafety: 'read-only',
      },
    ],
  }
  if (ports.binding.contract !== 'agh.identity' || !validateRuntime('ProviderDescriptor', descriptor).ok)
    throw new Error('invalid reference descriptor')
  return {
    descriptor,
    async create(config, _dependencies, context) {
      const empty = read(config, 'JsonValue', ports.config.ref)
      if (
        empty === null ||
        !ports.config.parse(empty).ok ||
        context.bindingId !== ports.binding.bindingId ||
        context.signal.aborted ||
        context.scope.kind !== 'runtime' ||
        !validateRuntime('ScopeRef', context.scope).ok
      )
        throw new Error('invalid reference factory input')
      const providerScope = context.scope
      let ready = false
      let stopped = false
      let active = 0
      const activeIds = new Set<string>()
      const lifetime = new AbortController()
      const used = new WeakSet<object>()
      const references = new Set<string>()
      const stop = () => {
        if (stopped) return
        ready = false
        stopped = true
        lifetime.abort()
        for (const ref of references) ports.authority.revoke(ref)
      }
      context.signal.addEventListener('abort', stop, { once: true })
      const valid = (signal: AbortSignal) => ready && !stopped && !context.signal.aborted && !signal.aborted
      return {
        async ready(call) {
          if (stopped || ready || context.signal.aborted || call.signal.aborted || !ports.control(call))
            return denied()
          ready = true
          return { ok: true, value: undefined }
        },
        async health(call) {
          return ports.control(call)
            ? { ok: true, value: { status: ready && !stopped ? 'ready' : 'failed', diagnosticIds: [] } }
            : denied()
        },
        async drain(_deadline, call) {
          if (!ports.control(call)) return denied()
          ready = false
          lifetime.abort()
          return {
            ok: true,
            value: {
              state: active ? 'blocked' : 'drained',
              activeInvocationIds: [...activeIds],
              durableOwnerRefs: [],
              diagnosticIds: [],
            },
          }
        },
        async close() {
          stop()
        },
        async ingress(request, call) {
          if (
            !valid(call.signal) ||
            used.has(call) ||
            request.method !== 'authenticate' ||
            jcs(request.target) !== jcs(ports.binding)
          )
            return denied()
          const associated = ports.ingress.inspect(request, call)
          const input = read(request.input, 'IdentityAuthenticateRequest', methods.authenticate.input)
          if (
            !associated ||
            !input ||
            jcs(input) !== jcs(associated.input) ||
            call.installationId !== providerScope.installationId ||
            call.runtimeId !== providerScope.runtimeId ||
            associated.scope.installationId !== providerScope.installationId ||
            !('runtimeId' in associated.scope) ||
            associated.scope.runtimeId !== providerScope.runtimeId
          )
            return denied()
          used.add(call)
          active++
          activeIds.add(call.ingressId)
          const timeout = new AbortController()
          const timer = setTimeout(
            () => timeout.abort(),
            Math.max(0, Math.min(2147483647, Date.parse(call.deadline) - ports.now())),
          )
          const signal = AbortSignal.any([call.signal, context.signal, lifetime.signal, timeout.signal])
          try {
            const configuration = await ports.verification(signal)
            if (!configuration || !valid(signal) || !ports.ingress.inspect(request, call)) return denied()
            const legacy = read(
              input.credentialEnvelope,
              'LegacyIdentityCredentialEnvelope',
              RuntimeSchemaRefs.LegacyIdentityCredentialEnvelope,
            )
            let result: ReferenceCredential | null = null
            if (legacy) {
              const evidence = read(
                input.transportEvidence,
                'LegacyIdentityTransportEvidence',
                RuntimeSchemaRefs.LegacyIdentityTransportEvidence,
              )
              if (!evidence) return denied()
              result = await authenticateCredential(legacy, evidence, configuration, signal)
            } else {
              const http = validateIdentityTransportRequest(input)
              if (!http.ok) return denied()
              result = ports.sessions.authenticate(
                http.value.credential,
                http.value.evidence,
                associated.tenantRef,
                associated.scope,
              )
              if (
                !result &&
                http.value.credential.kind === 'bearer' &&
                !ports.sessions.known(http.value.credential.token)
              )
                result = await referenceJwt(http.value.credential.token, configuration)
            }
            if (!result || !configuration.generation || !valid(signal)) return denied()
            const source =
              result.credentialOwnerRef && result.credentialRevision
                ? {
                    kind: 'http-session' as const,
                    ownerRef: result.credentialOwnerRef,
                    revision: result.credentialRevision,
                  }
                : {
                    kind: 'deployment' as const,
                    generation: configuration.generation,
                    keyId: result.sourceKeyId ?? null,
                  }
            const principalRef = await ports.principal(principalKey(result), associated.tenantRef)
            if (
              !principalRef ||
              (result.principalRef !== undefined && result.principalRef !== principalRef) ||
              !valid(signal) ||
              !ports.ingress.inspect(request, call)
            )
              return denied()
            const instance = await ports.authority.accept({
              verified: result,
              principalRef,
              tenantRef: associated.tenantRef,
              scope: associated.scope,
              bindingId: associated.bindingId,
              signal,
              source,
            })
            if (!instance || !valid(signal) || !ports.ingress.inspect(request, call)) {
              if (instance) ports.authority.revoke(instance.authorizationRef)
              return denied()
            }
            references.add(instance.authorizationRef)
            try {
              ports.authenticated(call, instance)
              if (!valid(signal) || !ports.ingress.inspect(request, call)) {
                ports.authority.revoke(instance.authorizationRef)
                return denied()
              }
            } catch (error) {
              ports.authority.revoke(instance.authorizationRef)
              throw error
            }
            return {
              ok: true,
              value: write(instance.identity, 'AuthenticatedIdentity', methods.authenticate.output),
            }
          } catch {
            return {
              ok: false,
              error: {
                code: 'retryable',
                detailCode: 'identity_reference_owner_unavailable',
                message: 'Identity owner unavailable',
                retryAdvice: { kind: 'never' },
                diagnosticId: 'reference-identity',
              },
            }
          } finally {
            active--
            activeIds.delete(call.ingressId)
            clearTimeout(timer)
          }
        },
        async query(request, call) {
          if (
            !valid(call.signal) ||
            call.bindingId !== context.bindingId ||
            request.method !== 'resolve' ||
            jcs(request.target) !== jcs(ports.binding)
          )
            return denied()
          const instance = ports.authority.current(call)
          const input = read(request.input, 'IdentityResolveRequest', methods.resolve.input)
          if (!instance || !input || input.principalRef !== instance.identity.principalRef) return denied()
          return {
            ok: true,
            value: {
              kind: 'value',
              snapshot: instance.authorizationRef,
              output: write(instance.identity, 'AuthenticatedIdentity', methods.resolve.output),
            },
          }
        },
      }
    },
  }
}
