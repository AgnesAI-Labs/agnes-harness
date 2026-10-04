import { type ComparisonCreateParams, minimumContextBudget, type ThinkingLevel } from '@agnes/protocol'
import { materializeRoutes, pinPresetRoutes } from './assemble/routes.js'
import type { Assembled } from './assemble.js'
import { HostError } from './errors.js'
import type { HostSession } from './host.js'
import { type ResolvedPreset, resolvePreset } from './presets/resolve.js'
import type { ResolvedProfile } from './profile/types.js'
import { checkPresetHardRequirements } from './session.js'
import { applySessionSandboxFloor } from './session-sandbox-floor.js'

/**
 * core's `setPreset`/`setModel` (Task 32/32a) only check structure: does the preset exist, is the
 * route/model pair in the provider's sealed catalogue. Neither knows the profile, the capability
 * ceiling, or which routes this deployment's assembly actually materialized - so a daemon routing a
 * runtime switch through core directly would let a session land on a preset or a route the operator
 * never meant to expose. This module is the gate a caller (daemon's `setPreset`/`setModel` RPC
 * handlers) must go through first: resolve and validate here, then hand the already-validated value
 * to `session.setPreset()`/`session.setModel()` - never the raw client-supplied name.
 */
export function validatePresetSwitch(
  profile: ResolvedProfile,
  a: Assembled,
  name: string,
  sessionKey?: string,
): ResolvedPreset {
  const resolved = applySessionSandboxFloor(
    resolvePreset(name, a.presets, a.sessionPresetLimits()),
    a.adapters.storage,
    sessionKey,
  )
  checkPresetHardRequirements(profile, a, resolved, name)
  return resolved
}

/** Resolve comparison defaults once before allocating either lane. No session or model call is created. */
export function resolveSessionSelection(
  profile: ResolvedProfile,
  a: Assembled,
  input: { preset?: string; model?: ComparisonCreateParams['model'] },
): { preset: string; model: NonNullable<ComparisonCreateParams['model']> } {
  const preset = input.preset ?? profile.presets.default
  const { view } = validatePresetSwitch(profile, a, preset)
  const baseline = materializeRoutes(view, profile).primary
  const target = input.model ?? baseline
  validateModelSwitch(profile, a, { slot: 'primary', ...target })
  const record = a.provider.models().find((item) => item.route === target.route && item.id === target.model)
  if (!record) throw new HostError('E_MODEL_UNSUPPORTED', 'comparison model is unavailable')
  const sameModel = target.route === baseline.route && target.model === baseline.model
  const thinking =
    input.model?.thinking ??
    (sameModel ? view.model.thinking.primary : undefined) ??
    record.defaultSettings?.thinking
  const contextWindow =
    input.model?.contextWindow ??
    (sameModel ? view.model.contextWindow?.primary : undefined) ??
    record.defaultSettings?.contextWindow ??
    record.contextWindow
  const model = {
    route: target.route,
    model: target.model,
    ...(thinking === undefined ? {} : { thinking }),
    contextWindow,
  }
  validateModelSwitch(profile, a, { slot: 'primary', ...model })
  return { preset, model }
}

/**
 * `sel.route` must satisfy both: it is one of the routes this deployment declared in its resolved
 * profile, and the sealed provider publishes that exact route/model pair.  The initial preset only
 * materializes one target per slot; treating that bootstrap table as the whole runtime allow-list
 * made every other pre-registered API-key provider impossible to select.  The profile route list is
 * the deployment's stable allow-list; the sealed registry remains the source of truth for model ids.
 *
 * Checking only the second would let `setModel` reach a route the provider object carries - a
 * test/fallback route, say - that this deployment never allowed. Checking only the first would
 * accept a route the profile allowed, paired with a model id that route never actually registered.
 * Both conditions have to hold together.
 *
 */
export function validateModelSwitch(
  profile: ResolvedProfile,
  a: Assembled,
  sel: {
    slot: string
    route: string
    model: string
    thinking?: ThinkingLevel | null
    contextWindow?: number | null
  },
): void {
  const declared =
    (profile.provider.routes ?? []).some((route) => route.route === sel.route) ||
    a.preconfiguredRoutes.includes(sel.route)
  const record = a.provider.models().find((m) => m.route === sel.route && m.id === sel.model)
  // The route and model stay in `detail`, never the message: an account route is spelled
  // `account-acct-<uuid>`, which HostError's leak check reads as key material and replaces with a
  // code-less error, so the caller would get INTERNAL instead of this refusal.
  if (!declared || !record)
    throw new HostError(
      'E_MODEL_UNSUPPORTED',
      "the requested model is outside this deployment's assembled route table",
      { detail: { slot: sel.slot, route: sel.route, model: sel.model, declared, published: !!record } },
    )
  if (
    sel.thinking !== undefined &&
    sel.thinking !== null &&
    (!record.reasoning || (record.thinkingLevelMap && !(sel.thinking in record.thinkingLevelMap)))
  )
    throw new HostError(
      'E_MODEL_UNSUPPORTED',
      `the requested model does not support thinking level '${sel.thinking}'`,
      { detail: { slot: sel.slot, route: sel.route, model: sel.model, thinking: sel.thinking } },
    )
  if (
    sel.contextWindow !== undefined &&
    sel.contextWindow !== null &&
    (!Number.isSafeInteger(sel.contextWindow) ||
      sel.contextWindow < minimumContextBudget(record.contextWindow) ||
      sel.contextWindow > record.contextWindow)
  )
    throw new HostError(
      'E_MODEL_UNSUPPORTED',
      `context budget must be between ${minimumContextBudget(record.contextWindow)} and ${record.contextWindow} tokens`,
    )
}

