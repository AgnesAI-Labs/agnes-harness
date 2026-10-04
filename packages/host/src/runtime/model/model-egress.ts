import { isIP } from 'node:net'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type { BindingRef, NetworkTarget, SecretConsumerBinding, SecretHandle } from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { Agent, request as send } from 'undici'
import {
  type AddressResolver,
  createPinnedLookup,
  resolvePublicAddresses,
} from '../../adapters/public-fetch/network.js'
import type { NetworkOptions } from '../providers/network.js'
import type { SecretsService } from '../providers/secrets.js'

/** Host-local model transport. No wire service, ambient credential or production installation. */
export interface ModelEgressInstallation {
  readonly binding: BindingRef
  readonly route: string
  readonly api: string
  readonly endpointRef: string
  readonly consumer: SecretConsumerBinding
  readonly handle: SecretHandle
}
export interface ModelEndpointDeclaration {
  readonly endpointRef: string
  readonly target: NetworkTarget
  readonly method: 'POST'
}
export interface ModelEgressOptions {
  readonly installation?: ModelEgressInstallation | undefined
  readonly endpoints?: readonly ModelEndpointDeclaration[] | undefined
  /** The actual selected owner checks the original source, binding and current permission. */
  readonly current?: ((context: CallContext, installation: ModelEgressInstallation) => boolean) | undefined
  readonly network?:
    | (Pick<NetworkOptions, 'identity' | 'tenantId' | 'authorize' | 'rules'> & {
        readonly resolver: AddressResolver
      })
    | undefined
  readonly secrets?: Pick<SecretsService, 'use'> | undefined
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
}
export interface ModelEgressPort {
  readonly fetch: typeof globalThis.fetch
  readonly resolveCredential: (route: string, signal: AbortSignal) => Promise<string>
  close(): Promise<void>
}
class ModelEgressError extends Error {
  constructor(
    readonly code: string,
    readonly detailCode: string,
  ) {
    super('Model egress request refused')
    this.name = 'ModelEgressError'
  }
}
function refuse(detail: string, code = 'denied'): never {
  throw new ModelEgressError(code, detail)
}

