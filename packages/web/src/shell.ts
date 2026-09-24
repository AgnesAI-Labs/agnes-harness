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
    toggle.setAttribute('aria-label', visible ? '收起导航' : '打开导航')
    const sidebar = document.querySelector<HTMLElement>('.sidebar')
    if (sidebar) sidebar.inert = !visible
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
  const onDismiss = () => dismiss()
  const onMediaChange = () => sync()
  const onKeydown = (event: KeyboardEvent) => {
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
      const navigation = getButton(navigationId)
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
