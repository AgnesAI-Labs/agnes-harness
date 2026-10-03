import { jcs } from '@agnes/protocol'
import type { ProviderDescriptor, TelemetryExportRequest, TraceRecordRequest } from '@agnes/protocol/runtime'
import type { ScenarioName } from '../evidence.js'

export type TraceContractDriver = {
  expectedProviderId: string
  expectedPackageDigest: string
  start(): Promise<ProviderDescriptor>
  record(input: TraceRecordRequest, mode?: 'deny' | 'cancel'): Promise<unknown>
  export(input: TelemetryExportRequest, mode?: 'deny' | 'cancel' | 'hang'): Promise<unknown>
  cancel(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<{ previousPid: number; pid: number }>
  deliveries(): Promise<number>
  waitReceived(): Promise<void>
  input: TraceRecordRequest
  exportInput: TelemetryExportRequest
  close(): Promise<void>
}
function check(condition: boolean, id: string) {
  if (!condition) throw new Error(`Trace contract: ${id}`)
}
function result(value: unknown): {
  ok?: boolean
  outcome?: string
  value?: { kind?: string; value?: unknown }
  result?: { kind?: string; value?: unknown }
  error?: { code?: string }
} {
  return value as ReturnType<typeof result>
}
export async function runTraceContractScenario(
  driver: TraceContractDriver,
  scenario: ScenarioName,
): Promise<string[]> {
  const assertions: string[] = []
  const assert = (value: boolean, id: string) => {
    check(value, id)
    assertions.push(id)
  }
  try {
    const descriptor = await driver.start()
    assert(
      descriptor.providerId === driver.expectedProviderId &&
        descriptor.packageDigest === driver.expectedPackageDigest,
      'selected-provider-and-package-digest',
    )
    assert(validateRuntime('ProviderDescriptor', descriptor).ok, 'public-descriptor-schema')
    assert(descriptor.contract === 'agh.trace', 'selected-trace-contract')
    assert(
      descriptor.operations.length === 2 &&
        descriptor.operations.some((o) => o.method === 'record' && o.kind === 'observe') &&
        descriptor.operations.some((o) => o.method === 'export' && o.kind === 'action'),
      'local-observe-managed-action',
    )
    if (scenario === 'select') {
      assert(descriptor.providerId.startsWith('agh.'), 'selected-provider-identity')
    }
    if (scenario === 'normal') {
      const original = await driver.record(driver.input),
        same = await driver.record(driver.input)
      assert(result(original).ok === true && jcs(original) === jcs(same), 'local-idempotent-record')
      assert((await driver.deliveries()) === 0, 'record-zero-network')
      const exported = await driver.export(driver.exportInput),
        repeat = await driver.export(driver.exportInput)
      assert(
        result(exported).outcome === 'succeeded' && jcs(exported) === jcs(repeat),
        'one-export-original-receipt',
      )
      assert((await driver.deliveries()) === 1, 'export-real-peer-once')
    }
    if (scenario === 'deny') {
      assert(
        result(await driver.record(driver.input, 'deny')).error?.code === 'denied',
        'unauthorized-record',
      )
      assert(
        result(await driver.export(driver.exportInput, 'deny')).error?.code === 'denied',
        'unauthorized-export',
      )
      const changed = {
        ...driver.exportInput,
        consent: { ...driver.exportInput.consent, sourceDigest: 'f'.repeat(64) },
      }
      assert(result(await driver.export(changed)).error?.code === 'denied', 'forged-consent-rejected')
      assert((await driver.deliveries()) === 0, 'refusal-zero-network')
    }
    if (scenario === 'cancel') {
      assert(result(await driver.record(driver.input, 'cancel')).ok === false, 'cancel-before-record')
      assert(
        result(await driver.export(driver.exportInput, 'cancel')).outcome === 'cancelled',
        'cancel-before-export',
      )
      const pending = driver.export(driver.exportInput, 'hang')
      await driver.waitReceived()
      await driver.cancel()
      assert(result(await pending).outcome === 'unknown_effect', 'inflight-cancel-remains-unknown')
      assert(
        result(await driver.export(driver.exportInput, 'hang')).outcome === 'unknown_effect',
        'cancel-no-replay',
      )
      assert((await driver.deliveries()) === 1, 'cancel-one-real-send')
    }
    if (scenario === 'recover') {
      const recorded = await driver.record(driver.input),
        exported = await driver.export(driver.exportInput)
      const identity = await driver.restart()
      assert(identity.previousPid !== identity.pid, 'actual-cold-process')
      assert(jcs(recorded) === jcs(await driver.record(driver.input)), 'cold-original-record')
      assert(jcs(exported) === jcs(await driver.export(driver.exportInput)), 'cold-original-export-receipt')
      assert((await driver.deliveries()) === 1, 'cold-no-resend')
    }
    if (scenario === 'dispose') {
      const pending = driver.export(driver.exportInput, 'hang')
      await driver.waitReceived()
      await driver.stop()
      assert(result(await pending).outcome === 'unknown_effect', 'dispose-inflight-unknown')
      assert(result(await driver.record(driver.input)).ok === false, 'closed-local-port')
      assert(result(await driver.export(driver.exportInput)).outcome === 'failed', 'closed-export-port')
      assert((await driver.deliveries()) === 1, 'disposed-no-new-network')
    }
    return assertions
  } finally {
    await driver.close()
  }
}

import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { type BuildIdentity, SCENARIOS } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'
export function registerTraceContract(
  harness: ConformanceHarness,
  binding: {
    providerId: string
    providerDigest: string
    configDigest: string
    releaseSetDigest: string
    build: BuildIdentity
    command: string
    driver(scenario: ScenarioName): TraceContractDriver
  },
): void {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.trace',
      providerId: binding.providerId,
      scenario,
      qualification: 'required',
      async run() {
        let assertions: string[] = [],
          diagnostic: string | undefined
        try {
          assertions = await runTraceContractScenario(binding.driver(scenario), scenario)
        } catch (error) {
          diagnostic = error instanceof Error ? error.message : String(error)
        }
        return {
          id: `trace/${binding.providerId}/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: 'durable-public-provider',
          features: [],
          build: binding.build,
          consumer: 'selected-public-factory-restricted-effects-real-peer',
          command: binding.command,
          status: diagnostic ? 'failed' : 'passed',
          ...(diagnostic ? { diagnostic } : {}),
          configDigest: binding.configDigest,
          releaseSetDigest: binding.releaseSetDigest,
          attachmentDigest: canonicalJsonDigest(assertions),
          fixture: 'restricted-effects',
          sharedEvidenceId: null,
          reuse: {
            scope: 'runtime',
            methodKind: 'observe+action',
            lifecycle: ['cancel', 'recover', 'dispose'].includes(scenario)
              ? (scenario as 'cancel' | 'recover' | 'dispose')
              : 'call',
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
}
