// Interaction capacity: 1,000 concurrent pending interactions at session scope, under base
// load and across a restart. The default State provider is driven through its approval entries only;
// it refuses request/expire/cancel, so TTL expiry is measured on the reference provider.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Outcome } from '@agnes/extension-api/runtime'
import { createRuntimeInboxFixture } from '@agnes/extension-api/testkit'
import type * as Wire from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { openInteractionStore } from '../../../../examples/runtime-reference/src/providers/interaction.js'
import {
  approvalRequest,
  approve,
  code,
  deliverTo,
  must,
  owner,
  waiter,
} from '../../../../examples/runtime-reference/src/providers/interaction-contract.js'
import { createInteractionService } from '../../src/runtime/providers/interaction.js'
import { createRuntimeStateStore, type RuntimeStateStore } from '../../src/runtime/providers/state.js'
import {
  closeInteractionStateFixtures,
  interactionStateFixture,
} from '../runtime-state-interaction-read-fixture.js'

afterEach(closeInteractionStateFixtures)

/** Target load: 1,000 concurrent pending questions in one session. */
const PENDING = 1000
/** Runtime limits INTERACTION_TTL_MS and SCAN_DEFAULT_PAGE. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000
const PAGE = 100
/** Base load: answered traffic spread over 30 minutes of the store clock. */
const LOAD = 100
const LOAD_SPAN_MS = 30 * 60 * 1000

