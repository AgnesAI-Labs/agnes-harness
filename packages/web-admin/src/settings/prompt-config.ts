import type { SystemPromptConfig, SystemPromptSnapshot } from '@agnes/protocol'
import { hasPermission, trackPageRequest } from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { PluginAdminApi } from '../admin/plugins/api.js'
import { systemPromptApi } from './system-prompt-api.js'

export const PROMPT_NAMESPACE = '@agnes/web/system-prompt'
export const browserPromptApi = systemPromptApi()
export type PromptApi = ReturnType<typeof systemPromptApi>

/**
 * One prompt configuration per API, shared by every surface that shows it (General's
 * personalization, the run configuration's replacement and preview). A save by one is seen by all.
 */
type PromptStore = { snapshot: SystemPromptSnapshot | undefined; listeners: Set<() => void> }
const stores = new WeakMap<PromptApi, PromptStore>()
function storeOf(api: PromptApi): PromptStore {
  let store = stores.get(api)
  if (!store) {
    store = { snapshot: undefined, listeners: new Set() }
    stores.set(api, store)
  }
  return store
}
function publish(store: PromptStore, snapshot: SystemPromptSnapshot) {
  store.snapshot = snapshot
  for (const listener of store.listeners) listener()
}

/** A full replacement prompt is in use, so the instructions around the default are not saved. */
export class PromptReplacedError extends Error {
  constructor() {
    super('A full replacement prompt is in use')
    this.name = 'PromptReplacedError'
  }
}

/**
 * The shared prompt configuration: read when a surface shows it (again on `reload`). `save` reads
 * the latest stored configuration first and applies only the caller's change to it, so a surface
 * never writes back fields another surface changed meanwhile; the result reaches every surface.
 */
export function usePromptSnapshot(api: PromptApi, enabled = true) {
  const store = storeOf(api)
  const subscribe = useCallback(
    (listener: () => void) => {
      store.listeners.add(listener)
      return () => {
        store.listeners.delete(listener)
      }
    },
    [store],
  )
  const snapshot = useSyncExternalStore(subscribe, () => store.snapshot)
  const [busy, setBusy] = useState(enabled)
  const [failed, setFailed] = useState(false)
  const [reads, setReads] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads is an explicit retry.
  useEffect(() => {
    if (!enabled) return
    const pending = new AbortController()
    setBusy(true)
    void trackPageRequest(api.get(pending.signal))
      .then((value) => {
        if (pending.signal.aborted) return
        publish(store, value)
        setFailed(false)
      })
      .catch(() => {
        if (!pending.signal.aborted) setFailed(true)
      })
      .finally(() => {
        if (!pending.signal.aborted) setBusy(false)
      })
    return () => pending.abort()
  }, [api, enabled, reads, store])
  /** Apply `change` to the latest stored configuration and write it; rejects when the save fails. */
  const save = useCallback(
    async (change: (latest: SystemPromptConfig) => SystemPromptConfig, confirmFullOverride = false) => {
      const latest = await api.get()
      publish(store, latest)
      const result = await api.save({ config: change(latest.config), confirmFullOverride })
      publish(store, result)
      return result
    },
    [api, store],
  )
  const reload = useCallback(() => setReads((value) => value + 1), [])
  return { snapshot, busy, failed, save, reload }
}

const INSTRUCTIONS = ['personaPrefix', 'personaSuffix', 'replyStyle'] as const
/**
 * The latest configuration with only the instructions taken from `draft`. Refused while a full
 * replacement is stored: those instructions would not be sent, and writing would hide that.
 */
export function withInstructions(latest: SystemPromptConfig, draft: SystemPromptConfig): SystemPromptConfig {
  if (latest.fullOverride?.trim()) throw new PromptReplacedError()
  const next: SystemPromptConfig = { ...latest }
  for (const key of INSTRUCTIONS) {
    if (draft[key]) next[key] = draft[key]
    else delete next[key]
  }
  return next
}

/** Whether an element's pane and dialog are open, so a hidden settings pane reads nothing. */
export function useShown<T extends HTMLElement = HTMLDivElement>(eager: boolean) {
  const ref = useRef<T>(null)
  const [shown, setShown] = useState(eager)
  useEffect(() => {
    const node = ref.current
    if (shown || !node) return
    const check = () => {
      if (!node.closest('[hidden]') && (node.closest('dialog')?.open ?? true)) setShown(true)
    }
    check()
    // The pane and the dialog around it are shown by attribute changes on its ancestors.
    const observer = new MutationObserver(check)
    for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement)
      observer.observe(parent, { attributes: true, attributeFilter: ['hidden', 'open'] })
    return () => observer.disconnect()
  }, [shown])
  return [ref, shown] as const
}

export const canEditPrompt = async () => {
  const context = await PluginAdminApi.context()
  return !context.readOnly && hasPermission(context.permissions, 'packages.activate')
}

/** Whether this connection may save, asked once the surface is shown. */
export function useCanSave(shown: boolean, permission: () => Promise<boolean>) {
  const [canSave, setCanSave] = useState(false)
  useEffect(() => {
    if (!shown) return
    let current = true
    void permission().then(
      (value) => {
        if (current) setCanSave(value)
      },
      () => {},
    )
    return () => {
      current = false
    }
  }, [shown, permission])
  return canSave
}

/** Two configurations say the same, ignoring empty fields. */
export function samePromptConfig(a: SystemPromptConfig, b: SystemPromptConfig): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof SystemPromptConfig)[])
  return [...keys].every((key) => (a[key] ?? '') === (b[key] ?? ''))
}
