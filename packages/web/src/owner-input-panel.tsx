import type { ManagedInputDecideParams, ManagedInputGetResult } from '@agnes/protocol'
import { workbenchPanels } from '@agnes/web-client'
import type { WorkbenchContext } from '@agnes/web-conversation/workbench'
import {
  Button,
  SettingsGroup,
  SettingsItem,
  SettingsState,
  SettingsTag,
  type SettingsTagTone,
  useDocumentLanguage,
} from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'

export type OwnerInputCall = <T>(method: string, params: unknown) => Promise<T>
type Input = NonNullable<ManagedInputGetResult['input']>
type Target = ManagedInputDecideParams['target']

/** The workbench dock panel that opens from `/?session=<id>&ownerInput=<key>`. */
export const OWNER_INPUT_PANEL = 'owner-input'

const COPY = {
  en: {
    heading: 'Owner input',
    text: 'Original text',
    noText: 'The original text was not kept.',
    source: 'Source',
    task: 'Task',
    generation: 'Generation',
    startKey: 'Start key',
    state: 'State',
    reason: 'Reason',
    versions: 'Versions',
    deliver: 'Deliver',
    retain: 'Keep',
    discard: 'Discard',
    redeliver: 'Redeliver',
    parked: 'Parked channel messages',
    noParked: 'No parked messages.',
    attempts: (n: number) => `${n} attempts`,
    reading: 'Reading the input…',
    missing: 'This session has no input with this key.',
    readFailed: 'The input could not be read.',
    readAgain: 'Read again',
    changed: 'This input changed after it was shown. Review the current version before deciding.',
    failed: 'The decision did not go through. Read the input again and retry.',
    settled: 'This input is already settled; no further decision applies.',
    gone: 'This input no longer exists in this session.',
    cannotDeliver: 'The original text was not kept, so it cannot be delivered. Keep or discard it instead.',
    submitted: "This input is already in the session's queue, so it cannot be delivered again.",
    receiptGone: 'This channel message is no longer parked.',
    denied: 'Only your own Web page can decide owner inputs, and only for your sessions.',
    by: { platform: 'platform', owner: 'you' },
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
    text: '原文',
    noText: '原文没有保留。',
    source: '来源',
    task: '任务',
    generation: '代次',
    startKey: '启动键',
    state: '状态',
    reason: '原因',
    versions: '版本记录',
    deliver: '投递',
    retain: '保留',
    discard: '丢弃',
    redeliver: '重投',
    parked: '停放的渠道消息',
    noParked: '没有停放的消息。',
    attempts: (n: number) => `已尝试 ${n} 次`,
    reading: '正在读取输入…',
    missing: '这个会话里没有这条输入。',
    readFailed: '没能读取这条输入。',
    readAgain: '重新读取',
    changed: '这条输入在显示后已经变化，请先查看最新版本再决定。',
    failed: '决定没有生效。请重新读取后再试。',
    settled: '这条输入已经处理完，不能再作决定。',
    gone: '这个会话里已经没有这条输入。',
    cannotDeliver: '原文没有保留，无法投递。请改为保留或丢弃。',
    submitted: '这条输入已在会话队列中，不能再次投递。',
    receiptGone: '这条渠道消息已不在停放列表中。',
    denied: '只有你自己的 Web 页面能对你的会话作决定。',
    by: { platform: '平台', owner: '你' },
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

const FINAL = new Set(['consumed', 'retained'])
/** What the owner is told for each refusal code; a code itself is never shown. */
const REFUSALS: Readonly<Record<string, Notice>> = {
  VERSION_CHANGED: 'changed',
  OWNER_INPUT_STALE: 'changed',
  OWNER_INPUT_FINAL: 'settled',
  OWNER_INPUT_UNKNOWN: 'gone',
  OWNER_INPUT_NO_TEXT: 'cannotDeliver',
  OWNER_INPUT_SUBMITTED: 'submitted',
  RECEIPT_NOT_PARKED: 'receiptGone',
  CAPABILITY_DENIED: 'denied',
}
type Notice =
  | 'changed'
  | 'settled'
  | 'gone'
  | 'cannotDeliver'
  | 'submitted'
  | 'receiptGone'
  | 'denied'
  | 'failed'
  | 'readFailed'
/** Notices after which the panel has already read the current state, so there is nothing to retry. */
const SETTLED_NOTICES = new Set<Notice>([
  'changed',
  'settled',
  'gone',
  'cannotDeliver',
  'submitted',
  'receiptGone',
])
const refusal = (error: unknown): Notice => {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code
  return (typeof code === 'string' && Object.hasOwn(REFUSALS, code) && REFUSALS[code]) || 'failed'
}
const tone = (state: string): SettingsTagTone =>
  state === 'consumed' ? 'ok' : state === 'retained' ? 'muted' : state === 'enqueued' ? 'brand' : 'warn'

function sourceRows(source: unknown): Array<[string, string]> {
  if (source === null || typeof source !== 'object' || Array.isArray(source))
    return [['', JSON.stringify(source)]]
  return Object.entries(source).map(([name, value]) => [
    name,
    typeof value === 'string' ? value : JSON.stringify(value),
  ])
}

/**
 * The owner's review of one admitted input: what was said, where it came from, which task it is for,
 * where it stands and how it got there, with the decisions the platform accepts only from this page.
 * Every decision names the version shown here and is followed by a fresh read.
 */
export function OwnerInputPanel({
  sessionId,
  inputKey,
  call,
}: {
  sessionId: string
  inputKey: string
  call: OwnerInputCall
}) {
  const text = COPY[useDocumentLanguage() === 'zh-CN' ? 'zh' : 'en']
  const [view, setView] = useState<ManagedInputGetResult>()
  const [reading, setReading] = useState(true)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<Notice>()
  const live = useRef(true)
  // The dock hands a fresh call function on every render; reading again on each would be wasted.
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
      const next = await rpc.current<ManagedInputGetResult>('_agnes/v1/managedInput.get', {
        sessionId,
        key: inputKey,
      })
      if (live.current) setView(next)
      return true
    } catch {
      if (live.current) setNotice('readFailed')
      return false
    } finally {
      if (live.current) setReading(false)
    }
  }, [sessionId, inputKey])
  useEffect(() => {
    void load()
  }, [load])
  const decide = async (target: Target) => {
    setPending(true)
    setNotice(undefined)
    let outcome: typeof notice
    try {
      await rpc.current('_agnes/v1/managedInput.decide', { sessionId, target })
    } catch (error) {
      outcome = refusal(error)
    }
    if ((await load()) && live.current) setNotice(outcome)
    if (live.current) setPending(false)
  }
  const input = view?.input
  const decision = (current: Input, choice: 'deliver' | 'retain' | 'discard') => (
    <Button
      key={choice}
      appearance={choice === 'deliver' ? 'primary' : 'secondary'}
      disabled={pending || reading}
      onClick={() =>
        void decide({ kind: 'input', key: current.key, decision: choice, version: current.version })
      }
    >
      {text[choice]}
    </Button>
  )
  return (
    <section className="owner-input-panel" aria-label={text.heading} data-owner-input={inputKey}>
      {reading && !view && <SettingsState tone="loading">{text.reading}</SettingsState>}
      {notice && (
        <SettingsState tone={SETTLED_NOTICES.has(notice) ? 'empty' : 'error'}>
          {text[notice]}{' '}
          {!SETTLED_NOTICES.has(notice) && (
            <Button size="small" disabled={reading} onClick={() => void load()}>
              {text.readAgain}
            </Button>
          )}
        </SettingsState>
      )}
      {view && !input && <SettingsState>{text.missing}</SettingsState>}
      {input && (
        <>
          <SettingsGroup>
            <SettingsItem label={text.text} stacked>
              {input.text === null ? (
                text.noText
              ) : (
                <blockquote className="owner-input-text">{input.text}</blockquote>
              )}
            </SettingsItem>
            <SettingsItem label={text.state}>
              <SettingsTag tone={tone(input.state)}>{text.states[input.state]}</SettingsTag>
            </SettingsItem>
            <SettingsItem label={text.reason}>
              <code>{input.reason}</code>
            </SettingsItem>
            <SettingsItem label={text.task}>{input.binding.taskId}</SettingsItem>
            <SettingsItem label={text.generation}>{input.binding.taskGeneration}</SettingsItem>
            <SettingsItem label={text.startKey}>{input.binding.startKey}</SettingsItem>
            <SettingsItem label={text.source} stacked>
              <dl className="owner-input-source">
                {sourceRows(input.source).map(([name, value]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </SettingsItem>
          </SettingsGroup>
          {!FINAL.has(input.state) && (
            <div className="owner-input-actions">
              {(['deliver', 'retain', 'discard'] as const).map((choice) => decision(input, choice))}
            </div>
          )}
          <h4>{text.versions}</h4>
          <ol className="owner-input-history">
            {input.history.map((entry) => (
              <li key={entry.version}>
                <strong>{`v${entry.version}`}</strong> {text.states[entry.state]} ·{' '}
                <code>{entry.reason}</code>
                {` · ${text.by[entry.by]} · ${new Date(entry.at).toLocaleString()}`}
              </li>
            ))}
          </ol>
        </>
      )}
      {view && (
        <>
          <h4>{text.parked}</h4>
          {view.parkedReceipts.length === 0 && <SettingsState>{text.noParked}</SettingsState>}
          <ul className="owner-input-parked">
            {view.parkedReceipts.map((receipt) => (
              <li key={receipt.receiptId}>
                <blockquote className="owner-input-text">{receipt.text}</blockquote>
                <span>{`${receipt.service} · ${new Date(receipt.at).toLocaleString()} · ${text.attempts(receipt.attempts)}`}</span>
                <span className="owner-input-actions">
                  {(['redeliver', 'discard'] as const).map((choice) => (
                    <Button
                      key={choice}
                      size="small"
                      disabled={pending || reading}
                      onClick={() =>
                        void decide({ kind: 'receipt', receiptId: receipt.receiptId, decision: choice })
                      }
                    >
                      {text[choice]}
                    </Button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/** Show the owner input panel in the session's workbench dock while that session is open. */
export function registerOwnerInputPanel(anchor: { sessionId: string; key: string }): () => void {
  const sessionOf = (data: unknown) => (data as WorkbenchContext | undefined)?.session
  return workbenchPanels.register({
    id: OWNER_INPUT_PANEL,
    order: 80,
    edge: 'right',
    titleKey: '',
    title: () => COPY[document.documentElement.lang === 'zh-CN' ? 'zh' : 'en'].heading,
    visibility: 'contextual',
    icon: 'message-square',
    when: (context) => sessionOf(context.data)?.id === anchor.sessionId,
    component: ({ context }) => {
      const session = sessionOf(context.data)
      return session?.id === anchor.sessionId ? (
        <OwnerInputPanel
          sessionId={anchor.sessionId}
          inputKey={anchor.key}
          call={(method, params) => session.client.call(method, params)}
        />
      ) : null
    },
  })
}
