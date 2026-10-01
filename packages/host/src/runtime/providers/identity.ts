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
  type AuthenticatedIdentity,
  type BindingRef,
  type ProviderDescriptor,
  type RuntimeError,
  RuntimeIdentityLegacySchemas,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  RuntimeServiceCatalog,
  validateIdentityTransportRequest,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { CurrentIdentity, IdentityAuthority } from '../identity/authority.js'
import { decodeIdentityData, encodeIdentityData } from '../identity/data.js'
import type { IdentityHttpSessions } from '../identity/http-sessions.js'
import type { IdentityIngressAuthority } from '../identity/legacy-ingress.js'
import type { IdentityCredentialSource } from '../identity/source.js'
import {
  type IdentityVerificationPorts,
  identityPrincipalKey,
  type VerifiedIdentityCredential,
  verifyIdentityCredential,
  verifyIdentityJwt,
} from '../identity/verify.js'

export type IdentityDeploymentPorts = Readonly<{
  config: AuthorSchema<EmptyAuthorConfig>
  packageVersion: string
  packageDigest: string
  binding: BindingRef
  ingress: IdentityIngressAuthority
  authority: IdentityAuthority
  sessions: IdentityHttpSessions
  verification(signal: AbortSignal): Promise<IdentityVerificationPorts | null>
  principal(key: string, tenantRef: string): Promise<string | null>
  control(context: CallContext): boolean
  authenticated(context: TrustedIngressContext, instance: CurrentIdentity): void
  now(): number
}>

function failure(code: RuntimeError['code'], detailCode: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Identity request refused',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'identity-provider',
    },
  }
}

