export function loopbackOrigin(value: string): URL {
  let origin: URL
  try {
    origin = new URL(value)
  } catch {
    throw new Error('Web origin must be an exact loopback HTTP origin')
  }
  if (
    origin.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('Web origin must be an exact loopback HTTP origin')
  return origin
}

export function loopbackWs(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('WebSocket endpoint must be a credential-free loopback URL')
  }
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('WebSocket endpoint must be a credential-free loopback URL')
  return url
}

export function port(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new Error('invalid Web port')
  return value
}
