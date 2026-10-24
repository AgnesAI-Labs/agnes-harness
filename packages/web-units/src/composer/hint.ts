import { useCallback, useEffect, useRef, useState } from 'react'
import { useExampleHint } from './example-hint.js'

export type HintScope = { sessionId: string; turn: number; completed: boolean }
export type HintLoader = (scope: HintScope, signal: AbortSignal) => Promise<string | undefined>

/** Provider seam: both catalog and turn suggestions feed the one ghost-text renderer. */
export function useComposerHint(
  prompts: readonly string[],
  home: boolean,
  eligible: boolean,
  scope: HintScope | undefined,
  load: HintLoader | undefined,
  subscribeInvalidation?: (listener: () => void) => () => void,
) {
  const catalog = useExampleHint(prompts, home && eligible)
  const [revision, setRevision] = useState(0)
  useEffect(() => subscribeInvalidation?.(() => setRevision((value) => value + 1)), [subscribeInvalidation])
  const previous = useRef<HintScope>()
  const [suggestion, setSuggestion] = useState<{ key: string; text: string }>()
  // Closing the hint on purpose is the person's decision and outlives an emptied draft.
  const [dismissedByUser, setDismissedByUser] = useState<ReadonlySet<string>>(() => new Set())
  const key = scope ? JSON.stringify([scope.sessionId, scope.turn, revision]) : ''
  const sessionId = scope?.sessionId
  const turn = scope?.turn
  const completed = scope?.completed
  useEffect(() => {
    const prior = previous.current
    const next =
      sessionId !== undefined && turn !== undefined && completed !== undefined
        ? { sessionId, turn, completed }
        : undefined
    previous.current = next
    setSuggestion(undefined)
    if (
      !next ||
      !load ||
      !completed ||
      prior?.sessionId !== sessionId ||
      prior?.turn !== turn ||
      prior?.completed
    )
      return
    const abort = new AbortController()
    void load(next, abort.signal)
      .then((text) => {
        if (!abort.signal.aborted && text) setSuggestion({ key, text })
      })
      .catch(() => undefined)
    return () => abort.abort()
  }, [sessionId, turn, completed, load, key])
  const dismiss = useCallback(() => {
    setDismissedByUser((keys) => {
      if (keys.has(key)) return keys
      const next = new Set(keys)
      next.add(key)
      return next
    })
  }, [key])
  if (home) return catalog
  // `eligible` already means an empty draft with nothing attached, so no separate typing pause is
  // needed: a late edit that re-set one used to keep the suggestion hidden for the whole turn.
  const visible = eligible && completed === true && suggestion?.key === key && !dismissedByUser.has(key)
  return {
    visible,
    text: visible ? suggestion.text : '',
    // The turn suggestion has no animation: an available text is adoptable as soon as it is shown.
    adoptText: visible ? suggestion.text : '',
    dismiss,
  }
}
