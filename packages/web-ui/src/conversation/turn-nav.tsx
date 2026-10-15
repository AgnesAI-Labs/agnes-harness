import type { UINode, UITurn } from '@agnes/protocol'
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useDocumentLanguage } from '../document-language.js'
import type { Translate } from '../locales/index.js'
import { Button } from '../ui/button.js'
import { TURN_STATUS_KEYS } from './messages/turn.js'
import {
  currentTurn,
  nearestTick,
  RAIL_MIN_GUTTER,
  railHidden,
  TICK,
  type TurnNavEntry,
  tickGap,
  tickWidth,
  toggleBookmark,
  turnNavEntries,
} from './turn-nav-model.js'

export interface TurnNavProps {
  t: Translate
  nodes: readonly UINode[]
  turns?: readonly UITurn[] | undefined
  /** The scrolling transcript. The rail is drawn over its non-scrolling parent, left of the messages. */
  viewport: HTMLElement | null
  /** Saved bookmarks (entry ids). Undefined when the host cannot save them: no bookmark control. */
  bookmarks?: readonly string[] | undefined
  /** Save the whole list; a rejection puts the previous list back. */
  onBookmarksChange?: ((next: readonly string[]) => Promise<unknown>) | undefined
  /** Older prompts exist before the loaded window; ⌥↑ on the first loaded prompt loads them. */
  hasEarlier?: boolean | undefined
  loadEarlier?: (() => void) | undefined
}

/** How long the reader's bubble stays highlighted after a jump, and the card's hide delay. */
export const TURN_NAV_FLASH_MS = 1200
const HIDE_DELAY_MS = 160

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
    target.closest('[role="dialog"],[role="menu"],[role="listbox"],[contenteditable="true"]') !== null)

function anchorOf(viewport: HTMLElement, entry: TurnNavEntry): HTMLElement | null {
  return viewport.querySelector<HTMLElement>(
    `[${entry.anchor.attribute}="${CSS.escape(entry.anchor.value)}"]`,
  )
}

