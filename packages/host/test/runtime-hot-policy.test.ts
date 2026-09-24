import { Context } from '@agnes/cordis'
import type { CurrentSessionRuntime } from '@agnes/core'
import { buildRuntimeTarget, createPluginRow, normalizePluginExport } from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import { readCreditsPerUsd } from '../src/assemble/provider.js'
import { toPresetView } from '../src/presets/view.js'
import type { ResolvedProfile } from '../src/profile/types.js'
import {
  applyHotPolicySnapshot,
  approvalTicketRevision,
  bindApprovalTicket,
  businessLimit,
  commandHookInvocationSnapshot,
  createHotPolicyFacade,
  HOT_POLICY_ROWS,
} from '../src/profile-policy.js'
import { PublicationDispatch } from '../src/publication-dispatch.js'
import { PublicationGate } from '../src/publication-gate.js'
import {
  type IsolatedSessionOverlay,
  isolateHotPolicyServices,
  isolateSessionOverlay,
  syncHotPolicyFromTarget,
} from '../src/runtime-hot-policy.js'
import { RuntimePluginCatalogue } from '../src/runtime-plugin-catalogue.js'
import { RuntimeTargetPublisher } from '../src/runtime-target-publisher.js'

const revision = 'a'.repeat(64)

function policyRow(id: (typeof HOT_POLICY_ROWS)[number], config: unknown, mountRevision = 'policy-rev-1') {
  return createPluginRow({
    id,
    plugin: `builtin:host/${id}`,
    snapshotDigest: 'builtin:host:v1',
    exportName: id,
    entryRevision: 'host-row:v1',
    extrasRevision: 'none',
    mountRevision,
    config,
  })
}

describe('hot policy publisher snapshot consumers', () => {
  it('isolates each hot-policy service under one overlay label', () => {
    const root = new Context()
    const label = Symbol('overlay:session-a:coding')
    const isolated = isolateHotPolicyServices(root, label)
    for (const row of HOT_POLICY_ROWS) {
      expect(isolated[Context.isolate][row]).toBe(label)
      expect(root[Context.isolate][row]).toBeUndefined()
    }
    const overlay = isolateSessionOverlay(root, 'session-a', 'coding')
    expect(overlay.preset).toBe('coding')
    for (const row of HOT_POLICY_ROWS) expect(overlay.isolated[Context.isolate][row]).toBeDefined()
  })

  it('syncs publisher snapshots into ticket, hook, drain and business-limit consumers', async () => {
    const facade = createHotPolicyFacade()
    const claims = HOT_POLICY_ROWS.map((id) => {
      const row = policyRow(
        id,
        id === 'policy:business-limits' ? { 'approval.park': 1, 'cost.credits_per_usd': 4 } : { id },
        `${id}:r1`,
      )
      return Object.freeze({ row, entry: normalizePluginExport(() => undefined) })
    })
    const target = buildRuntimeTarget({
      rows: claims.map((claim) => claim.row),
      resources: { mcp: [], skills: {} },
      resourceRevision: revision,
      compositeRevision: revision,
    })
    const publication = new PublicationGate()
    const publisher = new RuntimeTargetPublisher<{ revision: string }, IsolatedSessionOverlay>({
      catalogue: new RuntimePluginCatalogue([]),
      publication,
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: { create: (input) => ({ revision: input.target.compositeRevision }) },
      staticClaims: (published) =>
        published.tree.rows
          .filter((row) => (HOT_POLICY_ROWS as readonly string[]).includes(row.id))
          .map((row) => Object.freeze({ row, entry: normalizePluginExport(() => undefined) })),
      onPublished: (published) => syncHotPolicyFromTarget(facade, published),
    })
    await publisher.apply(target)
    expect(bindApprovalTicket(facade, 'ticket-1')).toBe('policy:approvals:r1')
    expect(commandHookInvocationSnapshot(facade).revision).toBe('policy:command-hooks:r1')
    expect(businessLimit(facade, 'approval.park')).toBe(1)
    expect(businessLimit(facade, 'cost.credits_per_usd')).toBe(4)
    const view = toPresetView({ name: 'coding' }, { park: businessLimit(facade, 'approval.park') })
    expect(view.approval.onUnavailable).toBe('park')
    expect(
      readCreditsPerUsd({ limits: {} } as ResolvedProfile, businessLimit(facade, 'cost.credits_per_usd')),
    ).toBe(4)
    const dispatch = new PublicationDispatch(publication, facade)
    let releaseHeld = () => {}
    const hold = new Promise<void>((resolve) => {
      releaseHeld = resolve
    })
    const held = dispatch.ordinary(() => async () => {
      await hold
      return 'held'
    })
    await Promise.resolve()
    await Promise.resolve()
    applyHotPolicySnapshot(facade, 'policy:capabilities', { revision: 'policy:capabilities:r2', value: [] })
    await expect(dispatch.ordinary(() => () => 'denied')).rejects.toThrow(/E_POLICY_DRAIN/)
    expect(facade.current.get('policy:capabilities')?.revision).toBe('policy:capabilities:r1')
    releaseHeld()
    await expect(held).resolves.toBe('held')
    expect(facade.current.get('policy:capabilities')?.revision).toBe('policy:capabilities:r2')
    const root = new Context()
    await publisher.setSessionScope('session-a', { preset: 'coding' }, async () => {
      const overlay = isolateSessionOverlay(root, 'session-a', 'coding')
      return {
        desired: { preset: overlay.preset },
        overlay,
        runtime: {} as CurrentSessionRuntime,
        close: () => undefined,
      }
    })
    const stored = publisher.current().value.sessionScopes.get('session-a')?.overlay
    expect(stored?.preset).toBe('coding')
    for (const row of HOT_POLICY_ROWS) expect(stored?.isolated[Context.isolate][row]).toBeDefined()
    expect(approvalTicketRevision(facade, 'ticket-1')).toBe('policy:approvals:r1')
    await publisher.close()
  })

  it('refuses process-static business-limits keys on publisher apply', async () => {
    const claims = [
      policyRow(
        'policy:business-limits',
        { 'lease.ttl_ms': 1, 'approval.park': 1 },
        'policy:business-limits:r1',
      ),
    ]
    const target = buildRuntimeTarget({
      rows: claims,
      resources: { mcp: [], skills: {} },
      resourceRevision: revision,
      compositeRevision: revision,
    })
    const publisher = new RuntimeTargetPublisher<{ revision: string }>({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: { create: (input) => ({ revision: input.target.compositeRevision }) },
      staticClaims: () =>
        claims.map((row) => Object.freeze({ row, entry: normalizePluginExport(() => undefined) })),
    })
    await expect(publisher.apply(target)).rejects.toThrow(/E_STATIC_COMPONENT/)
    await publisher.close()
  })
})
