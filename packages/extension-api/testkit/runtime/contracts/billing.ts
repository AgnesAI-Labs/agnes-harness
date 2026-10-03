import type { EffectPorts } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type { BillingPostRequest, BillingRefundRequest, ProviderDescriptor } from '@agnes/protocol/runtime'
import { createRestrictedEffectsFixture } from '../effects.js'
import type { ScenarioName } from '../evidence.js'

/** Grants the synthetic consumer one managed network operation and refuses every other port. */
export function createBillingTraceNetworkFixture(handle: EffectPorts['invoke']): EffectPorts {
  const fixture = createRestrictedEffectsFixture()
  fixture.allow({ port: 'invoke', operation: 'agh.network.request', handle })
  return fixture.ports
}

export type BillingContractDriver = {
  expectedProviderId: string
  expectedPackageDigest: string
  start(): Promise<ProviderDescriptor>
  post(input: BillingPostRequest, mode?: 'deny' | 'cancel' | 'hang'): Promise<unknown>
  refund(input: BillingRefundRequest): Promise<unknown>
  cancel(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<{ previousPid: number; pid: number }>
  deliveries(): Promise<number>
  retirePrice(): Promise<void>
  accountingStats(): Promise<{ usageFacts: number; origins: number; settled: string }>
  waitReceived(): Promise<void>
  input: BillingPostRequest
  refundInput(entryId: string): BillingRefundRequest
  close(): Promise<void>
}
type Reply = {
  outcome?: string
  result?: { kind?: string; value?: { entryId?: string; status?: string } }
  error?: { code?: string }
}
const reply = (v: unknown) => v as Reply
export async function runBillingContractScenario(
  driver: BillingContractDriver,
  scenario: ScenarioName,
): Promise<string[]> {
  const checked: string[] = []
  const assert = (ok: boolean, id: string) => {
    if (!ok) throw new Error(`Billing contract: ${id}`)
    checked.push(id)
  }
  try {
    const descriptor = await driver.start()
    assert(
      descriptor.providerId === driver.expectedProviderId &&
        descriptor.packageDigest === driver.expectedPackageDigest,
      'selected-provider-and-package-digest',
    )
    assert(validateRuntime('ProviderDescriptor', descriptor).ok, 'public-descriptor-schema')
    assert(
      descriptor.contract === 'agh.billing' &&
        descriptor.operations.length === 3 &&
        ['post', 'refund', 'reconcile'].every((name) =>
          descriptor.operations.some((o) => o.method === name && o.kind === 'action'),
        ),
      'selected-billing-methods',
    )
    if (scenario === 'select') assert(descriptor.providerId.startsWith('agh.'), 'selected-provider-identity')
    if (scenario === 'normal') {
      const first = await driver.post(driver.input),
        again = await driver.post(driver.input)
      assert(
        reply(first).outcome === 'succeeded' &&
          reply(first).result?.value?.status === 'posted' &&
          jcs(first) === jcs(again),
        'posted-once',
      )
      assert(
        reply(
          await driver.post({
            ...driver.input,
            accountRef: { ...driver.input.accountRef, revision: 2 },
          }),
        ).error?.code === 'conflict',
        'changed-post-key-refused',
      )
      const id = reply(first).result?.value?.entryId
      assert(typeof id === 'string', 'entry-identity')
      if (typeof id !== 'string') throw new Error('Billing entry identity absent')
      const refund = driver.refundInput(id),
        a = await driver.refund(refund),
        b = await driver.refund(refund)
      assert(reply(a).outcome === 'succeeded' && jcs(a) === jcs(b), 'refund-once')
      assert(
        reply(await driver.post({ ...driver.input, chargeKey: 'empty-usage', usageRefs: [] })).error?.code ===
          'invalid_input',
        'bad-usage-refused',
      )
      assert(
        reply(await driver.post({ ...driver.input, usageRefs: [] })).error?.code === 'conflict',
        'changed-post-usage-refused',
      )
      assert(
        reply(await driver.refund({ ...refund, reason: 'changed' })).error?.code === 'conflict',
        'changed-key-refused',
      )
      assert(
        reply(
          await driver.refund({
            ...refund,
            refundKey: 'excess',
            amount: { ...refund.amount, units: '1000000000' },
          }),
        ).error?.code === 'denied',
        'over-refund-refused',
      )
      assert(
        reply(
          await driver.refund({
            ...refund,
            refundKey: 'exchange',
            amount: { ...refund.amount, currency: 'EUR' },
          }),
        ).error?.code === 'denied',
        'cross-currency-refused',
      )
      const stats = await driver.accountingStats()
      assert(
        stats.usageFacts === 1 && stats.origins === 1 && stats.settled === '100',
        'one-public-usage-and-budget-settlement',
      )
      assert(
        reply(await driver.post({ ...driver.input, chargeKey: 'other-charge' })).error?.code === 'conflict',
        'same-usage-new-charge-refused',
      )
      assert((await driver.deliveries()) === 2, 'two-real-receipts')
    }
    if (scenario === 'deny') {
      assert(
        reply(await driver.post(driver.input, 'deny')).error?.code === 'denied',
        'untrusted-post-refused',
      )
      assert((await driver.deliveries()) === 0, 'deny-zero-network')
      const stats = await driver.accountingStats()
      assert(stats.origins === 0 && stats.settled === '0', 'deny-no-budget-settlement')
    }
    if (scenario === 'cancel') {
      assert(reply(await driver.post(driver.input, 'cancel')).outcome === 'cancelled', 'pre-cancel-refused')
      const pending = driver.post(driver.input, 'hang')
      await driver.waitReceived()
      await driver.cancel()
      assert(reply(await pending).outcome === 'unknown_effect', 'sent-cancel-unknown')
      assert(reply(await driver.post(driver.input, 'hang')).outcome === 'unknown_effect', 'cancel-no-repost')
      assert((await driver.deliveries()) === 1, 'cancel-send-boundary')
      const stats = await driver.accountingStats()
      assert(
        stats.usageFacts === 1 && stats.origins === 1 && stats.settled === '100',
        'cancel-retains-real-settlement',
      )
    }
    if (scenario === 'recover') {
      const first = await driver.post(driver.input),
        id = reply(first).result?.value?.entryId
      assert(reply(first).outcome === 'succeeded', 'posted-before-restart')
      assert(typeof id === 'string', 'entry-identity-before-restart')
      if (typeof id !== 'string') throw new Error('Billing entry identity absent')
      const refund = driver.refundInput(id),
        a = await driver.refund(refund)
      await driver.retirePrice()
      const identity = await driver.restart()
      assert(identity.previousPid !== identity.pid, 'actual-cold-process')
      assert(
        jcs(await driver.post(driver.input)) === jcs(first),
        'original-charge-and-price-after-retirement-and-restart',
      )
      assert(jcs(await driver.refund(refund)) === jcs(a), 'original-refund-after-restart')
      assert(
        reply(await driver.post({ ...driver.input, chargeKey: 'retired-price-new-charge' })).error?.code ===
          'incompatible',
        'retired-price-refuses-new-post',
      )
      const stats = await driver.accountingStats()
      assert(
        stats.usageFacts === 1 && stats.origins === 1 && stats.settled === '100',
        'cold-original-usage-and-settled-amount',
      )
      assert((await driver.deliveries()) === 2, 'cold-no-double-settlement')
    }
    if (scenario === 'dispose') {
      const pending = driver.post(driver.input, 'hang')
      await driver.waitReceived()
      await driver.stop()
      assert(reply(await pending).outcome === 'unknown_effect', 'dispose-sent-unknown')
      assert(reply(await driver.post(driver.input)).outcome === 'failed', 'disposed-post-refused')
      assert((await driver.deliveries()) === 1, 'disposed-no-new-network')
      const stats = await driver.accountingStats()
      assert(
        stats.usageFacts === 1 && stats.origins === 1 && stats.settled === '100',
        'dispose-retains-real-settlement',
      )
    }
    return checked
  } finally {
    await driver.close()
  }
}

import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { type BuildIdentity, SCENARIOS } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'
export function registerBillingContract(
  harness: ConformanceHarness,
  binding: {
    providerId: string
    providerDigest: string
    configDigest: string
    releaseSetDigest: string
    build: BuildIdentity
    command: string
    driver(scenario: ScenarioName): BillingContractDriver
  },
): void {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.billing',
      providerId: binding.providerId,
      scenario,
      qualification: 'required',
      async run() {
        let assertions: string[] = [],
          diagnostic: string | undefined
        try {
          assertions = await runBillingContractScenario(binding.driver(scenario), scenario)
        } catch (error) {
          diagnostic = error instanceof Error ? error.message : String(error)
        }
        return {
          id: `billing/${binding.providerId}/${scenario}`,
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
            scope: 'workspace',
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
