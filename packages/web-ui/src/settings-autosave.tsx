import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { queueResourceWrite, resourceWritePending } from './data/resource.js'

/** How long typing must pause before a text setting saves. */
export const AUTOSAVE_IDLE_MS = 1000

type UndoEntry = { revert(): void }
type UndoStack = { push(entry: UndoEntry): void; undo(): boolean }
const UndoContext = createContext<UndoStack | undefined>(undefined)

/** Whether a key press edits text, where ⌘Z belongs to the field itself. */
function editsText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true
  return (
    target instanceof HTMLInputElement &&
    !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(target.type)
  )
}

/**
 * The undo history of one settings surface. ⌘Z (Ctrl+Z) outside a text field reverts the most
 * recent saved change, which saves again; inside a field the field's own undo applies.
 */
export function SettingsUndoScope({ children }: { children: ReactNode }) {
  const entries = useRef<UndoEntry[]>([])
  const stack = useMemo<UndoStack>(
    () => ({
      push: (entry) => {
        entries.current = [...entries.current.slice(-49), entry]
      },
      undo: () => {
        const entry = entries.current.pop()
        entry?.revert()
        return !!entry
      },
    }),
    [],
  )
  return (
    <UndoContext.Provider value={stack}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a keyboard shortcut scope, not a control. */}
      <div
        className="agnes-settings-undo-scope"
        onKeyDown={(event) => {
          if (event.key.toLowerCase() !== 'z' || !(event.metaKey || event.ctrlKey) || event.shiftKey) return
          if (editsText(event.target)) return
          if (stack.undo()) event.preventDefault()
        }}
      >
        {children}
      </div>
    </UndoContext.Provider>
  )
}

export type Autosave<T> = {
  /** What the control shows: the last edit, or the stored value when nothing is pending. */
  value: T | undefined
  /** Record an edit. `now` saves at once (switches, choices); `idle` saves after typing pauses. */
  set(next: T, when?: 'now' | 'idle'): void
  /** Save a pending text edit at once: on blur. */
  flush(): void
  /** The last save failed; the group label offers 「Retry」. */
  failed: boolean
  retry(): void
  busy: boolean
}

/**
 * One setting that saves itself. `stored` is what the server holds; `save` writes a value and
 * rejects on failure. A failed save keeps the edit on screen so retry sends it again. Each saved
 * change can be undone with ⌘Z.
 */
export function useAutosave<T>({
  resourceKey,
  stored,
  save,
  equal = Object.is,
  idle = AUTOSAVE_IDLE_MS,
  onSaved,
}: {
  /** Shared remote resource identity; omit only for a component-local setting. */
  resourceKey?: string | undefined
  stored: T | undefined
  save(next: T): Promise<unknown>
  equal?(a: T, b: T): boolean
  onSaved?(): void
  idle?: number
}): Autosave<T> {
  const undo = useContext(UndoContext)
  const [draft, setDraft] = useState<{ value: T } | undefined>()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef<{ value: T; previous: T | undefined } | undefined>(undefined)
  const latest = useRef({ stored, save, equal, onSaved })
  latest.current = { stored, save, equal, onSaved }
  // What the last successful save wrote. Until `stored` renders that answer, it is the newer fact:
  // an edit back to the old stored value in that window still has to be sent.
  const saved = useRef<{ value: T; over: T | undefined } | undefined>(undefined)
  if (saved.current && saved.current.over !== stored) saved.current = undefined
  const reverting = useRef(false)
  // One save per setting at a time. Settings are written as whole objects, so two saves in flight
  // could land in either order and leave an older value stored. An edit made while a save is on its
  // way waits here; only the newest waiting edit is sent, once the save in flight settles.
  const inflight = useRef(false)
  const writeOwner = useRef({})
  const writeGeneration = useRef(0)
  const queued = useRef<{ value: T; previous: T | undefined; undoable: boolean } | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
      clearTimeout(timer.current)
    },
    [],
  )

  const writeRef = useRef<(value: T, previous: T | undefined) => void>(() => {})
  const send = useCallback(
    (value: T, previous: T | undefined, undoable: boolean) => {
      const generation = ++writeGeneration.current
      inflight.current = true
      setBusy(true)
      const next = () => {
        if (generation !== writeGeneration.current) return true
        inflight.current = false
        const waiting = queued.current
        queued.current = undefined
        if (waiting) send(waiting.value, waiting.previous, waiting.undoable)
        return !!waiting
      }
      const save = latest.current.save
      const work = () => save(value)
      void (resourceKey ? queueResourceWrite(resourceKey, work, writeOwner.current) : work()).then(
        () => {
          if (generation !== writeGeneration.current) return
          saved.current = { value, over: latest.current.stored }
          if (mounted.current && undoable && previous !== undefined)
            undo?.push({
              revert: () => {
                reverting.current = true
                setDraft({ value: previous })
                writeRef.current(previous, value)
              },
            })
          // A newer edit is already waiting: it is the one the outcome must describe.
          if (next() || !mounted.current) return
          setBusy(false)
          setFailed(false)
          latest.current.onSaved?.()
        },
        () => {
          // The newest edit carries the whole setting, so it supersedes this failed one.
          if (next() || !mounted.current) return
          setBusy(false)
          setFailed(true)
          pending.current = { value, previous }
        },
      )
    },
    [undo, resourceKey],
  )

  const write = useCallback(
    (value: T, previous: T | undefined) => {
      clearTimeout(timer.current)
      pending.current = undefined
      const undoable = !reverting.current
      reverting.current = false
      if (inflight.current && !resourceKey) {
        // Keep the first waiting edit's «before» so one ⌘Z steps back over the whole burst.
        queued.current = { value, previous: queued.current?.previous ?? previous, undoable }
        return
      }
      const { equal: same } = latest.current
      const known = saved.current ? saved.current.value : latest.current.stored
      if (known !== undefined && same(value, known) && !(resourceKey && resourceWritePending(resourceKey))) {
        setDraft(undefined)
        setFailed(false)
        return
      }
      send(value, previous, undoable)
    },
    [send, resourceKey],
  )
  writeRef.current = write

  // Once the stored value matches the edit, the edit is no longer needed.
  useEffect(() => {
    if (
      draft &&
      stored !== undefined &&
      !pending.current &&
      !inflight.current &&
      !queued.current &&
      equal(draft.value, stored)
    )
      setDraft(undefined)
  }, [stored, draft, equal])

  const set = useCallback(
    (next: T, when: 'now' | 'idle' = 'now') => {
      const previous = pending.current?.previous ?? latest.current.stored
      setDraft({ value: next })
      setFailed(false)
      clearTimeout(timer.current)
      timer.current = undefined
      if (when === 'now') {
        write(next, previous)
        return
      }
      pending.current = { value: next, previous }
      timer.current = setTimeout(() => {
        timer.current = undefined
        const queued = pending.current
        if (queued) write(queued.value, queued.previous)
      }, idle)
    },
    [idle, write],
  )
  const flush = useCallback(() => {
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
    const queued = pending.current
    if (queued) write(queued.value, queued.previous)
  }, [write])
  const retry = useCallback(() => {
    const queued = pending.current
    if (queued) write(queued.value, queued.previous)
  }, [write])
  return { value: draft ? draft.value : stored, set, flush, failed, retry, busy }
}
