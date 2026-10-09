import { useLayoutEffect, useRef, type RefObject } from 'react'
import {
  type ComposerRegionOptions,
  type ComposerView,
  type ComposerDependencies,
  type ModelPicker,
  type PermissionPicker,
  pickerState,
} from './contracts.js'

type ComposerOptions<K extends keyof ComposerRegionOptions> = { [P in K]-?: ComposerRegionOptions[P] }

export function useComposerPickers({
  dependencies,
  onError,
  onModelSelect,
  onModelSettingsChange,
  onPermissionSelect,
  view,
  model,
  permission,
  usage,
}: ComposerOptions<
  'dependencies' | 'onError' | 'onModelSelect' | 'onModelSettingsChange' | 'onPermissionSelect'
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
  }, [dependencies, onError, onModelSelect, onModelSettingsChange, onPermissionSelect])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the preceding effect replaces handles when these inputs change.
  useLayoutEffect(() => {
    modelPicker.current?.render(pickerState(view))
    permissionPicker.current?.render(view.permission)
    renderUsage.current?.(view.usage, view.connected)
  }, [view, dependencies, onError, onModelSelect, onPermissionSelect])
}
