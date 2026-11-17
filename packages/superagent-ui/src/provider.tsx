/** Shared panel React contexts, state polling, restart detection, and action runner hook. */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  type ApiMessages,
  type Call,
  caller,
  type Services,
  type SetupView,
  type StateView,
  usePoll,
} from './api.js'
import type { Route } from './route.js'
import { errorText, setupText, type T, valueLabel } from './text.js'

export interface PanelContext {
  t: T
  call: Call
  navigate: (route: Route, replace?: boolean) => void
  back: () => void
  backLabel: string
  openSession: (sessionId: string) => Promise<void>
  notify: (text: string) => void
  restart: () => void
}
export interface PanelData {
  state: StateView | undefined
  error: Error | undefined
  reload: () => Promise<void>
  setup: SetupView | undefined
  /** Executor Sessions in an active turn, which a restart of Superagent interrupts. */
  running: number
  /** Incremented each time Superagent recovers from a restart so dependent views refetch. */
  restarts: number
}
const Panel = createContext<PanelContext | undefined>(undefined)
const PanelState = createContext<PanelData | undefined>(undefined)
export function usePanel(): PanelContext {
  const value = useContext(Panel)
  if (!value) throw new Error('Superagent page rendered outside its panel')
  return value
}
export function usePanelData(): PanelData {
  const value = useContext(PanelState)
  if (!value) throw new Error('Superagent page rendered outside its panel')
  return value
}
/** Wrap an async action with re-entrancy protection, busy state, optional reload, and error toast reporting. */
export function useAction<A extends unknown[]>(
  action: (...args: A) => Promise<unknown>,
  { reload }: { reload?: () => Promise<unknown> } = {},
) {
  const { notify } = usePanel()
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const run = async (...args: A): Promise<boolean> => {
    if (running.current) return false
    running.current = true
    setBusy(true)
    try {
      await action(...args)
      await reload?.()
      return true
    } catch (failure) {
      notify(errorText(failure))
      return false
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return { run, busy }
}

const messages = (t: T): ApiMessages => ({
  effectNotDone: (state) => t('effectNotDone', { state }),
  offline: t('offline'),
  notRunning: t('hostNotRunning'),
  serverError: (status) => t('serverError', { status }),
  requestFailed: (status) => t('requestFailed', { status }),
  setup: (problem) =>
    problem.values.output ? `${setupText(t, problem)}\n${problem.values.output}` : setupText(t, problem),
  // A refusal names a prompt part by its label.
  user: ({ code, values }) =>
    t(
      `userError.${code}`,
      values.part ? { ...values, part: valueLabel(t, 'promptPart', values.part) } : values,
    ),
})
function Toast({ text, onDone, holdMs = 3000 }: { text: string; onDone: () => void; holdMs?: number }) {
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    const timer = setTimeout(() => done.current(), holdMs + 1000)
    return () => clearTimeout(timer)
  }, [holdMs])
  return createPortal(
    <div className="dt-toast" role="status" style={{ ['--dt-toast-hold' as string]: `${holdMs}ms` }}>
      {text}
    </div>,
    document.body,
  )
}
const stay = () => {}
const noSession = async () => {}
export function PanelProvider({
  t,
  services,
  interval = 5000,
  openSession = noSession,
  navigate = stay,
  back = stay,
  backLabel = '',
  children,
}: {
  t: T
  services: Services
  interval?: number
  openSession?: (sessionId: string) => Promise<void>
  navigate?: PanelContext['navigate']
  back?: () => void
  backLabel?: string
  children: ReactNode
}) {
  // Read the current translator via ref so locale changes do not recreate `call` and restart polling.
  const copy = useRef(t)
  copy.current = t
  const call = useMemo(() => caller(() => messages(copy.current), services), [services])
  const [toast, setToast] = useState<{ text: string; id: number }>()
  const notify = useCallback((text: string) => setToast({ text, id: Date.now() }), [])
  // Poll at 1s during a restart until the server goes down and answers again, or time out after 30s if the restart completed between polls.
  const [restarting, setRestarting] = useState<{ down: boolean }>()
  const [restarts, setRestarts] = useState(0)
  const restart = useCallback(() => setRestarting({ down: false }), [])
  const {
    data: state,
    error,
    reload,
  } = usePoll(() => call('GET state'), [call], restarting ? 1000 : interval)
  if (restarting && !!error !== restarting.down) {
    setRestarting(error ? { down: true } : undefined)
    if (!error) setRestarts(restarts + 1)
  }
  useEffect(() => {
    if (!restarting) return
    const timer = setTimeout(() => setRestarting(undefined), 30_000)
    return () => clearTimeout(timer)
  }, [restarting])
  const context = useMemo(
    () => ({ t, call, navigate, back, backLabel, openSession, notify, restart }),
    [t, call, navigate, back, backLabel, openSession, notify, restart],
  )
  const data = useMemo(
    () => ({ state, error, reload, setup: state?.setup, running: state?.load.running ?? 0, restarts }),
    [state, error, reload, restarts],
  )
  return (
    <Panel.Provider value={context}>
      <PanelState.Provider value={data}>
        {children}
        {toast && <Toast key={toast.id} text={toast.text} onDone={() => setToast(undefined)} />}
      </PanelState.Provider>
    </Panel.Provider>
  )
}
