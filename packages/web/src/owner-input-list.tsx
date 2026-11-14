import type { ManagedInputListResult } from '@agnes/protocol'
import { type HomeEntryBadge, homeEntries, homeNavigation } from '@agnes/web-client'
import {
  Button,
  SettingsGroup,
  SettingsItem,
  SettingsState,
  SettingsTag,
  useDocumentLanguage,
} from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OwnerInputCall } from './owner-input-panel.js'
import { HomePageFrame } from './pages/page-frame.js'

/** The home entry that lists, across sessions, what waits on the owner. */
export const OWNER_INPUT_ENTRY = 'owner-inputs'
/** How often an open page re-reads the count while nothing else prompts it. */
const REFRESH_MS = 120_000

type Item = ManagedInputListResult['inputs'][number]
type Parked = ManagedInputListResult['parkedReceipts'][number]

const COPY = {
  en: {
    heading: 'Owner inputs',
    description:
      'Messages to your managed sessions that need your decision or are held, and channel messages a service could not take.',
    inputs: 'Inputs',
    noInputs: 'No input needs you.',
    parked: 'Parked channel messages',
    noParked: 'No parked messages.',
    review: 'Review',
    session: 'Session',
    redeliver: 'Redeliver',
    discard: 'Discard',
    noSession:
      'This service has no managed session to act through; it stays parked until one exists or the service is removed.',
    attempts: (n: number) => `${n} attempts`,
    reading: 'Reading…',
    readFailed: 'The list could not be read.',
    readAgain: 'Read again',
    failed: 'The decision did not go through. Read the list again and retry.',
    held: {
      gatesUnreadable: 'Held: the session checks could not be read; it runs once they can.',
      admissionIncomplete: 'Held: the service did not finish recording it; it runs once the service retries.',
    },
    states: {
      queued: 'Being recorded',
      enqueued: 'Waiting for the session',
      consumed: 'Taken by a turn',
      retained: 'Kept, not delivered',
      needsOwner: 'Waiting for your decision',
      waitingQuestion: 'Waiting for an open question',
      recoveryUnknown: 'Waiting for your decision',
    },
  },
  zh: {
    heading: '主人输入',
    description: '发给受管会话、需要你决定或被暂留的消息，以及服务没能接收的渠道消息。',
    inputs: '输入',
    noInputs: '没有需要你处理的输入。',
    parked: '停放的渠道消息',
    noParked: '没有停放的消息。',
    review: '查看',
    session: '会话',
    redeliver: '重投',
    discard: '丢弃',
    noSession: '这个服务目前没有可操作的受管会话；消息保持停放，直到有会话或服务被移除。',
    attempts: (n: number) => `已尝试 ${n} 次`,
    reading: '正在读取…',
    readFailed: '没能读取列表。',
    readAgain: '重新读取',
    failed: '决定没有生效。请重新读取后再试。',
    held: {
      gatesUnreadable: '暂留：会话检查暂时读不到，能读到后会照常执行。',
      admissionIncomplete: '暂留：服务没有完成记录，服务重试后会照常执行。',
    },
    states: {
      queued: '正在记录',
      enqueued: '等待会话空闲',
      consumed: '已被回合取走',
      retained: '已保留，未投递',
      needsOwner: '等你决定',
      waitingQuestion: '等待未答问题',
      recoveryUnknown: '等你决定',
    },
  },
}

const reviewLocation = (item: Item) =>
  `/?session=${encodeURIComponent(item.sessionId)}&ownerInput=${encodeURIComponent(item.key)}`

/**
 * The owner's list: every input that waits on the owner or is held without progress, and every parked
 * channel message, without knowing a key. An input opens its session's review panel; a parked message
 * is redelivered or discarded here, through a session of its own service.
 */
