import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { CallContext, Outcome, ScopedDependencies } from '@agnes/extension-api/runtime'
import {
  createPackageResolverProvider,
  type PackageResolverProvider,
} from '@agnes/package-manager/runtime/package-resolver'
import {
  createPackageSourceProvider,
  type PackageSourceProvider,
} from '@agnes/package-manager/runtime/package-source'
import { jcs } from '@agnes/protocol'
import {
  type BindingRef,
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  MAX_AUTHOR_INLINE_BYTES,
  RuntimeAuthorCodecPolicy,
  type RuntimeError,
  RuntimeMethodSchemaRefs,
  type RuntimeWireTypes,
  type SchemaRef,
  type ScopeRef,
  type ServiceOperation,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { HostPermissionGrant, HostSelectedProvider } from './scoped-dependencies.js'

// SHA-256 of the bundled package runtime sources, pinned by the product source guard.
// This bootstrap identity does not claim a ReleaseSet or a published authority route.
export const DEFAULT_PACKAGE_RUNTIME_DIGEST =
  '8f5a37f8e7b5ab3be190f7fc54cf7fc83d5b1b6c5bb9aefb38363c483b87baa4'

/** Host-private capability; never publish it through ExtensionAPI, tools or a wire endpoint. */
export type HostRuntimeServices = Readonly<{
  dependencies: ScopedDependencies
  contextFor(binding: BindingRef): CallContext
}>

type PackageResult =
  | { ok: true; value: unknown }
  | { ok: false; code: RuntimeError['code']; detailCode: string; message: string }
type Method = {
  schema: { input: SchemaRef; output: SchemaRef }
  input: keyof RuntimeWireTypes
  output: keyof RuntimeWireTypes
  run(input: unknown): PackageResult
}

function refusal(code: RuntimeError['code'], detailCode: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Host runtime service refused the request',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'host-runtime-services',
    },
  }
}

const safeValue = (value: unknown) =>
  boundedCanonicalJson(value, {
    maxBytes: MAX_AUTHOR_INLINE_BYTES,
    maxDepth: RuntimeAuthorCodecPolicy.payload.maxDepth,
    maxMembers: RuntimeAuthorCodecPolicy.payload.maxMembers,
  })
const same = (left: unknown, right: unknown) => jcs(left) === jcs(right)

function call(
  binding: BindingRef,
  request: ServiceOperation,
  context: CallContext,
  method: Method | undefined,
  scope: ScopeRef,
  clock: () => number,
): Outcome<Extract<DataRef, { kind: 'inline' }>> {
  try {
    if (context.signal.aborted) return refusal('cancelled', 'call_cancelled')
    const deadline = Date.parse(context.deadline)
    if (!Number.isFinite(deadline)) return refusal('invalid_input', 'deadline_invalid')
    if (deadline <= clock()) return refusal('timeout', 'deadline_expired')
    if (!validateRuntime('ScopeRef', context.scope).ok || !same(context.scope, scope))
      return refusal('denied', 'scope_mismatch')
    if (!same(request.target, binding) || context.bindingId !== binding.bindingId)
      return refusal('denied', 'binding_mismatch')
    if (!method) return refusal('incompatible', 'method_not_registered')
    const ref = request.input
    if (ref.kind !== 'inline' || !same(ref.schema, method.schema.input))
      return refusal('invalid_input', 'schema_mismatch')
    const safe = safeValue(ref.value)
    if (!safe.ok || safe.value.bytes !== ref.bytes || canonicalJsonDigest(safe.value.json) !== ref.digest)
      return refusal('invalid_input', 'data_integrity_mismatch')
    const input = validateRuntime(method.input, safe.value.json)
    if (!input.ok) return refusal('invalid_input', 'input_invalid')
    const result = method.run(input.value)
    if (!result.ok) return refusal(result.code, result.detailCode)
    const output = validateRuntime(method.output, result.value)
    if (!output.ok) return refusal('internal', 'output_invalid')
    const encoded = safeValue(output.value)
    if (!encoded.ok) return refusal('quota', 'inline_data_bytes')
    return {
      ok: true,
      value: {
        kind: 'inline',
        schema: method.schema.output,
        value: encoded.value.json,
        digest: canonicalJsonDigest(encoded.value.json),
        bytes: encoded.value.bytes,
      },
    }
  } catch {
    return refusal('internal', 'package_service_failed')
  }
}

