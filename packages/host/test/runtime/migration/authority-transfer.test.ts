import type { AuthorityTransferControl, CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AuthorityCheckpoint,
  AuthorityFence,
  AuthorityTransferProbe,
  StateAuthorityRef,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { inlineData } from '../../../src/runtime/maintenance/authority-publication.js'
import {
  createAuthorityTransferControl,
  type PublicationProbe,
  probeAuthorityTransferRecovery,
  type TransferRecoveryPlan,
  type TransferRecoveryPorts,
} from '../../../src/runtime/migration/authority-transfer.js'

const context = (): CallContext => ({
  principalRef: 'maintainer',
  scope: { kind: 'installation', installationId: 'install' },
  bindingId: 'binding',
  invocationId: 'invocation',
  deadline: '2099-01-01T00:00:00.000Z',
  traceRef: 'trace',
  authorizationRef: 'auth',
  signal: new AbortController().signal,
})
const digest = 'ab'.repeat(32)
const checkpoint = (authority: StateAuthorityRef): AuthorityCheckpoint => ({
  authorityId: authority.authorityId,
  authorityEpoch: authority.authorityEpoch,
  checkpointId: 'checkpoint',
  snapshotDigest: digest,
  recordCount: 1,
  bridgeWatermarks: [],
})
const source = (id: string): StateAuthorityRef => ({ authorityId: id, tenantId: 'tenant', authorityEpoch: 1 })
const target = (id: string): StateAuthorityRef => ({ ...source(id), authorityEpoch: 2 })
const fence = (id: string): AuthorityFence => ({
  upgradeId: 'upgrade',
  source: source(id),
  fenceId: `fence-${id}`,
  fenceEpoch: 1,
  checkpoint: checkpoint(source(id)),
  writerCredentialsRevoked: true,
})
const activated = (id: string): AuthorityTransferProbe => ({
  state: 'activated',
  cutoverId: 'cutover',
  authority: target(id),
  checkpoint: checkpoint(target(id)),
})
const imported = (id: string): AuthorityTransferProbe => ({
  state: 'imported',
  fence: fence(id),
  exportDigest: digest,
  targetCheckpoint: checkpoint(target(id)),
})
function recovery() {
  const sources: AuthorityTransferProbe[] = [
    { state: 'fenced', fence: fence('state') },
    { state: 'fenced', fence: fence('budget') },
  ]
  const targets: AuthorityTransferProbe[] = [imported('state'), imported('budget')]
  const plan: TransferRecoveryPlan = {
    upgradeId: 'upgrade',
    cutoverId: 'cutover',
    planFingerprint: digest,
    cohortDigest: digest,
    members: ['state', 'budget'].map((id, index) => ({
      source: source(id),
      target: target(id),
      sourceControl: { probe: async () => ({ ok: true, value: sources[index]! }) },
      targetControl: { probe: async () => ({ ok: true, value: targets[index]! }) },
    })),
  }
  const publication: PublicationProbe = {
    state: 'published',
    upgradeId: 'upgrade',
    cutoverId: 'cutover',
    planFingerprint: digest,
    cohortDigest: digest,
    targets: [target('state'), target('budget')],
    route: inlineData({ published: true }, 'agh.migration/route@1'),
  }
  let current: PublicationProbe = publication,
    ready = false
  const ports: TransferRecoveryPorts = {
    probePublication: async () => ({ ok: true, value: current }),
    probeReplay: async () => ({ ok: true, value: { ready } }),
  }
  return {
    plan,
    sources,
    targets,
    ports,
    publish: (value: PublicationProbe) => {
      current = value
    },
    replayReady: () => {
      ready = true
    },
  }
}

describe('authority transfer port framework (synthetic probes only)', () => {
  it('refuses every unconfigured public owner method and refuses missing maintenance authorization', async () => {
    const control = createAuthorityTransferControl({})
    const requests = {
      fence: { upgradeId: 'upgrade', expected: source('state'), cohortDigest: digest },
      export: { upgradeId: 'upgrade', fenceId: 'fence' },
      exportPage: { upgradeId: 'upgrade', fenceId: 'fence', manifestDigest: digest, cursor: null, limit: 1 },
      import: { upgradeId: 'upgrade', source: {} as never, targetLocationRef: 'target' },
      verify: {
        upgradeId: 'upgrade',
        source: {} as never,
        candidateRef: inlineData({}, 'agh.migration/candidate@1'),
      },
      activate: {
        upgradeId: 'upgrade',
        cutoverId: 'cutover',
        publishedRoute: inlineData({}, 'agh.migration/route@1'),
      },
      abort: {
        upgradeId: 'upgrade',
        expectedFenceId: 'fence',
        recoveryRoute: inlineData({}, 'agh.migration/route@1'),
      },
      probe: { upgradeId: 'upgrade' },
    }
    for (const method of Object.keys(requests) as (keyof AuthorityTransferControl)[]) {
      const invoke = control[method] as (request: unknown, context: CallContext) => Promise<Outcome<unknown>>
      const result = await invoke(requests[method], context())
      expect(!result.ok && result.error.code).toBe('incompatible')
      expect(!result.ok && result.error.detailCode).toMatch(/transfer_unavailable$/)
    }
    const selected = createAuthorityTransferControl({ source: control })
    expect(await selected.probe(requests.probe, context())).toMatchObject({
      ok: false,
      error: { detailCode: 'maintenance_authorization_unavailable' },
    })
    const cancelled = context()
    ;(cancelled as { signal: AbortSignal }).signal = AbortSignal.abort()
    expect(await selected.probe(requests.probe, cancelled)).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
  })
  it('re-probes current publication on each reopen and keeps admission closed until the whole cohort activates and intake replays', async () => {
    const state = recovery()
    expect(await probeAuthorityTransferRecovery(state.plan, undefined, context())).toMatchObject({
      ok: false,
    })
    state.publish({ state: 'source', sourceRoutesCurrent: true, recovery: null })
    expect(await probeAuthorityTransferRecovery(state.plan, state.ports, context())).toMatchObject({
      ok: true,
      value: { phase: 'validation', admission: 'closed', sourceMayReopen: false },
    })
    const published = recovery()
    expect(await probeAuthorityTransferRecovery(published.plan, published.ports, context())).toMatchObject({
      ok: true,
      value: { phase: 'cohort-activate', admission: 'closed' },
    })
    published.targets[0] = activated('state')
    expect(await probeAuthorityTransferRecovery(published.plan, published.ports, context())).toMatchObject({
      ok: true,
      value: { phase: 'cohort-activate', admission: 'closed', sourceMayReopen: false },
    })
    published.targets[1] = activated('budget')
    expect(await probeAuthorityTransferRecovery(published.plan, published.ports, context())).toMatchObject({
      ok: true,
      value: { phase: 'intake-replay', admission: 'closed' },
    })
    published.replayReady()
    expect(await probeAuthorityTransferRecovery(published.plan, published.ports, context())).toMatchObject({
      ok: true,
      value: { phase: 'admission-open', admission: 'ready' },
    })
    published.sources[1] = { state: 'absent' }
    expect(await probeAuthorityTransferRecovery(published.plan, published.ports, context())).toMatchObject({
      ok: false,
      error: { detailCode: 'source_fence_unproven' },
    })
  })
  it('requires new source epochs and a complete recovery publication; never unfreezes a partially recovered cohort', async () => {
    const state = recovery()
    const recovered = [target('state'), target('budget')]
    state.publish({
      state: 'source',
      sourceRoutesCurrent: true,
      recovery: { upgradeId: 'upgrade', planFingerprint: digest, cohortDigest: digest, sources: recovered },
    })
    state.sources[0] = { state: 'aborted', source: target('state'), restoredEpoch: 2 }
    expect(await probeAuthorityTransferRecovery(state.plan, state.ports, context())).toMatchObject({
      ok: true,
      value: { phase: 'freeze', sourceMayReopen: false, admission: 'closed' },
    })
    state.sources[1] = { state: 'aborted', source: target('budget'), restoredEpoch: 2 }
    expect(await probeAuthorityTransferRecovery(state.plan, state.ports, context())).toMatchObject({
      ok: true,
      value: { phase: 'source-recovered', sourceMayReopen: true },
    })
    state.sources[1] = { state: 'aborted', source: source('budget'), restoredEpoch: 1 }
    expect(await probeAuthorityTransferRecovery(state.plan, state.ports, context())).toMatchObject({
      ok: true,
      value: { sourceMayReopen: false },
    })
    state.targets[0] = activated('state')
    expect(await probeAuthorityTransferRecovery(state.plan, state.ports, context())).toMatchObject({
      ok: true,
      value: { phase: 'reverse-required', admission: 'closed' },
    })
  })
})
