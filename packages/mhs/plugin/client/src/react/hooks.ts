/** Hooks that connect components to the store (mhs-ui-design section 6.4). */
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import type { Latest, MyJob, Store } from '../core/store.js'
import type { Device, HubEvent, World } from '../core/types.js'
import { getLocale, onLocale } from '../i18n/i18n.js'

export const StoreContext = createContext<Store | null>(null)

/** Where the page shows a device; the conversation's cards use it to open a device. */
export interface Nav {
  device: string | undefined
  open(device: string | undefined): void
}
export const NavContext = createContext<Nav>({ device: undefined, open: () => undefined })

export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('no AgnesHub store')
  return store
}

export function useNav(): Nav {
  return useContext(NavContext)
}

function useKey<T>(key: string, get: () => T): T {
  const store = useStore()
  return useSyncExternalStore(
    useCallback((listener) => store.subscribe(key, listener), [store, key]),
    get,
  )
}

/** Re-renders when the language changes; returns it. */
export function useLocale(): string {
  return useSyncExternalStore(onLocale, getLocale)
}

export function useConn() {
  const store = useStore()
  return useKey('conn', () => store.conn)
}

export function useDevices(): Device[] {
  const store = useStore()
  return useKey('devices', () => store.list())
}

export function useDevice(id: string): Device | undefined {
  const store = useStore()
  return useKey(`d:${id}`, () => store.device(id))
}

export function useWorlds(): World[] {
  const store = useStore()
  return useKey('worlds', () => store.worlds())
}

export function useEvents(): HubEvent[] {
  const store = useStore()
  return useKey('events', () => store.recentEvents())
}

export function useTraffic() {
  const store = useStore()
  return useKey('traffic', () => store.traffic())
}

export function useBrainPulses() {
  const store = useStore()
  return useKey('brain', () => store.brainPulses())
}

export function useJob(id: string | undefined): MyJob | undefined {
  const store = useStore()
  return useKey(`j:${id}`, () => (id ? store.job(id) : undefined))
}

/**
 * The newest item of a source while the component wants it. `hz` 0 reads without subscribing
 * (state-like sources that someone else keeps on).
 */
export function useSource(device: string, source: string, hz: number, enabled = true): Latest | undefined {
  const store = useStore()
  useEffect(() => {
    if (!enabled || hz <= 0) return
    return store.want(device, source, hz)
  }, [store, device, source, hz, enabled])
  return useKey(`s:${device}/${source}`, () => store.item(device, source))
}

export function useSamples(device: string, source: string, field: string) {
  const store = useStore()
  return useKey(`h:${device}/${source}`, () => store.samples(device, source, field))
}

/** A clock that ticks every `ms` while mounted, for "x s ago" and elapsed times. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

/** Whether the element is on screen and the tab visible (section 6.3: subscribe only then). */
export function useVisible(element: Element | null): boolean {
  const [inView, setInView] = useState(true)
  const [tabVisible, setTabVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const onChange = () => setTabVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  useEffect(() => {
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return inView && tabVisible
}
