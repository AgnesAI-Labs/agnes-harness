import { SLOT_NAMES, validatePreset } from '@agnes/protocol'
import { DEPRECATED_ACTION } from '../command-policy.js'
import { HostError } from '../errors.js'
import type { PresetDoc } from './types.js'

const map = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const fail = (name: string, path: string): never => {
  throw new HostError('E_PRESET_UNSUPPORTED', `preset ${name}: invalid ${path}`, {
    detail: { source: name, path },
  })
}

/** Canonical consumer spellings; the original merged document remains the hash input. */
export function validatedPresetViewInput(doc: PresetDoc): PresetDoc {
  const canonical: PresetDoc = { ...doc }
  if (map(doc.model)) {
    canonical.model = { ...doc.model }
    if (map(doc.model.retry) && doc.model.retry.backoff_ms !== undefined) {
      const { backoff_ms, ...retry } = doc.model.retry
      if (retry.base_delay_ms !== undefined && retry.base_delay_ms !== backoff_ms)
        fail(doc.name, 'model.retry.backoff_ms conflicts with base_delay_ms')
      ;(canonical.model as Record<string, unknown>).retry = { ...retry, base_delay_ms: backoff_ms }
    }
  }
  if (map(doc.recovery) && doc.recovery.unknown_child === 'park')
    canonical.recovery = { ...doc.recovery, unknown_child: 'human' }
  const projection: PresetDoc = { ...canonical }
  // The one-version approval alias still reaches session validation unchanged so it is audited.
  if (map(canonical.approval) && Array.isArray(canonical.approval.command_policy))
    projection.approval = {
      ...canonical.approval,
      command_policy: canonical.approval.command_policy.map((rule) =>
        map(rule) && rule.action === DEPRECATED_ACTION ? { ...rule, action: 'require_approval' } : rule,
      ),
    }
  if (map(canonical.model)) {
    const { id, ...model } = canonical.model
    // model.id is the old split form consumed by core, never an open-ended bypass pocket.
    if (id !== undefined) {
      if (!map(id)) fail(doc.name, 'model.id')
      for (const [slot, pin] of Object.entries(id as Record<string, unknown>))
        if (!(SLOT_NAMES as readonly string[]).includes(slot) || typeof pin !== 'string' || pin.length > 256)
          fail(doc.name, `model.id.${slot}`)
    }
    const pins = map(id) ? id : {}
    const route = model.route === undefined && id !== undefined ? { primary: 'default' } : model.route
    if (map(route)) {
      for (const slot of Object.keys(pins))
        if (!(slot in route)) fail(doc.name, `model.id.${slot} has no route`)
      for (const [slot, target] of Object.entries(route))
        if (typeof target !== 'string' && (!map(target) || typeof target.route !== 'string'))
          fail(doc.name, `model.route.${slot} names no route`)
      model.route = Object.fromEntries(
        Object.entries(route).map(([slot, target]) => [
          slot,
          typeof target === 'string' ? { route: target, model: pins[slot] ?? 'default' } : target,
        ]),
      )
    }
    projection.model = model
  }
  const result = validatePreset(projection)
  if (!result.ok) {
    const errors = result.errors.map(({ path, code }) => ({ path, code }))
    throw new HostError('E_PRESET_UNSUPPORTED', `preset ${doc.name}: schema validation failed`, {
      detail: { source: doc.name, errors },
    })
  }
  return canonical
}
