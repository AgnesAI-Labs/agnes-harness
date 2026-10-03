import { registerBillingContract } from '../../../../packages/extension-api/testkit/runtime/contracts/billing.js'
import { registerTraceContract } from '../../../../packages/extension-api/testkit/runtime/contracts/trace.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { billingTraceProviderDigest } from '../../../../packages/host/test/runtime/billing-trace-fixture.js'
import {
  billingContractDriver,
  traceContractDriver,
} from '../../../../packages/host/test/runtime/billing-trace-process.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'
import { getConformanceBuildIdentity } from '../build-identity.js'
import type { ConformanceBindRequest } from '../run-conformance.js'

export async function bindConformance(harness: ConformanceHarness, request: ConformanceBindRequest) {
  const contracts = ['agh.billing', 'agh.trace'].filter(
    (c) => request.contracts === 'all' || request.contracts.includes(c),
  )
  const providers = request.providers.filter((p) => p === 'default' || p === 'reference')
  if (!contracts.length) return { contracts, providers }
  const build = getConformanceBuildIdentity()
  for (const kind of providers as ('default' | 'reference')[]) {
    for (const contract of contracts) {
      const name = contract === 'agh.trace' ? 'trace' : 'billing'
      const binding = {
        providerId: kind,
        providerDigest: billingTraceProviderDigest(kind, name),
        configDigest: canonicalJsonDigest({
          kind,
          contract,
          peer: 'synthetic-loopback',
          ports: 'restricted-effects',
        }),
        releaseSetDigest: build.buildDigest,
        build,
        command: request.command,
      }
      if (contract === 'agh.trace')
        registerTraceContract(harness, {
          ...binding,
          driver: (scenario) => traceContractDriver(kind, scenario),
        })
      else
        registerBillingContract(harness, {
          ...binding,
          driver: (scenario) => billingContractDriver(kind, scenario),
        })
    }
  }
  return { contracts, providers }
}
