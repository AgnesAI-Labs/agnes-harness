import type { ComparisonListItem, ComparisonListParams, ComparisonListResult } from '@agnes/protocol'
import { comparisonCreationMessage } from './comparison-errors.js'
import type { Translate } from './jev-locale.js'

const phases: Record<ComparisonListItem['phase'], string> = {
  preparing: 'chist.phase.preparing',
  ready: 'chist.phase.ready',
  running: 'chist.phase.running',
  partial: 'chist.phase.partial',
  completed: 'chist.phase.completed',
  cancelled: 'chist.phase.cancelled',
  failed: 'chist.phase.failed',
}
const time = (value: number | null, t: Translate) => {
  if (value === null) return t('chist.unknown')
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? t('chist.unknown') : date.toLocaleString('zh-CN')
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
  t: Translate,
) {
  const details = document.createElement('details')
  details.className = 'comparison-history'
  const summary = document.createElement('summary')
  summary.textContent = t('chist.title')
  const controls = document.createElement('div')
  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.textContent = t('chist.refresh')
  const more = document.createElement('button')
  more.type = 'button'
  more.textContent = t('chist.more')
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
        button.textContent = t('chist.row', {
          id: item.id,
          phase: t(phases[item.phase]),
          rounds: item.roundCount,
        })
        button.addEventListener('click', () => {
          if (!item.inspectable || !options.canSelect() || item.id === options.selected()) return
          void options.select(item.id).catch((error: unknown) => {
            if (options.active())
              status.textContent = t('chist.openFailed', {
                message:
                  comparisonCreationMessage(error, t) ??
                  (error instanceof Error ? error.message : t('chist.retry')),
              })
          })
        })
        buttons.set(item.id, button)
        const facts = document.createElement('p')
        facts.textContent = t('chist.facts', {
          lanes: item.lanes
            .map(
              (lane) =>
                `${lane.side === 'left' ? t('chist.left') : t('chist.right')} ${lane.runtime.id}@${lane.runtime.version}`,
            )
            .join(' · '),
          created: time(item.createdAt, t),
          updated: time(item.updatedAt, t),
        })
        row.append(button, facts)
        if (!item.inspectable) {
          const reason = document.createElement('p')
          reason.textContent =
            item.phase === 'preparing' ? t('chist.reasonPreparing') : t('chist.reasonIncomplete')
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
    status.textContent = t('chist.loading')
    render()
    try {
      const page = await options.list({ limit: 20, ...(!reset && nextCursor ? { cursor: nextCursor } : {}) })
      if (ticket !== revision || !options.active()) return
      const merged = new Map((reset ? [] : items).map((item) => [item.id, item]))
      for (const item of page.items) merged.set(item.id, item)
      items = [...merged.values()]
      nextCursor = page.nextCursor
      status.textContent = items.length ? t('chist.listed', { count: items.length }) : t('chist.empty')
      drawRows()
    } catch (error) {
      if (ticket !== revision || !options.active()) return
      status.textContent = t('chist.listFailed', {
        message: error instanceof Error ? error.message : t('chist.retry'),
      })
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
      if (loading) status.textContent = t('chist.retired')
      loading = false
      render()
    },
  }
}
