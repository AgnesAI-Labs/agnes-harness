import type { ConfigTestResult } from '@agnes/protocol'
import { tr } from '@agnes/web-foundation/locale-bridge'

type SaveStateInput = {
  /** Something outside the model group already blocks saving: offline, busy, no provider, load error. */
  unavailable: boolean
  step: 'provider' | 'connection'
  oauth: boolean
  /** OAuth has its own model readiness check; every other path only needs a tested connection. */
  oauthReady: boolean
  tested: ConfigTestResult | undefined
  model: string
}

/**
 * The save button's availability and why it is unavailable. A tested connection still needs a chosen
 * default model; before any test the button stays available, because clicking it runs one.
 */
export function saveState(input: SaveStateInput): { disabled: boolean; reason: string } {
  const waitsForModel = input.oauth
    ? !input.oauthReady || !input.model
    : !!input.tested && (!input.tested.models.length || !input.model)
  const disabled = input.unavailable || (input.step === 'connection' && waitsForModel)
  const reason =
    input.step === 'connection' && waitsForModel
      ? tr(input.oauth ? 'accounts.modelLockedOAuth' : 'accounts.saveNeedsModel')
      : ''
  return { disabled, reason }
}

/**
 * Apply the state to the button, keeping the reason where the shared tooltip reads it when it opens.
 * Only a reason gives the wrapper a tab stop, so an enabled button leaves no stray focus stop.
 */
export function applySaveState(button: HTMLButtonElement, input: SaveStateInput): void {
  const { disabled, reason } = saveState(input)
  button.disabled = disabled
  if (reason) button.dataset.disabledReason = reason
  else delete button.dataset.disabledReason
  const anchor = button.closest<HTMLElement>('.agh-tooltip-anchor')
  if (!anchor) return
  if (reason) {
    anchor.setAttribute('tabindex', '0')
    anchor.setAttribute('aria-label', reason)
    return
  }
  anchor.removeAttribute('tabindex')
  anchor.removeAttribute('aria-label')
}

/** The empty choice of the default model, named after what the draft is still missing. */
export function modelChoiceLabel(chosen: number, catalogueKnown: boolean): string {
  if (chosen > 0) return tr('settings.model.chooseSaved')
  return catalogueKnown ? tr('settings.model.chooseAbove') : tr('settings.model.testFirst')
}
