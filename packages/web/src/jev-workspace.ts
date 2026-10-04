import { createJevDirectStats } from './jev-stats.js'

/** Keep the existing conversation and composer together beside the decision canvas. */
export function bindJevWorkspace(root: HTMLElement, separator: HTMLElement) {
  const stats = document.createElement('div')
  stats.className = 'jev-stats-dock'
  root.querySelector('#composer-mount')?.before(stats)
  const directStats = createJevDirectStats(stats)
  const storageKey = 'agnes.jev-workspace.graph-percent'
  const setWidth = (value: number) => {
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
  const defaultWidth = () => (root.querySelector('#view-trace[aria-selected="true"]') ? 35 : 55)
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
  root.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('#view-chat, #view-trace')) return
    queueMicrotask(() => {
      if (!manual) width = setWidth(defaultWidth())
    })
  })
  const views = root.querySelectorAll<HTMLButtonElement>('[data-workspace-view]')
  const selectView = (view: string) => {
    root.dataset.view = view
    for (const peer of views) peer.setAttribute('aria-pressed', String(peer.dataset.workspaceView === view))
  }
  for (const button of views)
    button.addEventListener('click', () => {
      selectView(button.dataset.workspaceView ?? 'chat')
    })
  if (typeof ResizeObserver !== 'undefined')
    new ResizeObserver(() => {
      width = setWidth(manual ? width : defaultWidth())
      if (root.clientWidth > 780) return
      const active = document.activeElement
      if (active?.closest('.session-chat')) selectView('chat')
      else if (active?.closest('#runtime-records')) selectView('graph')
    }).observe(root)
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
  separator.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pointer !== undefined) return
    event.preventDefault()
    pointer = event.pointerId
    separator.setPointerCapture(pointer)
    separator.dataset.dragging = 'true'
  })
  separator.addEventListener('pointermove', move)
  separator.addEventListener('pointerup', (event) => {
    move(event)
    finish(event)
  })
  separator.addEventListener('pointercancel', finish)
  separator.addEventListener('lostpointercapture', finish)
  separator.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return
    event.preventDefault()
    if (event.key === 'Home') {
      reset()
      return
    }
    width = setWidth(width + (event.key === 'ArrowLeft' ? -2 : 2))
    save()
  })
  separator.addEventListener('dblclick', reset)
  return { directStats }
}
