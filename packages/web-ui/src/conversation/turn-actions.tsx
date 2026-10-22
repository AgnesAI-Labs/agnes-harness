import type { UITurn } from '@agnes/protocol'
import {
  type ReactNode,
  type Ref,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { legacyCopy } from '../clipboard.js'
import { reportSuccess, StatusMessage } from '../feedback.js'
import { fallbackT, type Translate } from '../locales/index.js'
import { Button } from '../ui/button.js'
import { Disclosure } from '../ui/disclosure.js'
import { Icon as SharedIcon } from '../ui/icon.js'
import { Actions } from '../x/index.js'
import { TurnUsagePanel } from './turn-usage.js'
import { ConversationXScope } from './x-scope.js'

export interface ConversationTurnFeedback {
  clear(): void
  report(message: string, durationMs?: number): void
}

export interface ConversationTurnActionsProps {
  turn: UITurn
  finalText: string
  settled: boolean
  /** Locale-bound translate injected by the host; render-time lookup only. */
  t?: Translate
  /** Current locale tag for date formatting; defaults to en-US. */
  localeTag?: string
  onFork?: (turn: UITurn) => Promise<void>
  feedbackRef?: Ref<ConversationTurnFeedback>
  /** Host actions that belong to the same bar: rating and plugin contributions for this answer. */
  extra?: ReactNode
  /** Host marks shown first in the bar, before copy (for example «answered» on an asking answer). */
  leading?: ReactNode
}

const ACTION_BUTTON = { htmlType: 'button', appearance: 'ghost', size: 'small' } as const

const durationLabel = (ms: number | undefined, t: Translate): string | undefined => {
  if (ms === undefined) return undefined
  if (ms < 1000) return t('turn.duration.ms', { n: ms })
  if (ms < 60_000) return t('turn.duration.s', { n: (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) })
  return t('turn.duration.minSec', { min: Math.floor(ms / 60_000), sec: Math.round((ms % 60_000) / 1000) })
}
const latestModel = (turn: UITurn): string | undefined => {
  if (turn.finalModel !== undefined) return turn.finalModel
  for (let i = turn.usage.calls.length - 1; i >= 0; i--) {
    const call = turn.usage.calls[i]
    if (call?.purpose === 'inference' && !call.adjustment) return call.model
  }
  return undefined
}

function positionUsage(meta: HTMLElement, usage: HTMLElement): void {
  const doc = meta.ownerDocument
  const box = meta.getBoundingClientRect()
  const width = doc.documentElement.clientWidth || doc.defaultView?.innerWidth || 0
  const height = doc.documentElement.clientHeight || doc.defaultView?.innerHeight || 0
  const gutter = 12
  const gap = 8
  const panelWidth = Math.max(0, Math.min(344, width - gutter * 2))
  const below = Math.max(0, height - box.bottom - gutter - gap)
  const above = Math.max(0, box.top - gutter - gap)
  usage.style.width = `${panelWidth}px`
  usage.style.left = `${Math.min(Math.max(gutter, box.right - panelWidth), Math.max(gutter, width - panelWidth - gutter))}px`
  usage.style.right = 'auto'
  if (below >= 220 || below >= above) {
    usage.style.top = `${Math.max(gutter, box.bottom + gap)}px`
    usage.style.bottom = 'auto'
    usage.style.maxHeight = `${below}px`
  } else {
    usage.style.top = 'auto'
    usage.style.bottom = `${Math.max(gutter, height - box.top + gap)}px`
    usage.style.maxHeight = `${above}px`
  }
}

function Icon({ paths }: { paths: readonly string[] }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  )
}

