import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

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
  /** The last save failed; the group label offers 「重试」. */
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
  stored,
  save,
  equal = Object.is,
  idle = AUTOSAVE_IDLE_MS,
}: {
  stored: T | undefined
  save(next: T): Promise<unknown>
  equal?(a: T, b: T): boolean
  idle?: number
}): Autosave<T> {
  const undo = useContext(UndoContext)
  const [draft, setDraft] = useState<{ value: T } | undefined>()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef<{ value: T; previous: T | undefined } | undefined>(undefined)
  const latest = useRef({ stored, save, equal })
  latest.current = { stored, save, equal }
  const reverting = useRef(false)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
      clearTimeout(timer.current)
    },
    [],
  )

  const write = useCallback(
    (value: T, previous: T | undefined) => {
      clearTimeout(timer.current)
      pending.current = undefined
      const { stored: known, save: send, equal: same } = latest.current
      if (known !== undefined && same(value, known)) {
        setDraft(undefined)
        setFailed(false)
        return
      }
      const undoable = !reverting.current
      reverting.current = false
      setBusy(true)
      void send(value).then(
        () => {
          if (!mounted.current) return
          setBusy(false)
          setFailed(false)
          // The stored value catches up with the next read; until then the edit stays shown.
          if (undoable && previous !== undefined)
            undo?.push({
              revert: () => {
                reverting.current = true
                setDraft({ value: previous })
                write(previous, value)
              },
            })
        },
        () => {
          if (!mounted.current) return
          setBusy(false)
          setFailed(true)
          pending.current = { value, previous }
        },
      )
    },
    [undo],
  )

  // Once the stored value matches the edit, the edit is no longer needed.
  useEffect(() => {
    if (draft && stored !== undefined && !pending.current && equal(draft.value, stored)) setDraft(undefined)
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
