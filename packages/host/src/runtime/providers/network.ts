import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { Agent, ProxyAgent, request as send } from 'undici'
import { createPinnedLookup, resolvePublicAddresses } from '../../adapters/public-fetch/network.js'
import { WebFetchError } from '../../adapters/public-fetch/policy.js'
import { inlineData } from '../maintenance/authority-publication.js'

export const NETWORK_CONTRACT = 'agh.network'
export const DEFAULT_NETWORK_PROVIDER_ID = 'agh.default/network'

export interface NetworkRule {
  readonly targetId: string
  readonly scheme: 'http' | 'https'
  readonly host: string
  readonly port: number
  readonly effect: 'allow' | 'deny'
  /** Explicit deployment exception; every DNS answer must still be in this set. */
  readonly addresses?: readonly string[]
  readonly proxy?: string
}
export interface NetworkOptions {
  readonly directory: string
  readonly rules: readonly NetworkRule[]
  readonly maxBytes?: number
  readonly timeoutMs?: number
  readonly identity: {
    resolve(
      request: Wire.IdentityResolveRequest,
      context: CallContext,
    ): Promise<Outcome<Wire.AuthenticatedIdentity>>
  }
  readonly tenantId: string
  readonly authorize: (target: Wire.NetworkTarget, context: CallContext) => boolean | Promise<boolean>
  readonly content: {
    read(ref: Wire.BytesRef, context: CallContext): Promise<Uint8Array>
    retain(bytes: Uint8Array, context: CallContext): Promise<Wire.BytesRef>
  }
  readonly resolver?: typeof lookup
}
export interface NetworkService {
  readonly binding: Wire.BindingRef
  readonly providerDigest: string
  readonly features: readonly string[]
  request(input: unknown, context: CallContext): Promise<Outcome<Wire.NetworkRequestResult>>
  close(): Promise<void>
}

