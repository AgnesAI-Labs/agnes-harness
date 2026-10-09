import type { SessionControlledChild } from '@agnes/protocol/gen/agnes-v1'
import type { ContentBlock, ModelSettings, ThinkingLevel, UIPendingInput, UsageView } from '@agnes/protocol'
import { userImagePolicy } from '@agnes/protocol'
import { type ComponentType, type ReactNode } from 'react'
import { type ComposerReferences } from '../reference-picker.js'
import { composerLocaleCatalog } from '../locales/composer.js'
import type { Translate } from '../locales/index.js'

export type ModelPickerOption = {
  id: string
  route: string
  label?: string
  /** 模型声明的「档位 → provider 取值」映射；缺省表示任意合法档位都接受。 */
  thinkingLevelMap?: Record<string, string>
}

/** 面板里「思考强度」与「上下文预算」两段的会话现状；字段与宿主侧 ModelPickerSettings 对齐。 */
export type ModelPickerSettings = {
  thinking?: ThinkingLevel
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
  destroy(): void
  render(state: ModelPickerState): void
}

export type PermissionMode = 'view' | 'workspace' | 'full'

export type ComposerImageBlock = Extract<ContentBlock, { type: 'image' }>

export type ComposerAttachmentBlock = Extract<ContentBlock, { type: 'image' | 'file' | 'resource_link' }>

export type PermissionPickerState = { disabled: boolean; pending: boolean; selected: PermissionMode | null }

export type PermissionPicker = {
  destroy(): void
  render(state: PermissionPickerState): void
}

/** DOM helpers remain host adapters so this package has no dependency on the Web application. */
export interface ComposerDependencies {
  /** Locale-bound translate (host injects `LocaleService#t`); called during render, never cached. */
  translate: Translate
  createModelPicker(options: {
    trigger: HTMLButtonElement
    onError(error: unknown): void
    onSelect(option: ModelPickerOption): Promise<boolean>
    /** 面板内改档位或预算时的提交口；缺省时面板只渲染模型列表。 */
    onSettingsChange?(settings: ModelSettings): Promise<boolean>
  }): ModelPicker
  createPermissionPicker(options: {
    trigger: HTMLButtonElement
    onError(error: unknown): void
    onSelect(mode: PermissionMode): Promise<boolean>
  }): PermissionPicker
  createUsagePanel(
    parent: HTMLElement,
    t?: Translate,
  ): ((usage: UsageView | undefined, connected: boolean) => void) & {
    dispose?(): void
  }
  /** 上传前把超出模型视觉上限的图片缩小；缺省时按原图发送。 */
  downscaleImage?(file: File, policy?: ReturnType<typeof userImagePolicy>): Promise<File>
  /** Component injection keeps production usage in the composer root; factories remain compatible. */
  UsagePanel?: ComponentType<{ usage: UsageView | undefined; connected: boolean; t?: Translate }>
  isSubmitShortcut(event: {
    key: string
    shiftKey: boolean
    isComposing: boolean
    keyCode: number
    metaKey: boolean
    ctrlKey: boolean
  }): boolean
  resize(textarea: HTMLTextAreaElement): void
}

export interface ComposerView {
  children?: readonly SessionControlledChild[]
  childrenDisabled?: boolean

  imagePolicy?: ReturnType<typeof userImagePolicy>
  cancel: { disabled: boolean; hidden: boolean; label: string }
  controls?: {
    paused: boolean
    pending: boolean
    disabled: boolean
    pauseSupported: boolean
    interruptSupported: boolean
    reason: string
  }
  connected: boolean
  configured: boolean
  hasSession: boolean
  hint: { kind: 'shortcut' | 'state'; text: string }
  input: { disabled: boolean; placeholder: string }
  loading: boolean
  model: ModelPickerState
  modelSettings?: {
    settings: ModelSettings
    /** 模型目录容量，不是本会话已保存的预算。 */
    contextWindow: number
    thinkingLevelMap?: Record<string, string> | undefined
  }
  permission: PermissionPickerState
  queue?: {
    items: readonly (UIPendingInput & { editText?: string })[]
    disabled: boolean
    removeDisabled?: boolean
    sending?: string
    removing?: string
    interruptSupported?: boolean
    reason?: string
    error?: string
  }
  sending: boolean
  send: { disabled: boolean; label: string; mode: 'idle' | 'busy' | 'pending'; title: string }
  stopping: boolean
  usage: UsageView | undefined
  workspace: { disabled: boolean; label: string; title: string }
}

