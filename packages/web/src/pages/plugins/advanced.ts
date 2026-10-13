import { useSyncExternalStore } from 'react'

// The same browser-local switch the settings dialog writes under 「显示高级设置」.
const KEY = 'agnes.settings.advanced'

function read(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === '1'
  } catch {
    return false
  }
}
function subscribe(listener: () => void): () => void {
  // The dialog closes over this page, so the window regaining focus is when the value may differ.
  window.addEventListener('storage', listener)
  window.addEventListener('focus', listener)
  document.addEventListener('agnes:advanced-settings', listener)
  return () => {
    window.removeEventListener('storage', listener)
    window.removeEventListener('focus', listener)
    document.removeEventListener('agnes:advanced-settings', listener)
  }
}

/** Whether advanced settings are shown on this computer. */
export function useAdvancedShown(): boolean {
  return useSyncExternalStore(subscribe, read, () => false)
}
