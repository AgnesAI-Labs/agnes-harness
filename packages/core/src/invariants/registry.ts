import type { LedgerState } from '../reduce/state.js'
import type { Event, Seq } from '../types.js'

/** One rule broken, at the row that broke it. `run` collects these across every registered package. */
export type Violation = { rule: string; seq: Seq; message: string }

/**
 * A single named check. `events` is the batch under inspection (a replay pass hands the whole
 * ledger; an incremental pass hands only the rows just appended); `state` is the ledger folded up to
 * (but not including) that batch, for checks that need context the batch itself does not carry.
 */
export type InvariantCheck = {
  id: string
  check(events: readonly Event[], state: LedgerState): Violation[]
}

/** What a package hands `register` when it deliberately has no checks, and why. */
export type BlankDeclaration = { none: true; reason: string }

/**
 * Every package that ships event types is expected to declare here, once, either its checks or a
 * reason it has none — `packages()` is what a CI test walks to catch a package that forgot to show
 * up at all, which a registry with checks-only has no way to distinguish from one that is silent on
 * purpose. Registering the same package twice is refused rather than merged, so two packages cannot
 * silently shadow each other's checks under one name.
 */
export class InvariantRegistry {
  mode: 'off' | 'on' | 'strict' = 'off'
  private readonly table = new Map<string, { checks: InvariantCheck[]; blank?: string }>()

  register(pkg: string, checks: InvariantCheck[] | BlankDeclaration): void {
    if (this.table.has(pkg)) throw new Error(`invariants already registered for ${pkg}`)
    this.table.set(pkg, Array.isArray(checks) ? { checks } : { checks: [], blank: checks.reason })
  }

  packages(): Array<{ pkg: string; checks: number; blank?: string }> {
    return [...this.table].map(([pkg, v]) => ({
      pkg,
      checks: v.checks.length,
      ...(v.blank !== undefined ? { blank: v.blank } : {}),
    }))
  }

  /** Runs every registered package's checks against the same batch and state, in registration order. */
  run(events: readonly Event[], state: LedgerState): Violation[] {
    const out: Violation[] = []
    for (const { checks } of this.table.values()) {
      for (const c of checks) out.push(...c.check(events, state))
    }
    return out
  }
}
