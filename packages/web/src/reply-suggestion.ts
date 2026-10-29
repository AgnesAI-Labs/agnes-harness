/** Read only volatile plugin output; never restore a hint from storage or transcript history. */
export async function loadReplySuggestion(
  scope: { sessionId: string; turn: number },
  signal: AbortSignal,
): Promise<string | undefined> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(5500)])
  const deadline = Date.now() + 5500
  while (!signal.aborted && Date.now() < deadline) {
    const response = await fetch('/api/client-modules/service', {
      method: 'POST',
      credentials: 'same-origin',
      signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        rowId: 'web:builtin:agnes/reply-suggestions',
        sessionId: scope.sessionId,
        service: 'replies.read',
        input: { turn: scope.turn },
      }),
    })
    if (!response.ok) return
    const body = (await response.json()) as { output?: { turn?: number; text?: string } }
    if (body.output?.turn === scope.turn && typeof body.output.text === 'string') return body.output.text
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, 300)
      signal.addEventListener('abort', done, { once: true })
      if (signal.aborted) done()
    })
  }
}
