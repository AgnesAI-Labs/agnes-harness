import type { BoundService, CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { RuntimeMethodSchemaRefs } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  contextFixtureData,
  contextInline,
} from '../../../extension-api/testkit/runtime/contracts/context.js'
import { createTestServiceContainer } from '../../../extension-api/testkit/runtime/harness.js'

type Scan = (
  state: BoundService,
  request: W.StateScanRequest,
  call: CallContext,
  resolve: (ref: W.DataRef, call: CallContext) => Promise<Outcome<W.JsonValue>>,
) => Promise<Outcome<readonly { reference: W.DataRef; value: W.JsonValue }[]>>
const schemas = RuntimeMethodSchemaRefs['agh.state'].scan
async function fixture(pages: W.StateScanResult[]) {
  const { scanLoopRecoveryRecords: scan } = (await import(
    new URL('../../../../tools/acceptance/runtime/platform/loop-recovery-scan.ts', import.meta.url).href
  )) as { scanLoopRecoveryRecords: Scan }
  const data = contextFixtureData()
  const controller = new AbortController()
  const binding: W.BindingRef = {
    bindingId: 'state',
    contract: 'agh.state',
    logicalName: 'default',
    providerId: 'fixture/state',
  }
  const requirement: W.ServiceRequirement = {
    contract: 'agh.state',
    major: 1,
    logicalName: 'default',
    scope: 'run',
    features: [],
    optional: false,
  }
  const call: CallContext = { ...data.context, bindingId: binding.bindingId, signal: controller.signal }
  const request: W.StateScanRequest = {
    snapshot: {
      snapshotId: 'snapshot',
      authority: { authorityId: 'state', tenantId: 'tenant', authorityEpoch: 1 },
      sessionId: 's',
      throughSeq: 1,
      headDigest: null,
      expiresAt: call.deadline,
    },
    collection: 'records',
    filter: { runId: 'r' },
    order: 'asc',
    cursor: null,
    limit: 10,
  }
  const calls: W.ServiceQuery[] = []
  const container = createTestServiceContainer()
  container.register({
    requirement,
    binding,
    async query(query) {
      calls.push(structuredClone(query))
      const page = pages[Math.min(calls.length - 1, pages.length - 1)]
      if (!page) throw new Error('Missing page')
      return {
        ok: true,
        value: { kind: 'value', snapshot: 'snapshot', output: contextInline(schemas.output, page) },
      }
    },
  })
  const selected = container.dependencies.get(requirement)
  if (!selected.ok) throw new Error('Missing bound State')
  const resolve = async (ref: W.DataRef): Promise<Outcome<W.JsonValue>> => {
    if (ref.kind !== 'inline') throw new Error('Fixture has no blob resolver')
    return { ok: true, value: ref.value }
  }
  return {
    scan,
    state: selected.value,
    request,
    call,
    resolve,
    calls,
    data,
    controller,
    close: () => container.dependencies.close(),
  }
}
const page = (items: W.DataRef[] = []): W.StateScanResult => ({
  items,
  snapshot: 'snapshot',
  nextCursor: null,
  complete: true,
})
function refused(result: Outcome<unknown>, detail: string) {
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.detailCode).toBe(detail)
}
describe('public State scan preparation for the Loop cold consumer', () => {
  it('reads complete pages and resolves every record using the exact supplied snapshot', async () => {
    const record = contextFixtureData().config
    const f = await fixture([{ ...page([record]), complete: false, nextCursor: 'next' }, page()])
    try {
      const result = await f.scan(f.state, f.request, f.call, f.resolve)
      expect(result).toEqual({
        ok: true,
        value: [{ reference: record, value: record.kind === 'inline' ? record.value : null }],
      })
      expect(f.calls.map((call) => call.snapshot)).toEqual(['snapshot', 'snapshot'])
      expect(
        f.calls.map(
          (call) => call.input.kind === 'inline' && (call.input.value as { cursor: string | null }).cursor,
        ),
      ).toEqual([null, 'next'])
    } finally {
      await f.close()
    }
  })
  it.each(['snapshot', 'cursor', 'duplicate', 'limit'] as const)(
    'rejects %s without publishing partial records',
    async (kind) => {
      const record = contextFixtureData().config
      const pages =
        kind === 'snapshot'
          ? [{ ...page(), snapshot: 'other' }]
          : kind === 'cursor'
            ? [{ ...page(), complete: false, nextCursor: 'repeat' }]
            : kind === 'duplicate'
              ? [page([record, record])]
              : [page(Array.from({ length: 11 }, () => record))]
      const f = await fixture(pages)
      try {
        refused(
          await f.scan(f.state, f.request, f.call, f.resolve),
          kind === 'cursor'
            ? 'loop_recovery_scan_cursor'
            : kind === 'duplicate'
              ? 'loop_recovery_scan_duplicate'
              : 'loop_recovery_scan_snapshot',
        )
      } finally {
        await f.close()
      }
    },
  )
  it.each(['run', 'session', 'binding', 'collection', 'expired'] as const)(
    'rejects %s before querying State',
    async (kind) => {
      const f = await fixture([page()])
      try {
        if (kind === 'run') f.request.filter.runId = 'other'
        if (kind === 'session') f.request.snapshot.sessionId = 'other'
        if (kind === 'collection') f.request.collection = 'actions'
        if (kind === 'expired') f.request.snapshot.expiresAt = '2000-01-01T00:00:00Z'
        refused(
          await f.scan(
            f.state,
            f.request,
            kind === 'binding' ? { ...f.call, bindingId: 'other' } : f.call,
            f.resolve,
          ),
          kind === 'collection'
            ? 'loop_recovery_scan_request'
            : kind === 'expired'
              ? 'loop_recovery_scan_expired'
              : 'loop_recovery_scan_scope',
        )
        expect(f.calls).toEqual([])
      } finally {
        await f.close()
      }
    },
  )
  it('does not trust inline page data without authorized resolution and integrity', async () => {
    const f = await fixture([page()])
    try {
      refused(
        await f.scan(f.state, f.request, f.call, async () => ({ ok: true, value: {} })),
        'loop_recovery_scan_integrity',
      )
      const denied: Outcome<W.JsonValue> = {
        ok: false,
        error: {
          code: 'denied',
          detailCode: 'state_revoked',
          message: 'Denied',
          diagnosticId: 'fixture',
          retryAdvice: { kind: 'never' },
        },
      }
      expect(await f.scan(f.state, f.request, f.call, async () => denied)).toEqual(denied)
    } finally {
      await f.close()
    }
  })
  it.each(['before-read', 'during-read'] as const)(
    'handles cancellation %s without partial state',
    async (when) => {
      const f = await fixture([page()])
      try {
        let entered!: () => void
        const ready = new Promise<void>((resolve) => {
          entered = resolve
        })
        if (when === 'before-read') f.controller.abort()
        const running = f.scan(f.state, f.request, f.call, async () => {
          entered()
          return new Promise(() => {})
        })
        if (when === 'during-read') {
          await ready
          f.controller.abort()
        }
        refused(await running, 'loop_recovery_scan_cancelled')
      } finally {
        await f.close()
      }
    },
  )
})
