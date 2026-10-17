import type { ModelInputLimits, ModelSettings, ThinkingLevel } from '@agnes/protocol'
import type { SessionAuxiliarySnapshot } from '@agnes/web-ui'

export type ModelPickerOption = {
  id: string
  route: string
  input?: readonly ('text' | 'image')[]
  inputLimits?: ModelInputLimits
  label?: string
  /** 模型声明的「档位 → provider 取值」映射；缺省表示这个模型不提供档位选择。 */
  thinkingLevelMap?: Record<string, string>
  contextWindow?: number
  defaultSettings?: ModelSettings
}

/** 面板里「思考强度」与「上下文窗口」两段要显示的会话现状。 */
export type ModelPickerSettings = {
  /** 会话已保存的档位；缺省表示交给 provider 默认。 */
  thinking?: ThinkingLevel
  /** 会话已保存的上下文预算；缺省表示按模型容量自动。 */
  contextWindow?: number
  /** 模型目录容量，同时是预算校验的上界。 */
  capacity: number
  thinkingLevelMap?: Record<string, string>
}

export type ModelPickerState = {
  auxiliaryAvailable?: boolean
  accessibleName: string
  disabled: boolean
  label: string
  options: readonly ModelPickerOption[]
  pending: boolean
  selected?: ModelPickerOption
  settings?: ModelPickerSettings
}

export type ModelPickerProps = {
  state: ModelPickerState
  onAuxiliaryRead?(): Promise<SessionAuxiliarySnapshot>
  onAuxiliarySelect?(slot: 'fast' | 'verifier', option: ModelPickerOption): Promise<boolean>
  onError(error: unknown): void
  onSelect(option: ModelPickerOption): Promise<boolean>
  /**
   * 档位与预算改动；缺省时面板只列模型。
   * 档位与预算一起提交：app 侧把缺省字段还原成 null，只送一项会重置另一项。
   */
  onSettingsChange?(settings: ModelSettings): Promise<boolean>
}
