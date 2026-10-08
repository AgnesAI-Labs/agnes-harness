import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

const MAX_RESPONSE_BYTES = 64 * 1024

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('The operation was aborted', 'AbortError')

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortError(signal)
}

const forbiddenV4 = (address: string): boolean => {
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

/** Refuse non-routable, local, documentation, multicast and metadata address space. */
export function isForbiddenTrajectoryAddress(input: string): boolean {
  const address = input.toLowerCase()
  if (address.includes('%')) return true
  if (isIP(address) === 4) return forbiddenV4(address)
  if (isIP(address) !== 6) return true
  const dotted = address.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (dotted) return forbiddenV4(dotted)
  const halves = address.split('::')
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
  if ((first & 0xe000) !== 0x2000) return true
  if (first === 0x2001) {
    const second = words[1] as number
    if (second <= 0x0002 || second === 0x0100 || second === 0x0db8) return true
    if ((second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020) return true
  }
  return first === 0x2002 || first === 0x3ffe || (first === 0x3fff && (words[1] as number) <= 0x0fff)
}

export type TrajectoryResolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly { address: string; family: 4 | 6 }[]>

export const resolvePublicTrajectoryAddresses: TrajectoryResolver = async (hostname, signal) => {
  throwIfAborted(signal)
  const lookup = dnsLookup(hostname, { all: true, verbatim: true })
  let rejectAbort: (reason: unknown) => void = () => undefined
  const onAbort = (): void => rejectAbort(abortError(signal))
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
    signal.addEventListener('abort', onAbort, { once: true })
  })
  let addresses: Awaited<typeof lookup>
  try {
    addresses = await Promise.race([lookup, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  throwIfAborted(signal)
  if (addresses.length === 0 || addresses.some(({ address }) => isForbiddenTrajectoryAddress(address)))
    throw new Error('trajectory endpoint did not resolve exclusively to public addresses')
  if (addresses.some(({ family }) => family !== 4 && family !== 6))
    throw new Error('trajectory endpoint resolved to an unsupported address family')
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }))
}

const sameAddress = (actual: string | undefined, pinned: string): boolean =>
  actual === pinned || actual?.toLowerCase() === `::ffff:${pinned.toLowerCase()}`

/** HTTPS-only transport whose TLS connection is pinned to the public address just authorized. */
export function createPinnedTrajectoryFetch(
  resolver: TrajectoryResolver = resolvePublicTrajectoryAddresses,
): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.protocol !== 'https:') throw new Error('production trajectory endpoint must use https')
    const signal = init.signal ?? new AbortController().signal
    throwIfAborted(signal)
    const addresses = await resolver(url.hostname, signal)
    throwIfAborted(signal)
    const pinned = addresses[0]
    if (!pinned || addresses.some(({ address }) => isForbiddenTrajectoryAddress(address)))
      throw new Error('trajectory endpoint address is not public')
    const body = init.body
    if (
      body !== undefined &&
      body !== null &&
      typeof body !== 'string' &&
      !(body instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(body)
    )
      throw new Error('trajectory transport only accepts buffered request bodies')
    const bytes =
      body === undefined || body === null
        ? undefined
        : typeof body === 'string'
          ? Buffer.from(body)
          : body instanceof ArrayBuffer
            ? Buffer.from(body)
            : Buffer.from(body.buffer, body.byteOffset, body.byteLength)
    throwIfAborted(signal)
    return await new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          method: init.method ?? 'GET',
          headers: Object.fromEntries(new Headers(init.headers)),
          signal,
          servername: url.hostname,
          lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
        },
        (response) => {
          if (!sameAddress(response.socket.remoteAddress, pinned.address)) {
            response.destroy(new Error('trajectory peer address did not match DNS pin'))
            return
          }
          const chunks: Buffer[] = []
          let length = 0
          response.on('data', (chunk: Buffer) => {
            length += chunk.byteLength
            if (length > MAX_RESPONSE_BYTES) response.destroy(new Error('trajectory response too large'))
            else chunks.push(chunk)
          })
          response.on('error', reject)
          response.on('end', () => {
            const headers = new Headers()
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) for (const item of value) headers.append(name, item)
              else if (value !== undefined) headers.set(name, value)
            }
            const candidate = response.statusCode ?? 500
            const status = candidate >= 200 && candidate <= 599 ? candidate : 500
            const responseBody =
              status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks)
            resolve(new Response(responseBody, { status, headers }))
          })
        },
      )
      req.on('error', reject)
      if (bytes) req.write(bytes)
      req.end()
    })
  }) as typeof fetch
}
