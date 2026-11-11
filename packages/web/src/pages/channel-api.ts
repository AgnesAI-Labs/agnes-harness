/** The launcher holds the Node control-plane client; page code never obtains its authority. */
export async function callChannel<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch('/api/channels', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as
      | { error?: { data?: { code?: unknown } } }
      | undefined
    const code = body?.error?.data?.code
    throw Object.assign(
      new Error('Channel operation was not confirmed'),
      typeof code === 'string' ? { code } : {},
    )
  }
  return response.json() as Promise<T>
}
