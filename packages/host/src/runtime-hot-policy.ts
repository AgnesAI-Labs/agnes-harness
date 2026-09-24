import type { Context } from '@agnes/cordis'
import type { RuntimeTarget } from '@agnes/plugin-runtime/host'
import {
  applyHotPolicyRow,
  applyHotPolicySnapshot,
  assertBusinessLimitsConfig,
  HOT_POLICY_ROWS,
  type HotPolicyFacade,
  type HotPolicyRow,
} from './profile-policy.js'
import { sessionOverlayDesired } from './runtime-session-overlay.js'

export type IsolatedSessionOverlay = Readonly<{
  preset: string
  isolated: Context
}>

/** Isolate each hot-policy service under one overlay/session label. Never isolate(sessionKey). */
export function isolateHotPolicyServices(ctx: Context, label: symbol): Context {
  let next = ctx
  for (const row of HOT_POLICY_ROWS) next = next.isolate(row, label)
  return next
}

export function isolateSessionOverlay(
  ctx: Context,
  sessionKey: string,
  preset: string,
): IsolatedSessionOverlay {
  const overlay = sessionOverlayDesired({ preset })
  return Object.freeze({
    preset: overlay.preset,
    isolated: isolateHotPolicyServices(ctx, Symbol(`overlay:${sessionKey}:${overlay.preset}`)),
  })
}

export function assertHotPolicyTarget(target: RuntimeTarget): void {
  for (const row of HOT_POLICY_ROWS) {
    const found = target.tree.rows.find((entry) => entry.id === row)
    if (!found) continue
    applyHotPolicyRow(row)
    if (row === 'policy:business-limits') assertBusinessLimitsConfig(found.config)
  }
}

export function syncHotPolicyFromTarget(facade: HotPolicyFacade, target: RuntimeTarget): void {
  assertHotPolicyTarget(target)
  for (const row of HOT_POLICY_ROWS) {
    const found = target.tree.rows.find((entry) => entry.id === row)
    if (!found) continue
    applyHotPolicySnapshot(facade, row as HotPolicyRow, {
      revision: found.mountRevision,
      value: found.config ?? null,
    })
  }
}
