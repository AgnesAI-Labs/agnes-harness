import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  type BudgetReserveRequest,
  canonicalJsonDigest,
  type DomainObjectRef,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  type BudgetFundingEvent,
  type BudgetFundingSource,
  fundingDigest,
  fundingGraph,
  verifiedFunding,
} from '../../../src/runtime/budget/funding.js'
import {
  type BudgetAccount,
  BudgetAuthorityFault,
  type BudgetStore,
  createBudgetReservations,
} from '../../../src/runtime/budget/reservations.js'
import { budgetContext } from './budget-authority.js'
import { budgetCorrectionFixture } from './budget-correction-authority.js'

/** Restricted original source issuer and immutable event verifier in the existing SQLite owner. */
export function budgetFundingFixture(path?: string, options: { exclusiveCap?: string } = {}) {
  const base = budgetCorrectionFixture(path)
  base.db.exec(
    'CREATE TABLE IF NOT EXISTS funding_sources(kind TEXT,key TEXT,body TEXT,PRIMARY KEY(kind,key)); CREATE TABLE IF NOT EXISTS funding_events(seq INTEGER PRIMARY KEY,body TEXT,digest TEXT)',
  )
  const get = <T>(kind: string, key: string): T | undefined => {
    const r = base.db.prepare('SELECT body FROM funding_sources WHERE kind=? AND key=?').get(kind, key) as
      | { body: string }
      | undefined
    return r ? (JSON.parse(r.body) as T) : undefined
  }
  const add = (kind: string, key: string, value: unknown) => {
    const body = jcs(value),
      old = get(kind, key)
    if (old !== undefined) {
      if (jcs(old) !== body) throw new Error('Immutable funding source changed')
      return
    }
    base.db.prepare('INSERT INTO funding_sources VALUES(?,?,?)').run(kind, key, body)
  }
  if (!get('graph', 'root')) {
    const root = base.tx.account('root')!,
      leaf = base.tx.account('leaf')!,
      other = { ...leaf, cap: options.exclusiveCap ?? leaf.cap, ref: { ...leaf.ref, id: 'other-leaf' } }
    base.put('account', 'root', { ...root, cap: '100' })
    base.put('account', 'other-leaf', other)
    for (const id of ['root', 'leaf', 'other-leaf']) add('graph', id, fundingGraph([base.tx.account(id)!])[0])
  }
  type Action = { attemptId: string; accountIds: string[]; scopeIds: string[]; parentActionId: string | null }
  const fail = (msg: string): never => {
    throw new BudgetAuthorityFault('integrity', msg)
  }
  const heads = () => {
    const result = new Map<string, BudgetFundingSource>(),
      rows = base.db.prepare('SELECT seq,body,digest FROM funding_events ORDER BY seq').all() as {
        seq: number
        body: string
        digest: string
      }[]
    let seq = 0
    for (const row of rows) {
      if (row.seq !== ++seq) fail('Original funding event sequence gap')
      const event = JSON.parse(row.body) as BudgetFundingEvent
      if (fundingDigest(event) !== row.digest || jcs(event) !== row.body)
        fail('Original funding event full bytes differ')
      if (
        !event.snapshots.length ||
        new Set(event.previous.map((p) => p.ref.id)).size !== event.previous.length ||
        event.previous.length !== event.snapshots.length
      )
        fail('Incomplete funding heads')
      for (const p of event.previous)
        if ((result.get(p.ref.id)?.eventDigest ?? null) !== p.digest)
          fail('Original funding event CAS chain differs')
      const reserve = validateRuntime('BudgetReserveRequest', event.input),
        settle = validateRuntime('BudgetSettleRequest', event.input),
        reconcile = validateRuntime('BudgetReconcileRequest', event.input)
      if (reserve.ok) {
        const actionId =
            'existingActionId' in reserve.value.actionRef
              ? reserve.value.actionRef.existingActionId
              : fail('Original Action missing'),
          action = get<Action>('action', actionId) ?? fail('Original Action source missing')
        if (
          action.attemptId !== reserve.value.attemptId ||
          canonicalJsonDigest({ action, mode: 'cost-hard' }) !== event.sourceDigest
        )
          fail('Original Action issuance differs')
        if (reserve.value.parentReservationRef !== null) {
          const original = result.get(reserve.value.parentReservationRef.id)
          if (
            !original ||
            original.snapshot.state.reservation.actionId !== action.parentActionId ||
            fundingDigest(original.snapshot.state.reservation.ref) !==
              fundingDigest(reserve.value.parentReservationRef)
          )
            fail('Original Action parent relationship differs')
        } else if (action.parentActionId !== null) fail('Child issuance discarded funding parent')
      } else if (settle.ok) {
        const proof = base.get<{ input: unknown }>('verified-charge', event.sourceDigest)
        if (!proof || jcs(proof.input) !== jcs(settle.value)) fail('Original Usage issuance differs')
      } else if (reconcile.ok) {
        const proof = base.get<{ value: { sourceDigest: string }; reference: unknown }>(
          'reconciliation-proof',
          canonicalJsonDigest(reconcile.value.evidenceRef),
        )
        if (
          !proof ||
          jcs(proof.reference) !== jcs(reconcile.value.evidenceRef) ||
          proof.value.sourceDigest !== event.sourceDigest
        )
          fail('Original terminal source issuance differs')
      } else fail('Original funding input is not an actual Budget method')
      for (const snapshot of event.snapshots) {
        const action = get<Action>('action', snapshot.state.reservation.actionId)
        if (
          !action ||
          fundingDigest(action.accountIds) !== fundingDigest(snapshot.state.accountIds) ||
          canonicalJsonDigest({ action, mode: 'cost-hard' }) !== snapshot.admissionSourceDigest
        )
          fail('Snapshot changes original admission')
        for (const node of snapshot.graph)
          if (fundingDigest(node) !== fundingDigest(get('graph', node.ref.id)))
            fail('Original graph issuance differs')
        const source = { eventDigest: row.digest, event, snapshot }
        verifiedFunding(source, snapshot.state)
        result.set(snapshot.state.reservation.ref.id, source)
      }
    }
    return result
  }
  const originalCheck = base.tx.assertCurrent.bind(base.tx)
  let active: { context: CallContext; wire: string; signal: AbortSignal } | undefined
  const wire = (context: CallContext) => {
    const { signal: _, ...value } = context
    return fundingDigest(value)
  }
  const check = (context: CallContext) => {
    originalCheck(context)
    if (
      context.principalRef !== budgetContext.principalRef ||
      context.bindingId !== budgetContext.bindingId ||
      context.authorizationRef !== budgetContext.authorizationRef ||
      fundingDigest(context.scope) !== fundingDigest(budgetContext.scope) ||
      (active &&
        (active.context !== context ||
          active.wire !== wire(context) ||
          active.signal !== context.signal ||
          active.signal.aborted))
    )
      throw new BudgetAuthorityFault('denied', 'Actual complete funding reader qualification differs')
  }
  const final = () => {
    if (!active) fail('Funding transaction fence missing')
    check(active!.context)
  }
  base.beforeCommit(final)
  const store: BudgetStore = {
    transaction: (ctx, body) => {
      const previous = active
      active = { context: ctx, wire: wire(ctx), signal: ctx.signal }
      try {
        check(ctx)
        return base.store.transaction(ctx, (tx) =>
          body({
            ...tx,
            assertCurrent: check,
            authorizeExisting: (reference, context) => {
              check(context)
              tx.authorizeExisting(reference, context)
            },
            authorizeReserve: (input, context) => {
              check(context)
              const admitted = tx.authorizeReserve(input, context),
                action = get<Action>('action', admitted.actionId)
              if (!action || jcs(action) !== jcs(base.get('action', admitted.actionId)))
                throw new BudgetAuthorityFault('denied', 'Actual funding Action issuance unavailable')
              const live = fundingGraph(
                action.accountIds.map((id) => tx.account(id) ?? fail('Actual graph missing')),
              )
              for (const node of live)
                if (fundingDigest(node) !== fundingDigest(get('graph', node.ref.id)))
                  throw new BudgetAuthorityFault('denied', 'Actual graph changed')
              return admitted
            },
            verifyFundingAdmission: (input, child, parent, context) => {
              check(context)
              const action = get<Action>('action', child.actionId),
                childGraph = fundingGraph(
                  child.accountIds.map((id) => tx.account(id) ?? fail('Actual graph missing')),
                )
              if (
                !action ||
                action.parentActionId !== parent.state.reservation.actionId ||
                input.parentReservationRef === null ||
                fundingDigest(input.parentReservationRef) !== fundingDigest(parent.state.reservation.ref)
              )
                throw new BudgetAuthorityFault('denied', 'Actual child-parent Action source missing')
              return {
                sourceDigest: fundingDigest({ action, parent: parent.admissionSourceDigest }),
                childActionId: child.actionId,
                parentActionId: action.parentActionId,
                parentReservationRef: parent.state.reservation.ref,
                parentGraphDigest: fundingDigest(parent.graph),
                childGraphDigest: fundingDigest(childGraph),
                admissionSourceDigest: child.sourceDigest,
              }
            },
            latestFunding: (ref) => {
              const found = heads().get(ref.id)
              if (found && fundingDigest(found.snapshot.state.reservation.ref) !== fundingDigest(ref))
                fail('Funding fullref changed')
              return found
            },
            appendFundingEvent: (event) => {
              const before = heads()
              for (const p of event.previous)
                if ((before.get(p.ref.id)?.eventDigest ?? null) !== p.digest)
                  throw new BudgetAuthorityFault('conflict', 'Funding append original heads CAS differs')
              for (const snapshot of event.snapshots)
                if (
                  fundingDigest(tx.reservation(snapshot.state.reservation.ref.id)) !==
                  fundingDigest(snapshot.state)
                )
                  fail('Funding event does not describe actual after-image')
              for (const account of event.accounts)
                if (fundingDigest(tx.account(account.ref.id)) !== fundingDigest(account))
                  fail('Funding event changes actual account after-image')
              const digest = fundingDigest(event)
              base.db.prepare('INSERT INTO funding_events(body,digest) VALUES(?,?)').run(jcs(event), digest)
              heads()
              return digest
            },
          }),
        )
      } finally {
        active = previous
      }
    },
  }
  const addAction = (name: string, leaf = 'leaf', parentActionId: string | null = null) => {
    const accountIds: string[] = [],
      seen = new Set<string>()
    let id: string | null = leaf
    while (id !== null) {
      if (seen.has(id)) fail('Original graph cycle')
      seen.add(id)
      accountIds.push(id)
      const node: { parentId: string | null } =
        get<{ parentId: string | null }>('graph', id) ?? fail('Original graph missing')
      id = node.parentId
    }
    const action: Action = {
      attemptId: `attempt-${name}`,
      accountIds,
      scopeIds: ['session-s', 'runtime-r'],
      parentActionId,
    }
    add('action', name, action)
    base.put('action', name, action)
  }
  return {
    ...base,
    beforeCommit: (fn: () => void) =>
      base.beforeCommit(() => {
        fn()
        final()
      }),
    store,
    operations: createBudgetReservations(store),
    addAction,
    head: (reference: DomainObjectRef) => heads().get(reference.id),
    events: () =>
      base.db.prepare('SELECT seq,body,digest FROM funding_events ORDER BY seq').all() as {
        seq: number
        body: string
        digest: string
      }[],
    request: (
      name: string,
      units: string,
      cost: string | null,
      parent: DomainObjectRef | null = null,
    ): BudgetReserveRequest => {
      const action = get<Action>('action', name) ?? fail('Action issuance missing')
      return {
        actionRef: { existingActionId: name },
        attemptId: action.attemptId,
        accountRef: base.tx.account(action.accountIds[0]!)!.ref,
        unitsByKind: [{ unit: 'token', value: units }],
        maxCost: cost === null ? null : { currency: 'EUR', scale: 6, units: cost },
        priceVersion: cost === null ? null : 'price-v1',
        parentReservationRef: parent,
      }
    },
  }
}
