/** DOM-only tab controls. The caller owns selection and calls sync after it changes. */
export function createTabs<K extends string>(ids: Readonly<Record<K, string>>, panel: HTMLElement) {
  const tabs = (Object.entries(ids) as [K, string][]).map(([key, id]) => {
    const control = document.getElementById(id)
    if (!(control instanceof HTMLButtonElement)) throw new Error(`missing button#${id}`)
    return { key, control }
  })
  let listeners: Array<() => void> = []
  const dispose = (): void => {
    for (const remove of listeners) remove()
    listeners = []
  }

  return {
    bind(onSelect: (tab: K) => void): void {
      dispose()
      for (const { key, control } of tabs) {
        const onClick = (): void => {
          if (!control.disabled && control.getAttribute('aria-selected') !== 'true') onSelect(key)
        }
        const onKeydown = (event: KeyboardEvent): void => {
          if (control.disabled || event.defaultPrevented) return
          const enabled = tabs.filter((tab) => !tab.control.disabled)
          let index = enabled.findIndex((tab) => tab.control === control)
          switch (event.key) {
            case 'ArrowLeft':
            case 'ArrowUp':
              index = (index + enabled.length - 1) % enabled.length
              break
            case 'ArrowRight':
            case 'ArrowDown':
              index = (index + 1) % enabled.length
              break
            case 'Home':
              index = 0
              break
            case 'End':
              index = enabled.length - 1
              break
            default:
              return
          }
          const target = enabled[index]?.control
          if (!target) return
          event.preventDefault()
          target.focus({ preventScroll: true })
          if (target.getAttribute('aria-selected') !== 'true') target.click()
        }
        control.addEventListener('click', onClick)
        control.addEventListener('keydown', onKeydown)
        listeners.push(() => {
          control.removeEventListener('click', onClick)
          control.removeEventListener('keydown', onKeydown)
        })
      }
    },
    sync(selected: K): void {
      const current = tabs.find((tab) => tab.key === selected)
      const focusable = current?.control.disabled ? tabs.find((tab) => !tab.control.disabled) : current
      for (const tab of tabs) {
        tab.control.setAttribute('aria-selected', String(tab.key === selected))
        tab.control.setAttribute('aria-controls', panel.id)
        tab.control.tabIndex = tab === focusable ? 0 : -1
      }
      panel.setAttribute('role', 'tabpanel')
      panel.setAttribute('aria-labelledby', ids[selected])
    },
    dispose,
  }
}
