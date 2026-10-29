import { tr } from '@agnes/web-foundation/locale-bridge'
import { cycleTaskFocus } from './workbench/focus.js'

const getButton = (id: string) => {
  const value = document.getElementById(id)
  if (!(value instanceof HTMLButtonElement)) throw new Error(`missing button#${id}`)
  return value
}

export function bindSidebar(narrow: MediaQueryList): { close(): void; dismiss(): void; dispose(): void } {
  let readingTop: number | undefined
  const transcript = (): HTMLElement | undefined => {
    const value = document.getElementById('transcript')
    return value instanceof HTMLElement ? value : undefined
  }
  const sync = (): void => {
    const visible = narrow.matches
      ? document.body.classList.contains('sidebar-open')
      : !document.body.classList.contains('sidebar-collapsed')
    const toggle = getButton('sidebar-toggle')
    toggle.setAttribute('aria-expanded', String(visible))
    toggle.setAttribute('aria-label', visible ? tr('shell.collapseNav') : tr('shell.openNav'))
    const sidebar = document.querySelector<HTMLElement>('.sidebar')
    // A collapsed desktop sidebar is still an interactive rail. Only the closed mobile
    // drawer is off-screen and must leave the keyboard/accessibility tree.
    if (sidebar) sidebar.inert = narrow.matches && !visible
    const main = document.querySelector('main')
    if (main) main.inert = narrow.matches && visible
  }
  const hide = (): void => {
    document.body.classList.remove('sidebar-open')
    sync()
  }
  const close = (): void => {
    hide()
    readingTop = undefined
  }
  const dismiss = (): void => {
    // Only an open drawer has anything to dismiss; a closed one must not take focus.
    if (!document.body.classList.contains('sidebar-open')) return
    hide()
    getButton('sidebar-toggle').focus({ preventScroll: true })
    if (readingTop !== undefined) {
      const value = transcript()
      if (value) value.scrollTop = readingTop
      readingTop = undefined
    }
  }
  const toggle = getButton('sidebar-toggle')
  const closeButton = getButton('sidebar-close')
  const backdrop = getButton('sidebar-backdrop')
  const onToggle = () => {
    if (narrow.matches && !document.body.classList.contains('sidebar-open'))
      readingTop = transcript()?.scrollTop
    document.body.classList.toggle(narrow.matches ? 'sidebar-open' : 'sidebar-collapsed')
    sync()
    if (narrow.matches && document.body.classList.contains('sidebar-open'))
      getButton('sidebar-close').focus({ preventScroll: true })
  }
  const onDismiss = () => (narrow.matches ? dismiss() : onToggle())
  const onMediaChange = () => sync()
  const onKeydown = (event: KeyboardEvent) => {
    cycleTaskFocus(event)
    if (
      !event.defaultPrevented &&
      !document.querySelector('dialog[open]') &&
      event.key === 'Escape' &&
      document.body.classList.contains('sidebar-open')
    ) {
      dismiss()
    }
  }
  toggle.addEventListener('click', onToggle)
  narrow.addEventListener('change', onMediaChange)
  closeButton.addEventListener('click', onDismiss)
  backdrop.addEventListener('click', onDismiss)
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('agnes:locale-changed', sync)
  sync()
  return {
    close,
    dismiss,
    dispose() {
      toggle.removeEventListener('click', onToggle)
      narrow.removeEventListener('change', onMediaChange)
      closeButton.removeEventListener('click', onDismiss)
      backdrop.removeEventListener('click', onDismiss)
      document.removeEventListener('keydown', onKeydown)
      window.removeEventListener('agnes:locale-changed', sync)
    },
  }
}
