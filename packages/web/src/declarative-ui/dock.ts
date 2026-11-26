import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { type PluginUiCard, pluginUiEntries } from './entries.js'
import { returnPluginUiFocus } from './presentation.js'

type Edge = 'right' | 'bottom'
type Selection = { edge: Edge; entry: PluginUiCard; trigger: HTMLElement | undefined }

/** This state ends with the dock's session, and never supplies a legacy tab key or saved layout. */
export function usePluginUiDock() {
  const { entries } = useSyncExternalStore(pluginUiEntries.subscribe, pluginUiEntries.getSnapshot)
  const [selection, setSelection] = useState<Selection>()
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 767)
  const active = selection && entries.includes(selection.entry) ? selection : undefined
  useEffect(() => {
    if (!active) return
    const update = () => setNarrow(window.innerWidth <= 767)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [active])
  useLayoutEffect(() => {
    if (!selection || active) return
    setSelection(undefined)
    if (document.activeElement === document.body) {
      returnPluginUiFocus(selection.trigger, document.querySelector('[data-testid="workbench-right-toggle"]'))
    }
  }, [active, selection])
  const clear = useCallback(() => setSelection(undefined), [])
  const close = useCallback(() => {
    if (!selection) return
    setSelection(undefined)
    returnPluginUiFocus(selection.trigger, document.querySelector('[data-testid="workbench-right-toggle"]'))
  }, [selection])
  return {
    entries,
    narrow,
    active,
    open(entry: PluginUiCard) {
      if (entry.placement !== 'workbench.right' && entry.placement !== 'workbench.bottom') return
      if (!pluginUiEntries.isCurrent(entry)) return
      setNarrow(window.innerWidth <= 767)
      const trigger = document.activeElement
      setSelection({
        entry,
        edge: entry.placement === 'workbench.right' ? 'right' : 'bottom',
        trigger: trigger instanceof HTMLElement ? trigger : undefined,
      })
    },
    clear,
    close,
  }
}
