import type { UsageView } from '@agnes/protocol'
import {
  createElement,
  type FormEvent,
  type ForwardedRef,
  forwardRef,
  type KeyboardEvent,
  type ReactNode,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'

export type ModelPickerOption = { id: string; route: string; label?: string }
export type ModelPickerState = {
  accessibleName: string
  disabled: boolean
  label: string
  options: readonly ModelPickerOption[]
  pending: boolean
  selected?: ModelPickerOption
}
export type ModelPicker = {
  destroy(): void
  render(state: ModelPickerState): void
}
export type PermissionMode = 'view' | 'workspace' | 'full'
export type PermissionPickerState = { disabled: boolean; pending: boolean; selected: PermissionMode }
export type PermissionPicker = {
  destroy(): void
  render(state: PermissionPickerState): void
}

/** DOM helpers remain host adapters so this package has no dependency on the Web application. */
export interface ComposerDependencies {
  createModelPicker(options: {
    trigger: HTMLButtonElement
    onError(error: unknown): void
    onSelect(option: ModelPickerOption): Promise<boolean>
  }): ModelPicker
  createPermissionPicker(options: {
    trigger: HTMLButtonElement
    onError(error: unknown): void
    onSelect(mode: PermissionMode): Promise<boolean>
  }): PermissionPicker
  createUsagePanel(parent: HTMLElement): (usage: UsageView | undefined, connected: boolean) => void
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
  cancel: { disabled: boolean; hidden: boolean; label: string }
  connected: boolean
  configured: boolean
  hasSession: boolean
  hint: { kind: 'shortcut' | 'state'; text: string }
  input: { disabled: boolean; placeholder: string }
  loading: boolean
  model: ModelPickerState
  permission: PermissionPickerState
  sending: boolean
  send: { disabled: boolean; label: string; mode: 'idle' | 'busy' | 'pending'; title: string }
  stopping: boolean
  usage: UsageView | undefined
  workspace: { disabled: boolean; label: string; title: string }
}

export interface ComposerHandle {
  focus(): void
  getDraft(): string
  render(view: ComposerView): void
  resize(): void
  setDraft(value: string): void
}

export interface ComposerRegionOptions {
  initialDraft?: string
  onCancel(): void
  onDraftChange(value: string): void
  onError(error: unknown): void
  onModelSelect(option: ModelPickerOption): Promise<boolean>
  onPermissionSelect(mode: PermissionMode): Promise<boolean>
  onSubmit(): void
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

const INITIAL_VIEW: ComposerView = {
  cancel: { disabled: true, hidden: true, label: '停止' },
  connected: false,
  configured: false,
  hasSession: false,
  hint: { kind: 'state', text: '连接后台后开始' },
  input: { disabled: true, placeholder: '描述你想完成的事…' },
  loading: false,
  model: {
    accessibleName: '选择当前会话模型',
    disabled: true,
    label: '选择模型',
    options: [],
    pending: false,
  },
  permission: { disabled: true, pending: false, selected: 'workspace' },
  sending: false,
  send: { disabled: true, label: '发送', mode: 'idle', title: '发送（Enter）' },
  stopping: false,
  usage: undefined,
  workspace: { disabled: true, label: '选择工作区', title: '选择工作区' },
}

interface ComposerProps extends ComposerRegionOptions {
  initialView?: ComposerView
  dependencies: ComposerDependencies
  slots?: ComposerSlots
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    initialDraft = '',
    initialView = INITIAL_VIEW,
    dependencies,
    onCancel,
    onDraftChange,
    onError,
    onModelSelect,
    onPermissionSelect,
    onSubmit,
    onWorkspace,
    slots,
  }: ComposerProps,
  ref: ForwardedRef<ComposerHandle>,
) {
  const [view, setView] = useState<ComposerView>(initialView)
  const form = useRef<HTMLFormElement>(null)
  const prompt = useRef<HTMLTextAreaElement>(null)
  const model = useRef<HTMLButtonElement>(null)
  const permission = useRef<HTMLButtonElement>(null)
  const usage = useRef<HTMLElement>(null)
  const modelPicker = useRef<ModelPicker>()
  const permissionPicker = useRef<PermissionPicker>()
  const renderUsage = useRef<ReturnType<ComposerDependencies['createUsagePanel']>>()

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        prompt.current?.focus()
      },
      getDraft() {
        return prompt.current?.value ?? ''
      },
      render(next) {
        flushSync(() => setView(next))
      },
      resize() {
        if (prompt.current) dependencies.resize(prompt.current)
      },
      setDraft(value) {
        if (!prompt.current || prompt.current.value === value) return
        prompt.current.value = value
        dependencies.resize(prompt.current)
      },
    }),
    [dependencies.resize],
  )

  useLayoutEffect(() => {
    if (!model.current || !permission.current || !usage.current) return
    modelPicker.current = dependencies.createModelPicker({
      trigger: model.current,
      onError,
      onSelect: onModelSelect,
    })
    permissionPicker.current = dependencies.createPermissionPicker({
      trigger: permission.current,
      onError,
      onSelect: onPermissionSelect,
    })
    renderUsage.current = dependencies.createUsagePanel(usage.current)
    return () => {
      modelPicker.current?.destroy()
      permissionPicker.current?.destroy()
      modelPicker.current = undefined
      permissionPicker.current = undefined
      renderUsage.current = undefined
    }
  }, [dependencies, onError, onModelSelect, onPermissionSelect])

  useLayoutEffect(() => {
    modelPicker.current?.render(view.model)
    permissionPicker.current?.render(view.permission)
    renderUsage.current?.(view.usage, view.connected)
  }, [view])

  return createElement(
    'form',
    {
      ref: form,
      id: 'composer',
      'data-agnes-region': 'composer',
      'data-agnes-region-owner': 'builtin',
      'data-agnes-region-unit': 'composer',
      onSubmit: (event: SubmitEvent) => {
        event.preventDefault()
        onSubmit()
      },
    },
    slots?.overlay,
    createElement(
      'div',
      { className: 'composer-writing' },
      createElement('label', { className: 'visually-hidden', htmlFor: 'prompt' }, '任务内容'),
      createElement('textarea', {
        ref: prompt,
        id: 'prompt',
        'data-agnes-region': 'composer-input',
        rows: 1,
        'aria-describedby': 'composer-hint',
        disabled: view.input.disabled,
        placeholder: view.input.placeholder,
        defaultValue: initialDraft,
        onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (
            !dependencies.isSubmitShortcut({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
              keyCode: event.keyCode,
              metaKey: event.metaKey,
              ctrlKey: event.ctrlKey,
            })
          )
            return
          event.preventDefault()
          form.current?.requestSubmit()
        },
        onInput: (event: FormEvent<HTMLTextAreaElement>) => onDraftChange(event.currentTarget.value),
      }),
      createElement('p', { id: 'composer-hint', 'data-kind': view.hint.kind }, view.hint.text),
      slots?.attachments,
    ),
    createElement(
      'div',
      { className: 'composer-controls' },
      slots?.left,
      createElement(
        'button',
        {
          id: 'composer-workspace',
          className: 'composer-workspace',
          type: 'button',
          'aria-haspopup': 'dialog',
          title: view.workspace.title,
          disabled: view.workspace.disabled,
          onClick: onWorkspace,
        },
        createElement(
          'svg',
          {
            className: 'icon icon-folder',
            'data-agnes-region': 'icon',
            viewBox: '0 0 16 16',
            'aria-hidden': true,
          },
          createElement('path', {
            d: 'M5.37012 2.8418C5.52719 2.84178 5.68146 2.88387 5.81641 2.96289C5.95148 3.04201 6.06232 3.15581 6.13672 3.29199L6.74414 4.40137H12.7383C13.2166 4.40139 13.6084 4.78249 13.6084 5.25391V12.6631C13.6082 13.1343 13.2165 13.5146 12.7383 13.5146H2.7627C2.28458 13.5146 1.89277 13.1343 1.89258 12.6631V3.69434C1.89258 3.22297 2.28447 2.84189 2.7627 2.8418H5.37012ZM2.83496 11.4932V12.5908H12.667V11.5645H12.666V8.00488L2.84961 7.99121L2.83496 11.4932ZM2.83496 7.06738H12.666V5.32617H6.18066L6.16016 5.28809L5.32715 3.76562H2.83496V7.06738Z',
          }),
        ),
        createElement('span', { 'data-workspace-label': true }, view.workspace.label),
        createElement(
          'svg',
          {
            className: 'icon model-chevron',
            'data-agnes-region': 'icon',
            viewBox: '0 0 24 24',
            'aria-hidden': true,
          },
          createElement('path', { d: 'm6 9 6 6 6-6' }),
        ),
      ),
      slots?.permission,
      createElement(
        'button',
        {
          ref: permission,
          id: 'composer-permission',
          className: 'composer-permission',
          type: 'button',
          'aria-haspopup': 'listbox',
          'aria-expanded': false,
          'aria-label': '选择本会话权限',
          title: '工作区内修改',
          disabled: view.permission.disabled,
        },
        createElement(
          'svg',
          { className: 'icon', 'data-agnes-region': 'icon', viewBox: '0 0 24 24', 'aria-hidden': true },
          createElement('path', {
            d: 'M12 3 5 6.5v5.2c0 4.4 2.9 8.4 7 9.8 4.1-1.4 7-5.4 7-9.8V6.5L12 3zm0 2.1 5 2.5v4.1c0 3.4-2.2 6.5-5 7.7-2.8-1.2-5-4.3-5-7.7V7.6l5-2.5z',
          }),
        ),
        createElement('span', { 'data-permission-label': true }, '工作区内修改'),
        createElement(
          'svg',
          {
            className: 'icon model-chevron',
            'data-agnes-region': 'icon',
            viewBox: '0 0 24 24',
            'aria-hidden': true,
          },
          createElement('path', { d: 'm6 9 6 6 6-6' }),
        ),
      ),
      slots?.model,
      slots?.right,
      slots?.plan,
      createElement(
        'div',
        { className: 'model-field' },
        createElement(
          'button',
          {
            ref: model,
            id: 'model',
            type: 'button',
            'aria-haspopup': 'listbox',
            'aria-expanded': false,
            'aria-label': view.model.accessibleName,
          },
          createElement('span', { 'data-model-label': true }, view.model.label),
          createElement(
            'svg',
            {
              className: 'icon model-chevron',
              'data-agnes-region': 'icon',
              viewBox: '0 0 24 24',
              'aria-hidden': true,
            },
            createElement('path', { d: 'm6 9 6 6 6-6' }),
          ),
        ),
      ),
      createElement('section', { ref: usage, id: 'session-usage', 'aria-label': '上下文用量', hidden: true }),
      createElement(
        'button',
        {
          id: 'cancel',
          className: 'secondary-button compact',
          type: 'button',
          hidden: view.cancel.hidden,
          disabled: view.cancel.disabled,
          onClick: onCancel,
        },
        view.cancel.label,
      ),
      createElement(
        'button',
        {
          id: 'send',
          className: 'primary-button',
          type: 'submit',
          disabled: view.send.disabled,
          'data-mode': view.send.mode,
          'aria-label': view.send.label,
          title: view.send.title,
        },
        createElement('span', null, view.send.label),
        createElement(
          'svg',
          { className: 'icon', 'data-agnes-region': 'icon', viewBox: '0 0 24 24', 'aria-hidden': true },
          createElement('path', { d: 'M12 19V5M6.5 10.5 12 5l5.5 5.5' }),
        ),
      ),
      slots?.dock,
    ),
  )
})
