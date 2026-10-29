import type {
  ContentBlock,
  ModelSettings,
  ThinkingLevel,
  UIPendingInput,
  UsageView,
  userImagePolicy,
  WorkspaceEntry,
} from '@agnes/protocol'
import type { SessionControlledChild } from '@agnes/protocol/gen/agnes-v1'
import type { FileMention, SessionAuxiliarySnapshot } from '@agnes/web-ui'
import type { ComponentType, ReactNode } from 'react'
import { composerLocaleCatalog } from '../locales/composer.js'
import type { Translate } from '../locales/index.js'
import type { ComposerReferences } from '../reference-picker.js'
import type { ComposerSkills } from '../skill-picker.js'
import type { ComposerSkill } from '../skill-picker.js'

export type ModelPickerOption = {
  id: string
  route: string
  label?: string
  contextWindow?: number
  /** Model-declared effort-to-provider-value mapping; absence accepts any valid effort level. */
  thinkingLevelMap?: Record<string, string>
}

/** Session state for panel thinking-effort and context-budget sections; aligned with host ModelPickerSettings fields. */
export type ModelPickerSettings = {
  thinking?: ThinkingLevel
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
  state: ModelPickerState
  onError(error: unknown): void
  onSelect(option: ModelPickerOption): Promise<boolean>
  /** Submission port for panel effort/budget changes; without it the panel renders only the model list. */
  onSettingsChange?(settings: ModelSettings): Promise<boolean>
  onAuxiliaryRead?(): Promise<SessionAuxiliarySnapshot>
  onAuxiliarySelect?(slot: 'fast' | 'verifier', option: ModelPickerOption): Promise<boolean>
}

export type PermissionMode = 'view' | 'workspace' | 'full'

export type ComposerImageBlock = Extract<ContentBlock, { type: 'image' }>

export type ComposerAttachmentBlock = Extract<ContentBlock, { type: 'image' | 'file' | 'resource_link' }>

export type PermissionPickerState = {
  disabled: boolean
  pending: boolean
  selected: PermissionMode | null
  /** The level new sessions start under, marked in the list; absent when the Host does not say. */
  defaultMode?: PermissionMode
}

export type WorkspacePickerProps = {
  workspace: ComposerView['workspace']
  hidden: boolean
  /** Opens the host's full workspace dialog (register a new folder). */
  onWorkspace(): void
  onSelect(workspace: WorkspaceEntry | 'chats'): void
  onRemove?(workspace: WorkspaceEntry): void
}

export type PermissionPickerProps = {
  state: PermissionPickerState
  onError(error: unknown): void
  onSelect(mode: PermissionMode): Promise<boolean>
}

/** Host adapters: this package has no dependency on the Web application or its pickers. */
export interface ComposerDependencies {
  loadHint?: import('./hint.js').HintLoader
  subscribeHintInvalidation?: (listener: () => void) => () => void
  /** Locale-bound translate (host injects `LocaleService#t`); called during render, never cached. */
  translate: Translate
  /** Trigger plus popover for the session model; the host owns the catalog and the confirmed choice. */
  ModelPicker: ComponentType<ModelPickerProps>
  /** Trigger plus popover for the session approval mode. */
  PermissionPicker: ComponentType<PermissionPickerProps>
  /** Trigger plus popover for the draft workspace; without it the chip opens `onWorkspace` directly. */
  WorkspacePicker?: ComponentType<WorkspacePickerProps>
  UsagePanel: ComponentType<{ usage: UsageView | undefined; connected: boolean; t?: Translate }>
  /** Resize images exceeding model vision limits before upload; omission sends originals. */
  downscaleImage?(file: File, policy?: ReturnType<typeof userImagePolicy>): Promise<File>
  isSubmitShortcut(event: {
    key: string
    shiftKey: boolean
    isComposing: boolean
    keyCode: number
    metaKey: boolean
    ctrlKey: boolean
  }): boolean
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
  readOnly?: boolean
  /** `action` is the one-click way out of the state the hint describes: switch to this model. */
  hint: { kind: 'shortcut' | 'state'; text: string; action?: { label: string; model: ModelPickerOption } }
  input: {
    disabled: boolean
    placeholder: string
    exampleHint?: boolean
    hintScope?: import('./hint.js').HintScope
  }
  loading: boolean
  model: ModelPickerState
  modelSettings?: {
    settings: ModelSettings
    /** Model catalog capacity, not the budget saved for this session. */
    contextWindow: number
    thinkingLevelMap?: Record<string, string> | undefined
  }
  permission: PermissionPickerState
  queue?: {
    /** `kind` is how the item was queued: `steer` joins at the next step, others wait for the turn to end. */
    items: readonly (UIPendingInput & { editText?: string; kind?: string })[]
    disabled: boolean
    removeDisabled?: boolean
    sending?: string
    removing?: string
    promoting?: string
    interruptSupported?: boolean
    /** Whether a queued message can be turned into guidance for the next step. */
    promoteSupported?: boolean
    reason?: string
    error?: string
  }
  sending: boolean
  send: { disabled: boolean; label: string; mode: 'idle' | 'busy' | 'pending'; title: string }
  stopping: boolean
  usage: UsageView | undefined
  /** `root` is the absolute workspace path that `@` file references resolve against. */
  workspace: {
    disabled: boolean
    label: string
    title: string
    visible?: boolean
    root?: string
    /** The `~`-shortened folder shown after the name. */
    path?: string
    /** The draft runs in the daemon-managed chats workspace instead of a chosen one. */
    chats?: boolean
    /** The draft may leave its workspace for the chats workspace. */
    clearable?: boolean
    /** Registered workspaces the draft may switch to, never the chats workspace. */
    choices?: readonly WorkspaceEntry[]
  }
}

