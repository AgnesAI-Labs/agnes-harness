import type { ComparisonListItem, ComparisonListParams, ComparisonListResult } from '@agnes/protocol'
import { comparisonCreationMessage } from './comparison-errors.js'

const phases: Record<ComparisonListItem['phase'], string> = {
  preparing: '准备中',
  ready: '已就绪',
  running: '运行中',
  partial: '部分完成',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
}
const time = (value: number | null) => {
  if (value === null) return '未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString('zh-CN')
}

/** Saved metadata only. Opening a selected pair remains the workspace's explicit operation. */
export function createComparisonHistory(
  host: HTMLElement,
  options: {
    list(input: ComparisonListParams): Promise<ComparisonListResult>
    select(id: string): Promise<void>
    active(): boolean
    canSelect(): boolean
    selected(): string | undefined
  },
) {
  const details = document.createElement('details')
  details.className = 'comparison-history'
  const summary = document.createElement('summary')
  summary.textContent = '已保存对比'
  const controls = document.createElement('div')
  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.textContent = '刷新已保存对比'
  const more = document.createElement('button')
  more.type = 'button'
  more.textContent = '加载更多对比'
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  const rows = document.createElement('ul')
  rows.className = 'comparison-history-rows'
  controls.append(refresh, more)
  details.append(summary, controls, status, rows)
  host.append(details)
  let revision = 0
  let loading = false
  let nextCursor: string | null = null
  let items: ComparisonListItem[] = []
  const buttons = new Map<string, HTMLButtonElement>()
  function render() {
    refresh.disabled = loading || !options.active()
    more.hidden = nextCursor === null
    more.disabled = loading || !options.active()
    for (const item of items) {
      const button = buttons.get(item.id)
      if (!button) continue
      button.disabled = !item.inspectable || !options.canSelect() || item.id === options.selected()
      button.setAttribute('aria-current', item.id === options.selected() ? 'true' : 'false')
    }
  }
  function drawRows() {
    buttons.clear()
    rows.replaceChildren(
      ...items.map((item) => {
        const row = document.createElement('li')
        row.dataset.comparisonId = item.id
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = `${item.id} · ${phases[item.phase]} · ${item.roundCount} 轮`
        button.addEventListener('click', () => {
          if (!item.inspectable || !options.canSelect() || item.id === options.selected()) return
          void options.select(item.id).catch((error: unknown) => {
            if (options.active())
              status.textContent = `打开失败：${comparisonCreationMessage(error) ?? (error instanceof Error ? error.message : '请重试')}`
          })
        })
        buttons.set(item.id, button)
        const facts = document.createElement('p')
        facts.textContent = `${item.lanes.map((lane) => `${lane.side === 'left' ? '左' : '右'} ${lane.runtime.id}@${lane.runtime.version}`).join(' · ')}；创建：${time(item.createdAt)}；更新：${time(item.updatedAt)}`
        row.append(button, facts)
        if (!item.inspectable) {
          const reason = document.createElement('p')
          reason.textContent =
            item.phase === 'preparing'
              ? '仍在准备，尚无可检查的双侧会话。'
              : '尚无完整的双侧会话，当前无法打开。'
          row.append(reason)
        }
        return row
      }),
    )
    render()
  }
  async function read(reset: boolean) {
    if (!options.active() || loading || (!reset && nextCursor === null)) return
    const ticket = ++revision
    loading = true
    status.textContent = '正在读取已保存对比…'
    render()
    try {
      const page = await options.list({ limit: 20, ...(!reset && nextCursor ? { cursor: nextCursor } : {}) })
      if (ticket !== revision || !options.active()) return
      const merged = new Map((reset ? [] : items).map((item) => [item.id, item]))
      for (const item of page.items) merged.set(item.id, item)
      items = [...merged.values()]
      nextCursor = page.nextCursor
      status.textContent = items.length
        ? `已显示 ${items.length} 个对比；状态为最近读取的已提交摘要。`
        : '尚无已保存对比。'
      drawRows()
    } catch (error) {
      if (ticket !== revision || !options.active()) return
      status.textContent = `列表读取失败，已显示内容保留：${error instanceof Error ? error.message : '请重试'}`
    } finally {
      if (ticket === revision) {
        loading = false
        render()
      }
    }
  }
  refresh.addEventListener('click', () => void read(true))
  more.addEventListener('click', () => void read(false))
  render()
  return {
    refresh: () => read(true),
    render,
    retire() {
      revision++
      if (loading) status.textContent = '本次列表读取已作废，可刷新重新读取。'
      loading = false
      render()
    },
  }
}
