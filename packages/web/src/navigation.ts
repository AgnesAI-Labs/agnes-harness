import type { PageSessionMeta, WorkspaceEntry } from '@agnes/protocol'
import { attachSessionMenu, closeSessionMenu, createSessionMenuTrigger } from './session-menu.js'

type SessionRow = PageSessionMeta['items'][number] & { cwd?: string }

/** 客户端 `AgnesProjectFolderIcon`（`images/projectIcon_{light,dark}_{expand,collapse}.svg`）
 *  的两态字形：收起=闭口文件夹、展开=开口文件夹；原图写死的 `#676D83`/`#B9C1CE`
 *  换成 currentColor，颜色交回主题 token。切换用 `[aria-expanded]`，与客户端的
 *  `expanded` 属性同义。 */
const FOLDER_CLOSED =
  'M5.37012 2.8418C5.52719 2.84178 5.68146 2.88387 5.81641 2.96289C5.95148 3.04201 6.06232 3.15581 6.13672 3.29199L6.74414 4.40137H12.7383C13.2166 4.40139 13.6084 4.78249 13.6084 5.25391V12.6631C13.6082 13.1343 13.2165 13.5146 12.7383 13.5146H2.7627C2.28458 13.5146 1.89277 13.1343 1.89258 12.6631V3.69434C1.89258 3.22297 2.28447 2.84189 2.7627 2.8418H5.37012ZM2.83496 11.4932V12.5908H12.667V11.5645H12.666V8.00488L2.84961 7.99121L2.83496 11.4932ZM2.83496 7.06738H12.666V5.32617H6.18066L6.16016 5.28809L5.32715 3.76562H2.83496V7.06738Z'

const FOLDER_OPEN =
  'M14.8882 7.43937C14.7797 7.27754 14.6048 7.18094 14.4203 7.18094H13.0118V5.05978C13.0118 4.71287 12.7519 4.43062 12.4324 4.43062H7.94002L6.90381 3.20368C6.79449 3.07423 6.63884 3 6.47679 3H2.57931C2.25988 3 2 3.28223 2 3.62914V13.5309C2 13.784 2.19469 13.9892 2.43501 13.9894L12.5436 14C12.7867 14 13.0064 13.8332 13.0902 13.5849L14.9642 8.03053C15.0313 7.83148 15.003 7.61049 14.8882 7.43937ZM2.86667 12.1904V3.91258H6.34273L7.37891 5.1395C7.48823 5.26896 7.64389 5.3432 7.80597 5.3432H12.1451V7.18094H5.33423C5.1065 7.18094 4.89848 7.32662 4.80427 7.5521L2.86667 12.1904V12.1904ZM12.3382 13.0874H3.43876L5.52489 8.0935H14.0232L12.3382 13.0874V13.0874Z'

function folderSvg(shape: string, className: string): SVGSVGElement {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('class', className)
  icon.setAttribute('viewBox', '0 0 16 16')
  icon.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', shape)
  icon.append(path)
  return icon
}

/** 非切换场合（选择工作区、新建会话对话框）用收起态。 */
const folderIcon = () => folderSvg(FOLDER_CLOSED, 'icon icon-folder')

/** 工作区分组标题用两态字形，由 `.workspace-heading[aria-expanded]` 切换显示。 */
function folderPair(): [SVGSVGElement, SVGSVGElement] {
  return [
    folderSvg(FOLDER_CLOSED, 'icon icon-folder icon-folder-closed'),
    folderSvg(FOLDER_OPEN, 'icon icon-folder icon-folder-open'),
  ]
}

/** 已收起的工作区分组，按工作区路径记录（未分类分组用空串）。
 *
 *  这个状态不能只写在 DOM 上：`renderSessionNavigation` 每次更新都用 `replaceChildren`
 *  整体重建导航区，新建节点的属性一律按"展开"初始化，折叠态会在下一次状态更新时被抹掉。
 *  调用方（app.ts）的侧边栏更新挂在事件流上，一次回答期间会触发数十次，所以必须由
 *  这一层自己持有折叠态。键用路径而非显示名，因为显示名可被重命名。 */
const collapsedGroups = new Set<string>()

/** 清空折叠记录。供测试隔离使用，避免模块级状态跨用例泄漏。 */
export function resetCollapsedGroups(): void {
  collapsedGroups.clear()
}

