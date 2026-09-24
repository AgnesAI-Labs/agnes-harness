import { positionPopover } from '@agnes/web-admin-frame'
import type { SessionAction } from './session-actions.js'

/**
 * 会话行的三点菜单（重命名 / 分叉会话 / 归档会话）。
 *
 * 面板挂在 `body` 上而不是行内：`.sidebar` 是 `overflow: auto` 的滚动容器，行内绝对定位的面板
 * 会被它裁掉，越靠近列表底部的会话越只剩下半张菜单。落点与视口夹取沿用仓内既有的浮层基元
 * `positionPopover`，与模型选择器共用同一套算法。
 *
 * 交互设计：① 本仓保留"点外部/Escape/选中"三种关闭路径，避免鼠标顺手移开就丢菜单；
 * ② 触发按钮可 Tab 可达，菜单支持键盘导航。
 */

/** 会话菜单项定义。归档可恢复、不销毁日志，因此不标记为危险操作。 */
const ITEMS: readonly (readonly [SessionAction, string, readonly string[]])[] = [
  [
    'rename',
    '重命名',
    [
      'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
      'm15 5 4 4',
    ],
  ],
  ['fork', '分叉会话', ['M6 3v5a4 4 0 0 0 4 4h8', 'm14 8 4 4-4 4', 'M6 21v-5a4 4 0 0 1 4-4']],
  ['archive', '归档会话', ['M3 4h18v4H3z', 'M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8', 'M10 12h4']],
]

/** 24px 栅格 + `.icon`，线宽与端点样式因此自动跟随仓内图标族。 */
function icon(paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'icon')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  for (const data of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', data)
    svg.append(path)
  }
  return svg
}

let open:
  | { panel: HTMLElement; trigger: HTMLButtonElement; row: HTMLElement | null; stop(): void }
  | undefined

/**
 * 同一时刻只允许一张菜单：打开新的、列表重绘、切换会话都从这里走。
 * 面板已脱离文档流，列表 `replaceChildren` 不会带走它，重绘前必须显式关闭。
 */
export function closeSessionMenu(returnFocus = false): void {
  const current = open
  if (!current) return
  open = undefined
  current.stop()
  current.panel.remove()
  current.row?.removeAttribute('data-menu-open')
  current.trigger.setAttribute('aria-expanded', 'false')
  if (returnFocus && current.trigger.isConnected) current.trigger.focus({ preventScroll: true })
}

/** 行内可见的触发控件：16px 裸三点图标。 */
export function createSessionMenuTrigger(id: string, name: string): HTMLButtonElement {
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'session-menu-trigger'
  trigger.dataset.sessionActionId = id
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.setAttribute('aria-label', `会话操作 ${name}`)
  trigger.append(icon(['M5 12h.01', 'M12 12h.01', 'M19 12h.01']))
  return trigger
}

export function attachSessionMenu(trigger: HTMLButtonElement, select: (action: SessionAction) => void): void {
  trigger.addEventListener('click', () => {
    if (open?.trigger === trigger) closeSessionMenu(true)
    else show(trigger, select)
  })
}

function show(trigger: HTMLButtonElement, select: (action: SessionAction) => void): void {
  closeSessionMenu()
  const label = trigger.getAttribute('aria-label') ?? '会话操作'
  const panel = document.createElement('div')
  panel.className = 'session-menu-actions'
  panel.setAttribute('role', 'menu')
  panel.setAttribute('aria-label', label)
  for (const [action, text, paths] of ITEMS) {
    const item = document.createElement('button')
    item.type = 'button'
    item.setAttribute('role', 'menuitem')
    const caption = document.createElement('span')
    caption.textContent = text
    item.append(icon(paths), caption)
    item.addEventListener('click', () => {
      closeSessionMenu(true)
      select(action)
    })
    panel.append(item)
  }
  document.body.append(panel)
  // 菜单固定位置：按视口余量自适应上下，边距 12px，触发点间隙 4px。
  const place = () => positionPopover(trigger, panel, { preferredWidth: 218, preferredHeight: 128, gap: 4 })
  const dismiss = (event: PointerEvent) => {
    const target = event.target
    if (!(target instanceof Node) || panel.contains(target) || trigger.contains(target)) return
    closeSessionMenu()
  }
  // 侧栏一滚动行就移位，不重算会把面板留在被裁掉的旧坐标上。
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    closeSessionMenu(true)
  }
  // Tab 走出面板即收，不再留一张悬空菜单。
  const focusout = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof Node) || !panel.contains(event.relatedTarget)) closeSessionMenu()
  }
  document.addEventListener('pointerdown', dismiss)
  document.addEventListener('keydown', keydown)
  document.addEventListener('scroll', place, true)
  window.addEventListener('resize', place)
  panel.addEventListener('focusout', focusout)
  trigger.setAttribute('aria-expanded', 'true')
  // 行状态用显式属性而不是 CSS `:has()`：Chrome 对"元素插入后再改属性"的 `:has()` 重算不可靠
  // （实测同一份规则里 `display` 会刷新而 `background` 不会），行底色与按钮显隐都靠这个属性。
  const row = trigger.closest<HTMLElement>('.session-row')
  row?.setAttribute('data-menu-open', 'true')
  open = {
    panel,
    trigger,
    row,
    stop: () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', keydown)
      document.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      panel.removeEventListener('focusout', focusout)
    },
  }
  place()
  panel.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus({ preventScroll: true })
}
