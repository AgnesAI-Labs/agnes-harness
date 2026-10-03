import { createHash } from 'node:crypto'
import { jcs } from '@agnes/protocol'
import type {
  BytesRef,
  EffectResult,
  EmbeddingEncodeRequest,
  ProviderDescriptor,
} from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { type BuildIdentity, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'

export const EMBEDDING_CONTRACT_COVERAGE = {
  implemented: [
    'restricted-fixture',
    'matrix-validation',
    'public-usage-provider',
    'duplicate-delivery',
    'cold-recovery',
  ],
  incomplete: ['live-model-gateway', 'price-and-billing-chain', 'production-wiring'],
} as const
export type EmbeddingContractDriver = {
  expectedProviderId: string
  expectedPackageDigest: string
  input: EmbeddingEncodeRequest
  start(): Promise<ProviderDescriptor>
  encode(input: EmbeddingEncodeRequest, mode?: string): Promise<EffectResult>
  readVectorsBlob(reference: BytesRef): Promise<Uint8Array>
  counts(): Promise<{ deliveries: number; usages: number }>
  cancel(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<{ previousPid: number; pid: number }>
  waitReceived(): Promise<void>
  close(): Promise<void>
}
export async function runEmbeddingContractScenario(
  driver: EmbeddingContractDriver,
  scenario: ScenarioName,
): Promise<string[]> {
  const observations: string[] = []
  const check = (condition: boolean, label: string) => {
    if (!condition) throw Error(`Embedding contract: ${label}`)
    observations.push(label)
  }
  try {
    const descriptor = await driver.start()
    check(
      validateRuntime('ProviderDescriptor', descriptor).ok &&
        descriptor.providerId === driver.expectedProviderId &&
        descriptor.packageDigest === driver.expectedPackageDigest,
      'selected-public-provider',
    )
    check(
      descriptor.contract === 'agh.embedding' &&
        descriptor.operations.length === 1 &&
        descriptor.operations[0]?.method === 'encode' &&
        descriptor.operations[0].kind === 'action',
      'encode-leaf-selected',
    )
    if (scenario === 'normal' || scenario === 'recover') {
      const first = await driver.encode(driver.input)
      check(first.outcome === 'succeeded' && first.result?.kind === 'inline', 'normal-fixture-encoding')
      if (first.result?.kind !== 'inline') throw Error('Embedding result missing')
      const parsed = validateRuntime('EmbeddingEncodeResult', first.result.value)
      check(
        parsed.ok &&
          jcs(parsed.value.vectorsRef.schema) === jcs(RuntimeSchemaRefs.EmbeddingVectors) &&
          parsed.value.dimensions === driver.input.dimensions &&
          parsed.value.usageRefs.length === 1,
        'fixed-vectors-schema-and-leaf-usage',
      )
      if (!parsed.ok) throw Error('Embedding output invalid')
      const vectorsRef = parsed.value.vectorsRef
      let matrix: unknown
      if (vectorsRef.kind === 'blob') {
        const bytes = await driver.readVectorsBlob(vectorsRef.blob)
        check(
          bytes.byteLength === vectorsRef.blob.bytes &&
            createHash('sha256').update(bytes).digest('hex') === vectorsRef.blob.digest,
          'vectors-blob-digest-and-size',
        )
        matrix = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      } else {
        matrix = vectorsRef.value
        check(
          vectorsRef.digest === canonicalJsonDigest(vectorsRef.value) &&
            vectorsRef.bytes === new TextEncoder().encode(jcs(vectorsRef.value)).byteLength,
          'vectors-inline-digest-and-size',
        )
      }
      const vectors = validateRuntime('EmbeddingVectors', matrix)
      check(
        vectors.ok &&
          vectors.value.length === driver.input.inputRefs.length &&
          vectors.value.every(
            (row) =>
              row.length === driver.input.dimensions &&
              Array.from(row).every((n) => Number.isFinite(n)) &&
              (!driver.input.normalize || Math.abs(Math.hypot(...row) - 1) <= 1e-6),
          ) &&
          parsed.value.inputDigest === canonicalJsonDigest(driver.input),
        'actual-vectors-match-input-and-dimensions',
      )
      check(jcs(await driver.encode(driver.input)) === jcs(first), 'same-delivery-original-result')
      check(
        (await driver.encode({ ...driver.input, dimensions: driver.input.dimensions + 1 })).error?.code ===
          'conflict',
        'different-fingerprint-conflict',
      )
      const count = await driver.counts()
      check(count.deliveries === 1 && count.usages === 1, 'one-leaf-one-usage')
      if (scenario === 'recover') {
        const boot = await driver.restart()
        check(
          boot.pid > 0 && boot.previousPid > 0 && boot.pid !== boot.previousPid,
          'true-cold-process-restart',
        )
        check(jcs(await driver.encode(driver.input)) === jcs(first), 'cold-original-result-and-usage-refs')
        const after = await driver.counts()
        check(after.deliveries === 1 && after.usages === 1, 'cold-no-resend-or-double-usage')
      }
    }
    if (scenario === 'deny') {
      check(
        (await driver.encode(driver.input, 'deny')).error?.code === 'denied',
        'current-permission-refused',
      )
      const count = await driver.counts()
      check(count.deliveries === 0 && count.usages === 0, 'deny-no-effect-or-usage')
    }
    if (scenario === 'cancel' || scenario === 'dispose') {
      if (scenario === 'cancel')
        check((await driver.encode(driver.input, 'cancel')).outcome === 'cancelled', 'pre-send-cancel')
      const inflight = driver.encode(driver.input)
      await driver.waitReceived()
      check(
        (await driver.encode(driver.input)).outcome === 'unknown_effect',
        'concurrent-delivery-no-second-effect',
      )
      if (scenario === 'cancel') await driver.cancel()
      else await driver.stop()
      check((await inflight).outcome === 'unknown_effect', 'sent-result-unknown')
      if (scenario === 'dispose')
        check((await driver.encode(driver.input)).error?.code === 'denied', 'disposed-refused')
      const boot = await driver.restart()
      check(boot.pid !== boot.previousPid, 'unknown-cold-restart')
      check((await driver.encode(driver.input)).outcome === 'unknown_effect', 'unknown-never-resend')
      const count = await driver.counts()
      check(count.deliveries === 1 && count.usages === 0, 'unknown-no-invented-zero-usage')
    }
    return observations
  } finally {
    await driver.close()
  }
}
export function registerEmbeddingContract(
  harness: ConformanceHarness,
  binding: {
    providerId: string
    providerDigest: string
    configDigest: string
    releaseSetDigest: string
    build: BuildIdentity
    command: string
    driver(scenario: ScenarioName): EmbeddingContractDriver
  },
): void {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.embedding',
      providerId: binding.providerId,
      scenario,
      qualification: 'required',
      async run() {
        let checked: string[] = [],
          diagnostic: string | undefined
        try {
          checked = await runEmbeddingContractScenario(binding.driver(scenario), scenario)
        } catch (error) {
          diagnostic = error instanceof Error ? error.message : String(error)
        }
        return {
          id: `embedding/${binding.providerId}/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: 'restricted-embedding-fixture',
          features: [],
          build: binding.build,
          consumer: 'public-embedding-leaf-with-injected-usage',
          command: binding.command,
          status: diagnostic ? 'failed' : 'passed',
          ...(diagnostic ? { diagnostic } : {}),
          configDigest: binding.configDigest,
          releaseSetDigest: binding.releaseSetDigest,
          attachmentDigest: canonicalJsonDigest(checked),
          fixture: 'restricted-effects',
          sharedEvidenceId: null,
          reuse: {
            scope: 'workspace',
            methodKind: 'action',
            lifecycle:
              scenario === 'cancel' || scenario === 'recover' || scenario === 'dispose' ? scenario : 'call',
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
}