/** Default factory consumes only explicit deployment ports and the selected binding. */
export function createIdentityProviderFactory(
  ports: IdentityDeploymentPorts,
): ProviderFactory<ServiceProvider> {
  const methods = RuntimeMethodSchemaRefs['agh.identity']
  const catalog = RuntimeServiceCatalog['agh.identity'].methods
  if (ports.binding.contract !== 'agh.identity') throw new Error('invalid identity binding')
  const descriptor: ProviderDescriptor = {
    providerId: ports.binding.providerId,
    contract: 'agh.identity',
    major: 1,
    logicalName: ports.binding.logicalName,
    packageVersion: ports.packageVersion,
    packageDigest: ports.packageDigest,
    features: [RuntimeIdentityLegacySchemas.requiredFeature],
    scope: 'runtime',
    configSchema: ports.config.ref,
    requires: [],
    capabilities: [],
    recovery: 'R1',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: (['authenticate', 'resolve'] as const).map((method) => ({
      method,
      kind: catalog[method].kind,
      inputSchema: methods[method].input,
      outputSchema: methods[method].output,
      requiredCapabilities: [],
      retrySafety: method === 'resolve' ? 'read-only' : 'never',
    })),
  }
  if (!validateRuntime('ProviderDescriptor', descriptor).ok) throw new Error('invalid identity descriptor')
  return {
    descriptor,
    async create(config, _dependencies, factoryContext) {
      const providerScope = factoryContext.scope
      if (
        factoryContext.bindingId !== ports.binding.bindingId ||
        factoryContext.signal.aborted ||
        config.kind !== 'inline' ||
        providerScope.kind !== 'runtime' ||
        !validateRuntime('ScopeRef', providerScope).ok ||
        jcs(config.schema) !== jcs(ports.config.ref)
      )
        throw new Error('invalid identity factory scope')
      const configInput = decodeIdentityData('JsonValue', ports.config.ref, config)
      if (configInput === null || !ports.config.parse(configInput).ok)
        throw new Error('invalid identity configuration')
      let state: 'created' | 'ready' | 'draining' | 'closed' = 'created'
      const active = new Map<Promise<unknown>, string>()
      const lifetime = new AbortController()
      const consumed = new WeakSet<object>()
      const issued = new Set<string>()
      const close = () => {
        if (state === 'closed') return
        state = 'closed'
        lifetime.abort()
        for (const reference of issued) ports.authority.revoke(reference)
      }
      factoryContext.signal.addEventListener('abort', close, { once: true })
      const available = (signal: AbortSignal) =>
        state === 'ready' && !signal.aborted && !factoryContext.signal.aborted
      const invoke = async (
        context: TrustedIngressContext,
        work: (signal: AbortSignal) => Promise<Outcome<AuthenticatedIdentity>>,
      ) => {
        const timeout = new AbortController()
        const timer = setTimeout(
          () => timeout.abort(),
          Math.max(0, Math.min(2147483647, Date.parse(context.deadline) - ports.now())),
        )
        const signal = AbortSignal.any([
          context.signal,
          factoryContext.signal,
          lifetime.signal,
          timeout.signal,
        ])
        const pending = work(signal)
        active.set(pending, context.ingressId)
        try {
          const result = await pending
          return available(signal) ? result : failure('cancelled', 'identity_cancelled')
        } catch {
          return failure('retryable', 'identity_owner_unavailable')
        } finally {
          active.delete(pending)
          clearTimeout(timer)
        }
      }
      const provider: ServiceProvider = {
        async ready(context) {
          if (
            state !== 'created' ||
            !ports.control(context) ||
            context.signal.aborted ||
            factoryContext.signal.aborted
          )
            return failure('denied', 'identity_lifecycle_denied')
          state = 'ready'
          return { ok: true, value: undefined }
        },
        async health(context) {
          if (!ports.control(context)) return failure('denied', 'identity_lifecycle_denied')
          return { ok: true, value: { status: state === 'ready' ? 'ready' : 'failed', diagnosticIds: [] } }
        },
        async drain(deadline, context) {
          if (!ports.control(context)) return failure('denied', 'identity_lifecycle_denied')
          if (state !== 'closed') state = 'draining'
          lifetime.abort()
          const remaining = Date.parse(deadline) - ports.now()
          if (remaining > 0 && !context.signal.aborted && active.size) {
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              await Promise.race([
                Promise.allSettled([...active.keys()]),
                new Promise<void>((resolve) => {
                  timer = setTimeout(resolve, Math.min(remaining, 2147483647))
                }),
              ])
            } finally {
              if (timer) clearTimeout(timer)
            }
          }
          return {
            ok: true,
            value: {
              state: active.size ? 'blocked' : 'drained',
              activeInvocationIds: [...active.values()],
              durableOwnerRefs: [],
              diagnosticIds: [],
            },
          }
        },
        async close() {
          close()
        },
        async ingress(request, context) {
          if (!available(context.signal)) return failure('cancelled', 'identity_unavailable')
          const association = ports.ingress.inspect(request, context)
          if (
            !association ||
            consumed.has(context) ||
            context.installationId !== providerScope.installationId ||
            context.runtimeId !== providerScope.runtimeId ||
            association.scope.installationId !== providerScope.installationId ||
            !('runtimeId' in association.scope) ||
            association.scope.runtimeId !== providerScope.runtimeId
          )
            return failure('denied', 'identity_ingress_untrusted')
          if (
            request.target.bindingId !== factoryContext.bindingId ||
            request.target.contract !== 'agh.identity' ||
            request.target.providerId !== ports.binding.providerId ||
            request.method !== 'authenticate'
          )
            return failure('denied', 'identity_binding_mismatch')
          consumed.add(context)
          const result = await invoke(context, async (signal) => {
            const input = decodeIdentityData(
              'IdentityAuthenticateRequest',
              methods.authenticate.input,
              request.input,
            )
            if (!input || jcs(input) !== jcs(association.input))
              return failure('invalid_input', 'identity_input_invalid')
            const verification = await ports.verification(signal)
            if (!verification || !available(signal) || !ports.ingress.inspect(request, context))
              return failure('denied', 'identity_cache_unavailable')
            let verified: VerifiedIdentityCredential | null = null
            const legacy = decodeIdentityData(
              'LegacyIdentityCredentialEnvelope',
              RuntimeSchemaRefs.LegacyIdentityCredentialEnvelope,
              input.credentialEnvelope,
            )
            if (legacy) {
              const evidence = decodeIdentityData(
                'LegacyIdentityTransportEvidence',
                RuntimeSchemaRefs.LegacyIdentityTransportEvidence,
                input.transportEvidence,
              )
              if (!evidence) return failure('invalid_input', 'identity_input_invalid')
              const credential = verifyIdentityCredential(legacy, evidence, verification)
              if (credential.ok) verified = credential.value
            } else {
              const http = validateIdentityTransportRequest(input)
              if (!http.ok) return failure('invalid_input', 'identity_input_invalid')
              verified = ports.sessions.authenticate(
                http.value.credential,
                http.value.evidence,
                association.tenantRef,
                association.scope,
              )
              if (
                !verified &&
                http.value.credential.kind === 'bearer' &&
                !ports.sessions.known(http.value.credential.token)
              ) {
                const credential = verifyIdentityJwt(http.value.credential.token, verification)
                if (credential.ok) verified = credential.value
              }
            }
            if (!verified || !verification.generation)
              return failure('denied', 'identity_credentials_invalid')
            const source: IdentityCredentialSource =
              verified.credentialOwnerRef && verified.credentialRevision
                ? {
                    kind: 'http-session',
                    ownerRef: verified.credentialOwnerRef,
                    revision: verified.credentialRevision,
                  }
                : {
                    kind: 'deployment',
                    generation: verification.generation,
                    keyId: verified.sourceKeyId ?? null,
                  }
            const principalRef = await ports.principal(identityPrincipalKey(verified), association.tenantRef)
            if (
              !principalRef ||
              (verified.principalRef !== undefined && principalRef !== verified.principalRef) ||
              !available(signal) ||
              !ports.ingress.inspect(request, context)
            )
              return failure('denied', 'identity_principal_unavailable')
            const instance = await ports.authority.accept({
              verified,
              principalRef,
              tenantRef: association.tenantRef,
              bindingId: association.bindingId,
              scope: association.scope,
              signal,
              source,
            })
            if (!instance || !available(signal) || !ports.ingress.inspect(request, context)) {
              if (instance) ports.authority.revoke(instance.authorizationRef)
              return failure('denied', 'identity_authority_unavailable')
            }
            issued.add(instance.authorizationRef)
            try {
              ports.authenticated(context, instance)
              if (!available(signal) || !ports.ingress.inspect(request, context)) {
                ports.authority.revoke(instance.authorizationRef)
                return failure('cancelled', 'identity_cancelled')
              }
            } catch (error) {
              ports.authority.revoke(instance.authorizationRef)
              throw error
            }
            return { ok: true, value: instance.identity }
          })
          return result.ok
            ? {
                ok: true,
                value: encodeIdentityData('AuthenticatedIdentity', methods.authenticate.output, result.value),
              }
            : result
        },
        async query(request, context) {
          if (!available(context.signal)) return failure('cancelled', 'identity_unavailable')
          const instance = ports.authority.current(context)
          if (
            !instance ||
            context.bindingId !== factoryContext.bindingId ||
            request.target.bindingId !== factoryContext.bindingId ||
            request.target.contract !== 'agh.identity' ||
            request.target.providerId !== ports.binding.providerId ||
            request.method !== 'resolve'
          )
            return failure('denied', 'identity_current_authorization_denied')
          const input = decodeIdentityData('IdentityResolveRequest', methods.resolve.input, request.input)
          if (!input || input.principalRef !== instance.identity.principalRef)
            return failure('denied', 'identity_subject_mismatch')
          return {
            ok: true,
            value: {
              kind: 'value',
              output: encodeIdentityData('AuthenticatedIdentity', methods.resolve.output, instance.identity),
              snapshot: instance.authorizationRef,
            },
          }
        },
      }
      return provider
    },
  }
}
