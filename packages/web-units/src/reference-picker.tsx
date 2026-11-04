import {
  parentFileReferenceBrowse,
  type ReferenceCandidate,
  type ReferenceSearchResult,
} from '@agnes/protocol'
import { Button, fileMentionIcon, Icon } from '@agnes/web-ui'
import {
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { Translate } from './locales/index.js'

export interface ComposerReferences {
  search(query: string): Promise<ReferenceSearchResult>
  cancelSearch(): void
  getSnapshot(): readonly ReferenceCandidate[]
  subscribe(listener: () => void): () => void
  select(candidate: ReferenceCandidate): boolean
  remove(source: string, id: string): void
  clear(): void
  restore(candidates: readonly ReferenceCandidate[]): void
}

/** Locators only: the backend owns content, authorization and version receipts. */
export function createComposerReferences(
  search: (query: string, signal: AbortSignal) => Promise<ReferenceSearchResult>,
  changed?: () => void,
): ComposerReferences {
  let selected: readonly ReferenceCandidate[] = []
  let scope = 0
  let request = 0
  let active: AbortController | undefined
  const listeners = new Set<() => void>()
  const publish = (next: readonly ReferenceCandidate[]) => {
    selected = next
    for (const listener of listeners) listener()
    changed?.()
  }
  return {
    search(query) {
      const epoch = scope
      const sequence = ++request
      active?.abort()
      const controller = new AbortController()
      active = controller
      return Promise.resolve()
        .then(async () => {
          controller.signal.throwIfAborted()
          const result = await search(query, controller.signal)
          if (scope !== epoch || sequence !== request || controller.signal.aborted)
            throw new Error('Reference scope changed.')
          return result
        })
        .finally(() => {
          if (active === controller) active = undefined
        })
    },
    cancelSearch() {
      request++
      active?.abort()
      active = undefined
    },
    getSnapshot: () => selected,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    select(candidate) {
      if (selected.some((item) => item.source === candidate.source && item.id === candidate.id)) return true
      if (selected.length >= 8) return false
      publish([...selected, candidate])
      return true
    },
    remove(source, id) {
      publish(selected.filter((item) => item.source !== source || item.id !== id))
    },
    clear() {
      scope++
      active?.abort()
      active = undefined
      publish([])
    },
    restore(candidates) {
      scope++
      active?.abort()
      active = undefined
      const unique = new Map(candidates.map((item) => [`${item.source}\0${item.id}`, item]))
      publish([...unique.values()].slice(0, 8))
    },
  }
}

const empty: readonly ReferenceCandidate[] = []
const noSubscribe = () => () => {}
const emptySnapshot = () => empty
const tokenAt = (input: HTMLTextAreaElement) => {
  const before = input.value.slice(0, input.selectionStart)
  let start = -1
  let quoted = false
  for (let index = 0; index < before.length; index++) {
    const char = before[index]
    if (char === '\n') {
      start = -1
      quoted = false
    } else if (char === '@' && (index === 0 || /\s/u.test(before[index - 1] ?? '')) && !quoted) {
      start = index
      quoted = false
    } else if (char === '"' && start >= 0) quoted = !quoted
  }
  if (start < 0) return undefined
  return { start, end: input.selectionStart, query: before.slice(start + 1) }
}

/**
 * Folders among the found files: each parent folder whose name matches the query, ahead of the
 * files, so a folder can be named too. The search walks files; their folders come with them.
 */
export function withFolders(result: ReferenceSearchResult, query: string): ReferenceSearchResult {
  const wanted = query.trim().toLowerCase()
  if (!wanted) return result
  const folders = new Map<string, ReferenceCandidate>()
  for (const item of result.items) {
    if (item.source !== 'file') continue
    const parts = item.id.split('/')
    for (let depth = 1; depth < parts.length && folders.size < 5; depth++) {
      const id = parts.slice(0, depth).join('/')
      const name = parts[depth - 1] ?? ''
      if (name.toLowerCase().includes(wanted) && !folders.has(id))
        folders.set(id, { source: 'folder', id, label: id })
    }
  }
  return folders.size ? { ...result, items: [...folders.values(), ...result.items] } : result
}

const FILE_SOURCES = new Set(['file', 'folder'])
type ReferenceLayout = 'overview' | 'tabs' | 'sources'
type ReferenceSourceView = 'file' | 'session' | 'all'

const sourceItems = (items: readonly ReferenceCandidate[], source: ReferenceSourceView) =>
  source === 'all'
    ? items
    : items.filter((item) => (source === 'file' ? FILE_SOURCES.has(item.source) : item.source === 'session'))

/** One composer mount point; keyboard capture keeps Enter from submitting while choosing. */
export function ReferencePicker({
  textarea,
  edit,
  adapter,
  chooseFile,
  isChip,
  t,
  disabled,
}: {
  textarea: RefObject<HTMLTextAreaElement>
  /** The composer owns the draft; the picker asks it to replace the `@query` it consumed. */
  edit(start: number, end: number, text: string): void
  /**
   * A workspace file or folder becomes a chip in the text at the `@query` it replaces, sent as a link
   * to its path. Returns false when the composer cannot place it (no workspace yet).
   */
  chooseFile?(id: string, directory: boolean, range: { start: number; end: number }): boolean
  /** Whether the `@` at this index starts a file chip already in the text, which is not a query. */
  isChip?(index: number): boolean
  adapter?: ComposerReferences
  t: Translate
  disabled: boolean
}) {
  const selected = useSyncExternalStore(
    adapter?.subscribe ?? noSubscribe,
    adapter?.getSnapshot ?? emptySnapshot,
  )
  const listId = useId()
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const editRef = useRef(edit)
  editRef.current = edit
  const chooseFileRef = useRef(chooseFile)
  chooseFileRef.current = chooseFile
  const isChipRef = useRef(isChip)
  isChipRef.current = isChip
  const [page, setPage] = useState<ReferenceSearchResult>({ items: [], truncated: false })
  const [opened, setOpened] = useState(false)
  const [active, setActive] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed' | 'limit'>('ready')
  const [queryText, setQueryText] = useState('')
  const [layout, setLayout] = useState<ReferenceLayout>('overview')
  const [sourceView, setSourceView] = useState<ReferenceSourceView>('file')
  const [sourceChosen, setSourceChosen] = useState(false)
  const [expanded, setExpanded] = useState<string[]>([])
  const emptyBrowse = queryText === ''
  const fileItems = page.items.filter((item) => FILE_SOURCES.has(item.source))
  const sessionItems = page.items.filter((item) => item.source === 'session')
  const otherItems = page.items.filter((item) => !FILE_SOURCES.has(item.source) && item.source !== 'session')
  const focusedItems = sourceItems(page.items, sourceView)
  const groups = !emptyBrowse
    ? [{ key: 'all', items: page.items, total: page.items.length }]
    : layout === 'overview'
      ? [
          {
            key: 'file',
            items: expanded.includes('file') ? fileItems : fileItems.slice(0, 3),
            total: fileItems.length,
          },
          {
            key: 'session',
            items: expanded.includes('session') ? sessionItems : sessionItems.slice(0, 2),
            total: sessionItems.length,
          },
          {
            key: 'other',
            items: expanded.includes('other') ? otherItems : otherItems.slice(0, 2),
            total: otherItems.length,
          },
        ].filter((group) => group.total > 0)
      : [
          {
            key: sourceView,
            items: expanded.includes(`${layout}:${sourceView}`) ? focusedItems : focusedItems.slice(0, 5),
            total: focusedItems.length,
          },
        ]
  const visibleItems =
    layout === 'sources' && emptyBrowse && !sourceChosen ? [] : groups.flatMap((group) => group.items)
  const choosingSource = emptyBrowse && layout === 'sources' && !sourceChosen
  const state = useRef({ opened, active, visibleItems, choosingSource })
  state.current = { opened, active, visibleItems, choosingSource }
  const choose = useRef<(candidate: ReferenceCandidate, selectDirectory?: boolean) => void>(() => {})

  const changeLayout = (next: ReferenceLayout) => {
    setLayout(next)
    setSourceView('file')
    setSourceChosen(false)
    setExpanded([])
    setActive(0)
  }
  const changeSource = useCallback((next: ReferenceSourceView) => {
    setSourceView(next)
    setSourceChosen(true)
    setActive(0)
  }, [])

  useLayoutEffect(() => {
    void selected
    setOpened(false)
    setPage({ items: [], truncated: false })
  }, [selected])

  // The picker precedes the input in the composer; bind after all sibling refs attach.
  useEffect(() => {
    const input = textarea.current
    if (!input || !adapter) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let epoch = 0
    let disposed = false
    const close = () => {
      epoch++
      adapter.cancelSearch()
      // Native key handlers may run again before React commits the closed popup.
      state.current = { ...state.current, opened: false }
      setOpened(false)
      if (timer) clearTimeout(timer)
    }
    const query = () => {
      const token = tokenAt(input)
      if (disabledRef.current || !token || isChipRef.current?.(token.start)) {
        close()
        return
      }
      const request = ++epoch
      setQueryText(token.query)
      setOpened(true)
      setActive(0)
      setStatus('loading')
      setPage({ items: [], truncated: false })
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void adapter.search(token.query).then(
          (result) => {
            if (disposed || request !== epoch || tokenAt(input)?.query !== token.query) return
            setPage(chooseFileRef.current ? withFolders(result, token.query) : result)
            setStatus('ready')
          },
          () => {
            if (!disposed && request === epoch) {
              setStatus('failed')
              setPage({ items: [], truncated: false })
            }
          },
        )
      }, 120)
    }
    choose.current = (candidate, selectDirectory = false) => {
      const token = tokenAt(input)
      if (!token || disabledRef.current) return
      if (candidate.source === 'folder' && (!selectDirectory || !chooseFileRef.current)) {
        editRef.current(token.start, token.end, `@${/[\s@]/u.test(candidate.id) ? '"' : ''}${candidate.id}/`)
        timer = setTimeout(query, 0)
        return
      }
      if (
        FILE_SOURCES.has(candidate.source) &&
        chooseFileRef.current?.(candidate.id, candidate.source === 'folder', token)
      ) {
        close()
        return
      }
      if (!adapter.select(candidate)) {
        setStatus('limit')
        return
      }
      editRef.current(token.start, token.end, '')
      close()
    }
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (disabledRef.current || !state.current.opened || event.isComposing) return
      if (event.key === 'Backspace' && input.selectionStart === input.selectionEnd) {
        const token = tokenAt(input)
        const parent = token && parentFileReferenceBrowse(token.query)
        if (token && parent !== undefined) {
          event.preventDefault()
          event.stopPropagation()
          editRef.current(token.start, token.end, `@${parent}`)
          timer = setTimeout(query, 0)
          return
        }
      }
      const { visibleItems: current, active: index, choosingSource: sourceMenu } = state.current
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        const length = sourceMenu ? 3 : current.length
        setActive(length ? (index + (event.key === 'ArrowDown' ? 1 : length - 1)) % length : 0)
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (event.key === 'Tab' && event.shiftKey) return
        if (sourceMenu) {
          event.preventDefault()
          event.stopPropagation()
          changeSource((['file', 'session', 'all'] as const)[index] ?? 'file')
          return
        }
        if (event.key === 'Tab' && !current[index]) {
          close()
          return
        }
        event.preventDefault()
        event.stopPropagation()
        const item = current[index]
        if (item) choose.current(item, event.key === 'Tab' && item.source === 'folder')
      }
    }
    const caret = (event: globalThis.KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) query()
    }
    const blur = (event: FocusEvent) => {
      // Admission can disable the input while the backend search opens a draft session.
      if (disabledRef.current) return
      const related = event.relatedTarget as Element | null
      if (!related?.closest('[data-testid="reference-picker"]')) close()
    }
    input.addEventListener('input', query)
    input.addEventListener('click', query)
    input.addEventListener('keydown', keydown, true)
    input.addEventListener('blur', blur)
    input.addEventListener('keyup', caret)
    return () => {
      disposed = true
      epoch++
      adapter.cancelSearch()
      if (timer) clearTimeout(timer)
      for (const attr of [
        'role',
        'aria-autocomplete',
        'aria-haspopup',
        'aria-expanded',
        'aria-controls',
        'aria-activedescendant',
      ])
        input.removeAttribute(attr)
      input.removeEventListener('input', query)
      input.removeEventListener('click', query)
      input.removeEventListener('keydown', keydown, true)
      input.removeEventListener('blur', blur)
      input.removeEventListener('keyup', caret)
    }
  }, [adapter, textarea, changeSource])

  useLayoutEffect(() => {
    const input = textarea.current
    if (!input || !adapter) return
    if (opened && !disabled) {
      input.setAttribute('role', 'combobox')
      input.setAttribute('aria-autocomplete', 'list')
      input.setAttribute('aria-haspopup', 'listbox')
      input.setAttribute('aria-expanded', 'true')
    } else {
      for (const attr of ['role', 'aria-autocomplete', 'aria-haspopup', 'aria-expanded'])
        input.removeAttribute(attr)
    }
    if (opened && !disabled) input.setAttribute('aria-controls', listId)
    else input.removeAttribute('aria-controls')
    if (opened && !disabled && (visibleItems[active] || choosingSource)) {
      input.setAttribute('aria-activedescendant', `${listId}-${active}`)
      document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' })
    } else input.removeAttribute('aria-activedescendant')
  }, [adapter, textarea, opened, disabled, active, visibleItems, choosingSource, listId])
  if (!adapter) return null
  return (
    <section
      data-testid="reference-picker"
      className="composer-references"
      aria-label={t('composer.reference.label')}
    >
      {selected.length > 0 && (
        <ul className="reference-chips" data-testid="reference-draft-chips">
          {selected.map((item) => (
            <li key={`${item.source}:${item.id}`} data-source={item.source}>
              <span className="reference-draft-chip" title={item.id}>
                <span className="reference-draft-chip-icon" aria-hidden="true">
                  <Icon name={item.source === 'session' ? 'message-square' : 'link'} size={16} />
                </span>
                <span className="reference-draft-chip-label">{item.label}</span>
              </span>
              <Button
                htmlType="button"
                disabled={disabled}
                data-testid="reference-remove"
                aria-label={t('composer.reference.remove', { label: item.label })}
                onClick={() => adapter.remove(item.source, item.id)}
              >
                <Icon name="x" size={16} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {opened && !disabled && (
        <div className="reference-popup" data-layout={emptyBrowse ? layout : 'search'}>
          {emptyBrowse ? (
            <div className="reference-popup-header">
              <div>
                <strong>{t('composer.reference.title')}</strong>
                <p>{t('composer.reference.subtitle')}</p>
              </div>
              <fieldset className="reference-layout-switch" aria-label={t('composer.reference.layout')}>
                {(['overview', 'tabs', 'sources'] as const).map((mode) => (
                  <Button
                    key={mode}
                    htmlType="button"
                    aria-pressed={layout === mode}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => changeLayout(mode)}
                  >
                    {t(`composer.reference.layout.${mode}`)}
                  </Button>
                ))}
              </fieldset>
            </div>
          ) : (
            <p className="reference-help">{t('composer.reference.help')}</p>
          )}
          {emptyBrowse && layout === 'tabs' && (
            <fieldset className="reference-source-tabs" aria-label={t('composer.reference.source')}>
              {(['file', 'session', 'all'] as const).map((source) => (
                <Button
                  key={source}
                  htmlType="button"
                  aria-pressed={sourceView === source}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => changeSource(source)}
                >
                  {t(`composer.reference.source.${source}`)}
                </Button>
              ))}
            </fieldset>
          )}
          <ul
            id={listId}
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: keyboard focus is owned by the textarea.
            role="listbox"
            aria-label={t('composer.reference.label')}
            data-testid="reference-options"
          >
            {choosingSource
              ? (['file', 'session', 'all'] as const).map((source, index) => (
                  <li
                    key={source}
                    id={`${listId}-${index}`}
                    tabIndex={-1}
                    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: options use the focused textarea for keyboard navigation.
                    role="option"
                    aria-selected={active === index}
                    className={`reference-source-choice${source === 'all' ? ' reference-source-all' : ''}`}
                    onMouseDown={(event) => {
                      if (event.button !== 0) return
                      event.preventDefault()
                      changeSource(source)
                    }}
                  >
                    <span className="reference-source-icon" aria-hidden="true">
                      {source === 'session' ? '◷' : source === 'file' ? '▣' : '⌕'}
                    </span>
                    <span>
                      <strong>{t(`composer.reference.choice.${source}`)}</strong>
                      <small>{t(`composer.reference.choice.${source}.description`)}</small>
                    </span>
                    <span className="reference-source-arrow" aria-hidden="true">
                      →
                    </span>
                  </li>
                ))
              : groups.map((group) => (
                  <li key={group.key} className="reference-group" role="presentation">
                    {emptyBrowse && (
                      <div className="reference-group-heading">
                        <span>{t(`composer.reference.group.${group.key}`)}</span>
                        {group.total > group.items.length && (
                          <Button
                            htmlType="button"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                              setExpanded((current) => [
                                ...current,
                                layout === 'overview' ? group.key : `${layout}:${group.key}`,
                              ])
                              setActive(0)
                            }}
                          >
                            {t('composer.reference.viewAll')} →
                          </Button>
                        )}
                      </div>
                    )}
                    <ul role="presentation">
                      {group.items.map((item) => {
                        const index = visibleItems.indexOf(item)
                        return (
                          <li
                            tabIndex={-1}
                            id={`${listId}-${index}`}
                            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: options use the focused textarea for keyboard navigation.
                            role="option"
                            aria-selected={active === index}
                            data-testid="reference-option"
                            key={`${item.source}:${item.id}`}
                            onMouseDown={(event) => {
                              if (event.button !== 0) return
                              event.preventDefault()
                              choose.current(item)
                            }}
                          >
                            <span className="reference-option-main">
                              {FILE_SOURCES.has(item.source) && chooseFile ? (
                                <span className="reference-file">
                                  <Icon
                                    name={fileMentionIcon(item.label, item.source === 'folder')}
                                    size={16}
                                  />
                                  {item.label}
                                </span>
                              ) : (
                                <span>
                                  @{item.source} {item.label}
                                </span>
                              )}
                              {item.source === 'folder' && (
                                <span className="reference-enter">{t('composer.reference.enter')}</span>
                              )}
                            </span>
                            {item.description && <small>{item.description}</small>}
                          </li>
                        )
                      })}
                    </ul>
                  </li>
                ))}
          </ul>
          <p role="status" data-testid="reference-status">
            {status === 'loading'
              ? t('composer.reference.loading')
              : status === 'failed'
                ? t('composer.reference.failed')
                : status === 'limit'
                  ? t('composer.reference.limit')
                  : choosingSource
                    ? t('composer.reference.chooseSource')
                    : emptyBrowse && layout !== 'overview' && !visibleItems.length
                      ? t('composer.reference.emptySource')
                      : page.truncated
                        ? t('composer.reference.truncated')
                        : !visibleItems.length
                          ? t('composer.reference.empty')
                          : t('composer.reference.keyboard')}
          </p>
        </div>
      )}
    </section>
  )
}