export function createModelEgress(options: ModelEgressOptions, context: CallContext): ModelEgressPort {
  const source = options.installation
  const network = options.network
  const broker = options.secrets
  const owner = options.current
  const endpoints = options.endpoints
  const installationDigest = source ? canonicalJsonDigest(source as never) : null
  const endpointDigest = endpoints ? canonicalJsonDigest(endpoints as never) : null
  const networkDigest = network
    ? canonicalJsonDigest({ rules: network.rules, tenant: network.tenantId } as never)
    : null
  const relation = () =>
    canonicalJsonDigest({
      bindingId: context.bindingId,
      principalRef: context.principalRef,
      scope: context.scope,
      invocationId: context.invocationId,
      authorizationRef: context.authorizationRef,
      deadline: context.deadline,
      traceRef: context.traceRef,
    })
  const originalRelation = relation()
  const limits = [options.maxRequestBytes, options.maxResponseBytes] as const
  const originalSignal = context.signal
  const lifetime = new AbortController()
  const work = new Set<Promise<unknown>>()
  let closing: Promise<void> | undefined
  let sent = false
  const identityResolve = network?.identity.resolve
  const auth = network?.authorize,
    identity = network?.identity,
    resolver = network?.resolver,
    use = broker?.use

  function check(signal: AbortSignal) {
    if (lifetime.signal.aborted) refuse('model_egress_closed')
    if (signal.aborted || context.signal.aborted) refuse('model_egress_cancelled', 'cancelled')
    if (!Number.isFinite(Date.parse(context.deadline)) || Date.parse(context.deadline) <= Date.now())
      refuse('model_egress_cancelled', 'cancelled')
    if (
      options.maxRequestBytes !== limits[0] ||
      options.maxResponseBytes !== limits[1] ||
      [options.maxRequestBytes ?? 1024 * 1024, options.maxResponseBytes ?? 2 * 1024 * 1024].some(
        (limit, index) =>
          !Number.isSafeInteger(limit) || limit < 0 || limit > (index === 0 ? 1024 * 1024 : 2 * 1024 * 1024),
      )
    )
      refuse('model_egress_limits')
    if (!source || !network || !broker || !owner || !endpoints || !auth || !identity || !resolver || !use)
      refuse('model_egress_owner')
    if (!['openai-completions', 'anthropic-messages'].includes(source.api))
      refuse('model_egress_api', 'incompatible')
    const declared = endpoints.filter((item) => item.endpointRef === source.endpointRef)
    if (
      declared.length !== 1 ||
      !declared[0] ||
      declared[0].method !== 'POST' ||
      !validateRuntime('NetworkTarget', declared[0].target).ok
    )
      refuse('model_egress_target')
    if (
      !validateRuntime('BindingRef', source.binding).ok ||
      source.binding.contract !== 'agh.model-adapter' ||
      !validateRuntime('SecretHandle', source.handle).ok ||
      !validateRuntime('SecretConsumerBinding', source.consumer).ok ||
      source.consumer.consumer !== 'model' ||
      source.consumer.secretId !== source.handle.secretId ||
      source.consumer.audience !== source.handle.audience ||
      context.bindingId !== source.binding.bindingId ||
      context.signal !== originalSignal ||
      relation() !== originalRelation ||
      options.installation !== source ||
      options.network !== network ||
      options.secrets !== broker ||
      options.current !== owner ||
      options.endpoints !== endpoints ||
      network.authorize !== auth ||
      network.identity !== identity ||
      network.identity.resolve !== identityResolve ||
      network.resolver !== resolver ||
      broker.use !== use ||
      canonicalJsonDigest(source as never) !== installationDigest ||
      canonicalJsonDigest(endpoints as never) !== endpointDigest ||
      canonicalJsonDigest({ rules: network.rules, tenant: network.tenantId } as never) !== networkDigest
    )
      refuse('model_egress_binding')
    if (owner(context, source) !== true) refuse('model_egress_binding')
    if (
      signal.aborted ||
      lifetime.signal.aborted ||
      context.signal !== originalSignal ||
      options.current !== owner ||
      options.network !== network ||
      options.secrets !== broker ||
      network.authorize !== auth ||
      network.identity !== identity ||
      network.identity.resolve !== identityResolve ||
      network.resolver !== resolver ||
      broker.use !== use ||
      canonicalJsonDigest({ rules: network.rules, tenant: network.tenantId } as never) !== networkDigest ||
      relation() !== originalRelation ||
      canonicalJsonDigest(source as never) !== installationDigest ||
      canonicalJsonDigest(endpoints as never) !== endpointDigest
    )
      refuse('model_egress_binding')
  }
  async function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) refuse('model_egress_cancelled', 'cancelled')
    let abort!: () => void
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new ModelEgressError('cancelled', 'model_egress_cancelled'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      return await Promise.race([promise, stopped])
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
  async function gate(target: NetworkTarget, signal: AbortSignal) {
    check(signal)
    if (!network) refuse('model_egress_owner')
    const verified = await wait(
      network.identity.resolve({ principalRef: context.principalRef }, context),
      signal,
    )
    if (
      !verified.ok ||
      !validateRuntime('AuthenticatedIdentity', verified.value).ok ||
      verified.value.principalRef !== context.principalRef ||
      verified.value.tenantRef !== network.tenantId ||
      Date.parse(verified.value.expiresAt) <= Date.now() ||
      !(await wait(Promise.resolve(network.authorize(target, context)), signal))
    )
      refuse('model_egress_network')
    check(signal)
    const rules = network.rules.filter(
      (rule) =>
        rule.scheme === target.scheme &&
        rule.host.toLowerCase() === target.host.toLowerCase() &&
        rule.port === target.port,
    )
    if (rules.some((rule) => rule.effect === 'deny')) refuse('model_egress_network')
    const rule = rules.find((rule) => rule.effect === 'allow' && rule.targetId === target.targetId)
    if (!rule) refuse('model_egress_network')
    if (rule.proxy) refuse('model_egress_proxy', 'incompatible')
    return rule
  }
  async function credential<T>(
    signal: AbortSignal,
    consume: (key: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    check(signal)
    if (!broker || !source) refuse('model_egress_owner')
    let value: T | undefined,
      consumed = false,
      localError: unknown
    const result: Outcome<void> = await wait(
      broker.use(source.handle, source.consumer, context, async (key, brokerSignal) => {
        try {
          const combined = AbortSignal.any([signal, brokerSignal])
          check(combined)
          if (consumed || !key.trim() || /[\p{Cc}]/u.test(key)) refuse('model_egress_credential')
          consumed = true
          const callback = consume(key, combined)
          work.add(callback)
          try {
            value = await callback
          } finally {
            work.delete(callback)
          }
        } catch (problem) {
          localError =
            problem instanceof ModelEgressError
              ? problem
              : new ModelEgressError(
                  sent ? 'unknown_effect' : 'denied',
                  sent ? 'model_egress_unknown' : 'model_egress_unavailable',
                )
          throw localError
        }
      }),
      signal,
    )
    if (localError) throw localError
    if (!result.ok)
      refuse(
        result.error.code === 'cancelled' ? 'model_egress_cancelled' : 'model_egress_credential',
        result.error.code === 'cancelled' ? 'cancelled' : 'denied',
      )
    check(signal)
    if (!consumed) refuse('model_egress_credential')
    return value as T
  }
  function run<T>(extra: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const timeout = new AbortController()
    const remaining = Math.min(30_000, Math.max(1, Date.parse(context.deadline) - Date.now()))
    const timer = setTimeout(() => timeout.abort(), Number.isFinite(remaining) ? remaining : 1)
    const signal = AbortSignal.any([extra, originalSignal, lifetime.signal, timeout.signal])
    const job = Promise.resolve()
      .then(() => operation(signal))
      .catch((problem) => {
        if (problem instanceof ModelEgressError) {
          if (sent && problem.code === 'cancelled') refuse('model_egress_unknown', 'unknown_effect')
          throw problem
        }
        if (signal.aborted)
          refuse(
            sent ? 'model_egress_unknown' : 'model_egress_cancelled',
            sent ? 'unknown_effect' : 'cancelled',
          )
        refuse(sent ? 'model_egress_unknown' : 'model_egress_unavailable', sent ? 'unknown_effect' : 'denied')
      })
      .finally(() => {
        clearTimeout(timer)
        work.delete(job)
      })
    work.add(job)
    return job
  }
  return Object.freeze({
    resolveCredential(route: string, signal: AbortSignal) {
      return run(signal, async (active) => {
        check(active)
        if (route !== source?.route) refuse('model_egress_binding')
        return credential(active, async (key) => key)
      })
    },
    fetch(input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) {
      // Even Request construction failures are sanitized; never forward a caller error or cause.
      return run(
        init?.signal ?? (input instanceof Request ? input.signal : originalSignal),
        async (signal) => {
          check(signal)
          const request = new Request(input, init)
          const requestSignal = AbortSignal.any([signal, request.signal])
          check(requestSignal)
          const declarations = endpoints?.filter((item) => item.endpointRef === source?.endpointRef) ?? []
          if (declarations.length !== 1) refuse('model_egress_target')
          const declaration = declarations[0]
          if (!declaration || !validateRuntime('NetworkTarget', declaration.target).ok)
            refuse('model_egress_target')
          const target = declaration.target
          const url = new URL(request.url)
          if (
            url.username ||
            url.password ||
            url.hash ||
            url.protocol !== `${target.scheme}:` ||
            url.hostname.toLowerCase() !== target.host.toLowerCase() ||
            Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== target.port ||
            url.pathname + url.search !== target.path ||
            declaration.method !== 'POST' ||
            request.method !== declaration.method
          )
            refuse('model_egress_target')
          if (sent) refuse('model_egress_replay', 'unknown_effect')
          const chunks: Uint8Array[] = []
          let bodyBytes = 0
          const reader = request.body?.getReader()
          try {
            if (reader)
              for (;;) {
                const part = await wait(reader.read(), requestSignal)
                if (part.done) break
                bodyBytes += part.value.byteLength
                if (bodyBytes > (options.maxRequestBytes ?? 1024 * 1024)) refuse('model_egress_limits')
                chunks.push(part.value)
              }
          } finally {
            if (reader) void reader.cancel().catch(() => {})
          }
          const bytes = Buffer.concat(chunks)
          if (bytes.length > (options.maxRequestBytes ?? 1024 * 1024)) refuse('model_egress_limits')
          const rule = await gate(target, requestSignal)
          if (!network) refuse('model_egress_owner')
          const addresses = rule.addresses
            ? await wait(
                network.resolver(target.host.replace(/^\[|\]$/g, ''), { all: true, order: 'verbatim' }),
                requestSignal,
              )
            : await resolvePublicAddresses(target.host, requestSignal, network.resolver).catch(() => {
                if (requestSignal.aborted) refuse('model_egress_cancelled', 'cancelled')
                refuse('model_egress_dns')
              })
          if (
            !addresses.length ||
            addresses.some(
              (item) =>
                isIP(item.address) !== item.family ||
                (item.family !== 4 && item.family !== 6) ||
                (rule.addresses && !rule.addresses.includes(item.address)),
            )
          )
            refuse('model_egress_dns')
          const literal = target.host.replace(/^\[|\]$/g, '')
          if (isIP(literal) && addresses.some((item) => item.address !== literal)) refuse('model_egress_dns')
          await gate(target, requestSignal)
          return credential(requestSignal, async (key, finalSignal) => {
            const headers: Record<string, string> = {}
            const name = source?.api === 'anthropic-messages' ? 'x-api-key' : 'authorization'
            const expected = name === 'authorization' ? `Bearer ${key}` : key
            for (const [header, value] of request.headers) {
              if (header === name) {
                if (value !== expected) refuse('model_egress_credential')
                continue
              }
              if (
                ![
                  'accept',
                  'content-type',
                  'user-agent',
                  'x-request-id',
                  'anthropic-version',
                  'anthropic-beta',
                  'x-stainless-lang',
                  'x-stainless-package-version',
                  'x-stainless-os',
                  'x-stainless-arch',
                  'x-stainless-runtime',
                  'x-stainless-runtime-version',
                  'x-stainless-retry-count',
                  'x-stainless-timeout',
                  'x-stainless-helper-method',
                  'anthropic-dangerous-direct-browser-access',
                  'x-client-request-id',
                  'x-session-affinity',
                  'x-session-id',
                  'session_id',
                ].includes(header) ||
                /[\p{Cc}]/u.test(value) ||
                value.includes(key)
              )
                refuse('model_egress_headers')
              headers[header] = value
            }
            if (url.href.includes(key) || Buffer.from(bytes).includes(Buffer.from(key)))
              refuse('model_egress_headers')
            await gate(target, finalSignal)
            check(finalSignal)
            if (sent) refuse('model_egress_replay', 'unknown_effect')
            headers[name] = expected
            const dispatcher = new Agent({
              connect: {
                lookup: createPinnedLookup(
                  addresses.map((item) => ({
                    address: item.address,
                    family: item.family as 4 | 6,
                  })),
                ),
              },
              maxHeaderSize: 16 * 1024,
            })
            try {
              sent = true
              const response = await send(url, {
                dispatcher,
                method: 'POST',
                body: bytes,
                headers,
                signal: finalSignal,
                headersTimeout: 30_000,
                bodyTimeout: 30_000,
              })
              response.body.on('error', () => {})
              try {
                if ([301, 302, 303, 307, 308].includes(response.statusCode)) refuse('model_egress_redirect')
                const chunks: Uint8Array[] = []
                let count = 0
                for await (const chunk of response.body) {
                  count += chunk.length
                  if (count > (options.maxResponseBytes ?? 2 * 1024 * 1024)) refuse('model_egress_limits')
                  chunks.push(chunk)
                }
                check(finalSignal)
                const payload = Buffer.concat(chunks)
                if (payload.includes(Buffer.from(key))) refuse('model_egress_response')
                const projected = new Headers()
                const contentType = response.headers['content-type']
                if (
                  typeof contentType === 'string' &&
                  !contentType.includes(key) &&
                  !/[\p{Cc}]/u.test(contentType)
                )
                  projected.set('content-type', contentType)
                return new Response([204, 205, 304].includes(response.statusCode) ? null : payload, {
                  status: response.statusCode,
                  headers: projected,
                })
              } finally {
                response.body.destroy()
              }
            } finally {
              await dispatcher.destroy()
            }
          })
        },
      )
    },
    close() {
      if (!closing) {
        lifetime.abort()
        closing = Promise.allSettled([...work]).then(() => undefined)
      }
      return closing
    },
  })
}
