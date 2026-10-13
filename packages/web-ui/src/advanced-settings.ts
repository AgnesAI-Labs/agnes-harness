import { useSyncExternalStore } from 'react'

/** Browser-local: the choice belongs to this computer, never to the account or the workspace. */
export const ADVANCED_SETTINGS_STORAGE_KEY = 'agnes.settings.advanced'

const listeners = new Set<() => void>()
let cached: boolean | undefined
let unbind: (() => void) | undefined
let memoryOnly = false

function read(): boolean {
  try {
    const storage = globalThis.localStorage
    return storage ? storage.getItem(ADVANCED_SETTINGS_STORAGE_KEY) === '1' : (cached ?? false)
  } catch {
    // Storage can be blocked; the switch then lasts for this page only.
    return cached ?? false
  }
}

function emit(): void {
  for (const listener of [...listeners]) listener()
}

function bind(): void {
  if (unbind || typeof window === 'undefined') return
  if (!memoryOnly) cached = read()
  const target = window
  // Another tab changed the switch: follow it.
  const changed = (event: StorageEvent) => {
    if (event.key !== null && event.key !== ADVANCED_SETTINGS_STORAGE_KEY) return
    let next: boolean
    try {
      const storage = globalThis.localStorage
      if (!storage || (event.storageArea && event.storageArea !== storage)) return
      next = storage.getItem(ADVANCED_SETTINGS_STORAGE_KEY) === '1'
      memoryOnly = false
    } catch {
      return
    }
    if (next === cached) return
    cached = next
    emit()
  }
  target.addEventListener('storage', changed)
  unbind = () => target.removeEventListener('storage', changed)
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
    const storage = globalThis.localStorage
    memoryOnly = !storage
    if (shown) storage?.setItem(ADVANCED_SETTINGS_STORAGE_KEY, '1')
    else storage?.removeItem(ADVANCED_SETTINGS_STORAGE_KEY)
  } catch {
    // Kept in memory for this page.
    memoryOnly = true
  }
  emit()
}

export function subscribeAdvancedSettings(listener: () => void): () => void {
  bind()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      unbind?.()
      unbind = undefined
    }
  }
}

export function useAdvancedSettings(): boolean {
  return useSyncExternalStore(subscribeAdvancedSettings, advancedSettingsShown, () => false)
}
