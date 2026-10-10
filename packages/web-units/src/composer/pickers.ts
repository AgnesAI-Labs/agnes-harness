import { type RefObject, useLayoutEffect, useRef } from 'react'
import {
  type ComposerDependencies,
  type ComposerProps,
  type ComposerView,
  type ModelPicker,
  type PermissionPicker,
  pickerState,
} from './contracts.js'

type ComposerOptions<K extends keyof ComposerProps> = { [P in K]: ComposerProps[P] }

export function useComposerPickers({
  dependencies,
  onError,
  onModelSelect,
  onAuxiliaryRead,
  onAuxiliarySelect,
  onModelSettingsChange,
  onPermissionSelect,
  view,
  model,
  permission,
  usage,
}: ComposerOptions<
  | 'dependencies'
  | 'onError'
  | 'onModelSelect'
  | 'onModelSettingsChange'
  | 'onPermissionSelect'
  | 'onAuxiliaryRead'
  | 'onAuxiliarySelect'
> & {
  view: ComposerView
  model: RefObject<HTMLButtonElement>
  permission: RefObject<HTMLButtonElement>
  usage: RefObject<HTMLElement>
}) {
  const modelPicker = useRef<ModelPicker>()
  const permissionPicker = useRef<PermissionPicker>()
  const renderUsage = useRef<ReturnType<ComposerDependencies['createUsagePanel']>>()
  useLayoutEffect(() => {
    if (!model.current || !permission.current || !usage.current) return
    modelPicker.current = dependencies.createModelPicker({
      trigger: model.current,
      onError,
      onSelect: onModelSelect,
      ...(onAuxiliaryRead ? { onAuxiliaryRead } : {}),
      ...(onAuxiliarySelect ? { onAuxiliarySelect } : {}),
      ...(onModelSettingsChange ? { onSettingsChange: onModelSettingsChange } : {}),
    })
    permissionPicker.current = dependencies.createPermissionPicker({
      trigger: permission.current,
      onError,
      onSelect: onPermissionSelect,
    })
    if (!dependencies.UsagePanel)
      renderUsage.current = dependencies.createUsagePanel(usage.current, dependencies.translate)
    return () => {
      modelPicker.current?.destroy()
      permissionPicker.current?.destroy()
      modelPicker.current = undefined
      permissionPicker.current = undefined
      renderUsage.current?.dispose?.()
      renderUsage.current = undefined
    }
  }, [
    dependencies,
    onError,
    onModelSelect,
    onAuxiliaryRead,
    onAuxiliarySelect,
    onModelSettingsChange,
    onPermissionSelect,
    model,
    permission,
    usage,
  ])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the preceding effect replaces handles when these inputs change.
  useLayoutEffect(() => {
    modelPicker.current?.render(pickerState(view))
    permissionPicker.current?.render(view.permission)
    renderUsage.current?.(view.usage, view.connected)
  }, [view, dependencies, onError, onModelSelect, onPermissionSelect])
}
