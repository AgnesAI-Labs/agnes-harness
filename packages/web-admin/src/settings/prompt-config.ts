import type { SystemPromptConfig, SystemPromptSnapshot } from '@agnes/protocol'
import { hasPermission } from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PluginAdminApi } from '../admin/plugins/api.js'
import { systemPromptApi } from './system-prompt-api.js'

export const PROMPT_NAMESPACE = '@agnes/web/system-prompt'
export const browserPromptApi = systemPromptApi()
export type PromptApi = ReturnType<typeof systemPromptApi>

/** The stored prompt configuration: read once (again on `reload`), replaced by each save. */
export function usePromptSnapshot(api: PromptApi, enabled = true) {
  const [snapshot, setSnapshot] = useState<SystemPromptSnapshot>()
  const [busy, setBusy] = useState(enabled)
  const [failed, setFailed] = useState(false)
  const [reads, setReads] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads is an explicit retry.
  useEffect(() => {
    if (!enabled) return
    const pending = new AbortController()
    setBusy(true)
    void api
      .get(pending.signal)
      .then((value) => {
        if (pending.signal.aborted) return
        setSnapshot(value)
        setFailed(false)
      })
      .catch(() => {
        if (!pending.signal.aborted) setFailed(true)
      })
      .finally(() => {
        if (!pending.signal.aborted) setBusy(false)
      })
    return () => pending.abort()
  }, [api, enabled, reads])
  /** Write a whole configuration; rejects when the save fails. */
  const save = useCallback(
    async (config: SystemPromptConfig, confirmFullOverride = false) => {
      const result = await api.save({ config, confirmFullOverride })
      setSnapshot(result)
      return result
    },
    [api],
  )
  const reload = useCallback(() => setReads((value) => value + 1), [])
  return { snapshot, busy, failed, save, reload }
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
