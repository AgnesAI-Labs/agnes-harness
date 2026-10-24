import { createExternalStore } from '@agnes/web-ui'

const ROW = 'web:builtin:agnes/heads-up'
const MAX_NOTE = 300
const POLL_MS = 1000
const POLL_MAX = 25

export type HeadsUpState = { enabled?: boolean; busy?: boolean; turn?: number; text?: string }
export type HeadsUpNoteValue = { sessionId: string; turn: number; text: string }

/** The note of the latest finished turn, if the side review had something to say. Volatile: never stored. */
export const headsUpNote = createExternalStore<HeadsUpNoteValue | undefined>(undefined)

/** One line, no control or bidi characters, capped: the note is model-written text. */
export function cleanNote(text: string): string {
  const line = text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(line).slice(0, MAX_NOTE).join('')
}

export async function callHeadsUp(
  sessionId: string,
  service: 'headsup.read' | 'headsup.set',
  input: Record<string, boolean | number>,
  signal?: AbortSignal,
): Promise<HeadsUpState | undefined> {
  const response = await fetch('/api/client-modules/service', {
    method: 'POST',
    credentials: 'same-origin',
    ...(signal ? { signal } : {}),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ rowId: ROW, sessionId, service, input }),
  })
  if (!response.ok) return
  return ((await response.json()) as { output?: HeadsUpState }).output
}

/**
 * Called once when a turn finishes. The side review can still be running then, so the extension is
 * read until it settles; a session where heads-up is off answers once and nothing is shown.
 */
export async function loadHeadsUp(
  scope: { sessionId: string; turn: number },
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  const shown = headsUpNote.getSnapshot()
  if (shown && (shown.sessionId !== scope.sessionId || shown.turn !== scope.turn)) headsUpNote.set(undefined)
  for (let i = 0; i < POLL_MAX && !signal.aborted; i++) {
    const state = await callHeadsUp(scope.sessionId, 'headsup.read', { turn: scope.turn }, signal).catch(
      () => undefined,
    )
    if (signal.aborted || !state?.enabled) return
    const text = state.text ? cleanNote(state.text) : ''
    if (text) headsUpNote.set({ sessionId: scope.sessionId, turn: scope.turn, text })
    if (!state.busy) return
    await sleep(POLL_MS)
  }
}
