import type { Translate } from './presentation.js'

const getButton = (doc: Document, id: string) => {
  const value = doc.getElementById(id)
  if (!(value instanceof HTMLButtonElement)) throw new Error(`missing button#${id}`)
  return value
}

/**
 * Binds the sidebar controls inside `root`, found by class so that two workbenches in one document
 * never share them. Body classes, `inert` and the Escape listener stay on the root's document.
 */
export function bindSidebar(
  narrow: MediaQueryList,
  root: HTMLElement,
  t: Translate,
): { close(): void; dismiss(): void; dispose(): void } {
  const doc = root.ownerDocument
  const control = (name: string) => {
    const value = root.querySelector(`.${name}`)
    if (!(value instanceof HTMLButtonElement)) throw new Error(`missing button.${name}`)
    return value
  }
  let readingTop: number | undefined
  const transcript = (): HTMLElement | undefined =>
    root.querySelector<HTMLElement>('.transcript') ?? undefined
  const sync = (): void => {
    const visible = narrow.matches
      ? doc.body.classList.contains('sidebar-open')
      : !doc.body.classList.contains('sidebar-collapsed')
    const toggle = control('sidebar-toggle')
    toggle.setAttribute('aria-expanded', String(visible))
    toggle.setAttribute('aria-label', visible ? t('shell.collapseNav') : t('shell.openNav'))
    const sidebar = root.querySelector<HTMLElement>('.sidebar')
    if (sidebar) sidebar.inert = !visible
    const main = root.querySelector('main')
    if (main) main.inert = narrow.matches && visible
  }
  const hide = (): void => {
    doc.body.classList.remove('sidebar-open')
    sync()
  }
  const close = (): void => {
    hide()
    readingTop = undefined
  }
  const dismiss = (): void => {
    hide()
    control('sidebar-toggle').focus({ preventScroll: true })
    if (readingTop !== undefined) {
      const value = transcript()
      if (value) value.scrollTop = readingTop
      readingTop = undefined
    }
  }
  const toggle = control('sidebar-toggle')
  const closeButton = control('sidebar-close')
  const backdrop = control('sidebar-backdrop')
  const onToggle = () => {
    if (narrow.matches && !doc.body.classList.contains('sidebar-open')) readingTop = transcript()?.scrollTop
    doc.body.classList.toggle(narrow.matches ? 'sidebar-open' : 'sidebar-collapsed')
    sync()
    if (narrow.matches && doc.body.classList.contains('sidebar-open'))
      closeButton.focus({ preventScroll: true })
  }
  const onDismiss = () => dismiss()
  const onMediaChange = () => sync()
  const onKeydown = (event: KeyboardEvent) => {
    if (
      !event.defaultPrevented &&
      !doc.querySelector('dialog[open]') &&
      event.key === 'Escape' &&
      doc.body.classList.contains('sidebar-open')
    ) {
      dismiss()
    }
  }
  toggle.addEventListener('click', onToggle)
  narrow.addEventListener('change', onMediaChange)
  closeButton.addEventListener('click', onDismiss)
  backdrop.addEventListener('click', onDismiss)
  doc.addEventListener('keydown', onKeydown)
  sync()
  return {
    close,
    dismiss,
    dispose() {
      toggle.removeEventListener('click', onToggle)
      narrow.removeEventListener('change', onMediaChange)
      closeButton.removeEventListener('click', onDismiss)
      backdrop.removeEventListener('click', onDismiss)
      doc.removeEventListener('keydown', onKeydown)
    },
  }
}

// 第三项是 rail 上的入口按钮 id。技能与 MCP 拆成两条独立 Tab（共用同一个面板），
// 所以这里允许一项对应多个入口。
const SETTINGS = [
  ['model', 'model-settings-pane', ['model-settings']],
  ['plugin', 'plugin-settings-pane', ['plugin-management']],
  ['resources', 'resource-settings-pane', ['skills-tab', 'mcp-tab']],
  ['archived', 'archived-settings-pane', ['archived-settings']],
  ['computer-use', 'computer-use-settings-pane', ['computer-use-management']],
  ['appearance', 'appearance-settings-pane', ['appearance-settings']],
] as const
export function showSettingsPane(pane: (typeof SETTINGS)[number][0]): void {
  for (const [name, paneId, navigationIds] of SETTINGS) {
    const content = document.getElementById(paneId)
    if (!(content instanceof HTMLElement)) throw new Error('missing settings panes')
    const selected = pane === name
    content.hidden = !selected
    for (const navigationId of navigationIds) {
      const navigation = getButton(document, navigationId)
      // 「技能 / MCP」这两个入口同时也是资源类型的切换器，高亮跟着 aria-selected 走，
      // 否则两条 Tab 会同时亮（面板里真正在看哪一类就分不出来了）。
      const highlighted = navigation.hasAttribute('aria-selected')
        ? selected && navigation.getAttribute('aria-selected') === 'true'
        : selected
      navigation.classList.toggle('active', highlighted)
      navigation.toggleAttribute('aria-current', highlighted)
      if (highlighted) navigation.setAttribute('aria-current', 'page')
    }
  }
}
