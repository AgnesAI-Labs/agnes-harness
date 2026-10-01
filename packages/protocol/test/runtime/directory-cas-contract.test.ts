import { describe, expect, it } from 'vitest'
import { RuntimeMethodSchemaRefs, RuntimeServiceCatalog, validateRuntime } from '../../src/runtime/index.js'

const digest = 'a'.repeat(64)
const authority = { authorityId: 'directory', tenantId: 'tenant', authorityEpoch: 2 }
const checkpoint = {
  authorityId: 'state',
  authorityEpoch: 2,
  checkpointId: 'checkpoint',
  snapshotDigest: digest,
  recordCount: 0,
  bridgeWatermarks: [],
}
const route = {
  logicalAuthorityId: 'state',
  tenantId: 'tenant',
  authorityEpoch: 2,
  providerBinding: {
    bindingId: 'binding',
    contract: 'agh.state',
    logicalName: 'default',
    providerId: 'provider',
  },
  locationRef: 'location',
  cohortDigest: digest,
  cutoverId: 'cutover',
  checkpoint,
  previous: null,
}
const publication = {
  upgradeId: 'upgrade',
  cutoverId: 'cutover',
  changes: [{ expectedRevision: 1, previous: route, next: { ...route, authorityEpoch: 3 } }],
  sourceFences: [],
  validationRef: {
    kind: 'inline',
    schema: { typeId: 'example/proof@1', revision: 1, digest },
    value: {},
    digest,
    bytes: 2,
  },
  jointDispatchMappings: [],
}

describe('authority directory CAS wire contract', () => {
  it('publishes exact maintenance method identities and closed request/result schemas', () => {
    const method = RuntimeServiceCatalog['agh.authority-directory'].methods.compareAndSwap
    expect(method.kind).toBe('maintenance')
    expect(RuntimeMethodSchemaRefs['agh.authority-directory'].compareAndSwap.input.typeId).toBe(
      'agh.authority-directory/compareAndSwap.request@1',
    )
    const request = { transactionId: 'cutover', authority, expectedWriterEpoch: 1, publication }
    expect(validateRuntime('AuthorityDirectoryCompareAndSwapRequest', request).ok).toBe(true)
    expect(
      validateRuntime('AuthorityDirectoryCompareAndSwapRequest', {
        ...request,
        publication: { ...publication, changes: [] },
      }).ok,
    ).toBe(false)
    expect(
      validateRuntime('AuthorityDirectoryCompareAndSwapRequest', { ...request, expectedWriterEpoch: -0 }).ok,
    ).toBe(false)
    const result = {
      transactionId: 'cutover',
      cutoverId: 'cutover',
      routes: [{ logicalAuthorityId: 'state', revision: 2, authorityEpoch: 3 }],
    }
    expect(validateRuntime('AuthorityDirectoryCompareAndSwapResult', result).ok).toBe(true)
    expect(validateRuntime('AuthorityDirectoryCompareAndSwapResult', { ...result, routes: [] }).ok).toBe(
      false,
    )
    expect(validateRuntime('AuthorityDirectoryCompareAndSwapResult', { ...result, hidden: true }).ok).toBe(
      false,
    )
  })
})
