import { lookup as nodeLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { HookProcessResult } from './map.js'

const MAX_BODY_BYTES = 64 * 1024
const MAX_PAYLOAD_BYTES = 1024 * 1024
const MAX_TIMEOUT_MS = 2_147_483_647

export type HookAddress = { address: string; family: 4 | 6 }
export type HookHttpResponse = { status: number; body: string; location?: string }
export type HookHttpRequest = {
  url: string
  address: string
  family: 4 | 6
  body: string
  timeoutMs: number
  signal?: AbortSignal
}
export type HookHttpClient = {
  resolve(host: string): Promise<HookAddress[]>
  request(input: HookHttpRequest): Promise<HookHttpResponse>
}
export type HttpHookSpec = {
  url: string
  timeoutMs: number
  allowHosts: string[]
  signal?: AbortSignal
}

function parseV4(host: string): number[] | undefined {
  const parts = host.split('.')
  if (parts.length !== 4) return undefined
  const octets = parts.map(Number)
  if (octets.some((part, index) => !/^\d+$/.test(parts[index] ?? '') || part < 0 || part > 255))
    return undefined
  return octets
}

function mappedV4(host: string): string | undefined {
  if (!host.startsWith('::ffff:')) return undefined
  const tail = host.slice('::ffff:'.length)
  if (parseV4(tail)) return tail
  const match = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail)
  if (!match) return undefined
  const hi = Number.parseInt(match[1] ?? '', 16)
  const lo = Number.parseInt(match[2] ?? '', 16)
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
}

/** True for destinations that must not be reached solely on a hostname allow-list decision. */
export function isPrivateAddress(host: string): boolean {
  const normalized = host
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true

  const mapped = mappedV4(normalized)
  if (mapped) return isPrivateAddress(mapped)

  const v4 = parseV4(normalized)
  if (v4) {
    const [a = 0, b = 0] = v4
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    )
  }

  if (isIP(normalized) !== 6) return false
  return (
    normalized === '::' ||
    normalized === '::1' ||
    /^f[cd]/.test(normalized) ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff')
  )
}

function normalizedAllowEntry(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '')
}

function allowlisted(allowHosts: string[], value: string): boolean {
  const wanted = normalizedAllowEntry(value)
  return allowHosts.some((entry) => normalizedAllowEntry(entry) === wanted)
}

export function createNodeHookHttpClient(
  options: { resolve?: (host: string) => Promise<HookAddress[]> } = {},
): HookHttpClient {
  return {
    resolve:
      options.resolve ??
      (async (host) => {
        const results = await nodeLookup(host, { all: true, verbatim: true })
        return results.flatMap((result) =>
          result.family === 4 || result.family === 6
            ? [{ address: result.address, family: result.family }]
            : [],
        )
      }),
    request(input) {
      return new Promise((resolve, reject) => {
        let settled = false
        const finish = (fn: () => void) => {
          if (settled) return
          settled = true
          fn()
        }
        const url = new URL(input.url)
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
          url,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(input.body),
            },
            lookup: (_host, options, callback) => {
              if (options.all) callback(null, [{ address: input.address, family: input.family }])
              else callback(null, input.address, input.family)
            },
            signal: input.signal,
          },
          (response) => {
            let body = ''
            let bytes = 0
            response.setEncoding('utf8')
            response.on('data', (chunk: string) => {
              bytes += Buffer.byteLength(chunk)
              if (bytes > MAX_BODY_BYTES) {
                response.destroy(new Error('hook HTTP response too large'))
                return
              }
              body += chunk
            })
            response.on('error', (error) => finish(() => reject(error)))
            response.on('end', () =>
              finish(() =>
                resolve({
                  status: response.statusCode ?? 0,
                  body,
                  ...(response.headers.location === undefined ? {} : { location: response.headers.location }),
                }),
              ),
            )
          },
        )
        request.setTimeout(input.timeoutMs, () => request.destroy(new Error('hook HTTP request timed out')))
        request.on('error', (error) => finish(() => reject(error)))
        request.end(input.body)
      })
    },
  }
}

function validateSpec(spec: HttpHookSpec): URL {
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0 || spec.timeoutMs > MAX_TIMEOUT_MS)
    throw new Error('invalid hook HTTP timeout')
  let url: URL
  try {
    url = new URL(spec.url)
  } catch {
    throw new Error('invalid hook HTTP URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.hash)
    throw new Error('invalid hook HTTP URL')
  if (!allowlisted(spec.allowHosts, url.host) && !allowlisted(spec.allowHosts, url.hostname))
    throw new Error('E_NETWORK_DENIED: hook HTTP destination is not allowlisted')
  return url
}

/** Resolve once, validate every answer, and pin the validated address into the actual socket. */
export async function runHttp(
  client: HookHttpClient,
  spec: HttpHookSpec,
  payload: unknown,
): Promise<HookProcessResult> {
  const url = validateSpec(spec)
  const body = JSON.stringify(payload)
  if (body === undefined || Buffer.byteLength(body) > MAX_PAYLOAD_BYTES)
    throw new Error('invalid hook HTTP payload')

  let addresses: HookAddress[]
  try {
    addresses = await client.resolve(url.hostname)
  } catch {
    throw new Error('hook HTTP DNS resolution failed')
  }
  if (addresses.length === 0) throw new Error('E_SSRF: hook HTTP destination did not resolve')
  for (const result of addresses) {
    if (isIP(result.address) !== result.family)
      throw new Error('E_SSRF: resolver returned an invalid address')
    if (isPrivateAddress(result.address) && !allowlisted(spec.allowHosts, result.address))
      throw new Error('E_SSRF: private resolved address is not explicitly allowlisted')
  }

  const address = addresses[0] as HookAddress
  let response: HookHttpResponse
  try {
    response = await client.request({
      url: url.href,
      address: address.address,
      family: address.family,
      body,
      timeoutMs: spec.timeoutMs,
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    })
  } catch {
    throw new Error('hook HTTP request failed')
  }
  if (response.status >= 300 && response.status < 400)
    throw new Error('E_SSRF_REDIRECT: hook HTTP redirects are disabled')

  let output: Record<string, unknown> | undefined
  if (response.body.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(response.body)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
        output = parsed as Record<string, unknown>
    } catch {
      output = undefined
    }
  }
  const ok = response.status >= 200 && response.status < 300
  return {
    exitCode: ok ? 0 : 1,
    stdout: '',
    stderr: ok ? '' : `http ${response.status}`,
    ...(output === undefined ? {} : { output }),
  }
}