/** React owns the footer and feedback; Web injects only the optional fork operation. */
export function ConversationTurnActions({
  turn,
  finalText,
  settled,
  t = fallbackT,
  localeTag = 'en-US',
  onFork,
  feedbackRef,
  extra,
  leading,
}: ConversationTurnActionsProps) {
  const [usageOpen, setUsageOpen] = useState(false)
  const summary = useRef<HTMLButtonElement>(null)
  const usage = useRef<HTMLDivElement>(null)
  const footer = useRef<HTMLElement>(null)
  const currentId = useRef(turn.id)
  currentId.current = turn.id
  const lastId = useRef(turn.id)
  const epoch = useRef(0)
  const mounted = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef<{ id: string; token: symbol } | undefined>(undefined)
  const [pendingId, setPendingId] = useState<string | undefined>()
  const [feedback, setFeedback] = useState<{ id: string; message: string } | undefined>()

  const clear = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
    setFeedback(undefined)
  }, [])
  const report = useCallback(
    (message: string, durationMs?: number) => {
      clear()
      const id = currentId.current
      const generation = epoch.current
      setFeedback({ id, message })
      if (durationMs !== undefined)
        timer.current = setTimeout(() => {
          timer.current = undefined
          if (mounted.current && currentId.current === id && epoch.current === generation)
            setFeedback((value) => (value?.id === id && value.message === message ? undefined : value))
        }, durationMs)
    },
    [clear],
  )
  useImperativeHandle(feedbackRef, () => ({ clear, report }), [clear, report])

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      epoch.current++
      if (timer.current !== undefined) clearTimeout(timer.current)
      timer.current = undefined
    }
  }, [])
  useLayoutEffect(() => {
    if (lastId.current === turn.id) return
    lastId.current = turn.id
    epoch.current++
    clear()
    pending.current = undefined
    setPendingId(undefined)
    setUsageOpen(false)
  }, [turn.id, clear])
  // The panel is fixed to the viewport: place it against its trigger whenever it is showing.
  useLayoutEffect(() => {
    if (usageOpen && summary.current && usage.current) positionUsage(summary.current, usage.current)
  })
  // Memoized history no longer supplies incidental renders while another turn streams.
  // An open fixed panel owns its positioning and releases all observers on close/unmount.
  useLayoutEffect(() => {
    const anchor = summary.current
    const panel = usage.current
    if (!usageOpen || !anchor || !panel) return
    const doc = anchor.ownerDocument
    const win = doc.defaultView
    let alive = true
    const position = () => {
      if (alive) positionUsage(anchor, panel)
    }
    doc.addEventListener('scroll', position, true)
    win?.addEventListener('resize', position)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(position) : undefined
    observer?.observe(anchor)
    const mutations =
      typeof MutationObserver === 'function'
        ? new MutationObserver((records) => {
            if (records.some((record) => record.target !== panel)) position()
          })
        : undefined
    if (footer.current)
      mutations?.observe(footer.current, {
        childList: true,
        characterData: true,
        attributes: true,
        subtree: true,
      })
    const row = anchor.closest('.conversation-turn')
    if (row) observer?.observe(row)
    return () => {
      alive = false
      doc.removeEventListener('scroll', position, true)
      win?.removeEventListener('resize', position)
      observer?.disconnect()
      mutations?.disconnect()
    }
  }, [usageOpen])

  const copy = () => {
    if (!finalText) return
    const id = turn.id
    const generation = epoch.current
    const doc = footer.current?.ownerDocument
    if (!doc) return
    const valid = () => mounted.current && currentId.current === id && epoch.current === generation
    const fallback = () => {
      const copied = legacyCopy(finalText, doc)
      if (valid()) {
        if (copied) reportSuccess('clipboard', t('turnactions.copied'))
        report(copied ? t('turnactions.copied') : t('turnactions.copyFailed'), copied ? 1600 : undefined)
      }
    }
    const clipboard = doc.defaultView?.navigator.clipboard
    if (!clipboard?.writeText) return fallback()
    try {
      void Promise.resolve(clipboard.writeText(finalText)).then(
        () => {
          if (valid()) {
            reportSuccess('clipboard', t('turnactions.copied'))
            report(t('turnactions.copied'), 1600)
          }
        },
        () => {
          if (valid()) fallback()
        },
      )
    } catch {
      fallback()
    }
  }

  const fork = () => {
    if (!turn.forkable || !onFork || pending.current?.id === turn.id) return
    const id = turn.id
    const generation = epoch.current
    const token = Symbol(id)
    pending.current = { id, token }
    setPendingId(id)
    clear()
    try {
      void Promise.resolve(onFork(turn))
        .then(undefined, () => {
          if (mounted.current && currentId.current === id && epoch.current === generation)
            report(t('turnactions.forkFailed'))
        })
        .finally(() => {
          if (pending.current?.token === token) {
            pending.current = undefined
            if (mounted.current && currentId.current === id && epoch.current === generation)
              setPendingId(undefined)
          }
        })
    } catch {
      pending.current = undefined
      setPendingId(undefined)
      report(t('turnactions.forkFailed'))
    }
  }

  const facts = [
    turn.inherited ? t('turnactions.inherited') : undefined,
    turn.endedAt
      ? new Intl.DateTimeFormat(localeTag, { hour: '2-digit', minute: '2-digit' }).format(
          new Date(turn.endedAt),
        )
      : undefined,
    latestModel(turn),
  ].filter(Boolean)
  // The bar names when and with which model; tokens, cost and time live in its panel.
  const duration = durationLabel(turn.durationMs, t)

  // The copy glyph becomes a check for as long as the confirmation is announced.
  const copied = feedback?.id === turn.id && feedback.message === t('turnactions.copied')
  // Actions lays the row out; each entry stays a real button so names, focus and keys are kept.
  const actions = [
    {
      key: 'copy',
      actionRender: (
        <Button
          {...ACTION_BUTTON}
          key="copy"
          className="turn-action"
          data-copied={copied ? 'true' : undefined}
          aria-label={t('turnactions.copy')}
          title={t('turnactions.copy')}
          hidden={!settled}
          disabled={!finalText}
          onClick={copy}
        >
          <Icon
            paths={
              copied
                ? ['m5 12.5 4.5 4.5L19 7.5']
                : [
                    'M9 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z',
                    'M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2',
                  ]
            }
          />
        </Button>
      ),
    },
    {
      key: 'fork',
      actionRender: (
        <Button
          {...ACTION_BUTTON}
          key="fork"
          className="turn-action"
          aria-label={t('turnactions.fork')}
          title={t('turnactions.fork')}
          hidden={!settled || !turn.forkable}
          disabled={pendingId === turn.id || !turn.forkable || !onFork}
          onClick={fork}
        >
          <SharedIcon name="split" />
        </Button>
      ),
    },
  ]
  return (
    <ConversationXScope>
      <footer ref={footer} className="turn-footer" hidden={!settled}>
        {leading}
        <Actions className="turn-actions" items={actions} />
        {extra}
        <Disclosure
          className="turn-usage"
          hidden={!settled}
          open={usageOpen}
          onOpenChange={setUsageOpen}
          dismissible
          summaryRef={summary}
          summaryProps={{
            className: 'turn-meta',
            'data-testid': 'turn-metadata',
            'aria-label': t('turnactions.metaAria'),
          }}
          summary={
            settled ? (
              <span className="turn-meta-text">
                <span className="turn-meta-facts">{facts.join(' · ')}</span>
              </span>
            ) : (
              ''
            )
          }
        >
          <TurnUsagePanel
            ref={usage}
            turn={turn}
            model={latestModel(turn)}
            duration={duration}
            settled={settled}
            t={t}
          />
        </Disclosure>
        {feedback?.id === turn.id && !copied ? (
          <StatusMessage
            kind="error"
            action={
              feedback.message === t('turnactions.copyFailed')
                ? { label: t('turnactions.copy'), onSelect: copy }
                : turn.forkable && onFork
                  ? { label: t('turnactions.fork'), onSelect: fork, busy: pendingId === turn.id }
                  : undefined
            }
          >
            <span className="turn-feedback">{feedback.message}</span>
          </StatusMessage>
        ) : (
          <span className="turn-feedback" />
        )}
      </footer>
    </ConversationXScope>
  )
}
