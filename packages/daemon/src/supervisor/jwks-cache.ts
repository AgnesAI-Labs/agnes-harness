import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'

export type Jwk = { kid?: string; kty: 'RSA' | 'EC' | 'oct'; [k: string]: unknown }
export type JwksResponse = {
  status: number
  contentLength?: number
  remoteAddress: string
  body: AsyncIterable<Uint8Array>
}
export type JwksTransport = (url: URL, pinnedAddress: string, signal: AbortSignal) => Promise<JwksResponse>
export type JwksResolver = (hostname: string, signal: AbortSignal) => Promise<string[]>

const MAX_JWKS_BYTES = 1024 * 1024

function forbiddenV4(address: string): boolean {
  const p = address.split('.').map(Number)
  if (p.length !== 4 || p.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a = 0, b = 0, c = 0] = p
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

export function isForbiddenJwksAddress(address: string): boolean {
  if (address.includes('%')) return true
  if (isIP(address) === 4) return forbiddenV4(address)
  if (isIP(address) !== 6) return true
  const dotted = address.toLowerCase().match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (dotted) return forbiddenV4(dotted)
  const halves = address.toLowerCase().split('::')
  const left = (halves[0] ? halves[0].split(':') : []).map((word) => Number.parseInt(word, 16))
  const right = (halves[1] ? halves[1].split(':') : []).map((word) => Number.parseInt(word, 16))
  const words =
    halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word))) return true
  if (words.every((word) => word === 0)) return true
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const high = words[6] as number
    const low = words[7] as number
    return forbiddenV4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`)
  }
  const first = words[0] as number
  // Public IPv6 is allocated from 2000::/3. An allow-list is intentional: future local/special
  // ranges fail closed until classified, including deprecated fec0::/10 site-local space.
  if ((first & 0xe000) !== 0x2000) return true
  // Special-purpose prefixes embedded inside 2000::/3 are not public fetch destinations.
  if (first === 0x2001) {
    const second = words[1] as number
    if (second <= 0x0002 || second === 0x0100 || second === 0x0db8) return true // special-use, discard, docs
    if ((second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020) return true // ORCHID
  }
  if (first === 0x2002) return true // deprecated 6to4 can tunnel an embedded private IPv4 target
  if (first === 0x3ffe) return true // former 6bone allocation
  if (first === 0x3fff && (words[1] as number) <= 0x0fff) return true // documentation 3fff::/20
  return false
}

const defaultResolver: JwksResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('JWKS request aborted'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('JWKS request aborted'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

const defaultTransport: JwksTransport = (url, pinnedAddress, signal) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        signal,
        servername: url.hostname,
        lookup: (_hostname, _options, callback) =>
          callback(null, pinnedAddress, isIP(pinnedAddress) as 4 | 6),
      },
      (response) => {
        const remoteAddress = response.socket.remoteAddress ?? ''
        const contentLength = Number(response.headers['content-length'] ?? 0) || undefined
        resolve({
          status: response.statusCode ?? 0,
          ...(contentLength ? { contentLength } : {}),
          remoteAddress,
          body: response,
        })
      },
    )
    req.once('error', reject)
    req.end()
  })

function keysFrom(value: unknown): Jwk[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { keys?: unknown }).keys)) return []
  return (value as { keys: unknown[] }).keys.filter(
    (key): key is Jwk =>
      !!key &&
      typeof key === 'object' &&
      ['RSA', 'EC', 'oct'].includes(String((key as { kty?: unknown }).kty)),
  )
}

export async function loadJwks(
  url: string,
  o: { resolver?: JwksResolver; transport?: JwksTransport; signal?: AbortSignal } = {},
): Promise<Jwk[]> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Error('JWKS URL must be credential-free HTTPS')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  const abort = () => controller.abort(o.signal?.reason)
  if (o.signal?.aborted) abort()
  else o.signal?.addEventListener('abort', abort, { once: true })
  try {
    const addresses = await abortable(
      (o.resolver ?? defaultResolver)(parsed.hostname, controller.signal),
      controller.signal,
    )
    if (addresses.length === 0 || addresses.some(isForbiddenJwksAddress))
      throw new Error('JWKS host resolves to a forbidden address')
    const pinnedAddress = addresses[0] as string
    const response = await (o.transport ?? defaultTransport)(parsed, pinnedAddress, controller.signal)
    if (response.remoteAddress !== pinnedAddress) throw new Error('JWKS connection address changed')
    if (response.status < 200 || response.status >= 300) throw new Error(`JWKS HTTP ${response.status}`)
    if ((response.contentLength ?? 0) > MAX_JWKS_BYTES) throw new Error('JWKS response too large')
    const chunks: Uint8Array[] = []
    let length = 0
    for await (const chunk of response.body) {
      length += chunk.byteLength
      if (length > MAX_JWKS_BYTES) {
        controller.abort()
        throw new Error('JWKS response too large')
      }
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks, length)
    const keys = keysFrom(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    if (keys.length === 0) throw new Error('JWKS contains no supported keys')
    return keys
  } finally {
    clearTimeout(timeout)
    o.signal?.removeEventListener('abort', abort)
  }
}

/** Serializes refreshes, retains last-known-good keys, and drains/aborts work on shutdown. */
export async function startJwksCache(o: {
  url: string
  target: { jwks?: Jwk[] }
  resolver?: JwksResolver
  transport?: JwksTransport
  intervalMs?: number
}): Promise<() => Promise<void>> {
  let stopped = false
  let active: Promise<void> | undefined
  let controller: AbortController | undefined
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (active) return active
    controller = new AbortController()
    active = loadJwks(o.url, {
      ...(o.resolver ? { resolver: o.resolver } : {}),
      ...(o.transport ? { transport: o.transport } : {}),
      signal: controller.signal,
    })
      .then((keys) => {
        if (!stopped) o.target.jwks = keys
      })
      .finally(() => {
        active = undefined
        controller = undefined
      })
    return active
  }
  await refresh()
  const timer = setInterval(() => void refresh().catch(() => undefined), o.intervalMs ?? 300_000)
  timer.unref()
  return async () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    controller?.abort()
    await active?.catch(() => undefined)
  }
}
