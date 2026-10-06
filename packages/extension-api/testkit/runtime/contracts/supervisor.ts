import type {
  CallContext,
  FactoryContext,
  Outcome,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { defineGeneratedAuthorSchema } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
} from '@agnes/protocol/runtime'
import { type BuildIdentity, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'

const emptyConfig = defineGeneratedAuthorSchema<Record<string, never>>({
  ownerPackageId: '@agnes/supervisor-contract',
  name: 'RuntimeEmptyConfig',
  typeId: '@agnes/supervisor-contract/empty@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/RuntimeEmptyConfig',
    $defs: {
      RuntimeEmptyConfig: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: [],
        maxProperties: 0,
      },
    },
  },
})

const catalog = RuntimeServiceCatalog['agh.supervisor'].methods
const refs = RuntimeMethodSchemaRefs['agh.supervisor']
type Method = keyof typeof catalog
const METHODS = Object.keys(catalog) as readonly Method[]

/** The official runtime-scope descriptor every implementation of the contract must be installable under. */
export function supervisorDescriptor(providerId: string, logicalName = 'default'): W.ProviderDescriptor {
  return {
    providerId,
    contract: 'agh.supervisor',
    major: 1,
    logicalName,
    packageVersion: '1.0.0',
    packageDigest: canonicalJsonDigest({ providerId, contract: 'agh.supervisor' }),
    features: [],
    scope: 'runtime',
    configSchema: emptyConfig.ref,
    requires: [],
    capabilities: [],
    recovery: 'R1',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: METHODS.map((method) => ({
      method,
      kind: catalog[method].kind,
      inputSchema: refs[method].input,
      outputSchema: refs[method].output,
      requiredCapabilities: [],
      retrySafety: catalog[method].kind === 'query' ? 'read-only' : 'never',
    })),
  } as W.ProviderDescriptor
}
/** An inline request body for one method, measured the way the Supervisor measures it. */
export function supervisorInput(method: Method, value: unknown): W.DataRef {
  const body = boundedCanonicalJson(value, { maxBytes: 65_536, maxDepth: 64, maxMembers: 10_000 })
  if (!body.ok) throw new Error('Supervisor contract: request body exceeds the inline limit')
  return {
    kind: 'inline',
    schema: refs[method].input,
    value: body.value.json,
    bytes: body.value.bytes,
    digest: canonicalJsonDigest(body.value.json),
  }
}
export function supervisorConfig(): W.DataRef {
  return { kind: 'inline', schema: emptyConfig.ref, value: {}, bytes: 2, digest: canonicalJsonDigest({}) }
}
const UNSERVED = new Set(['supervisor_method_unsupported', 'supervisor_port_unavailable'])

/** A restricted peer set. The cold and drive consumers must be real: a fixture that keeps State in memory
 * cannot implement `cold`, and a fixture without `drive` must say so instead of passing. */
export interface SupervisorContractFixture {
  factory: ProviderFactory<ServiceProvider>
  config: W.DataRef
  dependencies: ScopedDependencies
  factoryContext: FactoryContext
  binding: W.BindingRef
  /** A context for the fixture's session; the signal aborts the call. */
  context(signal?: AbortSignal): CallContext
  sessionId: string
  /** The session-control owner behind the Supervisor. */
  state: {
    /** Calls the owner has seen, oldest first. */
    calls(): readonly string[]
    /** Make the next owner call hang until the returned function releases it. */
    hang(): () => void
    /** Every later owner call refuses as a revoked authorization. */
    revoke(): void
  }
  /** Admission recipes. Absent until the admission slice exists. */
  admission?: {
    spec(key: string): W.NewRunSpec
    /** The next admit leaves its ticket issued but reports createRun as not yet known (a lost response). */
    holdCreate(): void
    /** The run reference of the ticket issued for this idempotency key, or null if none was issued. */
    runRefOf(key: string): W.RunRef | null
    /** Ticket and run records the owner holds. */
    issued(): number
    created(): number
  }
  /** Consumers for the normal scenario. Absent until the drive slice exists. */
  drive?(recipe: 'no-model' | 'tool-first-dag' | 'composite-wait'): Promise<{
    committedBeforeDispatch: boolean
    logicalAdvancesPerResult: number
    duplicateWakes: number
    openMandatoryAtComplete: number
    waitingAfterSevenDays: boolean
  }>
  /** SIGKILL at a named crash point and resume in a new process from State alone. */
  cold?(point: 'after-commit' | 'after-allocate' | 'after-mark-running'): Promise<{
    killedPid: number
    restoredPid: number
    signal: 'SIGKILL'
    stateConsumer: 'public-state-control'
    externalEffects: number
    unknownRerun: boolean
    deadlineExtended: boolean
  }>
  close(): Promise<void>
}

