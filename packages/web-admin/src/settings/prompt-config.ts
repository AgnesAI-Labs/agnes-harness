import type { SystemPromptConfig } from '@agnes/protocol'
import { hasPermission, queueResourceWrite, scopedResourceKey, setResource, useResource } from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PluginAdminApi } from '../admin/plugins/api.js'
import { SystemPromptConflict, systemPromptApi } from './system-prompt-api.js'

export const PROMPT_NAMESPACE = '@agnes/web/system-prompt'
export const browserPromptApi = systemPromptApi()
export type PromptApi = ReturnType<typeof systemPromptApi>

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
 * A conditional save also refuses a competing write after that read. Publish its saved value for
 * review while the editor keeps its own draft; only a successful resubmission clears the conflict.
 */
export function usePromptSnapshot(api: PromptApi, enabled = true) {
  const key = scopedResourceKey(api, 'settings:prompt')
  const state = useResource(enabled ? key : undefined, () => api.get())
  const [conflict, setConflict] = useState<SystemPromptConflict['current']>()
  const save = useCallback(
    (change: (latest: SystemPromptConfig) => SystemPromptConfig, confirmFullOverride = false) =>
      queueResourceWrite(key, async () => {
        const latest = await api.get()
        // A current snapshot also exposes a replacement that refuses this draft's save.
        setResource(key, latest)
        // Session previews may omit revisions; a settings write must never fall back to an unconditional save.
        if (latest.revision === undefined) throw new Error('Prompt revision unavailable')
        try {
          const result = await api.save({
            config: change(latest.config),
            confirmFullOverride,
            expectedRevision: latest.revision,
          })
          setResource(key, result)
          setConflict(undefined)
          return result
        } catch (error) {
          if (error instanceof SystemPromptConflict) {
            setResource(key, error.current)
            setConflict(error.current)
          }
          throw error
        }
      }),
    [api, key],
  )
  return {
    snapshot: state.data,
    busy: state.loading,
    failed: !!state.error,
    conflict: conflict ? (state.data ?? conflict) : undefined,
    save,
    reload: state.reload,
  }
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

/**
 * Counts how often the element has come into view. Settings keep their pages mounted while the
 * dialog is closed, so a page that shows files others may change re-reads on each new visit.
 */
export function useVisits<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null)
  const [visits, setVisits] = useState(0)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    let visible = false
    const check = () => {
      const now = !node.closest('[hidden]') && (node.closest('dialog')?.open ?? true)
      if (now && !visible) setVisits((count) => count + 1)
      visible = now
    }
    check()
    const observer = new MutationObserver(check)
    for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement)
      observer.observe(parent, { attributes: true, attributeFilter: ['hidden', 'open'] })
    return () => observer.disconnect()
  }, [])
  return [ref, visits] as const
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
