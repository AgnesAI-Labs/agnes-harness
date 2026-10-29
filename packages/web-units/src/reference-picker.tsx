import {
  parentFileReferenceBrowse,
  type ReferenceCandidate,
  type ReferenceSearchResult,
} from '@agnes/protocol'
import { Button, fileMentionIcon, Icon } from '@agnes/web-ui'
import {
  type RefObject,
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
  const state = useRef({ page, opened, active })
  state.current = { page, opened, active }
  const choose = useRef<(candidate: ReferenceCandidate, selectDirectory?: boolean) => void>(() => {})

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
      const { page: current, active: index } = state.current
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        setActive(
          current.items.length
            ? (index + (event.key === 'ArrowDown' ? 1 : current.items.length - 1)) % current.items.length
            : 0,
        )
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (event.key === 'Tab' && !current.items[index]) {
          close()
          return
        }
        event.preventDefault()
        event.stopPropagation()
        const item = current.items[index]
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
  }, [adapter, textarea])

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
    if (opened && !disabled && page.items[active]) {
      input.setAttribute('aria-activedescendant', `${listId}-${active}`)
      document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' })
    } else input.removeAttribute('aria-activedescendant')
  }, [adapter, textarea, opened, disabled, active, page, listId])
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
            <li key={`${item.source}:${item.id}`}>
              <span title={item.id}>
                @{item.source} {item.label}
              </span>
              <Button
                htmlType="button"
                disabled={disabled}
                data-testid="reference-remove"
                aria-label={t('composer.reference.remove', { label: item.label })}
                onClick={() => adapter.remove(item.source, item.id)}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}
      {opened && !disabled && (
        <div className="reference-popup">
          <p className="reference-help">{t('composer.reference.help')}</p>
          <ul
            id={listId}
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: keyboard focus is owned by the textarea.
            role="listbox"
            aria-label={t('composer.reference.label')}
            data-testid="reference-options"
          >
            {page.items.map((item, index) => (
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
                {FILE_SOURCES.has(item.source) && chooseFile ? (
                  <span className="reference-file">
                    <Icon name={fileMentionIcon(item.label, item.source === 'folder')} size={16} />
                    {item.label}
                  </span>
                ) : (
                  <span>
                    @{item.source} {item.label}
                  </span>
                )}
                {item.description && <small>{item.description}</small>}
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
                  : page.truncated
                    ? t('composer.reference.truncated')
                    : !page.items.length
                      ? t('composer.reference.empty')
                      : t('composer.reference.keyboard')}
          </p>
        </div>
      )}
    </section>
  )
}
