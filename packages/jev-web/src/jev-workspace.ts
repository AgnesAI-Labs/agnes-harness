import type { Client } from '@agnes/sdk/browser'
import { createJevDirectStats } from './jev-stats.js'
import { createSessionAccounting } from './session-accounting.js'

/** Keep the existing conversation and composer together beside the decision canvas. */
export function bindJevWorkspace(
  surfaces: {
    root: HTMLElement
    aside: HTMLElement
    divider: HTMLElement
    footer: HTMLElement
    toolbar: HTMLElement
    chat: HTMLElement
  },
  client: Pick<Client, 'call'>,
) {
  const { root, aside, divider: separator, footer, chat } = surfaces
  const listeners = new AbortController()
  let disposed = false
  let view: 'chat' | 'trace' = 'chat'
  const priorWidth = root.style.getPropertyValue('--jev-graph-width')
  const priorDividerHidden = separator.hidden
  const priorView = root.getAttribute('data-view')
  const previousAttributes = new Map(
    [
      'role',
      'tabindex',
      'aria-label',
      'aria-orientation',
      'aria-valuemin',
      'aria-valuemax',
      'aria-valuenow',
      'data-dragging',
    ].map((name) => [name, separator.getAttribute(name)]),
  )
  separator.setAttribute('role', 'separator')
  separator.setAttribute('tabindex', '0')
  separator.setAttribute('aria-label', '调整决策图与对话宽度')
  separator.setAttribute('aria-orientation', 'vertical')
  const navigation = document.createElement('nav')
  navigation.className = 'jev-workspace-views'
  const views = ['graph', 'chat'].map((name) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.workspaceView = name
    button.textContent = name === 'graph' ? '决策图' : '对话'
    navigation.append(button)
    return button
  })
  root.prepend(navigation)
  const stats = document.createElement('div')
  stats.className = 'jev-stats-dock'
  footer.append(stats)
  const directStats = createJevDirectStats(stats)
  const accounting = createSessionAccounting(stats, client)
  const storageKey = 'agnes.jev-workspace.graph-percent'
  const setWidth = (value: number) => {
    if (disposed) return value
    const total = root.getBoundingClientRect().width
    const min = total > 780 ? Math.max(30, (320 / total) * 100) : 30
    const max = total > 780 ? Math.min(65, ((total - 369) / total) * 100) : 65
    const width = Math.min(max, Math.max(min, value))
    root.style.setProperty('--jev-graph-width', `${width}%`)
    separator.setAttribute('aria-valuemin', String(Math.round(min)))
    separator.setAttribute('aria-valuemax', String(Math.round(max)))
    separator.setAttribute('aria-valuenow', String(Math.round(width)))
    return width
  }
  let width = 55
  let manual = false
  const defaultWidth = () => (view === 'trace' ? 35 : 55)
  try {
    const saved = localStorage.getItem(storageKey)
    if (saved !== null && Number.isFinite(Number(saved))) {
      manual = true
      width = setWidth(Number(saved))
    }
  } catch {
    /* A blocked storage never prevents adjusting the workspace. */
  }
  const save = () => {
    manual = true
    try {
      localStorage.setItem(storageKey, String(width))
    } catch {
      /* Session-local fallback. */
    }
  }
  const reset = () => {
    manual = false
    width = setWidth(defaultWidth())
    try {
      localStorage.removeItem(storageKey)
    } catch {
      /* Session-local fallback. */
    }
  }
  const selectView = (view: string) => {
    root.dataset.view = view
    for (const peer of views) peer.setAttribute('aria-pressed', String(peer.dataset.workspaceView === view))
  }
  for (const button of views)
    button.addEventListener(
      'click',
      () => {
        if (!disposed) selectView(button.dataset.workspaceView ?? 'chat')
      },
      { signal: listeners.signal },
    )
  const observer =
    typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => {
          if (disposed) return
          width = setWidth(manual ? width : defaultWidth())
          if (root.clientWidth > 780) return
          const active = document.activeElement
          if (active && chat.contains(active)) selectView('chat')
          else if (active && aside.contains(active)) selectView('graph')
        })
  observer?.observe(root)
  const syncDivider = () => {
    if (!disposed) separator.hidden = aside.hidden
  }
  const visibilityObserver =
    typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(syncDivider)
  visibilityObserver?.observe(aside, { attributes: true, attributeFilter: ['hidden'] })
  syncDivider()
  let pointer: number | undefined
  const move = (event: PointerEvent) => {
    if (pointer !== event.pointerId) return
    const bounds = root.getBoundingClientRect()
    if (bounds.width > 0) width = setWidth(((event.clientX - bounds.left) / bounds.width) * 100)
  }
  const finish = (event: PointerEvent) => {
    if (pointer !== event.pointerId) return
    pointer = undefined
    separator.removeAttribute('data-dragging')
    if (separator.hasPointerCapture(event.pointerId)) separator.releasePointerCapture(event.pointerId)
    save()
  }
  separator.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || pointer !== undefined) return
      event.preventDefault()
      pointer = event.pointerId
      separator.setPointerCapture(pointer)
      separator.dataset.dragging = 'true'
    },
    { signal: listeners.signal },
  )
  separator.addEventListener('pointermove', move, { signal: listeners.signal })
  separator.addEventListener(
    'pointerup',
    (event) => {
      move(event)
      finish(event)
    },
    { signal: listeners.signal },
  )
  separator.addEventListener('pointercancel', finish, { signal: listeners.signal })
  separator.addEventListener('lostpointercapture', finish, { signal: listeners.signal })
  separator.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return
      event.preventDefault()
      if (event.key === 'Home') {
        reset()
        return
      }
      width = setWidth(width + (event.key === 'ArrowLeft' ? -2 : 2))
      save()
    },
    { signal: listeners.signal },
  )
  separator.addEventListener('dblclick', reset, { signal: listeners.signal })
  selectView('chat')
  return {
    directStats,
    accounting,
    updateView(next: 'chat' | 'trace') {
      if (disposed) return
      view = next
      if (!manual) width = setWidth(defaultWidth())
    },
    dispose() {
      if (disposed) return
      disposed = true
      listeners.abort()
      observer?.disconnect()
      visibilityObserver?.disconnect()
      separator.hidden = priorDividerHidden
      if (pointer !== undefined && separator.hasPointerCapture(pointer))
        separator.releasePointerCapture(pointer)
      pointer = undefined
      navigation.remove()
      accounting.dispose()
      stats.remove()
      if (priorWidth) root.style.setProperty('--jev-graph-width', priorWidth)
      else root.style.removeProperty('--jev-graph-width')
      if (priorView === null) root.removeAttribute('data-view')
      else root.setAttribute('data-view', priorView)
      for (const [name, value] of previousAttributes) {
        if (value === null) separator.removeAttribute(name)
        else separator.setAttribute(name, value)
      }
    },
  }
}