export interface ComposerHandle {
  getAttachmentBlocks(): readonly ComposerAttachmentBlock[]
  restoreAttachmentBlocks(attachments: readonly ComposerAttachmentBlock[]): void
  clearImageBlocks(): void
  focus(): void
  getDraft(): string
  getImageBlocks(): readonly ComposerImageBlock[]
  hasPendingImages(): boolean
  render(view: ComposerView): void
  restoreImageBlocks(images: readonly ComposerImageBlock[]): void
  resize(): void
  setDraft(value: string): void
}

export interface ComposerRegionOptions {
  references?: ComposerReferences
  initialDraft?: string
  onCancel(): void
  onAttachmentsChange?(): void
  prepareUploadSession?(): Promise<string>
  onDraftChange(value: string): void
  onError(error: unknown): void
  onModelSelect(option: ModelPickerOption): Promise<boolean>
  onModelSettingsChange?(settings: ModelSettings): Promise<boolean>
  onPermissionSelect(mode: PermissionMode): Promise<boolean>
  onSubmit(): void
  onChildControl?(id: string, action: 'stop' | 'continue', text?: string): Promise<void>
  onPauseResume?(): void
  onEditQueued?(itemId: string, text: string): Promise<void>
  onSendNow?(itemId: string): void
  onRemoveQueued?(itemId: string): void
  onWorkspace(): void
}

export interface ComposerSlots {
  attachments?: ReactNode
  dock?: ReactNode
  left?: ReactNode
  model?: ReactNode
  overlay?: ReactNode
  permission?: ReactNode
  plan?: ReactNode
  right?: ReactNode
}

/** 会话设置只在已知模型上有值；缺失时面板退化成纯模型列表。 */
export function pickerState(view: ComposerView): ModelPickerState {
  const settings = view.modelSettings
  if (!settings) return view.model
  return {
    ...view.model,
    settings: {
      ...(settings.settings.thinking ? { thinking: settings.settings.thinking } : {}),
      ...(settings.settings.contextWindow === undefined
        ? {}
        : { contextWindow: settings.settings.contextWindow }),
      capacity: settings.contextWindow,
      ...(settings.thinkingLevelMap ? { thinkingLevelMap: settings.thinkingLevelMap } : {}),
    },
  }
}

export const INITIAL_VIEW: ComposerView = {
  cancel: { disabled: true, hidden: true, label: composerLocaleCatalog.en['composer.initial.stop']! },
  connected: false,
  configured: false,
  hasSession: false,
  hint: { kind: 'state', text: composerLocaleCatalog.en['composer.initial.connect']! },
  input: { disabled: true, placeholder: composerLocaleCatalog.en['composer.initial.placeholder']! },
  loading: false,
  model: {
    accessibleName: composerLocaleCatalog.en['composer.initial.modelAria']!,
    disabled: true,
    label: composerLocaleCatalog.en['composer.initial.model']!,
    options: [],
    pending: false,
  },
  permission: { disabled: true, pending: false, selected: 'workspace' },
  sending: false,
  send: {
    disabled: true,
    label: composerLocaleCatalog.en['composer.initial.send']!,
    mode: 'idle',
    title: composerLocaleCatalog.en['composer.initial.sendTitle']!,
  },
  stopping: false,
  usage: undefined,
  workspace: {
    disabled: true,
    label: composerLocaleCatalog.en['composer.initial.workspace']!,
    title: composerLocaleCatalog.en['composer.initial.workspace']!,
  },
}

export interface ComposerProps extends ComposerRegionOptions {
  initialView?: ComposerView
  dependencies: ComposerDependencies
  slots?: ComposerSlots
}
