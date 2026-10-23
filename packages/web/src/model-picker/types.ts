import type { ModelInputLimits, ModelSettings, ThinkingLevel } from '@agnes/protocol'
import type { SessionAuxiliarySnapshot, Translate } from '@agnes/web-ui'

export type ModelPickerOption = {
  id: string
  route: string
  input?: readonly ('text' | 'image')[]
  inputLimits?: ModelInputLimits
  label?: string
  /** Model-declared effort-to-provider-value mapping; absence means the model offers no effort selection. */
  thinkingLevelMap?: Record<string, string>
  contextWindow?: number
  defaultSettings?: ModelSettings
}

/** Current session state shown in the panel's thinking-effort and context-window sections. */
export type ModelPickerSettings = {
  /** Saved session effort; absence uses the provider default. */
  thinking?: ThinkingLevel
  /** Saved session context budget; absence automatically uses model capacity. */
  contextWindow?: number
  /** Model catalog capacity, also the upper bound for budget validation. */
  capacity: number
  thinkingLevelMap?: Record<string, string>
}

export type ModelPickerState = {
  auxiliaryAvailable?: boolean
  accessibleName: string
  disabled: boolean
  /** Why the trigger is disabled, shown as its tooltip when the reason is temporary. */
  disabledReason?: string
  label: string
  options: readonly ModelPickerOption[]
  pending: boolean
  selected?: ModelPickerOption
  settings?: ModelPickerSettings
}

export type ModelPickerProps = {
  /** Presentation-owned locale; bundled clients cannot share the host's imperative bridge. */
  t?: Translate
  state: ModelPickerState
  onAuxiliaryRead?(): Promise<SessionAuxiliarySnapshot>
  onAuxiliarySelect?(slot: 'fast' | 'verifier', option: ModelPickerOption): Promise<boolean>
  onError(error: unknown): void
  onSelect(option: ModelPickerOption): Promise<boolean>
  /**
   * Effort and budget changes; without this callback the panel only lists models.
   * Submit both together: app restores missing fields to null, so sending one would reset the other.
   */
  onSettingsChange?(settings: ModelSettings): Promise<boolean>
}