function require(value: unknown, detail: string): asserts value {
  if (!value) throw new Error(`Supervisor contract: ${detail}`)
}
const unavailable = (what: string) => new Error(`supervisor_${what}_consumer_unavailable`)
const bad = (method: Method): W.DataRef => supervisorInput(method, {})
const call = (
  fixture: SupervisorContractFixture,
  provider: ServiceProvider,
  method: Method,
  input: W.DataRef,
  context: CallContext,
) => {
  const request = { target: fixture.binding, method, input }
  return catalog[method].kind === 'query'
    ? provider.query?.(request, context)
    : provider.control?.(request, context)
}
const refusal = (result: Outcome<unknown> | undefined) => (result && !result.ok ? result.error : null)

export async function runSupervisorContractScenario(
  scenario: ScenarioName,
  open: () => Promise<SupervisorContractFixture>,
) {
  const fixture = await open()
  const provider = await fixture.factory.create(fixture.config, fixture.dependencies, fixture.factoryContext)
  try {
    const context = fixture.context()
    require(provider.query && provider.control, 'query and control handlers')
    if (scenario === 'select') {
      const d = fixture.factory.descriptor
      require(d.contract === 'agh.supervisor' &&
        d.major === 1 &&
        d.scope === 'runtime' &&
        d.recovery === 'R1', 'descriptor identity')
      require(d.operations.length === METHODS.length &&
        METHODS.every((m) => {
          const op = d.operations.find((o) => o.method === m)
          return (
            op &&
            op.kind === catalog[m].kind &&
            canonicalJsonDigest(op.inputSchema as never) === canonicalJsonDigest(refs[m].input as never) &&
            canonicalJsonDigest(op.outputSchema as never) === canonicalJsonDigest(refs[m].output as never)
          )
        }), 'fifteen operations equal the catalog')
      require((await provider.ready(context)).ok, 'ready')
      // A method is either served (a bad body is invalid_input) or refused by name before its body is read.
      const unserved: string[] = []
      for (const method of METHODS) {
        const error = refusal(await call(fixture, provider, method, bad(method), context))
        require(error, `${method} must refuse an empty body`)
        if (error.code === 'incompatible') {
          require(UNSERVED.has(error.detailCode), `${method} refuses by an allowed name`)
          unserved.push(method)
        } else require(error.code === 'invalid_input', `${method} serves and validates its body`)
      }
      const health = await provider.health(context)
      require(health.ok &&
        health.value.status ===
          (unserved.length === 0 ? 'ready' : 'degraded'), 'health reflects unavailable methods')
      require(health.ok &&
        [...health.value.diagnosticIds].sort().join() ===
          unserved
            .map((m) => `supervisor-unavailable:${m}`)
            .sort()
            .join(), 'health names exactly the unavailable methods')
      if (!unserved.includes('readSessionControl')) {
        const reply = await provider.query?.(
          {
            target: fixture.binding,
            method: 'readSessionControl',
            input: supervisorInput('readSessionControl', fixture.sessionId),
          },
          context,
        )
        require(reply?.ok && reply.value.kind === 'value', 'readSessionControl reaches the State owner')
      }
    } else if (scenario === 'deny') {
      require((await provider.ready(context)).ok, 'ready')
      fixture.state.revoke()
      const error = refusal(
        await call(
          fixture,
          provider,
          'readSessionControl',
          supervisorInput('readSessionControl', fixture.sessionId),
          context,
        ),
      )
      require(error && error.code === 'denied', 'a revoked authorization is refused as denied, not swallowed')
      if (fixture.admission) {
        const before = fixture.admission.issued()
        const admit = refusal(
          await call(
            fixture,
            provider,
            'admit',
            supervisorInput('admit', fixture.admission.spec('deny-1')),
            context,
          ),
        )
        require(admit &&
          admit.code === 'denied' &&
          fixture.admission.issued() === before &&
          fixture.admission.created() === 0, 'a revoked admit creates no ticket and no run')
      }
    } else if (scenario === 'cancel') {
      require((await provider.ready(context)).ok, 'ready')
      const before = fixture.state.calls().length
      const aborted = new AbortController()
      aborted.abort()
      const early = refusal(
        await call(
          fixture,
          provider,
          'readSessionControl',
          supervisorInput('readSessionControl', fixture.sessionId),
          fixture.context(aborted.signal),
        ),
      )
      require(early &&
        early.code === 'cancelled' &&
        fixture.state.calls().length === before, 'an aborted caller never reaches State')
      const release = fixture.state.hang()
      const controller = new AbortController()
      const pending = call(
        fixture,
        provider,
        'readSessionControl',
        supervisorInput('readSessionControl', fixture.sessionId),
        fixture.context(controller.signal),
      )
      controller.abort()
      const late = refusal(await pending)
      release()
      require(late && late.code === 'cancelled', 'abort while State is slow returns cancelled')
      if (fixture.admission) {
        const admission = fixture.admission
        admission.holdCreate()
        const held = refusal(
          await call(
            fixture,
            provider,
            'admit',
            supervisorInput('admit', admission.spec('cancel-1')),
            context,
          ),
        )
        require(held &&
          held.code === 'retryable' &&
          held.detailCode ===
            'supervisor_admission_pending', 'an unknown createRun is a retry, never a success')
        const runRef = admission.runRefOf('cancel-1')
        require(runRef, 'the ticket was issued')
        const first = await call(
          fixture,
          provider,
          'cancel',
          supervisorInput('cancel', { runRef, reason: 'stop' }),
          context,
        )
        const again = await call(
          fixture,
          provider,
          'cancel',
          supervisorInput('cancel', { runRef, reason: 'another reason' }),
          context,
        )
        require(first?.ok &&
          again?.ok &&
          canonicalJsonDigest(first.value as never) ===
            canonicalJsonDigest(again.value as never), 'a repeated cancel returns the same pointer')
        const afterTombstone = refusal(
          await call(
            fixture,
            provider,
            'admit',
            supervisorInput('admit', admission.spec('cancel-1')),
            context,
          ),
        )
        require(afterTombstone &&
          afterTombstone.code === 'cancelled' &&
          afterTombstone.detailCode === 'supervisor_admission_cancelled' &&
          admission.created() === 0, 'createRun after the tombstone creates nothing')
      }
    } else if (scenario === 'dispose') {
      require((await provider.ready(context)).ok, 'ready')
      const release = fixture.state.hang()
      const pending = call(
        fixture,
        provider,
        'readSessionControl',
        supervisorInput('readSessionControl', fixture.sessionId),
        context,
      )
      const drained = await provider.drain(new Date(Date.now() + 30).toISOString(), context)
      require(drained.ok && drained.value.state === 'blocked', 'drain is blocked while a call is in flight')
      const closedWrite = refusal(
        await call(
          fixture,
          provider,
          'submitSessionControl',
          supervisorInput('submitSessionControl', {
            sessionId: fixture.sessionId,
            requestId: 'late',
            expectedRevision: null,
            command: { kind: 'set-yolo', enabled: true },
          }),
          context,
        ),
      )
      require(closedWrite && closedWrite.code === 'cancelled', 'drain closes new control calls')
      release()
      await pending
      const again = await provider.drain(new Date(Date.now() + 200).toISOString(), context)
      require(again.ok && again.value.state === 'drained', 'drain completes once the call ends')
      await provider.close('shutdown')
      await provider.close('shutdown')
      const after = refusal(
        await call(
          fixture,
          provider,
          'readSessionControl',
          supervisorInput('readSessionControl', fixture.sessionId),
          context,
        ),
      )
      require(after && after.code === 'cancelled', 'a closed provider refuses')
      require(!(await provider.ready(context)).ok, 'cannot revive')
    } else if (scenario === 'normal') {
      require((await provider.ready(context)).ok, 'ready')
      if (!fixture.drive) throw unavailable('drive')
      for (const recipe of ['no-model', 'tool-first-dag', 'composite-wait'] as const) {
        const seen = await fixture.drive(recipe)
        require(seen.committedBeforeDispatch, `${recipe}: committed before dispatch`)
        require(seen.logicalAdvancesPerResult === 1 &&
          seen.duplicateWakes >= 0, `${recipe}: one logical advance per result`)
        require(seen.openMandatoryAtComplete === 0, `${recipe}: nothing mandatory is open at completion`)
        if (recipe === 'composite-wait')
          require(seen.waitingAfterSevenDays, 'a seven day wait is not a leaf deadline')
      }
    } else {
      require((await provider.ready(context)).ok, 'ready')
      if (!fixture.cold) throw unavailable('cold_state')
      for (const point of ['after-commit', 'after-allocate', 'after-mark-running'] as const) {
        const cold = await fixture.cold(point)
        require(cold.killedPid > 0 &&
          cold.restoredPid > 0 &&
          cold.killedPid !== cold.restoredPid &&
          cold.signal === 'SIGKILL' &&
          cold.stateConsumer === 'public-state-control', `${point}: a real new process through State`)
        require(cold.externalEffects === 1 &&
          !cold.unknownRerun &&
          !cold.deadlineExtended, `${point}: one external effect, unknown not rerun, deadline not extended`)
      }
    }
    return {
      providerDigest: fixture.factory.descriptor.packageDigest,
      configDigest: fixture.config.kind === 'inline' ? fixture.config.digest : fixture.config.blob.digest,
    }
  } finally {
    await provider.close('shutdown')
    await fixture.close()
  }
}

