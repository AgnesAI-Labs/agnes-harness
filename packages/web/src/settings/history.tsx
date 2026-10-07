import { type FormEvent, useState } from 'react'

export type HistoryHit = {
  sessionId: string
  title: string
  workspace: string
  snippet: string
  ts: string
  seq?: number
}

export type HistoryPageResult = { items: HistoryHit[]; next?: string; truncated?: boolean }

export type HistorySearchInput = {
  query: string
  title: string
  workspace: string
  cursor?: string
}

export type HistorySearch = (input: HistorySearchInput) => Promise<HistoryPageResult>

type Filters = { query: string; title: string; workspace: string }

async function fetchHistory(input: HistorySearchInput): Promise<HistoryPageResult> {
  const params = new URLSearchParams()
  if (input.query) params.set('q', input.query)
  if (input.title) params.set('title', input.title)
  if (input.workspace) params.set('workspace', input.workspace)
  if (input.cursor) params.set('cursor', input.cursor)
  const response = await fetch(`/api/history-search?${params.toString()}`, {
    cache: 'no-store',
    credentials: 'same-origin',
  })
  if (!response.ok) throw new Error('unavailable')
  const body = (await response.json()) as { items?: HistoryHit[]; next?: string; truncated?: boolean }
  if (!Array.isArray(body.items)) throw new Error('unavailable')
  return {
    items: body.items,
    ...(typeof body.next === 'string' ? { next: body.next } : {}),
    ...(body.truncated ? { truncated: true } : {}),
  }
}

function readFilters(form: HTMLFormElement): Filters {
  const data = new FormData(form)
  return {
    query: String(data.get('query') ?? ''),
    title: String(data.get('title') ?? ''),
    workspace: String(data.get('workspace') ?? ''),
  }
}

export function HistorySearchPanel({
  t,
  search = fetchHistory,
}: {
  t(key: string): string
  search?: HistorySearch
}) {
  const [filters, setFilters] = useState<Filters>({ query: '', title: '', workspace: '' })
  const [page, setPage] = useState<HistoryPageResult>()
  const [status, setStatus] = useState<'idle' | 'empty' | 'error'>('idle')
  const [busy, setBusy] = useState(false)

  async function run(input: Filters, cursor?: string) {
    setBusy(true)
    try {
      const result = await search({ ...input, ...(cursor ? { cursor } : {}) })
      setPage(result)
      setStatus(result.items.length === 0 ? 'empty' : 'idle')
    } catch {
      setPage(undefined)
      setStatus('error')
    } finally {
      setBusy(false)
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next = readFilters(event.currentTarget)
    setFilters(next)
    void run(next)
  }

  const next = page?.next
  return (
    <form className="history-search" data-testid="history-search-form" onSubmit={onSubmit}>
      <p>{t('historyHelp')}</p>
      <label htmlFor="history-search-query">{t('historyQuery')}</label>
      <input id="history-search-query" data-testid="history-search-query" name="query" />
      <label htmlFor="history-search-title">{t('historyTitle')}</label>
      <input id="history-search-title" data-testid="history-search-title" name="title" />
      <label htmlFor="history-search-workspace">{t('historyWorkspace')}</label>
      <input id="history-search-workspace" data-testid="history-search-workspace" name="workspace" />
      <button type="submit" data-testid="history-search-submit" disabled={busy}>
        {t('historySubmit')}
      </button>
      <p data-testid="history-search-status" role={status === 'error' ? 'alert' : 'status'}>
        {status === 'empty' ? t('historyEmpty') : status === 'error' ? t('historyUnavailable') : ''}
      </p>
      <ul data-testid="history-search-results">
        {page?.items.map((item) => (
          <li key={`${item.sessionId}:${item.seq ?? ''}:${item.ts}`} data-testid="history-hit">
            <span>{item.title || item.sessionId}</span>
            <span>{item.workspace}</span>
            <span>{item.snippet}</span>
          </li>
        ))}
      </ul>
      {next && (
        <button
          type="button"
          data-testid="history-search-next"
          disabled={busy}
          onClick={() => void run(filters, next)}
        >
          {t('historyNext')}
        </button>
      )}
      {page?.truncated && <p role="status">{t('historyCapped')}</p>}
    </form>
  )
}
