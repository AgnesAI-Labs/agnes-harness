import type { Translate } from '@agnes/web-conversation/presentation'
import {
  Button,
  createRegionHost,
  Dialog,
  Icon,
  IconButton,
  Kbd,
  renderRegion,
  SettingsInput,
  unmountRegion,
} from '@agnes/web-ui'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'

export type SessionSearchHit = {
  sessionId: string
  title: string
  workspace: string
  snippet: string
  ts: string
  seq?: number
}
export type SessionSearchPage = { items: SessionSearchHit[]; next?: string; truncated?: boolean }
export type SessionSearchInput = { query: string; title: string; workspace: string; cursor?: string }
export type SessionSearchRequest = (
  input: SessionSearchInput,
  signal: AbortSignal,
) => Promise<SessionSearchPage>
/** A session to offer before anything is typed. */
export type SessionSearchRecent = { sessionId: string; title: string; workspace: string }

export async function fetchSessionSearch(
  input: SessionSearchInput,
  signal: AbortSignal,
): Promise<SessionSearchPage> {
  const params = new URLSearchParams()
  if (input.query) params.set('q', input.query)
  if (input.title) params.set('title', input.title)
  if (input.workspace) params.set('workspace', input.workspace)
  if (input.cursor) params.set('cursor', input.cursor)
  const response = await fetch(`/api/history-search?${params.toString()}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) throw new Error('unavailable')
  const body = (await response.json()) as Partial<SessionSearchPage>
  if (!Array.isArray(body.items)) throw new Error('unavailable')
  return {
    items: body.items,
    ...(typeof body.next === 'string' ? { next: body.next } : {}),
    ...(body.truncated ? { truncated: true } : {}),
  }
}

export type SessionSearchGroup = {
  sessionId: string
  title: string
  workspace: string
  snippets: string[]
  matches: number
}

/** One entry per session, in first-hit order, keeping its first two matching lines. */
export function groupSessionHits(hits: readonly SessionSearchHit[]): SessionSearchGroup[] {
  const groups = new Map<string, SessionSearchGroup>()
  for (const hit of hits) {
    let group = groups.get(hit.sessionId)
    if (!group) {
      group = {
        sessionId: hit.sessionId,
        title: hit.title,
        workspace: hit.workspace,
        snippets: [],
        matches: 0,
      }
      groups.set(hit.sessionId, group)
    }
    group.matches += 1
    if (hit.snippet && group.snippets.length < 2 && !group.snippets.includes(hit.snippet))
      group.snippets.push(hit.snippet)
  }
  return [...groups.values()]
}

/** The index marks each match as `[match]`; split a snippet into plain and matched runs. */
export function snippetParts(snippet: string): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = []
  for (const piece of snippet.split(/(\[[^[\]]+\])/)) {
    if (!piece) continue
    const match = piece.length > 2 && piece.startsWith('[') && piece.endsWith(']')
    parts.push({ text: match ? piece.slice(1, -1) : piece, match })
  }
  return parts
}

/** ⌘K on Apple platforms, Ctrl+K elsewhere; never with another modifier held. */
export function isSessionSearchShortcut(event: KeyboardEvent | globalThis.KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
  )
}

const workspaceName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

/** The empty state is a shortcut, not the sidebar's full list; it never offers more than this. */
const RECENT_LIMIT = 8

export function SessionSearch({
  open,
  t,
  recent,
  recentStatus,
  retryRecent,
  total,
  titleOf,
  request,
  onOpen,
  onClose,
}: {
  open: boolean
  t: Translate
  recent: readonly SessionSearchRecent[]
  recentStatus?: 'loading' | 'error' | undefined
  retryRecent?: (() => void) | undefined
  /** Sessions the sidebar lists in total, for the footer note; undefined while that count is unavailable. */
  total?: number | undefined
  /** The name the sidebar shows for a session the index has no title for. */
  titleOf(sessionId: string): string | undefined
  request: SessionSearchRequest
  onOpen(sessionId: string): void
  onClose(): void
}) {
  const listId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [title, setTitle] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [filtering, setFiltering] = useState(false)
  const [hits, setHits] = useState<SessionSearchHit[]>([])
  const [next, setNext] = useState<string>()
  const [truncated, setTruncated] = useState(false)
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [active, setActive] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const moreRequest = useRef<AbortController>()
  const searching = Boolean(query.trim() || title.trim() || workspace.trim())
  useEffect(() => {
    if (open) return
    setQuery('')
    setTitle('')
    setWorkspace('')
    setFiltering(false)
  }, [open])
  // Typing replaces the results; "more" appends the next page of the same search.
  useEffect(() => {
    moreRequest.current?.abort()
    moreRequest.current = undefined
    setLoadingMore(false)
    setActive(0)
    setHits([])
    setNext(undefined)
    setTruncated(false)
    if (!open || !searching) {
      setStatus('idle')
      return
    }
    const abort = new AbortController()
    setStatus('loading')
    const timer = setTimeout(() => {
      request({ query: query.trim(), title: title.trim(), workspace: workspace.trim() }, abort.signal).then(
        (page) => {
          if (abort.signal.aborted) return
          setHits(page.items)
          setNext(page.next)
          setTruncated(Boolean(page.truncated))
          setStatus('done')
        },
        () => {
          if (!abort.signal.aborted) setStatus('error')
        },
      )
    }, 180)
    return () => {
      clearTimeout(timer)
      abort.abort()
      moreRequest.current?.abort()
    }
  }, [open, searching, query, title, workspace, request])
  const loadMore = () => {
    if (!open || !next || moreRequest.current) return
    const abort = new AbortController()
    moreRequest.current = abort
    setLoadingMore(true)
    setStatus('done')
    void request(
      { query: query.trim(), title: title.trim(), workspace: workspace.trim(), cursor: next },
      abort.signal,
    )
      .then(
        (page) => {
          if (abort.signal.aborted) return
          setHits((current) => [...current, ...page.items])
          setNext(page.next)
          setTruncated(Boolean(page.truncated))
        },
        () => {
          if (!abort.signal.aborted) setStatus('error')
        },
      )
      .finally(() => {
        if (abort.signal.aborted) return
        moreRequest.current = undefined
        setLoadingMore(false)
      })
  }
  const rows: SessionSearchGroup[] = searching
    ? groupSessionHits(hits)
    : recent.slice(0, RECENT_LIMIT).map((row) => ({ ...row, snippets: [], matches: 0 }))
  const current = rows[Math.min(active, rows.length - 1)]
  const choose = (sessionId: string) => {
    onClose()
    onOpen(sessionId)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!rows.length) return
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const index = (Math.min(active, rows.length - 1) + step + rows.length) % rows.length
      setActive(index)
      document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Enter' && current) {
      event.preventDefault()
      choose(current.sessionId)
    }
  }
  return (
    <Dialog
      open={open}
      width={600}
      footer={null}
      closable={false}
      className="session-search-dialog"
      title={<h2 className="visually-hidden">{t('home.search.title')}</h2>}
      onCancel={onClose}
      afterOpenChange={(shown) => {
        if (shown) input.current?.focus()
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move the listbox selection from either field. */}
      <div className="session-search" data-testid="session-search" onKeyDown={onKeyDown}>
        <div className="session-search-field">
          <Icon name="search" />
          <SettingsInput
            ref={input}
            type="search"
            role="combobox"
            autoComplete="off"
            spellCheck={false}
            data-testid="session-search-input"
            aria-label={t('home.search.title')}
            aria-expanded={rows.length > 0}
            aria-controls={listId}
            aria-activedescendant={current ? `${listId}-${rows.indexOf(current)}` : undefined}
            placeholder={t('home.search.placeholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <IconButton
            name="sliders-horizontal"
            data-testid="session-search-filters"
            label={t('home.search.filters')}
            aria-expanded={filtering}
            onClick={() => setFiltering((value) => !value)}
          />
        </div>
        {filtering && (
          <div className="session-search-filters">
            <SettingsInput
              data-testid="session-search-title"
              aria-label={t('home.search.byTitle')}
              placeholder={t('home.search.byTitle')}
              autoComplete="off"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <SettingsInput
              data-testid="session-search-workspace"
              aria-label={t('home.search.byWorkspace')}
              placeholder={t('home.search.byWorkspace')}
              autoComplete="off"
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
            />
          </div>
        )}
        {!searching && rows.length > 0 && (
          <p className="session-search-label">{t('home.search.recent', { count: rows.length })}</p>
        )}
        {!searching && recentStatus && (
          <p role={recentStatus === 'error' ? 'alert' : 'status'}>
            {t(recentStatus === 'error' ? 'home.search.unavailable' : 'nav.loading')}
            {recentStatus === 'error' && (
              <Button size="small" onClick={retryRecent}>
                {t('nav.retry')}
              </Button>
            )}
          </p>
        )}
        <div
          id={listId}
          className="session-search-results"
          role="listbox"
          aria-label={t('home.search.results')}
          data-testid="session-search-results"
        >
          {rows.map((row, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the field above carries the listbox keys.
            <div
              key={row.sessionId}
              id={`${listId}-${index}`}
              role="option"
              tabIndex={-1}
              className="session-search-option"
              data-testid="session-search-option"
              data-session={row.sessionId}
              aria-selected={row === current}
              onMouseMove={() => setActive(index)}
              onClick={() => choose(row.sessionId)}
            >
              <span className="session-search-option-heading">
                <strong>{row.title || titleOf(row.sessionId) || t('nav.sessionFallback')}</strong>
                {row.workspace && <span title={row.workspace}>{workspaceName(row.workspace)}</span>}
              </span>
              {row.snippets.map((snippet) => (
                <span key={snippet} className="session-search-snippet">
                  {snippetParts(snippet).map((part, position) =>
                    // biome-ignore lint/suspicious/noArrayIndexKey: runs of one snippet never reorder.
                    part.match ? <mark key={position}>{part.text}</mark> : part.text,
                  )}
                </span>
              ))}
              {row.matches > row.snippets.length && row.snippets.length > 0 && (
                <span className="session-search-count">
                  {t('home.search.moreMatches', { count: row.matches - row.snippets.length })}
                </span>
              )}
            </div>
          ))}
        </div>
        <p className="session-search-status" role="status" data-testid="session-search-status">
          {status === 'error'
            ? t('home.search.unavailable')
            : status === 'loading'
              ? t('home.search.searching')
              : searching && status === 'done' && !rows.length
                ? t('home.search.empty')
                : !searching && !rows.length
                  ? t('home.search.hint')
                  : truncated
                    ? t('home.search.capped')
                    : ''}
        </p>
        {!searching && total !== undefined && (
          // Reuse the quiet status-line styling; the footer row stays for paging and key hints.
          <p className="session-search-status" data-testid="session-search-total">
            {t('home.search.total', { count: total })}
          </p>
        )}
        <div className="session-search-footer">
          {next && (status === 'done' || status === 'error') ? (
            <Button
              appearance="ghost"
              size="small"
              className="session-search-more"
              data-testid="session-search-more"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {t('home.search.more')}
            </Button>
          ) : (
            <span />
          )}
          <span className="session-search-keys" aria-hidden="true">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            {t('home.search.keySelect')}
            <Kbd keys={['enter']} />
            {t('home.search.keyOpen')}
            <Kbd keys={['esc']} />
            {t('home.search.keyClose')}
          </span>
        </div>
      </div>
    </Dialog>
  )
}

/**
 * The session search palette: one field over the history search, results grouped by session.
 * ⌘K / Ctrl+K opens it from anywhere unless another dialog is open; the same chord closes it.
 */
export function mountSessionSearch(options: {
  translate: Translate
  recent(): readonly SessionSearchRecent[] | Promise<readonly SessionSearchRecent[]>
  /** Sessions the sidebar lists in total; read on every render so it follows the sidebar snapshot. */
  total?(): number | undefined
  titleOf?(sessionId: string): string | undefined
  open(sessionId: string): void
  request?: SessionSearchRequest
}): { open(trigger?: HTMLElement): void; refresh(): void; refreshLocale(): void; dispose(): void } {
  const host = createRegionHost(document.body, 'div')
  let opened = false
  let generation = 0
  let recent: readonly SessionSearchRecent[] = []
  let recentStatus: 'loading' | 'error' | undefined
  let returnFocus: HTMLElement | undefined
  const render = () =>
    renderRegion(
      host,
      <dialog
        open={opened}
        hidden={!opened}
        role="presentation"
        className="react-dialog-host"
        data-agnes-region="dialog"
        id="session-search-dialog"
      >
        <SessionSearch
          open={opened}
          t={options.translate}
          recent={opened ? recent : []}
          recentStatus={recentStatus}
          retryRecent={loadRecent}
          total={options.total?.()}
          titleOf={(id) => options.titleOf?.(id)}
          request={options.request ?? fetchSessionSearch}
          onOpen={options.open}
          onClose={close}
        />
      </dialog>,
    )
  function close(): void {
    if (!opened) return
    opened = false
    generation++
    render()
    if (returnFocus?.isConnected) returnFocus.focus()
    returnFocus = undefined
  }
  function loadRecent(): void {
    const epoch = ++generation
    recentStatus = 'loading'
    try {
      const value = options.recent()
      if (Array.isArray(value)) {
        recent = value
        recentStatus = undefined
        render()
        return
      }
      render()
      void Promise.resolve(value).then(
        (rows) => {
          if (!opened || epoch !== generation) return
          recent = rows
          recentStatus = undefined
          render()
        },
        () => {
          if (!opened || epoch !== generation) return
          recentStatus = 'error'
          render()
        },
      )
    } catch {
      recentStatus = 'error'
      render()
    }
  }
  const open = (trigger?: HTMLElement) => {
    if (opened) return
    returnFocus =
      trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined)
    opened = true
    loadRecent()
  }
  const onKeydown = (event: globalThis.KeyboardEvent) => {
    if (event.defaultPrevented || !isSessionSearchShortcut(event)) return
    if (opened) {
      event.preventDefault()
      close()
      return
    }
    // Another dialog keeps the keyboard; its own fields may use the chord.
    if (
      document.querySelector('dialog[open]:not(.react-dialog-host)') ||
      [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')].some(
        (wrap) => wrap.getClientRects().length > 0,
      )
    )
      return
    event.preventDefault()
    open()
  }
  document.addEventListener('keydown', onKeydown)
  render()
  return {
    open,
    refresh() {
      if (opened) render()
    },
    refreshLocale: render,
    dispose() {
      opened = false
      generation++
      document.removeEventListener('keydown', onKeydown)
      unmountRegion(host)
      host.remove()
    },
  }
}