/**
 * Runs after `createSession`'s six steps open the kernel session, before the session is handed back
 * to whoever asked for it. core's `setPreset`/`setModel` take effect in memory only and write an
 * ignorable audit event - nothing about them survives a fresh process opening the same ledger except
 * that audit trail, so this is the one place that trail gets read back and turned into live state
 * again. The last preset establishes the baseline; only model switches after it can override that
 * view. Applying the recovered views in memory never writes another switch event.
 *
 * Wired into `createSession` alone, not repeated by daemon or sdk: resuming the last switch is part
 * of what "open this session" means, not a separate recovery command a caller has to remember to
 * issue.
 */
type ModelTo = { route: string; model: string; thinking?: ThinkingLevel; contextWindow?: number }

const MODEL_SWITCH_PAGE = 200

export async function replaySwitchesOnOpen(
  session: HostSession,
  profile: ResolvedProfile,
  a: Assembled,
): Promise<void> {
  const presetRows = await session.scan({ type: 'x/core/preset-switch', order: 'desc', limit: 1 })
  const lastPresetRow = presetRows[0]
  const lastPreset = lastPresetRow?.data as { to: string } | undefined
  const lastPresetSeq = lastPresetRow?.seq
  const latestPerSlot = await latestModelSwitchPerSlot(session)
  // Finish scanning before updating the recovered view.
  // Names can agree while session/start has restored older model settings. A later preset always
  // supersedes that initial snapshot, even after switching away and back to the original name.
  if (lastPreset) {
    const resolved = validatePresetSwitch(profile, a, lastPreset.to, session.key)
    applyPresetInMemory(session, pinPresetRoutes(resolved.view, materializeRoutes(resolved.view, profile)))
  }
  // Latest switch per slot across the whole ledger, not a 200-row window: a busy slot must not
  // push a quiet slot's last switch out of the restore set. Model rows at or before the last
  // preset are already superseded by that preset's view.
  for (const [slot, rec] of latestPerSlot) {
    if (lastPresetSeq !== undefined && rec.seq <= lastPresetSeq) continue
    const to = rec.to
    if (
      session.preset.model.route[slot] === to.route &&
      session.preset.model.id[slot] === to.model &&
      session.preset.model.thinking[slot] === to.thinking &&
      session.preset.model.contextWindow?.[slot] === to.contextWindow
    )
      continue
    // Restore the durable selection even when its account was removed. Opening history must
    // remain possible; new switches and inference still validate the current model catalogue.
    applyModelInMemory(session, slot, to)
  }
}

async function latestModelSwitchPerSlot(
  session: HostSession,
): Promise<Map<string, { seq: number; to: ModelTo }>> {
  const latestPerSlot = new Map<string, { seq: number; to: ModelTo }>()
  let toSeq: number | undefined
  for (;;) {
    const page = await session.scan({
      type: 'x/core/model-switch',
      order: 'desc',
      limit: MODEL_SWITCH_PAGE,
      ...(toSeq === undefined ? {} : { toSeq }),
    })
    for (const row of page) {
      const d = row.data as { slot: string; to: ModelTo }
      if (!latestPerSlot.has(d.slot)) latestPerSlot.set(d.slot, { seq: row.seq, to: d.to })
    }
    if (page.length < MODEL_SWITCH_PAGE) break
    const oldest = page[page.length - 1]
    if (!oldest || oldest.seq <= 1) break
    toSeq = oldest.seq - 1
  }
  return latestPerSlot
}

function applyPresetInMemory(session: HostSession, view: HostSession['preset']): void {
  session.preset = view
  session.d.runtime.preset = view
}

function applyModelInMemory(session: HostSession, slot: string, to: ModelTo): void {
  const view = {
    ...session.preset,
    model: {
      ...session.preset.model,
      route: { ...session.preset.model.route, [slot]: to.route },
      id: { ...session.preset.model.id, [slot]: to.model },
      thinking: { ...session.preset.model.thinking, [slot]: to.thinking },
      contextWindow: { ...session.preset.model.contextWindow, [slot]: to.contextWindow },
    },
  }
  applyPresetInMemory(session, view)
}