/** Six required cases per implementation. A case without a real consumer is registered as failed with a named
 * diagnostic; it is never recorded as passed. */
export function registerSupervisorContract(
  harness: ConformanceHarness,
  binding: {
    providerId: string
    build: BuildIdentity
    command: string
    open: () => Promise<SupervisorContractFixture>
  },
) {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.supervisor',
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      async run() {
        let proof: { providerDigest: W.Digest; configDigest: W.Digest } | undefined
        let status: 'passed' | 'failed' = 'passed'
        let diagnostic = 'Restricted peers; no production installation claim.'
        try {
          proof = await runSupervisorContractScenario(scenario, async () => {
            const fixture = await binding.open()
            proof = {
              providerDigest: fixture.factory.descriptor.packageDigest,
              configDigest:
                fixture.config.kind === 'inline' ? fixture.config.digest : fixture.config.blob.digest,
            }
            return fixture
          })
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/^supervisor_[a-z_]+_consumer_unavailable/.test(error.message) ||
            !proof
          )
            throw error
          status = 'failed'
          diagnostic = error.message
        }
        require(proof, 'implementation evidence')
        return {
          id: `agh.supervisor/${binding.providerId}/${scenario}/restricted-peers`,
          ...proof,
          recipe: 'supervisor-restricted-peers',
          features: [],
          build: binding.build,
          consumer: 'public-supervisor-spi-restricted-peers',
          command: binding.command,
          status,
          diagnostic,
          releaseSetDigest: canonicalJsonDigest({ slice: 'supervisor-contract' }),
          attachmentDigest: null,
          fixture: 'test-service-container',
          sharedEvidenceId: null,
          perImplementation: true,
          gate: null,
        }
      },
    })
}
