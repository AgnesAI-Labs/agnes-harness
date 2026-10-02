import type {
  CallContext,
  FactoryContext,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  type ActionFrame,
  type AuditAppend,
  type DataRef,
  type EffectResult,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { ScenarioName } from '../evidence.js'

export type AuditContractInstance = {
  readonly factory: ProviderFactory<ServiceProvider>
  readonly configuration: DataRef
  readonly dependencies: ScopedDependencies
  readonly factoryContext: FactoryContext
  readonly call: CallContext
  readonly append: AuditAppend
  readonly appendInput: DataRef
  readonly exportFrame: ActionFrame
  actionContext(call: CallContext): import('@agnes/extension-api/runtime').ActionContext
  wrongCall(): CallContext
  restart(): Promise<AuditContractInstance>
  archiveDeliveries(): number
}
export type AuditContractDriver = { open(): Promise<AuditContractInstance>; close(): Promise<void> }
export type AuditContractAssertion = { readonly id: string; readonly passed: boolean }

/** Public provider contract; every scenario drives the actual factory/control/action surface. */
export async function runAuditContractScenario(
  driver: AuditContractDriver,
  scenario: ScenarioName,
): Promise<readonly AuditContractAssertion[]> {
  const results: AuditContractAssertion[] = []
  const assert = (id: string, passed: boolean) => {
    results.push({ id, passed })
    if (!passed) throw new Error(`Audit contract assertion failed: ${id}`)
  }
  let fixture = await driver.open()
  let service = await fixture.factory.create(
    fixture.configuration,
    fixture.dependencies,
    fixture.factoryContext,
  )
  const operation = () => ({
    target: {
      bindingId: fixture.factoryContext.bindingId,
      contract: 'agh.audit',
      logicalName: fixture.factory.descriptor.logicalName,
      providerId: fixture.factory.descriptor.providerId,
    },
    method: 'append',
    input: fixture.appendInput,
  })
  const append = async () => {
    assert('append-control-present', typeof service.control === 'function')
    const result = await service.control?.(operation(), fixture.call)
    assert('append-accepted', result?.ok === true)
    if (!result?.ok || result.value.kind !== 'inline') throw new Error('Audit append result missing')
    assert(
      'append-output-schema',
      result.value.schema.digest === RuntimeMethodSchemaRefs['agh.audit'].append.output.digest &&
        validateRuntime('AuditAppendResult', result.value.value).ok,
    )
    return result.value
  }
  const exportAction = async () => {
    const action = await service.actions?.export?.create({
      instanceId: fixture.factoryContext.instanceId,
      actionId: fixture.exportFrame.actionId,
      runId: fixture.exportFrame.runId,
      bindingId: fixture.factoryContext.bindingId,
      scope: fixture.factoryContext.scope,
      signal: fixture.call.signal,
    })
    assert('managed-export-action-present', action?.kind === 'leaf')
    if (action?.kind !== 'leaf') throw new Error('audit action missing')
    return action
  }
  try {
    if (scenario === 'select') {
      const checked = validateRuntime('ProviderDescriptor', fixture.factory.descriptor)
      if (!checked.ok) throw new Error(JSON.stringify(checked.errors))
      assert('descriptor-exact', checked.ok)
      assert('audit-contract', fixture.factory.descriptor.contract === 'agh.audit')
      assert(
        'append-export-kinds',
        fixture.factory.descriptor.operations.some((x) => x.method === 'append' && x.kind === 'control') &&
          fixture.factory.descriptor.operations.some((x) => x.method === 'export' && x.kind === 'action'),
      )
      assert('ready', (await service.ready(fixture.call)).ok)
    } else if (scenario === 'normal') {
      const first = await append(),
        second = await append()
      assert('same-identity-original-receipt', jcs(first) === jcs(second))
      const action = await exportAction()
      const result: EffectResult = await action.execute(
        fixture.exportFrame,
        fixture.actionContext(fixture.call),
      )
      assert('export-succeeded', result.outcome === 'succeeded')
      assert(
        'export-schema',
        result.result?.kind === 'inline' && validateRuntime('AuditExportResult', result.result.value).ok,
      )
      assert('actual-egress-one', fixture.archiveDeliveries() === 1)
      await action.close('completed')
    } else if (scenario === 'deny') {
      const result = await service.control?.(operation(), fixture.wrongCall())
      assert('untrusted-context-denied', result?.ok === false && result.error.code === 'denied')
      const deniedCall = fixture.wrongCall()
      const { signal: _signal, ...wire } = deniedCall
      const action = await exportAction()
      const deniedExport = await action.execute(
        { ...fixture.exportFrame, context: wire },
        fixture.actionContext(deniedCall),
      )
      assert(
        'untrusted-export-denied',
        deniedExport.outcome === 'failed' && deniedExport.error?.code === 'denied',
      )
      await action.close('completed')
      assert('denial-no-egress', fixture.archiveDeliveries() === 0)
    } else if (scenario === 'cancel') {
      const abort = new AbortController()
      abort.abort()
      const call = { ...fixture.call, signal: abort.signal }
      const result = await service.control?.(operation(), call)
      assert('cancel-no-append', result?.ok === false)
      const action = await exportAction()
      const cancelledExport = await action.execute(fixture.exportFrame, fixture.actionContext(call))
      assert('cancel-no-export', cancelledExport.outcome === 'cancelled')
      await action.close('completed')
      assert('cancel-no-egress', fixture.archiveDeliveries() === 0)
    } else if (scenario === 'recover') {
      const first = await append()
      const oldInvocation = fixture.call.invocationId
      const originalAction = await exportAction()
      const originalExport = await originalAction.execute(
        fixture.exportFrame,
        fixture.actionContext(fixture.call),
      )
      assert('original-export-accepted', originalExport.outcome === 'succeeded')
      await originalAction.close('completed')
      await service.close('shutdown')
      fixture = await fixture.restart()
      service = await fixture.factory.create(
        fixture.configuration,
        fixture.dependencies,
        fixture.factoryContext,
      )
      assert('new-invocation-after-restart', fixture.call.invocationId !== oldInvocation)
      const second = await append()
      const recoveredAction = await exportAction()
      const recoveredExport = await recoveredAction.execute(
        fixture.exportFrame,
        fixture.actionContext(fixture.call),
      )
      assert('cold-export-original-receipt', jcs(originalExport) === jcs(recoveredExport))
      assert('cold-export-no-resend', fixture.archiveDeliveries() === 1)
      await recoveredAction.close('completed')
      assert('cold-restart-original-receipt', jcs(first) === jcs(second))
    } else if (scenario === 'dispose') {
      const disposedAction = await exportAction()
      await service.close('shutdown')
      const disposedExport = await disposedAction.execute(
        fixture.exportFrame,
        fixture.actionContext(fixture.call),
      )
      assert('disposed-no-export', disposedExport.outcome === 'failed')
      await disposedAction.close('shutdown')
      const result = await service.control?.(operation(), fixture.call)
      assert('disposed-no-append', result?.ok === false)
      assert('dispose-no-egress', fixture.archiveDeliveries() === 0)
    }
    return results
  } finally {
    await service.close('shutdown')
    await driver.close()
  }
}

import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import type { BuildIdentity } from '../evidence.js'
import { SCENARIOS } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'

export type AuditConformanceBinding = {
  readonly providerId: string
  readonly providerDigest: string
  readonly build: BuildIdentity
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly consumer: string
  readonly command: string
  driver(): AuditContractDriver
}
/** Registration records the actual suite outcome, preserving failed/missing implementations. */
export function registerAuditContract(harness: ConformanceHarness, binding: AuditConformanceBinding): void {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.audit',
      providerId: binding.providerId,
      scenario,
      qualification: 'required',
      async run() {
        let results: readonly AuditContractAssertion[] = []
        let passed = false
        try {
          results = await runAuditContractScenario(binding.driver(), scenario)
          passed = results.length > 0 && results.every((row) => row.passed)
        } catch {
          passed = false
        }
        return {
          id: `audit/${scenario}/${binding.providerId}`,
          providerDigest: binding.providerDigest,
          recipe: 'durable-audit-public-provider',
          features: [],
          build: binding.build,
          consumer: binding.consumer,
          command: binding.command,
          status: passed ? 'passed' : 'failed',
          configDigest: binding.configDigest,
          releaseSetDigest: binding.releaseSetDigest,
          attachmentDigest: canonicalJsonDigest(results.map((row) => ({ id: row.id, passed: row.passed }))),
          fixture: null,
          sharedEvidenceId: null,
          reuse: {
            scope: 'workspace',
            methodKind: scenario === 'select' ? 'descriptor' : 'control+action',
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
