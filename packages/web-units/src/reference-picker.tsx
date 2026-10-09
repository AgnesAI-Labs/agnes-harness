import type { ReferenceCandidate, ReferenceSearchResult } from '@agnes/protocol'
import { Button } from '@agnes/web-ui'
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
  getSnapshot(): readonly ReferenceCandidate[]
  subscribe(listener: () => void): () => void
  select(candidate: ReferenceCandidate): boolean
  remove(source: string, id: string): void
  clear(): void
  restore(candidates: readonly ReferenceCandidate[]): void
}

/** Locators only: the backend owns content, authorization and version receipts. */
export function createComposerReferences(
  search: ComposerReferences['search'],
  changed?: () => void,
): ComposerReferences {
  let selected: readonly ReferenceCandidate[] = []
  let scope = 0
  let request = 0
  let searching: Promise<unknown> = Promise.resolve()
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
      const next = searching
        .catch(() => {})
        .then(async () => {
          if (scope !== epoch || sequence !== request) throw new Error('Reference scope changed.')
          const result = await search(query)
          if (scope !== epoch || sequence !== request) throw new Error('Reference scope changed.')
          return result
        })
      searching = next
      return next
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
      publish([])
    },
    restore(candidates) {
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
  const match = /(?:^|\s)@([^\n@]*)$/u.exec(before)
  if (!match) return undefined
  const query = match[1] ?? ''
  return { start: before.length - query.length - 1, end: input.selectionStart, query }
}

/** One composer mount point; keyboard capture keeps Enter from submitting while choosing. */
export function ReferencePicker({
  textarea,
  adapter,
  t,
  disabled,
}: {
  textarea: RefObject<HTMLTextAreaElement>
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
  const [page, setPage] = useState<ReferenceSearchResult>({ items: [], truncated: false })
  const [opened, setOpened] = useState(false)
  const [active, setActive] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed' | 'limit'>('ready')
  const state = useRef({ page, opened, active })
  state.current = { page, opened, active }
  const choose = useRef<(candidate: ReferenceCandidate) => void>(() => {})

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
      setOpened(false)
      if (timer) clearTimeout(timer)
    }
    const query = () => {
      const token = tokenAt(input)
      if (disabledRef.current || !token) {
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
            setPage(result)
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
    choose.current = (candidate) => {
      const token = tokenAt(input)
      if (!token || disabledRef.current) return
      if (!adapter.select(candidate)) {
        setStatus('limit')
        return
      }
      input.setRangeText('', token.start, token.end, 'end')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      close()
      input.focus()
    }
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (disabledRef.current || !state.current.opened || event.isComposing) return
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
        if (item) choose.current(item)
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
                <span>
                  @{item.source} {item.label}
                </span>
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