export function OwnerInputListPage({ call, changed }: { call: OwnerInputCall; changed?(): void }) {
  const text = COPY[useDocumentLanguage() === 'zh-CN' ? 'zh' : 'en']
  const [list, setList] = useState<ManagedInputListResult>()
  const [reading, setReading] = useState(true)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<'readFailed' | 'failed'>()
  const live = useRef(true)
  const rpc = useRef(call)
  rpc.current = call
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const load = useCallback(async () => {
    setReading(true)
    try {
      const next = await rpc.current<ManagedInputListResult>('_agnes/v1/managedInput.list', {})
      if (live.current) setList(next)
      return true
    } catch {
      if (live.current) setNotice('readFailed')
      return false
    } finally {
      if (live.current) setReading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  const decide = async (receipt: Parked, decision: 'redeliver' | 'discard') => {
    if (!receipt.sessionId) return
    setPending(true)
    setNotice(undefined)
    let failed = false
    try {
      await rpc.current('_agnes/v1/managedInput.decide', {
        sessionId: receipt.sessionId,
        target: { kind: 'receipt', receiptId: receipt.receiptId, decision },
      })
    } catch {
      failed = true
    }
    if ((await load()) && live.current && failed) setNotice('failed')
    changed?.()
    if (live.current) setPending(false)
  }
  return (
    <HomePageFrame id={OWNER_INPUT_ENTRY} title={text.heading} description={text.description}>
      <section className="owner-input-list" data-testid="owner-input-list">
        {reading && !list && <SettingsState tone="loading">{text.reading}</SettingsState>}
        {notice && (
          <SettingsState tone="error">
            {text[notice]}{' '}
            <Button size="small" disabled={reading} onClick={() => void load()}>
              {text.readAgain}
            </Button>
          </SettingsState>
        )}
        {list && (
          <>
            <h2>{text.inputs}</h2>
            {list.inputs.length === 0 && <SettingsState>{text.noInputs}</SettingsState>}
            {list.inputs.length > 0 && (
              <SettingsGroup>
                {list.inputs.map((item) => (
                  <SettingsItem
                    key={`${item.sessionId}\u0000${item.key}`}
                    label={
                      <>
                        <SettingsTag tone={item.held ? 'brand' : 'warn'}>
                          {text.states[item.state]}
                        </SettingsTag>{' '}
                        <code>{item.reason}</code>
                      </>
                    }
                    description={`${text.session} ${item.sessionId} · ${new Date(item.at).toLocaleString()}${
                      item.held ? ` · ${text.held[item.held]}` : ''
                    }`}
                  >
                    <a className="owner-input-review-link" href={reviewLocation(item)}>
                      {text.review}
                    </a>
                  </SettingsItem>
                ))}
              </SettingsGroup>
            )}
            <h2>{text.parked}</h2>
            {list.parkedReceipts.length === 0 && <SettingsState>{text.noParked}</SettingsState>}
            <ul className="owner-input-parked">
              {list.parkedReceipts.map((receipt) => (
                <li key={receipt.receiptId}>
                  <blockquote className="owner-input-text">{receipt.text}</blockquote>
                  <span>{`${receipt.service} · ${new Date(receipt.at).toLocaleString()} · ${text.attempts(receipt.attempts)}`}</span>
                  {receipt.sessionId ? (
                    <span className="owner-input-actions">
                      {(['redeliver', 'discard'] as const).map((choice) => (
                        <Button
                          key={choice}
                          size="small"
                          disabled={pending || reading}
                          onClick={() => void decide(receipt, choice)}
                        >
                          {text[choice]}
                        </Button>
                      ))}
                    </span>
                  ) : (
                    <SettingsState>{text.noSession}</SettingsState>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </HomePageFrame>
  )
}

/** The count beside the entry: listed inputs and parked messages. A refused or failed read shows none. */
export function ownerInputCount(call: OwnerInputCall): HomeEntryBadge & { refresh(): Promise<number> } {
  let count = 0
  // Reads run one after another, so a read asked for while one is under way still sees what came since.
  let reading: Promise<unknown> = Promise.resolve()
  const listeners = new Set<() => void>()
  const read = () =>
    call<ManagedInputListResult>('_agnes/v1/managedInput.list', {})
      .then((list) => list.inputs.length + list.parkedReceipts.length)
      .catch(() => 0)
      .then((next) => {
        if (next !== count) {
          count = next
          for (const listener of listeners) listener()
        }
        return next
      })
  const refresh = () => {
    const next = reading.then(read)
    reading = next
    return next
  }
  return {
    refresh,
    getSnapshot: () => count,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * Adds the owner input entry to the home sidebar the first time something waits on the owner, and keeps
 * it from then on with its count; a page whose owner never had anything waiting shows no entry. The count
 * is read on load, on every home navigation, when the page becomes visible, and every two minutes. `call`
 * is the page's own owner-only caller.
 */
export function registerOwnerInputEntry(call: OwnerInputCall): () => void {
  const badge = ownerInputCount(call)
  let removeEntry: (() => void) | undefined
  const refresh = async () => {
    if ((await badge.refresh()) > 0 && !removeEntry && !homeEntries.get(OWNER_INPUT_ENTRY))
      removeEntry = homeEntries.register({
        id: OWNER_INPUT_ENTRY,
        order: 50,
        placement: 'primary',
        icon: 'message-square',
        titleKey: 'home.entry.ownerInputs',
        badge,
        component: () => <OwnerInputListPage call={call} changed={() => void badge.refresh()} />,
      })
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible') void refresh()
  }
  const offNavigation = homeNavigation.subscribe(() => void refresh())
  document.addEventListener('visibilitychange', onVisible)
  const timer = setInterval(() => void refresh(), REFRESH_MS)
  void refresh()
  return () => {
    clearInterval(timer)
    offNavigation()
    document.removeEventListener('visibilitychange', onVisible)
    removeEntry?.()
  }
}
