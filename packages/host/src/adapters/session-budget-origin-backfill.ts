import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { CoreError, canonicalJson, type IntegrityRow, verifyIntegrityRows } from '@agnes/core'

export type RetirementIntegrityReader = (
  key: string,
  query: { fromSeq: number; toSeq: number; limit: number },
) => IntegrityRow[]

const fail = (reason: string): never => {
  throw new CoreError('E_RELATION', `Legacy budget origin is unproven: ${reason}`)
}
const parse = (value: unknown): unknown => {
  try {
    return JSON.parse(String(value))
  } catch {
    return fail('invalid JSON')
  }
}
const scopeList = (value: unknown): string[] => {
  const list = parse(value)
  if (
    !Array.isArray(list) ||
    !list.length ||
    list.some((id) => typeof id !== 'string' || !id) ||
    new Set(list).size !== list.length
  )
    return fail('invalid scopes')
  return list
}

/** Called only inside the purge write transaction. Never infer a session from an opaque task ID.
 * An affected root must have complete protected settlement evidence for every permit; partial
 * owner recovery must not turn a shared legacy budget into an apparently exclusive one. */
export function backfillVerifiedBudgetOrigins(
  db: DatabaseSync,
  head: (key: string) => number,
  scan: RetirementIntegrityReader,
  options: { verifyRoots?: ReadonlySet<string>; requireResponse?: boolean } = {},
): Array<{ root: string; sessionKey: string; seq: number; permitId: string; eventDigest: string }> {
  const origins = db.prepare('SELECT root_task_id,session_key FROM session_budget_origins').all()
  const children = db.prepare('SELECT root_task_id FROM child_tasks').all()
  const permits = db.prepare('SELECT * FROM budget_reservations').all()
  const scopes = db.prepare('SELECT * FROM budget_scopes').all()
  const needed = new Set<string>(options.verifyRoots)
  for (const row of [...scopes, ...db.prepare('SELECT root_task_id FROM child_writer_gens').all()])
    if (
      !origins.some((origin) => origin.root_task_id === row.root_task_id) &&
      !children.some((child) => child.root_task_id === row.root_task_id)
    )
      needed.add(String(row.root_task_id))
  const evidence = db
    .prepare('SELECT * FROM cost_origins')
    .all()
    .map((row) => {
      const value = parse(row.scope_ids)
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('unknown envelope')
      const envelope = value as Record<string, unknown>
      if (
        envelope.v !== 2 ||
        Object.keys(envelope).sort().join(',') !== 'effectId,permitId,requestHash,scopeIds,v,writerGeneration'
      )
        return fail('unknown envelope')
      const permit = permits.find((entry) => entry.permit_id === envelope.permitId)
      if (!permit) return fail('missing permit')
      // origin_key has a documented session-key plus integer-sequence encoding, unlike root_task_id.
      const key = String(row.origin_key)
      const delimiter = key.lastIndexOf(':')
      const sessionKey = key.slice(0, delimiter)
      const suffix = key.slice(delimiter + 1)
      const seq = Number(suffix)
      if (delimiter <= 0 || !/^[1-9][0-9]*$/.test(suffix) || !Number.isSafeInteger(seq))
        return fail('invalid source identity')
      const root = String(permit.root_task_id)
      if (!origins.some((origin) => origin.root_task_id === root && origin.session_key === sessionKey))
        needed.add(root)
      return { row, envelope, permit, sessionKey, seq, root }
    })
  const verified = new Map<string, IntegrityRow[]>()
  let verifiedBytes = 0
  const verifySource = (sessionKey: string, seq: number) => {
    if (!verified.has(sessionKey)) {
      const session = db.prepare('SELECT format_version FROM sessions WHERE session_key=?').get(sessionKey)
      const through = head(sessionKey)
      if (
        session?.format_version !== 1 ||
        !Number.isSafeInteger(through) ||
        through < seq ||
        through > 100_000
      )
        fail('source ledger is missing or exceeds verification limits')
      let state = { lastSeq: 0, legacyThroughSeq: 0, headDigest: null as string | null }
      const facts: IntegrityRow[] = []
      while (state.lastSeq < through) {
        const rows = scan(sessionKey, { fromSeq: state.lastSeq + 1, toSeq: through, limit: 500 })
        if (!rows.length || rows.length > 500 || rows.some((row) => row.event.seq > through))
          fail('source ledger is incomplete')
        verifiedBytes += rows.reduce((n, row) => n + Buffer.byteLength(JSON.stringify(row)), 0)
        if (verifiedBytes > 256 * 1024 * 1024) fail('source ledgers exceed verification limits')
        state = verifyIntegrityRows(rows, state)
        if (state.legacyThroughSeq !== 0 || state.headDigest === null)
          fail('legacy ledger has no integrity proof')
        facts.push(
          ...rows.filter(
            (row) =>
              row.sessionKey === sessionKey &&
              row.event.origin === 'system' &&
              row.event.trust === 'trusted' &&
              ['runtime/record', 'x/agnes/jev-tree-admission', 'x/agnes/jev-tree-dispatch'].includes(
                row.event.type,
              ),
          ),
        )
      }
      verified.set(sessionKey, facts)
    }
    const [source] = scan(sessionKey, { fromSeq: seq, toSeq: seq, limit: 1 })
    if (
      !source ||
      source.sessionKey !== sessionKey ||
      source.event.seq !== seq ||
      source.event.origin !== 'system' ||
      source.event.trust !== 'trusted'
    )
      fail('source is not a trusted physical event')
    return source ?? fail('source is missing')
  }
  const recovered: Array<{
    root: string
    sessionKey: string
    seq: number
    permitId: string
    eventDigest: string
  }> = []
  for (const root of needed) {
    const reservations = permits.filter((permit) => permit.root_task_id === root)
    if (!reservations.length) fail('root has no settlement evidence')
    for (const permit of reservations) {
      const matching = evidence.filter((item) => item.permit.permit_id === permit.permit_id)
      if (matching.length !== 1 || !['settled', 'unknown'].includes(String(permit.status)))
        fail('not every reservation has settled evidence')
      const entry = matching[0] ?? fail('missing settlement')
      const ids = scopeList(permit.scope_ids)
      if (
        entry.envelope.effectId !== permit.effect_id ||
        entry.envelope.requestHash !== permit.request_hash ||
        entry.envelope.writerGeneration !== permit.writer_generation ||
        !Number.isSafeInteger(permit.writer_generation) ||
        Number(permit.writer_generation) < 1 ||
        JSON.stringify(entry.envelope.scopeIds) !== JSON.stringify(ids) ||
        !(
          /^(0|[1-9][0-9]*)$/.test(String(entry.row.micro)) ||
          (permit.status === 'unknown' && entry.row.micro === 'unknown')
        )
      )
        fail('settlement binding mismatch')
      for (const id of ids) {
        const scope = scopes.find((row) => row.scope_id === id)
        if (
          !scope ||
          scope.root_task_id !== root ||
          (scope.parent_scope_id !== null && !ids.includes(String(scope.parent_scope_id)))
        )
          fail('scope ownership mismatch')
      }
      const source = verifySource(entry.sessionKey, entry.seq)
      const data = source.event.data as {
        runtime?: { id?: unknown; version?: unknown }
        record?: Record<string, unknown>
      } | null
      const settled = data?.record
      if (
        source.event.type !== 'runtime/record' ||
        data?.runtime?.id !== 'jevloop' ||
        data.runtime.version !== '1' ||
        settled?.version !== 1 ||
        settled?.kind !== 'model.settled' ||
        typeof settled.requested !== 'string'
      )
        fail('source has no independently protected permit binding')
      const requestedId = settled?.requested
      const facts = verified.get(entry.sessionKey) ?? []
      const expectedEffect = createHash('sha256')
        .update(canonicalJson(['jev-tree-model', entry.sessionKey, source.event.lane, requestedId]))
        .digest('hex')
      const admissions = facts.filter(({ event }) => {
        const d = event.data as Record<string, unknown>
        return (
          event.type === 'x/agnes/jev-tree-admission' &&
          event.lane === source.event.lane &&
          event.seq < entry.seq &&
          d.requestedId === requestedId &&
          d.rootTaskId === root &&
          d.effectId === permit.effect_id &&
          d.effectId === expectedEffect &&
          d.requestHash === permit.request_hash &&
          d.writerGeneration === permit.writer_generation &&
          d.qMicro === permit.q_micro &&
          JSON.stringify(d.scopeIds) === JSON.stringify(ids)
        )
      })
      if (admissions.length !== 1) fail('protected admission binding is missing or ambiguous')
      const admission = admissions[0] ?? fail('missing admission')
      const admissionData = admission.event.data as Record<string, unknown>
      const requested = facts.find(
        ({ event }) =>
          event.seq === admissionData.requestedSeq &&
          event.seq < admission.event.seq &&
          event.lane === source.event.lane &&
          event.type === 'runtime/record',
      )
      const requestData = requested?.event.data as typeof data
      if (
        requestData?.runtime?.id !== 'jevloop' ||
        requestData.runtime.version !== '1' ||
        requestData.record?.version !== 1 ||
        requestData.record?.kind !== 'model.requested' ||
        requestData.record.id !== requestedId
      )
        fail('protected model request binding is missing')
      const dispatches = facts.filter(({ event }) => {
        const d = event.data as Record<string, unknown>
        return (
          event.type === 'x/agnes/jev-tree-dispatch' &&
          event.lane === source.event.lane &&
          event.seq > admission.event.seq &&
          event.seq < entry.seq &&
          d.admissionSeq === admission.event.seq &&
          d.permitId === permit.permit_id
        )
      })
      if (dispatches.length !== 1) fail('protected dispatch binding is missing or ambiguous')
      if (options.requireResponse) {
        const settlement = settled?.settlement as
          | { output?: unknown; error?: unknown; snapshot?: { codec?: unknown; response?: unknown } }
          | undefined
        const snapshot = settlement?.snapshot
        if (snapshot?.codec === 'systemone-json-v1') {
          if (
            settlement?.error !== undefined ||
            settlement?.output === undefined ||
            canonicalJson(settlement.output) !== canonicalJson(snapshot.response)
          )
            fail('decision response is not complete')
        } else if (snapshot?.codec === 'agnes-inference-v1') {
          const events = (snapshot.response as { events?: unknown } | null)?.events
          if (
            !Array.isArray(events) ||
            events.at(-1)?.type !== 'done' ||
            events.some((event) => event?.type === 'error')
          )
            fail('language response has no completed transport receipt')
          const error = settlement?.error as { code?: unknown } | undefined
          if (
            error &&
            ['ABORTED', 'LANGUAGE_TRANSPORT', 'LANGUAGE_INCOMPLETE', 'LANGUAGE_RESPONSE_LIMIT'].includes(
              String(error.code),
            )
          )
            fail('language dispatch completion is unknown')
        } else fail('response codec cannot prove dispatch completion')
      }
      const eventDigest = source.integrity?.digest
      if (!eventDigest) fail('settlement digest is missing')
      recovered.push({
        root,
        sessionKey: entry.sessionKey,
        seq: entry.seq,
        permitId: String(permit.permit_id),
        eventDigest: String(eventDigest),
      })
    }
  }
  const insert = db.prepare(
    'INSERT OR IGNORE INTO session_budget_origins(root_task_id,session_key) VALUES(?,?)',
  )
  for (const row of recovered) insert.run(row.root, row.sessionKey)
  return recovered
}
