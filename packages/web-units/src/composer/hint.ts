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
  const [dismissed, setDismissed] = useState<string>()
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
  const pause = useCallback(() => setDismissed(key), [key])
  const resume = useCallback(() => undefined, [])
  if (home) return catalog
  const visible = eligible && completed === true && suggestion?.key === key && dismissed !== key
  return {
    visible,
    text: visible ? suggestion.text : '',
    complete: visible,
    pause,
    resume,
  }
}
