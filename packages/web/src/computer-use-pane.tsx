import { SettingsComputerUse } from '@agnes/web-ui'
import { createElement, useLayoutEffect, useSyncExternalStore } from 'react'
import {
  type ComputerUseOperationPolling,
  type ComputerUseState,
  type ComputerUseStatusClient,
  type ComputerUseStatusController,
  createComputerUseState,
} from './computer-use-state.js'
import { computerUseLocale, computerUseText } from './locales/computer-use.js'

/** Web owns coordination; each real pane mount gets a fresh, independently retired state. */
export function createComputerUsePaneController(
  client: ComputerUseStatusClient,
  polling: ComputerUseOperationPolling = {},
) {
  const initial = createComputerUseState(client, polling)
  const initialSnapshot = initial.getSnapshot()
  initial.dispose()
  let snapshot = initialSnapshot
  let state: ComputerUseState | undefined
  let disposed = false
  const listeners = new Set<() => void>()
  const publish = () => {
    for (const listener of [...listeners]) listener()
  }
  const subscribe = (listener: () => void) => {
    if (disposed) return () => undefined
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const getSnapshot = () => snapshot
  const invoke = (action: Exclude<keyof ComputerUseStatusController, 'dispose'>) =>
    state?.[action]() ?? Promise.resolve()
  const controller: ComputerUseStatusController = {
    refresh: () => invoke('refresh'),
    grantPermissions: () => invoke('grantPermissions'),
    doctor: () => invoke('doctor'),
    install: () => invoke('install'),
    update: () => invoke('update'),
    restart: () => invoke('restart'),
    refreshOperation: () => invoke('refreshOperation'),
    cancelOperation: () => invoke('cancelOperation'),
    dispose() {
      if (disposed) return
      disposed = true
      retire?.()
      listeners.clear()
    },
  }
  let retire: (() => void) | undefined
  const mount = () => {
    if (disposed) return
    retire?.()
    const model = createComputerUseState(client, polling)
    state = model
    const update = () => {
      if (disposed || state !== model) return
      snapshot = model.getSnapshot()
      publish()
    }
    const unsubscribe = model.subscribe(update)
    const cleanup = () => {
      unsubscribe()
      model.dispose()
      if (state === model) state = undefined
      if (retire === cleanup) retire = undefined
    }
    retire = cleanup
    update()
    void model.refresh().then(() => {
      // A ready driver can still have maintenance running. Recover its backend ID by reading
      // the latest operation; never replay start/grant/cancel on a replacement or StrictMode mount.
      if (state === model && !model.getSnapshot().operation.record) void model.refreshOperation()
    })
    return cleanup
  }
  function ComputerUsePane() {
    const view = useSyncExternalStore(subscribe, getSnapshot)
    const locale = useSyncExternalStore((listener) => {
      window.addEventListener('agnes:locale-changed', listener)
      return () => window.removeEventListener('agnes:locale-changed', listener)
    }, computerUseLocale)
    useLayoutEffect(mount, [])
    return createElement(SettingsComputerUse, {
      view,
      actions: controller,
      text: (key) => computerUseText(key, undefined, locale),
    })
  }
  return { ...controller, render: () => createElement(ComputerUsePane) }
}
