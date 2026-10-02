import type { ProviderFactory, ServiceProvider } from '@agnes/extension-api/runtime'
import type {
  AuditConformanceBinding,
  AuditContractDriver,
  ConformanceHarness,
} from '@agnes/extension-api/testkit'
import { registerAuditContract, runAuditContractScenario } from '@agnes/extension-api/testkit'
import {
  createReferenceAuditFactory,
  openReferenceAuditStore,
  type ReferenceAuditDeployment,
} from './index.js'

export function auditPublicConsumer(
  harness: ConformanceHarness,
  binding: AuditConformanceBinding,
  driver: AuditContractDriver,
  deployment: ReferenceAuditDeployment,
) {
  const factory: ProviderFactory<ServiceProvider> = createReferenceAuditFactory(deployment)
  registerAuditContract(harness, binding)
  return { factory, scenario: runAuditContractScenario(driver, 'normal'), store: openReferenceAuditStore }
}
