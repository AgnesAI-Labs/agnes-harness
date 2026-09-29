import type { UITurn } from '@agnes/protocol'
import {
  Fragment,
  type Ref,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

export interface ConversationTurnFeedback {
  clear(): void
  report(message: string, durationMs?: number): void
}

export interface ConversationTurnActionsProps {
  turn: UITurn
  finalText: string
  settled: boolean
  onFork?: (turn: UITurn) => Promise<void>
  /** The legacy bridge may supply its existing disclosure binding. */
  bindAutoDismiss?: (element: HTMLDetailsElement) => void
  feedbackRef?: Ref<ConversationTurnFeedback>
}

const durationLabel = (ms?: number): string | undefined => {
  if (ms === undefined) return undefined
  if (ms < 1000) return `${ms} 毫秒`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`
}
const sourceLabel = (source: 'gateway' | 'estimated') => (source === 'estimated' ? '估算' : '网关记录')
const latestModel = (turn: UITurn): string | undefined => {
  if (turn.finalModel !== undefined) return turn.finalModel
  for (let i = turn.usage.calls.length - 1; i >= 0; i--) {
    const call = turn.usage.calls[i]
    if (call?.purpose === 'inference' && !call.adjustment) return call.model
  }
  return undefined
}

function positionUsage(meta: HTMLElement, usage: HTMLDListElement): void {
  const doc = meta.ownerDocument
  const box = meta.getBoundingClientRect()
  const width = doc.documentElement.clientWidth || doc.defaultView?.innerWidth || 0
  const height = doc.documentElement.clientHeight || doc.defaultView?.innerHeight || 0
  const gutter = 12
  const gap = 8
  const panelWidth = Math.max(0, Math.min(400, width - gutter * 2))
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

/** Temporary platform clipboard target; attached presentation remains React-owned. */
function legacyCopy(text: string, doc: Document): boolean {
  const active = doc.activeElement as HTMLElement | null
  const selection = doc.getSelection()
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : []
  const textarea = doc.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  doc.body.append(textarea)
  textarea.select()
  let copied = false
  try {
    copied = doc.execCommand('copy')
  } catch {
    copied = false
  } finally {
    textarea.remove()
    selection?.removeAllRanges()
    for (const range of ranges) selection?.addRange(range)
    active?.focus?.({ preventScroll: true })
  }
  return copied
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
  onFork,
  bindAutoDismiss,
  feedbackRef,
}: ConversationTurnActionsProps) {
  const details = useRef<HTMLDetailsElement>(null)
  const summary = useRef<HTMLElement>(null)
  const usage = useRef<HTMLDListElement>(null)
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
    if (details.current) details.current.open = false
  }, [turn.id, clear])
  useLayoutEffect(() => {
    const element = details.current
    if (!element) return
    if (bindAutoDismiss) {
      bindAutoDismiss(element)
      return
    }
    const doc = element.ownerDocument
    const dismiss = (event: Event) => {
      if (element.isConnected && element.open && !event.composedPath().includes(element)) element.open = false
    }
    doc.addEventListener('click', dismiss)
    return () => doc.removeEventListener('click', dismiss)
  }, [bindAutoDismiss])
  useLayoutEffect(() => {
    if (details.current?.open && summary.current && usage.current)
      positionUsage(summary.current, usage.current)
  })

  const copy = () => {
    if (!finalText) return
    const id = turn.id
    const generation = epoch.current
    const doc = footer.current?.ownerDocument
    if (!doc) return
    const valid = () => mounted.current && currentId.current === id && epoch.current === generation
    const fallback = () => {
      const copied = legacyCopy(finalText, doc)
      if (valid()) report(copied ? '已复制' : '复制失败', copied ? 1600 : undefined)
    }
    const clipboard = doc.defaultView?.navigator.clipboard
    if (!clipboard?.writeText) return fallback()
    try {
      void Promise.resolve(clipboard.writeText(finalText)).then(
        () => {
          if (valid()) report('已复制', 1600)
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
            report('分支失败，请重试。')
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
      report('分支失败，请重试。')
    }
  }

  const facts = [
    turn.inherited ? '继承历史' : undefined,
    turn.endedAt
      ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(
          new Date(turn.endedAt),
        )
      : undefined,
    latestModel(turn),
  ].filter(Boolean)
  const { totals, cost, credits, billingComplete } = turn.usage
  const duration = durationLabel(turn.durationMs)
  const rows: Array<[string, string]> = [
    ['输入 Token', totals.input.toLocaleString()],
    ['输出 Token', totals.output.toLocaleString()],
    ['缓存读取 / 写入', `${totals.cacheRead.toLocaleString()} / ${totals.cacheWrite.toLocaleString()}`],
    ...(cost
      ? [
          [
            '费用',
            `$${(cost.usdMicros / 1e6).toFixed(6)} · ${sourceLabel(cost.source)}${cost.subscription ? ' · 订阅' : ''}${billingComplete ? '' : ' · 已知部分'}`,
          ] as [string, string],
        ]
      : []),
    ...(credits
      ? [
          [
            '额度',
            `${credits.amount.toFixed(8).replace(/\.?0+$/, '')} credits · ${sourceLabel(credits.source)}${credits.complete ? '' : ' · 部分'}`,
          ] as [string, string],
        ]
      : []),
    ...(duration ? [['用时', duration] as [string, string]] : []),
  ]

  return (
    <footer ref={footer} className="turn-footer" hidden={!settled}>
      <button
        type="button"
        className="turn-action"
        aria-label="复制回答"
        title="复制回答"
        hidden={!settled}
        disabled={!finalText}
        onClick={copy}
      >
        <Icon
          paths={[
            'M9 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z',
            'M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2',
          ]}
        />
      </button>
      <button
        type="button"
        className="turn-action"
        aria-label="分支到新聊天"
        title="分支到新聊天"
        hidden={!settled || !turn.forkable}
        disabled={pendingId === turn.id || !turn.forkable || !onFork}
        onClick={fork}
      >
        <Icon paths={['M6 3v5a4 4 0 0 0 4 4h8', 'm14 8 4 4-4 4', 'M6 21v-5a4 4 0 0 1 4-4']} />
      </button>
      <details
        ref={details}
        className="turn-usage"
        hidden={!settled}
        onToggle={() => {
          if (details.current?.open && summary.current && usage.current)
            positionUsage(summary.current, usage.current)
        }}
      >
        <summary ref={summary} className="turn-meta" aria-label="查看本轮用量与调用明细">
          {settled ? facts.join(' · ') : ''}
        </summary>
        <dl ref={usage} className="turn-usage-grid">
          {settled &&
            rows.map(([name, value]) => (
              <Fragment key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </Fragment>
            ))}
        </dl>
      </details>
      <span className="turn-feedback" role="status">
        {feedback?.id === turn.id ? feedback.message : ''}
      </span>
    </footer>
  )
}