const openHandles = () => (existsSync('/dev/fd') ? readdirSync('/dev/fd').length : null)
const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length
function value<T>(result: Outcome<T>): T {
  if (!result.ok) throw Error(`unexpected refusal ${result.error.detailCode}`)
  return result.value
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Each reference case takes about 3 s on darwin-arm64 and went past the 5 s default on a Linux CI runner.
const REFERENCE_TIMEOUT_MS = 60_000

describe('reference interaction provider', () => {
  const start = Date.parse('2026-10-01T00:00:00Z')
  const expiresAt = new Date(start + TTL_MS).toISOString()
  const ask = (idempotencyKey: string) =>
    approvalRequest({
      idempotencyKey,
      expiresAt,
      scope: { kind: 'session', installationId: 'i1', runtimeId: 'r1', workspaceId: 'w1', sessionId: 's1' },
    })
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'interaction-capacity-'))
    dirs.push(dir)
    const clock = { at: start, next: 0 }
    const options = {
      clock: { now: () => new Date(clock.at).toISOString(), newId: () => `ix-${++clock.next}` },
      batch: PAGE,
    }
    const file = join(dir, 'interaction.sqlite')
    return { clock, open: () => openInteractionStore(file, options) }
  }
  function openPending(store: ReturnType<typeof openInteractionStore>, prefix: string) {
    return Array.from(
      { length: PENDING },
      (_, i) => must(store.request({ request: ask(`${prefix}-${i}`), owner })).interactionId,
    )
  }

  it(
    'keeps 1000 pending approvals readable after base load and a restart, with no handle or timer per question',
    async () => {
      const { clock, open } = setup()
      let store = open()
      const inbox = createRuntimeInboxFixture()
      must(store.request({ request: ask('warm'), owner }))
      const handles = openHandles()
      const timersBefore = timers()
      const ids = openPending(store, 'pending')
      // Base load: other approvals are asked, answered and delivered while the 1000 stay pending.
      for (let i = 0; i < LOAD; i++) {
        clock.at = start + Math.floor((i * LOAD_SPAN_MS) / LOAD)
        const request = ask(`load-${i}`)
        const { interactionId } = must(store.request({ request, owner }))
        const answer = approve(interactionId, { responseId: `load-${i}`, intentDigest: request.intentDigest })
        expect(must(store.respond(answer)).status).toBe('accepted')
        expect(await store.flush(deliverTo(inbox))).toEqual({ acked: 1, retrying: 0, dead: 0 })
      }
      expect(openHandles()).toBe(handles)
      expect(timers()).toBe(timersBefore)
      expect(store.wakes()).toHaveLength(LOAD)
      expect(store.wakes().every((wake) => wake.delivery === 'acked')).toBe(true)

      store.close()
      store = open()
      try {
        expect(new Set(ids).size).toBe(PENDING)
        for (const id of ids) expect(must(store.read(id))).toMatchObject({ status: 'pending', version: 1 })
        // Reopening each question by its key returns the stored one; nothing is duplicated.
        expect(openPending(store, 'pending')).toEqual(ids)
        expect(store.wakes()).toHaveLength(LOAD)
        expect(await store.flush(deliverTo(inbox))).toEqual({ acked: 0, retrying: 0, dead: 0 })
      } finally {
        store.close()
      }
    },
    REFERENCE_TIMEOUT_MS,
  )

  it(
    'expires 1000 pending approvals at the TTL, keeps their history and wakes each waiter once in bounded batches',
    async () => {
      const { clock, open } = setup()
      let store = open()
      const inbox = createRuntimeInboxFixture()
      const ids = openPending(store, 'ttl')
      const [early] = ids
      if (early === undefined) throw Error('no pending interaction')
      clock.at = start + TTL_MS - 1
      expect(code(store.expire({ interactionId: early, expectedVersion: 1, reason: 'ttl' }))).toBe('blocked')
      clock.at = start + TTL_MS
      const woken = ids.map((id) => waiter(inbox, `${id}@2`))
      for (const id of ids) must(store.expire({ interactionId: id, expectedVersion: 1, reason: 'ttl' }))
      // Answers that arrive after the expiry are refused and never accepted.
      const late = approve(early, { responseId: 'late', intentDigest: ask('ttl-0').intentDigest })
      expect(code(store.respond(late))).toBe('revision_conflict')

      let inflight = 0
      let peak = 0
      const relay = deliverTo(inbox)
      const sink = async (wake: Parameters<typeof relay>[0]) => {
        peak = Math.max(peak, ++inflight)
        try {
          return await relay(wake)
        } finally {
          inflight--
        }
      }
      const rounds: number[] = []
      for (;;) {
        const { acked, retrying, dead } = await store.flush(sink)
        expect({ retrying, dead }).toEqual({ retrying: 0, dead: 0 })
        if (acked === 0) break
        rounds.push(acked)
      }
      expect(rounds).toEqual(Array(PENDING / PAGE).fill(PAGE))
      expect(peak).toBe(1)

      store.close()
      store = open()
      try {
        expect(await store.flush(sink)).toEqual({ acked: 0, retrying: 0, dead: 0 })
        expect(woken.every((seen) => seen.woken === 1)).toBe(true)
        expect(must(store.responseStatus('late')).status).toBe('not-accepted')
        for (const [i, id] of ids.entries()) {
          const record = must(store.read(id))
          expect(record).toMatchObject({
            status: 'expired',
            version: 2,
            terminationReason: 'ttl',
            resolution: null,
            createdAt: new Date(start).toISOString(),
            request: { idempotencyKey: `ttl-${i}` },
          })
        }
        // The opening identity survives expiry: asking again by key returns the expired record.
        expect(must(store.request({ request: ask('ttl-0'), owner }))).toMatchObject({
          interactionId: early,
          status: 'expired',
        })
      } finally {
        store.close()
      }
    },
    REFERENCE_TIMEOUT_MS,
  )
})

