/** The launcher holds the Node control-plane client; page code never obtains its authority. */
export async function callChannel<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch('/api/channels', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  if (!response.ok) throw new Error('Channel operation was not confirmed')
  return response.json() as Promise<T>
}
