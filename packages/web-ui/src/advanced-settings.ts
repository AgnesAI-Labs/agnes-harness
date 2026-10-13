import { useSyncExternalStore } from 'react'

/** Browser-local: the choice belongs to this computer, never to the account or the workspace. */
export const ADVANCED_SETTINGS_STORAGE_KEY = 'agnes.settings.advanced'

const listeners = new Set<() => void>()
let cached: boolean | undefined
let bound = false

function read(): boolean {
  try {
    return globalThis.localStorage?.getItem(ADVANCED_SETTINGS_STORAGE_KEY) === '1'
  } catch {
    // Storage can be blocked; the switch then lasts for this page only.
    return false
  }
}

function emit(): void {
  for (const listener of [...listeners]) listener()
}

function bind(): void {
  if (bound || typeof window === 'undefined') return
  bound = true
  // Another tab changed the switch: follow it.
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== ADVANCED_SETTINGS_STORAGE_KEY) return
    const next = read()
    if (next === cached) return
    cached = next
    emit()
  })
}

/** Whether 「显示高级设置」 is on: the advanced settings group and every advanced fold follow it. */
export function advancedSettingsShown(): boolean {
  if (cached === undefined) cached = read()
  return cached
}

export function setAdvancedSettingsShown(shown: boolean): void {
  if (advancedSettingsShown() === shown) return
  cached = shown
  try {
    if (shown) globalThis.localStorage?.setItem(ADVANCED_SETTINGS_STORAGE_KEY, '1')
    else globalThis.localStorage?.removeItem(ADVANCED_SETTINGS_STORAGE_KEY)
  } catch {
    // Kept in memory for this page.
  }
  emit()
}

export function subscribeAdvancedSettings(listener: () => void): () => void {
  bind()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useAdvancedSettings(): boolean {
  return useSyncExternalStore(subscribeAdvancedSettings, advancedSettingsShown, () => false)
}