export interface ComposerHandle {
  getAttachmentBlocks(): readonly ComposerAttachmentBlock[]
  restoreAttachmentBlocks(attachments: readonly ComposerAttachmentBlock[]): void
  clearImageBlocks(): void
  focus(): void
  getDraft(): string
  getDraftReferences(): ComposerDraftReferences
  getImageBlocks(): readonly ComposerImageBlock[]
  hasPendingImages(): boolean
  render(view: ComposerView): void
  restoreImageBlocks(images: readonly ComposerImageBlock[]): void
  restoreDraftReferences(references: ComposerDraftReferences): void
  setDraft(value: string): void
  /** Name a file or folder at the caret: a chip in the text, sent as its `file://` link. */
  mention(mention: FileMention): void
  /** Insert text at the caret, as a paste does. */
  insertText?(text: string): void
  /** Send the draft as the send button would; false when the composer refuses (empty, busy, read-only). */
  submit?(): boolean
}

export type ComposerDraftReferences = Readonly<{
  files: readonly FileMention[]
  skills: readonly ComposerSkill[]
}>

export interface ComposerRegionOptions {
  references?: ComposerReferences
  skills?: ComposerSkills
  initialDraft?: string
  initialDraftReferences?: ComposerDraftReferences
  /** Localized catalog sample tasks, offered decoratively only in a new-session composer. */
  examplePrompts?: readonly string[]
  onCancel(): void
  onAttachmentsChange?(): void
  prepareUploadSession?(): Promise<string>
  onDraftChange(value: string): void
  onError(error: unknown): void
  onAuxiliaryRead?(): Promise<SessionAuxiliarySnapshot>
  onAuxiliarySelect?(slot: 'fast' | 'verifier', option: ModelPickerOption): Promise<boolean>
  onModelSelect(option: ModelPickerOption): Promise<boolean>
  onModelSettingsChange?(settings: ModelSettings): Promise<boolean>
  onPermissionSelect(mode: PermissionMode): Promise<boolean>
  /** `steer` is true for the guidance shortcut (⌘/Ctrl+Enter): while the agent runs it joins at the next step. */
  onSubmit(options?: { steer?: boolean }): void
  onChildControl?(id: string, action: 'stop' | 'continue', text?: string): Promise<void>
  onPauseResume?(): void
  onEditQueued?(itemId: string, text: string): Promise<void>
  onSendNow?(itemId: string): void
  /** Turn a queued message into guidance delivered when the current step ends. */
  onPromoteQueued?(itemId: string): void
  onRemoveQueued?(itemId: string): void
  onWorkspace(): void
  /** Switches the draft's workspace in place; `'chats'` leaves it for the managed chats workspace. */
  onWorkspaceSelect?(workspace: WorkspaceEntry | 'chats'): void
  onWorkspaceRemove?(workspace: WorkspaceEntry): void
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
  /** Rendered in the card's control row immediately before send, hidden when read-only. */
  beforeSend?: ReactNode
}

/** Session settings exist only for known models; otherwise the panel degrades to a plain model list. */
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