function timeLabel(iso: string | undefined, language: string): string {
  const at = iso ? new Date(iso) : undefined
  if (!at || Number.isNaN(at.getTime())) return ''
  const today = new Date().toDateString() === at.toDateString()
  return new Intl.DateTimeFormat(language || undefined, {
    ...(today ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(at)
}

const BOOKMARK_PATH =
  'M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z'

/** Bring a prompt into view and highlight the reader's bubble briefly. */
export function scrollToTurn(viewport: HTMLElement, entry: TurnNavEntry): boolean {
  const target = anchorOf(viewport, entry)
  if (!target) return false
  const top = Math.max(
    0,
    viewport.scrollTop + target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 16,
  )
  const still = reducedMotion()
  const distance = top - viewport.scrollTop
  // A long way off, gliding the whole distance takes seconds: arrive within a screen at once and
  // glide only the last stretch, so the reader still sees which way the conversation moved.
  if (!still && Math.abs(distance) > viewport.clientHeight * 1.5) {
    const behavior = viewport.style.scrollBehavior
    viewport.style.scrollBehavior = 'auto'
    viewport.scrollTop = top - Math.sign(distance) * viewport.clientHeight
    viewport.style.scrollBehavior = behavior
  }
  viewport.scrollTo({ top, behavior: still ? 'auto' : 'smooth' })
  target.setAttribute('data-turn-nav-flash', 'true')
  setTimeout(() => target.removeAttribute('data-turn-nav-flash'), TURN_NAV_FLASH_MS)
  return true
}

/**
 * The prompt navigator: one tick per prompt along the conversation's left edge. Ticks near the
 * pointer lengthen, the hovered one shows a preview card, a click scrolls to that prompt. ⌥↑ / ⌥↓
 * move between prompts even when the rail itself has no room to show.
 */
export function TurnNav({
  t,
  nodes,
  turns,
  viewport,
  bookmarks,
  onBookmarksChange,
  hasEarlier,
  loadEarlier,
}: TurnNavProps) {
  const language = useDocumentLanguage()
  const entries = useMemo(() => turnNavEntries(nodes, turns), [nodes, turns])
  const [current, setCurrent] = useState(0)
  const [hover, setHover] = useState<number | undefined>(undefined)
  const [pointer, setPointer] = useState<number | undefined>(undefined)
  const [focusWithin, setFocusWithin] = useState(false)
  const [focusIndex, setFocusIndex] = useState<number | undefined>(undefined)
  const [layout, setLayout] = useState({ hidden: true, paneHeight: 0 })
  // The newest unsaved list and the change that made it. It stays until that change settles: an
  // earlier change's response never replaces it, and only its own failure rolls it back.
  const [optimistic, setOptimistic] = useState<{ version: number; list: readonly string[] } | undefined>(
    undefined,
  )
  const changeVersion = useRef(0)
  const [failed, setFailed] = useState(false)
  const [cardTop, setCardTop] = useState(0)
  const rail = useRef<HTMLElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const ticks = useRef<(HTMLElement | null)[]>([])
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const marks = optimistic?.list ?? bookmarks
  const host = viewport?.parentElement ?? null
  const count = entries.length
  const gap = tickGap(count, layout.paneHeight)
  const pitch = gap + TICK.line

  // Which prompt is being read follows the scroll position.
  const measure = useCallback(() => {
    if (!viewport) return
    const top = viewport.getBoundingClientRect().top
    const tops = entries.map((entry) => {
      const element = anchorOf(viewport, entry)
      return element ? element.getBoundingClientRect().top - top : Number.POSITIVE_INFINITY
    })
    setCurrent(currentTurn(tops, viewport.clientHeight))
  }, [viewport, entries])
  useLayoutEffect(() => {
    if (!viewport) return
    measure()
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      viewport.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [viewport, measure])

  // The rail shows only where there is room left of the messages.
  useLayoutEffect(() => {
    if (!viewport) return
    const update = () => {
      const messages = viewport.querySelector<HTMLElement>('[data-agnes-conversation-messages]')
      const gutter = messages
        ? messages.getBoundingClientRect().left - viewport.getBoundingClientRect().left
        : RAIL_MIN_GUTTER
      const hidden = railHidden({ count, viewportWidth: window.innerWidth, gutter })
      const paneHeight = viewport.clientHeight
      setLayout((previous) =>
        previous.hidden === hidden && previous.paneHeight === paneHeight ? previous : { hidden, paneHeight },
      )
    }
    update()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : undefined
    observer?.observe(viewport)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [viewport, count])

  const go = useCallback(
    (index: number) => {
      const entry = entries[index]
      if (!viewport || !entry) return
      if (scrollToTurn(viewport, entry)) setCurrent(index)
    },
    [viewport, entries],
  )

  // ⌥↑ / ⌥↓: previous / next prompt. ⌥↑ inside a long answer first returns to its own prompt.
  useEffect(() => {
    if (!viewport) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.defaultPrevented) return
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      if (editable(event.target) || viewport.getClientRects().length === 0 || entries.length === 0) return
      event.preventDefault()
      const up = event.key === 'ArrowUp'
      const here = entries[current]
      const anchor = here && anchorOf(viewport, here)
      const above = anchor
        ? anchor.getBoundingClientRect().top < viewport.getBoundingClientRect().top - 4
        : false
      if (up && above) return go(current)
      const next = current + (up ? -1 : 1)
      if (next < 0) {
        if (hasEarlier) loadEarlier?.()
        return
      }
      if (next < entries.length) go(next)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [viewport, entries, current, go, hasEarlier, loadEarlier])

  useEffect(() => () => clearTimeout(hideTimer.current), [])

  const shown = hover !== undefined ? entries[hover] : undefined
  useLayoutEffect(() => {
    if (hover === undefined || !host) return
    const tick = ticks.current[hover]
    if (!tick) return
    const hostTop = host.getBoundingClientRect().top
    const top = tick.getBoundingClientRect().top - hostTop - 40
    const height = card.current?.offsetHeight ?? 0
    setCardTop(Math.max(8, Math.min(top, host.clientHeight - height - 8)))
  }, [hover, host])

  // Keep the current tick in view when a very long rail scrolls.
  useLayoutEffect(() => {
    const element = rail.current
    const tick = ticks.current[current]
    if (layout.hidden || !element || !tick || element.scrollHeight <= element.clientHeight) return
    const offset = tick.offsetTop - element.clientHeight / 2
    element.scrollTop = Math.max(0, offset)
  }, [current, layout.hidden])

  if (!host || layout.hidden) return null

  const show = (index: number) => {
    clearTimeout(hideTimer.current)
    setFailed(false)
    setHover(index)
  }
  const scheduleHide = () => {
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      setHover(undefined)
      setPointer(undefined)
    }, HIDE_DELAY_MS)
  }
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const first = ticks.current[0]
    if (!first) return
    const box = first.getBoundingClientRect()
    const centre = box.top + box.height / 2
    const y = event.clientY - centre
    setPointer(y)
    show(nearestTick(y, pitch, count))
  }
  const focusTick = (index: number) => {
    const next = Math.max(0, Math.min(count - 1, index))
    setFocusIndex(next)
    ticks.current[next]?.focus()
  }
  const onTickKey = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (event.altKey) return
    if (event.key === 'Enter') {
      event.preventDefault()
      go(index)
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      focusTick(index + (event.key === 'ArrowUp' ? -1 : 1))
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusTick(event.key === 'Home' ? 0 : count - 1)
    } else if (event.key === 'Escape') {
      setHover(undefined)
    }
  }
  const toggle = (entry: TurnNavEntry) => {
    if (!marks || !onBookmarksChange) return
    const next = toggleBookmark(marks, entry.id)
    const version = ++changeVersion.current
    setOptimistic({ version, list: next })
    setFailed(false)
    const settle = (ok: boolean) => {
      // A newer change owns the list on screen; this one's outcome no longer decides it.
      if (changeVersion.current !== version) return
      setOptimistic(undefined)
      if (!ok) setFailed(true)
    }
    onBookmarksChange(next).then(
      () => settle(true),
      () => settle(false),
    )
  }
  const still = reducedMotion()
  const tabStop = focusIndex ?? current
  const marked = shown ? marks?.includes(shown.id) === true : false
  const replyText = (entry: TurnNavEntry): { lead: string; more?: string | undefined } => {
    const reply = entry.reply
    if (reply.kind === 'text') return reply
    if (reply.kind === 'streaming') return { lead: t('turnNav.streaming') }
    if (reply.kind === 'tools')
      return { lead: t(reply.count === 1 ? 'turnNav.tools.one' : 'turnNav.tools', { n: reply.count }) }
    if (reply.kind === 'status') return { lead: t(TURN_STATUS_KEYS[reply.status]) }
    return { lead: t('turnNav.noReply') }
  }
  const reply = shown ? replyText(shown) : undefined

  return createPortal(
    <div className="turn-nav" data-testid="turn-nav">
      <nav
        ref={rail}
        className="turn-nav-rail"
        aria-label={t('turnNav.label')}
        data-dense={count > TICK.denseFrom ? 'true' : undefined}
        onPointerMove={onPointerMove}
        onPointerLeave={() => {
          setPointer(undefined)
          scheduleHide()
        }}
        onFocus={() => setFocusWithin(true)}
        onBlur={(event) => {
          if (event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) return
          setFocusWithin(false)
          setFocusIndex(undefined)
          scheduleHide()
        }}
      >
        <ol className="turn-nav-list">
          {entries.map((entry, index) => {
            const isCurrent = index === current
            const bookmarked = marks?.includes(entry.id) === true
            const distance = pointer === undefined ? undefined : pointer - index * pitch
            return (
              <li key={entry.id} className="turn-nav-item" style={{ height: pitch }}>
                <span
                  ref={(element) => {
                    ticks.current[index] = element
                  }}
                  role="link"
                  tabIndex={index === tabStop ? 0 : -1}
                  className="turn-nav-tick"
                  data-testid="turn-nav-tick"
                  data-prompt-id={entry.id}
                  data-current={isCurrent ? 'true' : undefined}
                  data-hot={index === hover ? 'true' : undefined}
                  data-bookmarked={bookmarked ? 'true' : undefined}
                  aria-current={isCurrent ? 'location' : undefined}
                  aria-label={t(bookmarked ? 'turnNav.tickBookmarked' : 'turnNav.tick', {
                    n: entry.number,
                    prompt: entry.prompt,
                  })}
                  style={{ width: tickWidth(distance, isCurrent, still) }}
                  onClick={() => go(index)}
                  onKeyDown={(event) => onTickKey(event, index)}
                  onFocus={() => {
                    setFocusIndex(index)
                    show(index)
                  }}
                />
              </li>
            )
          })}
        </ol>
      </nav>
      {/* A click on the card is a pointer shortcut; the tick it previews is the keyboard's link. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: duplicates the previewed tick's link */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Enter on the previewed tick does the same */}
      <div
        ref={card}
        className="turn-nav-card"
        data-testid="turn-nav-card"
        data-open={shown && (hover !== undefined || focusWithin) ? 'true' : undefined}
        hidden={!shown}
        style={{ top: cardTop }}
        onPointerEnter={() => clearTimeout(hideTimer.current)}
        onPointerLeave={scheduleHide}
        onFocus={() => {
          clearTimeout(hideTimer.current)
          setFocusWithin(true)
        }}
        onBlur={(event) => {
          if (event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) return
          setFocusWithin(false)
          scheduleHide()
        }}
        onClick={(event) => {
          if ((event.target as Element).closest('.turn-nav-bookmark') || hover === undefined) return
          go(hover)
        }}
      >
        {shown && reply && (
          <>
            <p className="turn-nav-card-meta">
              <span>{t('turnNav.number', { n: shown.number })}</span>
              <span>{timeLabel(shown.startedAt, language)}</span>
            </p>
            <p className="turn-nav-card-prompt" data-testid="turn-nav-card-prompt">
              {shown.prompt}
            </p>
            <p className="turn-nav-card-reply" data-testid="turn-nav-card-reply" data-kind={shown.reply.kind}>
              {reply.lead}
            </p>
            {reply.more && (
              <p className="turn-nav-card-more" data-testid="turn-nav-card-more">
                {reply.more}
              </p>
            )}
            {failed && (
              <p className="turn-nav-card-error" role="status">
                {t('turnNav.bookmarkFailed')}
              </p>
            )}
            {marks && onBookmarksChange && (
              <Button
                appearance="ghost"
                size="small"
                className="turn-nav-bookmark"
                data-testid="turn-nav-bookmark"
                aria-pressed={marked}
                aria-label={t(marked ? 'turnNav.unbookmark' : 'turnNav.bookmark')}
                title={t(marked ? 'turnNav.unbookmark' : 'turnNav.bookmark')}
                onClick={() => toggle(shown)}
                icon={
                  <svg
                    viewBox="0 0 24 24"
                    width={16}
                    height={16}
                    fill={marked ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="turn-nav-bookmark-icon"
                  >
                    <path d={BOOKMARK_PATH} />
                  </svg>
                }
              />
            )}
          </>
        )}
      </div>
    </div>,
    host,
  )
}