export function renderWorkspaceOptions(
  container: HTMLElement,
  workspaces: readonly WorkspaceEntry[],
  select: (workspace: WorkspaceEntry) => void,
): void {
  container.replaceChildren(
    ...workspaces.map((workspace) => {
      const choice = document.createElement('button')
      choice.type = 'button'
      choice.className = 'workspace-option'
      choice.dataset.available = String(workspace.available)
      choice.disabled = !workspace.available
      const copy = document.createElement('span')
      copy.className = 'workspace-option-copy'
      const name = document.createElement('span')
      name.className = 'workspace-option-name'
      name.textContent = workspace.name
      const path = document.createElement('span')
      path.className = 'workspace-option-path'
      path.textContent = workspace.path
      copy.append(name, path)
      choice.append(folderIcon(), copy)
      choice.addEventListener('click', () => select(workspace))
      return choice
    }),
  )
}

export function renderSessionNavigation(options: {
  nav: HTMLElement
  sessions: PageSessionMeta['items']
  workspaces: readonly WorkspaceEntry[]
  currentId?: string
  activeId?: string
  labels: ReadonlyMap<string, string>
  disabled?: boolean
  next?: string
  loadMore?(cursor: string): void
  action?(action: 'rename' | 'fork' | 'archive', id: string, title: string, trigger: HTMLElement): void
  open(id: string): void
}): void {
  const groups = new Map<string, SessionRow[]>()
  for (const workspace of options.workspaces) groups.set(workspace.path, [])
  groups.set('', [])
  for (const session of options.sessions) {
    if (session.archived) continue
    const row = session as SessionRow
    ;(groups.get(row.cwd ?? '') ?? groups.get(''))?.push(row)
  }
  const fragments: HTMLElement[] = []
  for (const [path, sessions] of groups) {
    if (!sessions.length && !path) continue
    const group = document.createElement('section')
    group.className = 'workspace-group'
    const workspace = options.workspaces.find((entry) => entry.path === path)
    const collapsed = collapsedGroups.has(path)
    const heading = document.createElement('button')
    heading.type = 'button'
    heading.className = 'workspace-heading'
    heading.setAttribute('aria-expanded', String(!collapsed))
    heading.title = workspace?.path ?? '没有工作区归属的历史会话'
    const name = document.createElement('span')
    name.className = 'workspace-name'
    name.textContent = workspace?.name ?? '未分类'
    heading.append(...folderPair(), name)
    const children = document.createElement('div')
    children.className = 'workspace-sessions'
    children.hidden = collapsed
    for (const row of sessions) {
      const choice = document.createElement('button')
      choice.type = 'button'
      choice.className = row.sessionId === options.currentId ? 'session active' : 'session'
      choice.disabled = options.disabled ?? false
      choice.dataset.session = row.sessionId
      if (row.sessionId === options.currentId) choice.setAttribute('aria-current', 'page')
      const title = document.createElement('span')
      title.className = 'session-title'
      title.textContent = row.title || options.labels.get(row.sessionId) || `会话 ${row.sessionId.slice(-8)}`
      choice.title = title.textContent
      choice.append(title)
      choice.addEventListener('click', () => options.open(row.sessionId))
      const item = document.createElement('div')
      item.className = 'session-row'
      // 选中底色画在行上：底色要连行尾的动作槽一起铺满，画在内层按钮上会在动作槽左侧断掉。
      // 按钮上的 `active` 类与 `aria-current` 保留作语义标记。
      // 与模型选择器同款：`data-active` 恒为 "true"/"false"，不留"属性缺失"这种第三态。
      item.dataset.active = String(row.sessionId === options.currentId)
      item.append(choice)
      if (options.action) {
        const menu = document.createElement('div')
        menu.className = 'session-menu'
        const trigger = createSessionMenuTrigger(row.sessionId, title.textContent ?? '新会话')
        trigger.disabled = options.disabled ?? false
        attachSessionMenu(trigger, (action) =>
          options.action?.(action, row.sessionId, title.textContent ?? '新会话', trigger),
        )
        menu.append(trigger)
        item.append(menu)
      }
      children.append(item)
      if (row.sessionId === options.activeId) queueMicrotask(() => choice.focus({ preventScroll: true }))
    }
    heading.addEventListener('click', () => {
      const expanded = heading.getAttribute('aria-expanded') === 'true'
      heading.setAttribute('aria-expanded', String(!expanded))
      children.hidden = expanded
      if (expanded) collapsedGroups.add(path)
      else collapsedGroups.delete(path)
    })
    group.append(heading, children)
    fragments.push(group)
  }
  closeSessionMenu()
  options.nav.replaceChildren(...fragments)
  if (options.next && options.loadMore) {
    const next = options.next
    const more = document.createElement('button')
    more.type = 'button'
    more.textContent = '加载更多任务'
    more.disabled = options.disabled ?? false
    more.addEventListener('click', () => options.loadMore?.(next))
    options.nav.append(more)
  }
}
