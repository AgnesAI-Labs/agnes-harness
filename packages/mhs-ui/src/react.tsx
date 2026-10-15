import type { JsonValue } from '@agnes/protocol'
import { Button, Toast } from '@agnes/web-ui'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { type MhsClient, receiptMessage } from './client.js'
import type { Translate } from './locales.js'
import type { Receipt } from './ports.js'
import type { MhsStore } from './store.js'

export type Ui = { client: MhsClient; store: MhsStore; t: Translate; openDevice(id: string): void }
const UiContext = createContext<Ui | undefined>(undefined)
export function MhsProvider({ value, children }: { value: Ui; children: ReactNode }) {
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>
}
export function useMhs() {
  const ui = useContext(UiContext)
  if (!ui) throw new Error('MHS context missing')
  return ui
}
export function useSnapshot() {
  const { store } = useMhs()
  return useSyncExternalStore(store.subscribe, store.read, store.read)
}
export function useQuery<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [value, setValue] = useState<T>(),
    [error, setError] = useState(false),
    [revision, setRevision] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry invalidates an otherwise identical read.
  useEffect(() => {
    const abort = new AbortController()
    setValue(undefined)
    setError(false)
    void load(abort.signal)
      .then((v) => {
        if (!abort.signal.aborted) setValue(v)
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true)
      })
    return () => abort.abort()
  }, [load, revision])
  return { value, error, retry: useCallback(() => setRevision((n) => n + 1), []) }
}
export function ReceiptView({ receipt }: { receipt: Receipt | undefined }) {
  const { t } = useMhs()
  if (!receipt) return null
  const message = receiptMessage(receipt)
  return (
    <div role="status" className="mhs-receipt" data-state={receipt.state}>
      {receipt.state === 'approval-required'
        ? t('pending')
        : receipt.state === 'unknown'
          ? t('unknown')
          : message}
      <small>{receipt.operationId}</small>
    </div>
  )
}
export function useAction() {
  const { client } = useMhs(),
    [receipt, setReceipt] = useState<Receipt>(),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false)
  const locked = useRef(false)
  const operationId = receipt?.operationId,
    state = receipt?.state
  useEffect(() => {
    if (!operationId || !state || !['approval-required', 'running'].includes(state)) return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await client.ports.services.readOperation(operationId)
        if (live) {
          setReceipt(next)
          if (['approval-required', 'running'].includes(next.state)) timer = setTimeout(poll, 750)
        }
      } catch {
        if (live) {
          setFailed(true)
          timer = setTimeout(poll, 2000)
        }
      }
    }
    timer = setTimeout(poll, 750)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [client, operationId, state])
  const run = async (name: string, input: JsonValue) => {
    if (locked.current) return undefined
    locked.current = true
    setBusy(true)
    setFailed(false)
    setReceipt(undefined)
    try {
      const result = await client.effect(name, input)
      if (!client.abort.signal.aborted) setReceipt(result)
      return result
    } catch {
      if (!client.abort.signal.aborted) setFailed(true)
      return undefined
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  return {
    run,
    receipt,
    busy,
    failed,
    pending: receipt?.state === 'approval-required' || receipt?.state === 'running',
  }
}
export function ActionFeedback({ action }: { action: ReturnType<typeof useAction> }) {
  const { t } = useMhs()
  return (
    <>
      <ReceiptView receipt={action.receipt} />
      {action.failed && <div role="alert">{t('unknown')}</div>}
    </>
  )
}
export function Stop({ device }: { device?: string }) {
  const { t } = useMhs(),
    action = useAction()
  return (
    <div className="mhs-stop">
      <Button
        appearance="danger"
        loading={action.busy}
        onClick={() => void action.run('stop', device ? { device } : {})}
      >
        {t(device ? 'stop' : 'stopAll')}
      </Button>
      <ActionFeedback action={action} />
    </div>
  )
}
export function QueryState({ error, retry, empty }: { error: boolean; retry(): void; empty?: boolean }) {
  const { t } = useMhs()
  return (
    <div role={error ? 'alert' : 'status'} className="mhs-empty">
      {t(error ? 'failed' : empty ? 'noEvents' : 'loading')}
      {error && <Button onClick={retry}>{t('retry')}</Button>}
    </div>
  )
}
export function Notice({ children }: { children: string }) {
  const [open, setOpen] = useState(true)
  return (
    <Toast open={open} onDismiss={() => setOpen(false)}>
      {children}
    </Toast>
  )
}
