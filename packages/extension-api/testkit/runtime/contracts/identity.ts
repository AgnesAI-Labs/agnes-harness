import type {
  CallContext,
  FactoryContext,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
  TrustedIngressContext,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  RuntimeIdentityLegacySchemas,
  RuntimeMethodSchemaRefs,
  type ServiceOperation,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { type BuildIdentity, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, ConformanceHarness } from '../harness.js'

export const IDENTITY_CREDENTIAL_CASES = [
  'local',
  'jwt',
  'source-auth',
  'portal-identity',
  'surface',
  'bearer',
  'session-cookie',
  'module-session',
] as const
export type IdentityCredentialCase = (typeof IDENTITY_CREDENTIAL_CASES)[number]

/** Fixture owns real connection, token, durable database, and current authorization controls. */
export interface IdentityContractFixture {
  readonly factory: ProviderFactory<ServiceProvider>
  readonly config: DataRef
  readonly dependencies: ScopedDependencies
  readonly context: FactoryContext
  readonly administrativeContext: CallContext
  readonly releaseSetDigest: string
  ingress(
    kind: IdentityCredentialCase,
    signal: AbortSignal,
    replay: boolean,
  ): Promise<{ operation: ServiceOperation; context: TrustedIngressContext }>
  current(identity: DataRef, signal: AbortSignal): Promise<CallContext>
  revoke(context: CallContext): Promise<void>
  coldRestart(): Promise<IdentityContractFixture>
  dispose(): Promise<void>
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Identity conformance: ${message}`)
}
function parsedIdentity(ref: DataRef, method: 'authenticate' | 'resolve') {
  check(ref.kind === 'inline', 'output must be inline')
  check(
    jcs(ref.schema) === jcs(RuntimeMethodSchemaRefs['agh.identity'][method].output),
    'output schema identity',
  )
  const safe = boundedCanonicalJson(ref.value, { maxBytes: 65536, maxDepth: 64, maxMembers: 10000 })
  check(
    safe.ok && safe.value.bytes === ref.bytes && canonicalJsonDigest(safe.value.json) === ref.digest,
    'output canonical bytes',
  )
  const result = validateRuntime('AuthenticatedIdentity', ref.value)
  check(result.ok, 'output structure')
  return result.value
}
async function open(fixture: IdentityContractFixture) {
  const provider = await fixture.factory.create(fixture.config, fixture.dependencies, fixture.context)
  check((await provider.ready(fixture.administrativeContext)).ok, 'selected provider ready')
  check(provider.ingress && provider.query, 'all identity methods exist')
  return provider
}

/** Executes actual public provider calls; adapters cannot supply a passed boolean. */
export async function runIdentityContractCase(
  fixture: IdentityContractFixture,
  scenario: ScenarioName,
): Promise<void> {
  const descriptor = fixture.factory.descriptor
  check(
    validateRuntime('ProviderDescriptor', descriptor).ok && descriptor.contract === 'agh.identity',
    'descriptor contract',
  )
  check(
    descriptor.features.includes(RuntimeIdentityLegacySchemas.requiredFeature),
    'legacy family advertised',
  )
  for (const method of ['authenticate', 'resolve'] as const) {
    const operation = descriptor.operations.find((entry) => entry.method === method)
    check(
      operation &&
        jcs(operation.inputSchema) === jcs(RuntimeMethodSchemaRefs['agh.identity'][method].input) &&
        jcs(operation.outputSchema) === jcs(RuntimeMethodSchemaRefs['agh.identity'][method].output),
      'operation schema identity',
    )
  }
  const provider = await open(fixture)
  const controller = new AbortController()
  try {
    if (scenario === 'select') return
    if (scenario === 'normal') {
      for (const kind of IDENTITY_CREDENTIAL_CASES) {
        const input = await fixture.ingress(kind, controller.signal, false)
        const output = await provider.ingress?.(input.operation, input.context)
        check(output?.ok, `credential ${kind}`)
        const identity = parsedIdentity(output.value, 'authenticate')
        if (kind === 'jwt' || kind === 'portal-identity' || kind === 'surface')
          check(identity.ownerClass === 'remote', 'remote subject never local owner')
        if (kind === 'source-auth') check(identity.ownerClass === 'service', 'source grant not user identity')
        const context = await fixture.current(output.value, controller.signal)
        const payload = { principalRef: identity.principalRef }
        const value: DataRef = {
          kind: 'inline',
          schema: RuntimeMethodSchemaRefs['agh.identity'].resolve.input,
          value: payload,
          digest: canonicalJsonDigest(payload),
          bytes: new TextEncoder().encode(jcs(payload)).length,
        }
        const resolved = await provider.query?.(
          { target: input.operation.target, method: 'resolve', input: value },
          context,
        )
        check(resolved?.ok && resolved.value.kind === 'value', 'current resolve succeeds')
        check(
          jcs(parsedIdentity(resolved.value.output, 'resolve')) === jcs(identity),
          'same authentication instance projection',
        )
      }
    } else {
      const input = await fixture.ingress('source-auth', controller.signal, false)
      if (scenario === 'cancel') {
        controller.abort()
        check(!(await provider.ingress?.(input.operation, input.context))?.ok, 'cancelled ingress rejected')
      } else if (scenario === 'dispose') {
        await provider.close('shutdown')
        check(!(await provider.ingress?.(input.operation, input.context))?.ok, 'disposed ingress rejected')
      } else {
        const output = await provider.ingress?.(input.operation, input.context)
        check(output?.ok, 'authenticated current instance')
        const identity = parsedIdentity(output.value, 'authenticate')
        const context = await fixture.current(output.value, controller.signal)
        const value = { principalRef: identity.principalRef }
        const query = {
          target: input.operation.target,
          method: 'resolve',
          input: {
            kind: 'inline' as const,
            schema: RuntimeMethodSchemaRefs['agh.identity'].resolve.input,
            value,
            digest: canonicalJsonDigest(value),
            bytes: new TextEncoder().encode(jcs(value)).length,
          },
        }
        if (scenario === 'deny') {
          check(
            !(await provider.ingress?.(input.operation, { ...input.context }))?.ok,
            'forged trusted context rejected',
          )
          check(!(await provider.query?.(query, { ...context }))?.ok, 'forged call context rejected')
          await fixture.revoke(context)
          check(!(await provider.query?.(query, context))?.ok, 'current revocation enforced')
        } else {
          await provider.close('upgrade')
          const next = await fixture.coldRestart()
          try {
            const recovered = await open(next)
            check(
              !(await recovered.query?.(query, context))?.ok,
              'old context not revived after cold restart',
            )
            const replay = await next.ingress('source-auth', controller.signal, true)
            check(
              !(await recovered.ingress?.(replay.operation, replay.context))?.ok,
              'durable nonce survives restart',
            )
            const fresh = await next.ingress('source-auth', controller.signal, false)
            check(
              (await recovered.ingress?.(fresh.operation, fresh.context))?.ok,
              'new signed request works after recovery',
            )
            await recovered.close('shutdown')
          } finally {
            await next.dispose()
          }
        }
      }
    }
  } finally {
    await provider.close('shutdown')
  }
}

/** Public registrar contains no provider implementation or private Host import. */
export function registerIdentityContract(
  harness: ConformanceHarness,
  binding: {
    providerId: string
    command: string
    build: BuildIdentity
    fixture(): Promise<IdentityContractFixture>
  },
): void {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.identity',
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      async run(): Promise<AssertionInput> {
        const fixture = await binding.fixture()
        let passed = false
        try {
          await runIdentityContractCase(fixture, scenario)
          passed = true
        } finally {
          await fixture.dispose()
        }
        return {
          id: `agh.identity/${binding.providerId}/${scenario}`,
          providerDigest: fixture.factory.descriptor.packageDigest,
          recipe: 'identity-transport',
          features: [...fixture.factory.descriptor.features],
          build: binding.build,
          consumer: 'identity-current-authorization-consumer',
          command: binding.command,
          status: passed ? 'passed' : 'failed',
          configDigest: fixture.config.kind === 'inline' ? fixture.config.digest : fixture.config.blob.digest,
          releaseSetDigest: fixture.releaseSetDigest,
          attachmentDigest: null,
          fixture: null,
          sharedEvidenceId: null,
          reuse: {
            scope: 'deployment',
            methodKind: scenario === 'normal' ? 'query' : 'ingress',
            lifecycle:
              scenario === 'recover' || scenario === 'cancel' || scenario === 'dispose' ? scenario : 'call',
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
}
