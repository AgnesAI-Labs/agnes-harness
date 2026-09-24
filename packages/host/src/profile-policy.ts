export const HOT_POLICY_ROWS = Object.freeze([
  'policy:approvals',
  'policy:command-hooks',
  'policy:capabilities',
  'policy:workspace-packages',
  'policy:business-limits',
] as const)

const PROCESS_STATIC_PREFIXES = Object.freeze([
  'lease.ttl_ms',
  'daemon.',
  'worker.',
  'subscribe.',
  'jobs.',
  'shutdown.',
] as const)

export function classifyProfileKey(key: string): 'hot' | 'static' {
  if ((HOT_POLICY_ROWS as readonly string[]).includes(key)) return 'hot'
  return 'static'
}

export function assertHotPolicyKey(key: string): void {
  if (classifyProfileKey(key) === 'hot') return
  throw Object.assign(new Error(`E_STATIC_COMPONENT: ${key} cannot be updated at runtime`), {
    code: 'E_STATIC_COMPONENT' as const,
  })
}

export function isProcessStaticLimit(key: string): boolean {
  return PROCESS_STATIC_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix))
}

export function applyHotPolicyRow(id: string): void {
  assertHotPolicyKey(id)
}

export type HotPolicyRow = (typeof HOT_POLICY_ROWS)[number]

export type HotPolicySnapshot = Readonly<{
  revision: string
  value: unknown
}>

export type HotPolicyFacade = {
  current: Map<HotPolicyRow, HotPolicySnapshot>
  tickets: Map<string, string>
  draining: Set<HotPolicyRow>
  inflight: number
  pending: Map<HotPolicyRow, HotPolicySnapshot>
}

export function createHotPolicyFacade(): HotPolicyFacade {
  return {
    current: new Map(),
    tickets: new Map(),
    draining: new Set(),
    inflight: 0,
    pending: new Map(),
  }
}

/** Approvals: bind the current revision onto a ticket; later swaps do not rewrite it. */
export function bindApprovalTicket(facade: HotPolicyFacade, ticketId: string): string {
  applyHotPolicyRow('policy:approvals')
  const revision = facade.current.get('policy:approvals')?.revision ?? '0'
  facade.tickets.set(ticketId, revision)
  return revision
}

export function approvalTicketRevision(facade: HotPolicyFacade, ticketId: string): string | undefined {
  return facade.tickets.get(ticketId)
}

/** Command-hooks: each invocation copies the current snapshot; in-flight updates wait for the next. */
export function commandHookInvocationSnapshot(facade: HotPolicyFacade): HotPolicySnapshot {
  applyHotPolicyRow('policy:command-hooks')
  const current = facade.current.get('policy:command-hooks')
  return Object.freeze({ revision: current?.revision ?? '0', value: current?.value ?? null })
}

/**
 * Capabilities and workspace-packages: refuse new admission while draining, then swap the snapshot.
 */
export function admitHotPolicyEntry(facade: HotPolicyFacade, row: HotPolicyRow): boolean {
  applyHotPolicyRow(row)
  if (row !== 'policy:capabilities' && row !== 'policy:workspace-packages') return true
  if (facade.draining.has(row)) return false
  facade.inflight += 1
  return true
}

export function releaseHotPolicyEntry(facade: HotPolicyFacade): void {
  if (facade.inflight > 0) facade.inflight -= 1
  if (facade.inflight > 0) return
  for (const row of [...facade.draining]) {
    const pending = facade.pending.get(row)
    if (!pending) continue
    facade.current.set(row, pending)
    facade.pending.delete(row)
    facade.draining.delete(row)
  }
}

export function assertBusinessLimitsConfig(value: unknown): void {
  if (value == null) return
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('E_POLICY_UNKNOWN: policy:business-limits config must be an object'), {
      code: 'E_POLICY_UNKNOWN' as const,
    })
  }
  for (const key of Object.keys(value)) assertDynamicLimitKey(key)
}

export function applyHotPolicySnapshot(
  facade: HotPolicyFacade,
  row: HotPolicyRow,
  snapshot: HotPolicySnapshot,
): void {
  applyHotPolicyRow(row)
  if (row === 'policy:business-limits') assertBusinessLimitsConfig(snapshot.value)
  if (row === 'policy:capabilities' || row === 'policy:workspace-packages') {
    if (facade.inflight > 0) {
      facade.draining.add(row)
      facade.pending.set(row, Object.freeze({ ...snapshot }))
      return
    }
    facade.draining.delete(row)
    facade.pending.delete(row)
  }
  facade.current.set(row, Object.freeze({ ...snapshot }))
}

export function finishHotPolicyDrain(
  facade: HotPolicyFacade,
  row: HotPolicyRow,
  snapshot: HotPolicySnapshot,
): void {
  applyHotPolicyRow(row)
  if (facade.inflight > 0) {
    throw Object.assign(new Error(`E_POLICY_DRAIN: ${row} still has admitted calls`), {
      code: 'E_POLICY_DRAIN' as const,
    })
  }
  facade.draining.delete(row)
  facade.current.set(row, Object.freeze({ ...snapshot }))
}

export function businessLimit(
  facade: HotPolicyFacade,
  key: 'approval.park' | 'cost.credits_per_usd',
): unknown {
  assertDynamicLimitKey(key)
  applyHotPolicyRow('policy:business-limits')
  const value = facade.current.get('policy:business-limits')?.value
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return key === 'approval.park' ? 0 : undefined
  return (value as Record<string, unknown>)[key]
}

export function assertDynamicLimitKey(key: string): void {
  if (key === 'approval.park' || key === 'cost.credits_per_usd') return
  if (isProcessStaticLimit(key)) {
    throw Object.assign(new Error(`E_STATIC_COMPONENT: ${key} cannot be updated at runtime`), {
      code: 'E_STATIC_COMPONENT' as const,
    })
  }
  throw Object.assign(new Error(`E_POLICY_UNKNOWN: unknown policy key ${key}`), {
    code: 'E_POLICY_UNKNOWN' as const,
  })
}
