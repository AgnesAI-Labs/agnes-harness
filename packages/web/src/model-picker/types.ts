import type { ModelInputLimits, ModelSettings, ThinkingLevel } from '@agnes/protocol'

export type ModelPickerOption = {
  id: string
  route: string
  input?: readonly ('text' | 'image')[]
  inputLimits?: ModelInputLimits
  label?: string
  /** 弹窗取用的档位映射；模型列表本身不展示或修改档位。 */
  thinkingLevelMap?: Record<string, string>
  contextWindow?: number
  defaultSettings?: ModelSettings
}

/** 模型详情里「思考强度」与「上下文窗口」两行要显示的会话现状。 */
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
  accessibleName: string
  disabled: boolean
  label: string
  options: readonly ModelPickerOption[]
  pending: boolean
  selected?: ModelPickerOption
  settings?: ModelPickerSettings
}

export type ModelPicker = {
  close(options?: { returnFocus?: boolean }): void
  destroy(): void
  render(state: ModelPickerState): void
}

export type ModelPickerOptions = {
  onError(error: unknown): void
  onSelect(option: ModelPickerOption): Promise<boolean>
  /**
   * 详情里的档位与预算改动；缺省时模型面板只列模型，不再往下一级展开。
   * 档位与预算一起提交：app 侧把缺省字段还原成 null，只送一项会重置另一项。
   */
  onSettingsChange?(settings: ModelSettings): Promise<boolean>
  trigger: HTMLButtonElement
}

export type DetailValues = {
  option: ModelPickerOption
  current: boolean
  capacity: number
  contextWindow?: number
  thinking?: ThinkingLevel
  thinkingLevelMap?: Record<string, string>
}
