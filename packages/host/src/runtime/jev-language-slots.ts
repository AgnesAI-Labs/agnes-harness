import { type PresetView, resolveModel } from '@agnes/core'
import { SLOT_NAMES, type SlotName } from '@agnes/protocol'

const LANGUAGE_STAGES = ['parameters', 'arbitration', 'answer'] as const

export type JevLanguageStage = (typeof LANGUAGE_STAGES)[number]

/**
 * The effective JevLoop language-stage-to-slot mapping, with defaults applied in exactly one
 * place: a stage the preset left unset (or bound to a name outside the closed slot set — the
 * PresetView types slot names loosely) runs on primary, which is also what a Native session and
 * every preset without `model.jev_language_slots` already do. Host's Jev loop and the daemon's
 * read-only session.modelSlots projection both read this, so a stage always reports and requests
 * through the same slot.
 */
export function jevLanguageSlots(view: PresetView): Record<JevLanguageStage, SlotName> {
  const bound = view.model.jevLanguageSlots
  const result = { parameters: 'primary', arbitration: 'primary', answer: 'primary' } as Record<
    JevLanguageStage,
    SlotName
  >
  if (bound === undefined) return result
  for (const stage of LANGUAGE_STAGES) {
    const slot = bound[stage]
    if (slot === 'primary' || slot === 'escalation' || slot === 'fast' || slot === 'verifier')
      result[stage] = slot
  }
  return result
}

/** Minimal session surface the projection needs; SessionImpl satisfies it structurally. */
type ProjectedSession = {
  preset: PresetView
  d: { provider: { models(): unknown[] } }
}

/**
 * The full session.modelSlots body shared by every serving side: per-slot resolved route/model
 * plus the session's thinking/context overrides, the effective stage mapping and any direct stage
 * bindings. Pure — no session calls, no writes. Both the daemon's in-process path and the worker
 * command behind the supervisor's remote-session proxy build the same answer here, so local and
 * worker-hosted sessions cannot drift.
 */
export function projectJevModelSlots(session: ProjectedSession): {
  languageSlots: Record<JevLanguageStage, SlotName>
  languageBindings: Record<
    JevLanguageStage,
    { route: string; model: string; thinking?: string | null } | null
  >
  slots: Array<{
    slot: SlotName
    route: string
    model: string
    thinking: string | null
    contextWindow: number | null
  }>
} {
  const bindings = session.preset.model.jevStageBindings
  return {
    languageSlots: jevLanguageSlots(session.preset),
    languageBindings: {
      parameters: bindings?.parameters ?? null,
      arbitration: bindings?.arbitration ?? null,
      answer: bindings?.answer ?? null,
    },
    slots: SLOT_NAMES.map((slot) => {
      const target = resolveModel(session as Parameters<typeof resolveModel>[0], slot)
      return {
        slot,
        route: target.route,
        model: target.model,
        thinking: session.preset.model.thinking[slot] ?? null,
        contextWindow: session.preset.model.contextWindow?.[slot] ?? null,
      }
    }),
  }
}