class NetworkFault extends Error {
  constructor(
    readonly code: Wire.RuntimeError['code'],
    readonly detail: string,
  ) {
    super('Network request refused')
  }
}
function refusal(code: Wire.RuntimeError['code'], detailCode: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Network request refused',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'network-provider',
    },
  }
}
function addressUrl(target: Wire.NetworkTarget): URL {
  if (
    !target.host ||
    /[/\\@?#\s]/u.test(target.host) ||
    target.port < 1 ||
    target.port > 65535 ||
    !target.path.startsWith('/') ||
    target.path.startsWith('//') ||
    /[\r\n#]/u.test(target.path)
  )
    throw new NetworkFault('invalid_input', 'network_target')
  const value = new URL(`${target.scheme}://${target.host}:${target.port}${target.path}`)
  if (value.username || value.password || value.hostname.toLowerCase() !== target.host.toLowerCase())
    throw new NetworkFault('invalid_input', 'network_target')
  return value
}
function interruptible<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new NetworkFault('cancelled', 'network_cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
function requestHeaders(ref: Wire.DataRef): Record<string, string> {
  if (
    ref.kind !== 'inline' ||
    canonicalJsonDigest(ref.value) !== ref.digest ||
    ref.value === null ||
    typeof ref.value !== 'object' ||
    Array.isArray(ref.value)
  )
    throw new NetworkFault('invalid_input', 'network_headers')
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(ref.value)) {
    if (
      !/^[a-zA-Z0-9-]+$/u.test(key) ||
      typeof value !== 'string' ||
      /[\r\n]/u.test(value) ||
      ['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization'].includes(
        key.toLowerCase(),
      )
    )
      throw new NetworkFault('invalid_input', 'network_headers')
    result[key.toLowerCase()] = value
  }
  return result
}
function safeHeaders(headers: Record<string, string | string[] | undefined>): Wire.DataRef {
  const result: Record<string, string> = {}
  for (const key of ['content-type', 'content-length', 'etag', 'last-modified']) {
    const value = headers[key]
    if (typeof value === 'string') result[key] = value
  }
  return inlineData(result, 'agh.network/response-headers@1')
}

export function createNetworkService(options: NetworkOptions): NetworkService {
  if (!existsSync(options.directory)) createPrivateDirectorySync(options.directory)
  const path = join(options.directory, 'requests.sqlite')
  if (!existsSync(path)) closeSync(createPrivateFileSync(path))
  const database = new DatabaseSync(path)
  database.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, output TEXT)',
  )
  const binding: Wire.BindingRef = {
    bindingId: `${DEFAULT_NETWORK_PROVIDER_ID}/binding`,
    contract: NETWORK_CONTRACT,
    logicalName: 'network',
    providerId: DEFAULT_NETWORK_PROVIDER_ID,
  }
  const providerDigest = canonicalJsonDigest({ contract: NETWORK_CONTRACT, recipe: 'pinned-undici' })
  const lifetime = new AbortController()
  const active = new Set<Promise<Outcome<Wire.NetworkRequestResult>>>()
  let closing: Promise<void> | undefined

  async function permitted(target: Wire.NetworkTarget, context: CallContext, signal: AbortSignal) {
    const identity = await interruptible(
      signal,
      options.identity.resolve({ principalRef: context.principalRef }, context),
    )
    if (
      !identity.ok ||
      !validateRuntime('AuthenticatedIdentity', identity.value).ok ||
      identity.value.principalRef !== context.principalRef ||
      identity.value.tenantRef !== options.tenantId ||
      Date.parse(identity.value.expiresAt) <= Date.now() ||
      !(await interruptible(signal, Promise.resolve(options.authorize(target, context))))
    )
      throw new NetworkFault('denied', 'network_denied')
    const candidates = options.rules.filter(
      (rule) =>
        rule.host.toLowerCase() === target.host.toLowerCase() &&
        rule.port === target.port &&
        rule.scheme === target.scheme,
    )
    if (candidates.some((rule) => rule.effect === 'deny')) throw new NetworkFault('denied', 'network_denied')
    const rule = candidates.find((rule) => rule.effect === 'allow' && rule.targetId === target.targetId)
    if (!rule) throw new NetworkFault('denied', 'network_denied')
    return rule
  }
  async function perform(input: unknown, context: CallContext): Promise<Outcome<Wire.NetworkRequestResult>> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let entered = false
    let ownsJournal = false
    try {
      if (lifetime.signal.aborted) return refusal('denied', 'network_closed')
      if (context.signal.aborted) return refusal('cancelled', 'network_cancelled')
      const parsed = validateRuntime('NetworkRequest', input)
      if (!parsed.ok) return refusal('invalid_input', 'network_schema')
      const body = parsed.value
      const remaining = Math.min(Date.parse(context.deadline) - Date.now(), options.timeoutMs ?? 30_000)
      if (!Number.isFinite(remaining) || remaining <= 0) return refusal('cancelled', 'network_deadline')
      if (body.maxBytes > (options.maxBytes ?? 2 * 1024 * 1024) || body.redirect.maxHops > 5)
        return refusal('invalid_input', 'network_limits')
      const timeout = new AbortController()
      timer = setTimeout(() => timeout.abort(), remaining)
      const signal = AbortSignal.any([context.signal, lifetime.signal, timeout.signal])
      let target = body.target
      let url = addressUrl(target)
      let headers = requestHeaders(body.headers)
      await permitted(target, context, signal)
      signal.throwIfAborted()
      const fingerprint = canonicalJsonDigest({
        tenant: options.tenantId,
        request: body,
        scope: context.scope,
        principal: context.principalRef,
      })
      const id = `${context.bindingId}/${context.invocationId}`
      const previous = database.prepare('SELECT * FROM requests WHERE id = ?').get(id)
      if (previous) {
        if (previous.fingerprint !== fingerprint) return refusal('conflict', 'network_request_identity')
        if (previous.state !== 'done') return refusal('unknown_effect', 'network_unknown')
        const restored = validateRuntime('NetworkRequestResult', JSON.parse(String(previous.output)))
        return restored.ok
          ? { ok: true, value: restored.value }
          : refusal('unknown_effect', 'network_unknown')
      }
      const payload =
        body.bodyRef === null
          ? undefined
          : new Uint8Array(await interruptible(signal, options.content.read(body.bodyRef, context)))
      signal.throwIfAborted()
      if (
        payload &&
        (payload.byteLength !== body.bodyRef?.bytes ||
          createHash('sha256').update(payload).digest('hex') !== body.bodyRef.digest)
      )
        throw new NetworkFault('invalid_input', 'network_content')
      if (database.prepare('SELECT id FROM requests WHERE id = ?').get(id)) return perform(input, context)
      database.prepare("INSERT INTO requests VALUES (?, ?, 'pending', NULL)").run(id, fingerprint)
      ownsJournal = true
      for (let hop = 0; ; hop += 1) {
        const rule = await permitted(target, context, signal)
        const addresses = rule.addresses
          ? await interruptible(
              signal,
              (options.resolver ?? lookup)(target.host.replace(/^\[|\]$/g, ''), {
                all: true,
                order: 'verbatim',
              }),
            ).then((values) => {
              if (!values.length || values.some((value) => !rule.addresses?.includes(value.address)))
                throw new NetworkFault('denied', 'network_address')
              return values.map((value) => ({ address: value.address, family: value.family as 4 | 6 }))
            })
          : await resolvePublicAddresses(target.host, signal, options.resolver)
        // Recheck current policy after DNS and immediately before establishing any connection.
        await permitted(target, context, signal)
        signal.throwIfAborted()
        let endpoint = url
        let dispatcher: Agent | ProxyAgent
        if (rule.proxy) {
          const proxy = new URL(rule.proxy)
          if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password)
            throw new NetworkFault('invalid_input', 'network_proxy')
          const pinned = addresses[0]
          if (!pinned) throw new NetworkFault('denied', 'network_address')
          endpoint = new URL(url)
          endpoint.hostname = pinned.family === 6 ? `[${pinned.address}]` : pinned.address
          headers = { ...headers, host: url.host }
          dispatcher = new ProxyAgent({
            uri: proxy.href,
            proxyTunnel: true,
            requestTls: { servername: url.hostname },
          })
        } else {
          dispatcher = new Agent({
            connect: { lookup: createPinnedLookup(addresses) },
            maxHeaderSize: 16 * 1024,
          })
        }
        entered = true
        try {
          const response = await send(endpoint, {
            dispatcher,
            method: body.method,
            headers,
            body: payload ?? null,
            signal,
            headersTimeout: remaining,
            bodyTimeout: remaining,
          })
          response.body.on('error', () => {})
          try {
            const redirect = [301, 302, 303, 307, 308].includes(response.statusCode)
            if (redirect) {
              if (
                body.redirect.mode === 'deny' ||
                hop >= body.redirect.maxHops ||
                typeof response.headers.location !== 'string'
              )
                throw new NetworkFault('denied', 'network_redirect')
              // Avoid silently changing method/body semantics when an upstream requests rewriting.
              if (body.method !== 'GET' && body.method !== 'HEAD')
                throw new NetworkFault('incompatible', 'network_redirect_method')
              const next = new URL(response.headers.location, url)
              const port = next.port ? Number(next.port) : next.protocol === 'https:' ? 443 : 80
              const mapped = options.rules.find(
                (item) =>
                  item.effect === 'allow' &&
                  item.host === next.hostname &&
                  item.port === port &&
                  `${item.scheme}:` === next.protocol,
              )
              if (!mapped || next.username || next.password || next.hash)
                throw new NetworkFault('denied', 'network_redirect')
              target = {
                targetId: mapped.targetId,
                scheme: mapped.scheme,
                host: next.hostname,
                port,
                path: next.pathname + next.search,
              }
              url = addressUrl(target)
              const { authorization: _authorization, cookie: _cookie, host: _host, ...safe } = headers
              headers = safe
              continue
            }
            const chunks: Uint8Array[] = []
            let count = 0
            for await (const chunk of response.body) {
              count += chunk.length
              if (count > body.maxBytes) throw new NetworkFault('denied', 'network_response_limit')
              chunks.push(chunk)
            }
            signal.throwIfAborted()
            const bytes = Buffer.concat(chunks)
            const bodyRef = await interruptible(signal, options.content.retain(bytes, context))
            signal.throwIfAborted()
            if (
              bodyRef.bytes !== bytes.length ||
              bodyRef.digest !== createHash('sha256').update(bytes).digest('hex')
            )
              throw new NetworkFault('internal', 'network_content')
            const value: Wire.NetworkRequestResult = {
              status: response.statusCode,
              headersRef: safeHeaders(response.headers),
              bodyRef,
              finalTarget: target,
              receipt: inlineData(
                {
                  requestId: id,
                  inputDigest: fingerprint,
                  targetId: target.targetId,
                  status: response.statusCode,
                  bytes: count,
                  responseDigest: createHash('sha256').update(bytes).digest('hex'),
                },
                'agh.network/evidence@1',
              ),
            }
            if (!validateRuntime('NetworkRequestResult', value).ok)
              throw new NetworkFault('internal', 'network_content')
            database
              .prepare("UPDATE requests SET state = 'done', output = ? WHERE id = ?")
              .run(JSON.stringify(value), id)
            return { ok: true, value }
          } finally {
            response.body.destroy()
          }
        } finally {
          await dispatcher.destroy()
        }
      }
    } catch (error) {
      if (error instanceof WebFetchError && error.code === 'WEB_BLOCKED_URL')
        return refusal('denied', 'network_address')
      if (error instanceof NetworkFault)
        return refusal(
          entered && error.code === 'cancelled' ? 'unknown_effect' : error.code,
          entered && error.code === 'cancelled' ? 'network_unknown' : error.detail,
        )
      if (lifetime.signal.aborted || context.signal.aborted)
        return refusal(
          entered ? 'unknown_effect' : 'cancelled',
          entered ? 'network_unknown' : 'network_cancelled',
        )
      return refusal(
        entered || ownsJournal ? 'unknown_effect' : 'denied',
        entered || ownsJournal ? 'network_unknown' : 'network_unavailable',
      )
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  return {
    binding,
    providerDigest,
    features: ['request', 'pinned-dns', 'proxy', 'durable-request-identity'],
    request(input, context) {
      const pending = perform(input, context)
      active.add(pending)
      void pending.finally(() => active.delete(pending))
      return pending
    },
    close() {
      if (!closing) {
        lifetime.abort()
        closing = Promise.allSettled([...active]).then(() => {
          database.close()
        })
      }
      return closing
    },
  }
}
