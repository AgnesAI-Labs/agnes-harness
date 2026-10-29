import { useSyncExternalStore } from 'react'

/** Browser-local: the choice belongs to this computer, never to the account or the workspace. */
export const ADVANCED_SETTINGS_STORAGE_KEY = 'agnes.settings.advanced'

const listeners = new Set<() => void>()
let cached: boolean | undefined
let unbind: (() => void) | undefined
let memoryOnly = false

/**
 * What a stored value means. Only an explicit "off" hides the advanced settings: a browser that has
 * never chosen, or whose storage cannot be read, shows them.
 */
export function advancedSettingsValue(stored: string | null | undefined): boolean {
  return stored !== ADVANCED_SETTINGS_OFF
}

const ADVANCED_SETTINGS_OFF = '0'
const ADVANCED_SETTINGS_ON = '1'

function read(): boolean {
  try {
    const storage = globalThis.localStorage
    return storage ? advancedSettingsValue(storage.getItem(ADVANCED_SETTINGS_STORAGE_KEY)) : (cached ?? true)
  } catch {
    // Storage can be blocked; the switch then lasts for this page only.
    return cached ?? true
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
      next = advancedSettingsValue(storage.getItem(ADVANCED_SETTINGS_STORAGE_KEY))
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

/**
 * Whether 「Show advanced settings」 is on: the advanced settings group and every advanced fold follow it. On
 * unless this browser turned it off.
 */
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
    storage?.setItem(ADVANCED_SETTINGS_STORAGE_KEY, shown ? ADVANCED_SETTINGS_ON : ADVANCED_SETTINGS_OFF)
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
  return useSyncExternalStore(subscribeAdvancedSettings, advancedSettingsShown, () => true)
}
