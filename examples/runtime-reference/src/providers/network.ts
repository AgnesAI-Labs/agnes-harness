import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { closeSync, existsSync, fsyncSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import {
  createPrivateDirectorySync,
  createPrivateFileSync,
  renameWriteThroughSync,
  syncDirectorySync,
} from '@agnes/system-node'

interface Destination {
  readonly targetId: string
  readonly scheme: 'http' | 'https'
  readonly host: string
  readonly port: number
  readonly effect: 'allow' | 'deny'
  readonly addresses?: readonly string[]
  readonly proxy?: string
}
export interface ReferenceNetworkOptions {
  readonly directory: string
  readonly rules: readonly Destination[]
  readonly tenantId: string
  readonly maxBytes?: number
  readonly timeoutMs?: number
  readonly identity: {
    resolve(
      request: W.IdentityResolveRequest,
      context: CallContext,
    ): Promise<Outcome<W.AuthenticatedIdentity>>
  }
  readonly authorize: (target: W.NetworkTarget, context: CallContext) => boolean | Promise<boolean>
  readonly content: {
    read(ref: W.BytesRef, context: CallContext): Promise<Uint8Array>
    retain(bytes: Uint8Array, context: CallContext): Promise<W.BytesRef>
  }
  readonly resolver?: typeof lookup
}
class Refusal {
  constructor(
    readonly detail: string,
    readonly code: W.RuntimeError['code'] = 'denied',
  ) {}
}
function outcome<T = never>(problem: Refusal): Outcome<T> {
  return {
    ok: false,
    error: {
      message: 'Network request refused',
      code: problem.code,
      detailCode: problem.detail,
      diagnosticId: 'reference-network',
      retryAdvice: { kind: 'never' },
    },
  }
}
function box(value: W.JsonValue, typeId: string): W.DataRef {
  const digest = canonicalJsonDigest(value)
  return {
    kind: 'inline',
    value,
    digest,
    bytes: Buffer.byteLength(JSON.stringify(value)),
    schema: { typeId, digest, revision: 1 },
  }
}
async function until<T>(signal: AbortSignal, task: Promise<T>): Promise<T> {
  let stop!: () => void
  const interrupted = new Promise<never>((_, reject) => {
    stop = () => reject(new Refusal('network_cancelled', 'cancelled'))
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
  })
  try {
    return await Promise.race([task, interrupted])
  } finally {
    signal.removeEventListener('abort', stop)
  }
}
function urlOf(target: W.NetworkTarget): URL {
  if (
    !(target.port > 0 && target.port <= 65535) ||
    !target.path.startsWith('/') ||
    target.path.startsWith('//') ||
    /[\r\n#]/u.test(target.path) ||
    /[/\\@?#\s]/u.test(target.host)
  )
    throw new Refusal('network_target', 'invalid_input')
  const parsed = new URL(`${target.scheme}://${target.host}:${target.port}${target.path}`)
  if (parsed.hostname.toLowerCase() !== target.host.toLowerCase())
    throw new Refusal('network_target', 'invalid_input')
  return parsed
}
// This small reference supports IPv4 public addresses only. Unsupported address families never fall back.
function publicV4(address: string): boolean {
  if (isIP(address) !== 4) return false
  const octets = address.split('.').map(Number)
  const a = octets[0] ?? -1
  const b = octets[1] ?? -1
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && octets[2] === 100))) ||
    (a === 203 && b === 0 && octets[2] === 113)
  )
}
export function createReferenceNetwork(config: ReferenceNetworkOptions) {
  if (!existsSync(config.directory)) createPrivateDirectorySync(config.directory)
  const stopping = new AbortController()
  const inflight = new Set<Promise<unknown>>()
  let drain: Promise<void> | null = null
  const binding: W.BindingRef = {
    contract: 'agh.network',
    logicalName: 'network',
    providerId: 'agh.reference/network',
    bindingId: 'agh.reference/network/binding',
  }

  async function gate(
    destination: W.NetworkTarget,
    context: CallContext,
    cancel: AbortSignal,
  ): Promise<Destination> {
    const identity = await until(
      cancel,
      config.identity.resolve({ principalRef: context.principalRef }, context),
    )
    if (
      !identity.ok ||
      !validateRuntime('AuthenticatedIdentity', identity.value).ok ||
      identity.value.tenantRef !== config.tenantId ||
      identity.value.principalRef !== context.principalRef ||
      Date.parse(identity.value.expiresAt) <= Date.now() ||
      !(await until(cancel, Promise.resolve(config.authorize(destination, context))))
    )
      throw new Refusal('network_denied')
    const matches = config.rules.filter(
      (item) =>
        item.scheme === destination.scheme &&
        item.host.toLowerCase() === destination.host.toLowerCase() &&
        item.port === destination.port,
    )
    if (matches.some((item) => item.effect === 'deny')) throw new Refusal('network_denied')
    const allowed = matches.find((item) => item.targetId === destination.targetId && item.effect === 'allow')
    if (!allowed) throw new Refusal('network_denied')
    if (allowed.proxy) throw new Refusal('network_proxy_unsupported', 'incompatible')
    return allowed
  }
  async function transaction(value: unknown, context: CallContext): Promise<Outcome<W.NetworkRequestResult>> {
    let clock: ReturnType<typeof setTimeout> | undefined
    let connected = false
    try {
      if (stopping.signal.aborted) return outcome(new Refusal('network_closed'))
      if (context.signal.aborted) return outcome(new Refusal('network_cancelled', 'cancelled'))
      const parsed = validateRuntime('NetworkRequest', value)
      if (!parsed.ok) throw new Refusal('network_schema', 'invalid_input')
      const plan = parsed.value
      const budget = Math.min(config.timeoutMs ?? 30000, Date.parse(context.deadline) - Date.now())
      if (!(budget > 0)) throw new Refusal('network_deadline', 'cancelled')
      if (plan.maxBytes > (config.maxBytes ?? 2 * 1024 * 1024) || plan.redirect.maxHops > 5)
        throw new Refusal('network_limits', 'invalid_input')
      const alarm = new AbortController()
      clock = setTimeout(() => alarm.abort(), budget)
      const cancel = AbortSignal.any([context.signal, stopping.signal, alarm.signal])
      const headers: Record<string, string> = {}
      if (
        plan.headers.kind !== 'inline' ||
        !plan.headers.value ||
        typeof plan.headers.value !== 'object' ||
        Array.isArray(plan.headers.value) ||
        plan.headers.digest !== canonicalJsonDigest(plan.headers.value)
      )
        throw new Refusal('network_headers', 'invalid_input')
      const forbidden = new Set([
        'host',
        'content-length',
        'transfer-encoding',
        'connection',
        'proxy-authorization',
      ])
      for (const pair of Object.entries(plan.headers.value)) {
        if (
          typeof pair[1] !== 'string' ||
          /[\r\n]/u.test(pair[1]) ||
          !/^[A-Za-z0-9-]+$/u.test(pair[0]) ||
          forbidden.has(pair[0].toLowerCase())
        )
          throw new Refusal('network_headers', 'invalid_input')
        headers[pair[0].toLowerCase()] = pair[1]
      }
      let target = plan.target
      let url = urlOf(target)
      await gate(target, context, cancel)
      cancel.throwIfAborted()
      const identity = `${context.bindingId}/${context.invocationId}`
      const digest = canonicalJsonDigest({
        tenant: config.tenantId,
        request: plan,
        scope: context.scope,
        principal: context.principalRef,
      })
      const filename = join(config.directory, canonicalJsonDigest(identity))
      if (existsSync(filename)) {
        const saved = JSON.parse(readFileSync(filename, 'utf8')) as { digest: string; output: unknown }
        if (saved.digest !== digest) throw new Refusal('network_request_identity', 'conflict')
        if (saved.output === null) throw new Refusal('network_unknown', 'unknown_effect')
        const output = validateRuntime('NetworkRequestResult', saved.output)
        if (!output.ok) throw new Refusal('network_unknown', 'unknown_effect')
        return { ok: true, value: output.value }
      }
      const body = plan.bodyRef ? await until(cancel, config.content.read(plan.bodyRef, context)) : undefined
      cancel.throwIfAborted()
      if (
        body &&
        (body.byteLength !== plan.bodyRef?.bytes ||
          createHash('sha256').update(body).digest('hex') !== plan.bodyRef.digest)
      )
        throw new Refusal('network_content', 'invalid_input')
      if (existsSync(filename)) return transaction(value, context)
      const descriptor = createPrivateFileSync(filename)
      try {
        writeFileSync(descriptor, JSON.stringify({ digest, output: null }))
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      syncDirectorySync(config.directory)
      for (let redirects = 0; ; redirects += 1) {
        const rule = await gate(target, context, cancel)
        const answers = await until(
          cancel,
          (config.resolver ?? lookup)(target.host.replace(/^\[|\]$/g, ''), {
            all: true,
            order: 'verbatim',
          }),
        )
        cancel.throwIfAborted()
        if (!answers.length) throw new Refusal('network_address')
        if (!rule.addresses && answers.some((item) => item.family !== 4))
          throw new Refusal('network_address_family_unsupported', 'incompatible')
        if (
          answers.some((item) =>
            rule.addresses ? !rule.addresses.includes(item.address) : !publicV4(item.address),
          )
        )
          throw new Refusal('network_address')
        await gate(target, context, cancel)
        cancel.throwIfAborted()
        const endpoint = new URL(url)
        const firstAddress = answers[0]
        if (!firstAddress) throw new Refusal('network_address')
        endpoint.hostname = firstAddress.family === 6 ? `[${firstAddress.address}]` : firstAddress.address
        const transport = target.scheme === 'https' ? httpsRequest : httpRequest
        let close!: () => void
        const closed = new Promise<void>((resolve) => {
          close = resolve
        })
        const socket = transport(endpoint, {
          method: plan.method,
          signal: cancel,
          headers: { ...headers, host: url.host },
          servername: url.hostname,
          rejectUnauthorized: true,
        })
        socket.once('close', close)
        connected = true
        try {
          const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
            socket.once('response', resolve)
            socket.once('error', reject)
            socket.end(body)
          })
          try {
            if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
              if (
                plan.redirect.mode === 'deny' ||
                redirects >= plan.redirect.maxHops ||
                !response.headers.location
              )
                throw new Refusal('network_redirect')
              if (plan.method !== 'GET' && plan.method !== 'HEAD')
                throw new Refusal('network_redirect_method', 'incompatible')
              const next = new URL(response.headers.location, url)
              const port = Number(next.port || (next.protocol === 'https:' ? 443 : 80))
              const admitted = config.rules.find(
                (item) =>
                  item.effect === 'allow' &&
                  item.host === next.hostname &&
                  `${item.scheme}:` === next.protocol &&
                  item.port === port,
              )
              if (!admitted || next.username || next.password || next.hash)
                throw new Refusal('network_redirect')
              target = {
                host: next.hostname,
                port,
                scheme: admitted.scheme,
                targetId: admitted.targetId,
                path: next.pathname + next.search,
              }
              url = urlOf(target)
              for (const name of ['authorization', 'cookie', 'host']) delete headers[name]
              continue
            }
            const pieces: Buffer[] = []
            let length = 0
            for await (const piece of response) {
              length += piece.length
              if (length > plan.maxBytes) throw new Refusal('network_response_limit')
              pieces.push(Buffer.from(piece))
            }
            cancel.throwIfAborted()
            const bytes = Buffer.concat(pieces)
            const retained = await until(cancel, config.content.retain(bytes, context))
            if (
              retained.bytes !== bytes.length ||
              retained.digest !== createHash('sha256').update(bytes).digest('hex')
            )
              throw new Refusal('network_content', 'internal')
            const selected: Record<string, string> = {}
            Object.entries(response.headers).forEach(([name, content]) => {
              if (
                ['content-type', 'content-length', 'etag', 'last-modified'].includes(name) &&
                typeof content === 'string'
              )
                selected[name] = content
            })
            const output: W.NetworkRequestResult = {
              finalTarget: target,
              bodyRef: retained,
              status: response.statusCode ?? 0,
              headersRef: box(selected, 'agh.network/response-headers@1'),
              receipt: box(
                {
                  requestId: identity,
                  inputDigest: digest,
                  targetId: target.targetId,
                  status: response.statusCode ?? 0,
                  bytes: length,
                  responseDigest: createHash('sha256').update(bytes).digest('hex'),
                },
                'agh.network/evidence@1',
              ),
            }
            cancel.throwIfAborted()
            if (!validateRuntime('NetworkRequestResult', output).ok)
              throw new Refusal('network_content', 'internal')
            const temp = `${filename}.completed`
            const fd = createPrivateFileSync(temp)
            try {
              writeFileSync(fd, JSON.stringify({ digest, output }))
              fsyncSync(fd)
            } finally {
              closeSync(fd)
            }
            renameWriteThroughSync(temp, filename)
            syncDirectorySync(config.directory)
            return { ok: true, value: output }
          } finally {
            response.destroy()
          }
        } finally {
          socket.destroy()
          await closed
        }
      }
    } catch (reason) {
      if (reason instanceof Refusal)
        return outcome(
          connected && reason.code === 'cancelled'
            ? new Refusal('network_unknown', 'unknown_effect')
            : reason,
        )
      return outcome(
        new Refusal(
          connected
            ? 'network_unknown'
            : context.signal.aborted || stopping.signal.aborted
              ? 'network_cancelled'
              : 'network_unavailable',
          connected
            ? 'unknown_effect'
            : context.signal.aborted || stopping.signal.aborted
              ? 'cancelled'
              : 'denied',
        ),
      )
    } finally {
      if (clock) clearTimeout(clock)
    }
  }
  return {
    binding,
    providerDigest: canonicalJsonDigest({ contract: binding.contract, recipe: 'native-request-cabinet' }),
    features: ['request', 'pinned-dns', 'durable-request-identity'] as readonly string[],
    request(value: unknown, context: CallContext) {
      const task = transaction(value, context)
      inflight.add(task)
      void task.finally(() => inflight.delete(task))
      return task
    },
    close(): Promise<void> {
      if (!drain) {
        stopping.abort()
        drain = Promise.allSettled([...inflight]).then(() => {})
      }
      return drain
    },
  }
}
