import type { RefinementSettings } from '../gen/ts/agnes-v1.js'

/** Refinement is opt-in: a profile without saved settings has it off, in manual mode. */
export const DEFAULT_REFINEMENT_SETTINGS: RefinementSettings = Object.freeze({
  enabled: false,
  mode: 'manual',
})