/** Select bundled Q/C defaults without opening a container or granting maintenance capabilities. */
export function selectDefaultHostServices(dataDir: string, clock: () => number) {
  const generationId = `host:${randomUUID()}`
  const authorizationRef = randomUUID()
  const scope = Object.freeze({
    kind: 'runtime' as const,
    installationId: randomUUID(),
    runtimeId: generationId,
  })
  const lifetime = new AbortController()
  let cacheDir: string | undefined
  let source: PackageSourceProvider | undefined
  let resolver: PackageResolverProvider | undefined
  const binding = (contract: string): BindingRef =>
    Object.freeze({
      bindingId: `${generationId}/${contract}`,
      contract,
      logicalName: 'default',
      providerId: `agh.default/${contract.slice(4)}`,
    })
  const sourceBinding = binding('agh.package-source')
  const resolverBinding = binding('agh.package-resolver')
  const base = (selected: BindingRef): HostSelectedProvider => ({
    binding: selected,
    major: 1,
    scope: 'runtime',
    features: [],
    packageDigest: DEFAULT_PACKAGE_RUNTIME_DIGEST,
    ownerId: selected.providerId,
    permissions: [],
  })
  const providers: HostSelectedProvider[] = [
    {
      ...base(sourceBinding),
      create() {
        // No local root, registry, Git origin or maintenance method is admitted at bootstrap.
        const parent = join(dataDir, 'runtime-services')
        mkdirSync(parent, { recursive: true })
        cacheDir = mkdtempSync(join(parent, 'packages-'))
        source = createPackageSourceProvider({ cacheDir })
      },
      async query(request, context) {
        const parsed = validateRuntime('ServiceQuery', request)
        if (!parsed.ok) return refusal('invalid_input', 'query_invalid')
        request = parsed.value
        const opened = source
        if (!opened) return refusal('internal', 'provider_not_ready')
        const schema = RuntimeMethodSchemaRefs['agh.package-source']
        const methods: Record<string, Method> = {
          discover: {
            schema: schema.discover,
            input: 'PackageSourceDiscoverRequest',
            output: 'PackageSourceDiscoverResult',
            run: (input) => opened.discover(input),
          },
          resolveMetadata: {
            schema: schema.resolveMetadata,
            input: 'PackageSourceResolveMetadataRequest',
            output: 'PackageSourceResolveMetadataResult',
            run: (input) => opened.resolveMetadata(input),
          },
        }
        const result = call(
          sourceBinding,
          request,
          context,
          Object.hasOwn(methods, request.method) ? methods[request.method] : undefined,
          scope,
          clock,
        )
        if (!result.ok) return result
        if (request.snapshot !== undefined && request.snapshot !== result.value.digest)
          return refusal('incompatible', 'snapshot_unavailable')
        return {
          ok: true,
          value: { kind: 'value', output: result.value, snapshot: result.value.digest },
        }
      },
      close() {
        try {
          source?.dispose()
        } finally {
          if (cacheDir) rmSync(cacheDir, { recursive: true, force: true })
        }
      },
    },
    {
      ...base(resolverBinding),
      requires: [
        {
          contract: 'agh.package-source',
          major: 1,
          logicalName: 'default',
          scope: 'runtime',
          features: [],
          optional: false,
          capture: 'instance',
        },
      ],
      create() {
        if (!cacheDir) throw new Error('Package source cache is not ready')
        resolver = createPackageResolverProvider({ cacheDir })
      },
      async compute(request, context) {
        const parsed = validateRuntime('ServiceOperation', request)
        if (!parsed.ok) return refusal('invalid_input', 'operation_invalid')
        request = parsed.value
        const opened = resolver
        if (!opened) return refusal('internal', 'provider_not_ready')
        return call(
          resolverBinding,
          request,
          context,
          request.method === 'resolve'
            ? {
                schema: RuntimeMethodSchemaRefs['agh.package-resolver'].resolve,
                input: 'PackageResolverResolveRequest',
                output: 'PackageResolverResolveResult',
                run: (input) => opened.resolve(input),
              }
            : undefined,
          scope,
          clock,
        )
      },
      close() {
        resolver?.dispose()
      },
    },
  ]
  const grants: HostPermissionGrant[] = providers.map((provider) => ({
    authorizationRef,
    ownerId: provider.ownerId,
    permissions: [],
    scope: 'runtime',
  }))
  return {
    generationId,
    providers,
    grants,
    stop: () => lifetime.abort(),
    contextFor(selected: BindingRef): CallContext {
      if (lifetime.signal.aborted || !providers.some((provider) => same(provider.binding, selected)))
        throw new Error('Host runtime services are closed or the binding is not selected')
      return {
        principalRef: generationId,
        scope,
        bindingId: selected.bindingId,
        invocationId: randomUUID(),
        deadline: new Date(clock() + 30_000).toISOString(),
        traceRef: randomUUID(),
        authorizationRef,
        signal: lifetime.signal,
      }
    },
  }
}