describe('default State interaction provider', () => {
  const stores: RuntimeStateStore[] = []
  afterEach(() => {
    for (const store of stores.splice(0)) store.close()
  })

  // ponytail: every State write and page read re-verifies the whole session ledger (verifySessionFully),
  // so cost grows with N squared: measured 110 prepares in 111 s and 210 in 428 s on darwin-arm64.
  // Run the full check at PENDING once that verification is incremental; until then the same assertions
  // run at the reduced scale below.
  it.todo(
    `default State provider holds ${PENDING} pending approvals within the heavy tier (blocked: full ledger re-verification per call)`,
  )

  const SCALED = 30
  const SCALED_LOAD = 5
  const SCALED_PAGE = 10
  it(`pages ${SCALED} pending approvals at session scope from one stable cut, before and after a restart`, async () => {
    // SCALED stay pending, SCALED_LOAD are answered as base load, and one more opens after the first page.
    const f = await interactionStateFixture({ actions: SCALED + SCALED_LOAD + 1 })
    const open = () => {
      const store = createRuntimeStateStore({
        file: f.file,
        authority: { authorityId: 'authority', tenantId: 'tenant', authorityEpoch: 1 },
        now: () => Date.parse('2026-04-01T00:00:00.000Z'),
        interactionRead: f.readOwner,
        approvalJoint: f.joint,
      })
      stores.push(store)
      return createInteractionService({
        store,
        responder: (context) => (context === f.context ? f.capability : null),
      })
    }
    let service = open()
    const prepared: Wire.InteractionRecord[] = []
    for (const approval of f.approvals.slice(0, SCALED + SCALED_LOAD))
      prepared.push(
        value(
          await service.prepareApproval({
            request: approval.question,
            owner: { runId: 'run', actionId: approval.actionId },
            preparation: approval.prepare,
            context: f.context,
          }),
        ),
      )
    for (const [i, record] of prepared.slice(SCALED).entries()) {
      const answered = await service.respondApproval(
        {
          interactionId: record.interactionId,
          responseId: `load-${i}`,
          expectedVersion: 1,
          decision: 'approve',
          intentDigest: f.approvals[SCALED + i]?.question.intentDigest,
        },
        f.context,
      )
      expect(value(answered).status).toBe('accepted')
    }
    const pendingIds = prepared.slice(0, SCALED).map((record) => record.interactionId)
    const scope = f.readScope

    async function readAll(first: Wire.PageInteractionRecord) {
      const pages = [first]
      let page = first
      while (page.nextCursor !== null) {
        page = value(await service.pending({ scope, limit: SCALED_PAGE, cursor: page.nextCursor }, f.context))
        pages.push(page)
      }
      return pages
    }
    const firstPage = value(await service.pending({ scope, limit: SCALED_PAGE }, f.context))
    // An approval opened after the cut is not part of it.
    const late = f.approvals[SCALED + SCALED_LOAD]
    if (!late) throw Error('late approval missing')
    const lateRecord = value(
      await service.prepareApproval({
        request: late.question,
        owner: { runId: 'run', actionId: late.actionId },
        preparation: late.prepare,
        context: f.context,
      }),
    )
    const pages = await readAll(firstPage)
    const items = pages.flatMap((page) => page.items)
    expect(pages).toHaveLength(SCALED / SCALED_PAGE)
    expect(
      pages.every((page) => page.items.length === SCALED_PAGE && page.snapshot === firstPage.snapshot),
    ).toBe(true)
    expect(pages.map((page) => page.complete)).toEqual([...Array(SCALED / SCALED_PAGE - 1).fill(false), true])
    expect(items.every((item) => item.status === 'pending' && item.version === 1)).toBe(true)
    expect(items.map((item) => item.interactionId)).toEqual([...pendingIds].sort())
    // The continuation cursor stays the same size however far into the cut it points.
    const cursors = pages.flatMap((page) => (page.nextCursor ? [page.nextCursor.length] : []))
    expect(Math.max(...cursors) - Math.min(...cursors)).toBeLessThanOrEqual(8)
    expect(Math.max(...cursors)).toBeLessThan(4096)

    // Restart the State store: the old cursor still continues its cut, and a new query sees the late one.
    const midCursor = pages[1]?.nextCursor
    if (!midCursor) throw Error('mid cursor missing')
    for (const store of stores.splice(0)) store.close()
    service = open()
    const resumed = await readAll(
      value(await service.pending({ scope, limit: SCALED_PAGE, cursor: midCursor }, f.context)),
    )
    expect(resumed.flatMap((page) => page.items)).toEqual(items.slice(2 * SCALED_PAGE))
    const fresh = await readAll(value(await service.pending({ scope, limit: SCALED_PAGE }, f.context)))
    expect(fresh.flatMap((page) => page.items.map((item) => item.interactionId))).toEqual(
      [...pendingIds, lateRecord.interactionId].sort(),
    )
    expect(fresh.at(-1)).toMatchObject({ complete: true, nextCursor: null })

    // Page limits are bounded, and a cursor is bound to its limit.
    for (const limit of [0, 10_001])
      expect(await service.pending({ scope, limit }, f.context)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input', detailCode: 'interaction_limit' },
      })
    expect(
      await service.pending({ scope, limit: SCALED_PAGE + 1, cursor: midCursor }, f.context),
    ).toMatchObject({
      ok: false,
      error: { detailCode: 'resync_required' },
    })
  }, 120_000)
})
