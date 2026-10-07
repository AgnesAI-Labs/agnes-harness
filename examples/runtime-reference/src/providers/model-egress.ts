import { createHash } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import { request as http } from 'node:http'
import { request as https } from 'node:https'
import { isIP } from 'node:net'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AuthenticatedIdentity,
  BindingRef,
  IdentityResolveRequest,
  NetworkTarget,
  SecretConsumerBinding,
  SecretHandle,
} from '@agnes/protocol/runtime'
import { canonicalJsonDigest as digest, validateRuntime as validate } from '@agnes/protocol/runtime'

interface InstalledModel {
  readonly binding: BindingRef
  readonly route: string
  readonly api: string
  readonly endpointRef: string
  readonly consumer: SecretConsumerBinding
  readonly handle: SecretHandle
}
interface Endpoint {
  readonly endpointRef: string
  readonly target: NetworkTarget
  readonly method: 'POST'
}
interface ReferenceModelOptions {
  readonly installation?: InstalledModel | undefined
  readonly endpoints?: readonly Endpoint[] | undefined
  readonly current?: ((call: CallContext, installed: InstalledModel) => boolean) | undefined
  readonly network?:
    | {
        readonly tenantId: string
        readonly identity: {
          resolve(input: IdentityResolveRequest, call: CallContext): Promise<Outcome<AuthenticatedIdentity>>
        }
        readonly authorize: (target: NetworkTarget, call: CallContext) => boolean | Promise<boolean>
        readonly resolver: (
          host: string,
          options: { all: true; order: 'verbatim' },
        ) => Promise<LookupAddress[]>
        readonly rules: readonly {
          targetId: string
          scheme: 'http' | 'https'
          host: string
          port: number
          effect: 'allow' | 'deny'
          addresses?: readonly string[]
          proxy?: string
        }[]
      }
    | undefined
  readonly secrets?:
    | {
        use(
          handle: unknown,
          consumer: SecretConsumerBinding,
          call: CallContext,
          take: (key: string, stop: AbortSignal) => Promise<void> | void,
        ): Promise<Outcome<void>>
      }
    | undefined
  /** Synchronous sole-send fence after TCP/TLS establishment, before request headers or body. */
  readonly beforeWrite?: ((bodyDigest: string) => boolean) | undefined
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
}
class ReferenceEgressError extends Error {
  constructor(
    readonly code: string,
    readonly detailCode: string,
  ) {
    super('Model egress request refused')
    this.name = 'ModelEgressError'
  }
}
function reject(detailCode: string, code = 'denied'): never {
  throw new ReferenceEgressError(code, detailCode)
}
function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false
  const [a = 0, b = 0, c = 0] = address.split('.').map(Number)
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  )
}

/** Independent, bounded native-HTTP recipe; IPv4 only, no proxy or credential fallback. */
export function createReferenceModelEgress(
  settings: ReferenceModelOptions,
  call: CallContext,
): {
  readonly fetch: typeof globalThis.fetch
  readonly resolveCredential: (route: string, signal: AbortSignal) => Promise<string>
  fenced(): boolean
  close(): Promise<void>
} {
  const installed = settings.installation,
    destinations = settings.endpoints,
    policy = settings.network
  const takeKey = settings.secrets,
    stillInstalled = settings.current
  const captures = new Map<string, unknown>(Object.entries(settings))
  const frozen = digest({
    installed: installed ?? null,
    endpoints: destinations ?? null,
    network: policy ? { rules: policy.rules, tenant: policy.tenantId } : null,
  } as never)
  const callStamp = () =>
    digest({
      principalRef: call.principalRef,
      scope: call.scope,
      bindingId: call.bindingId,
      invocationId: call.invocationId,
      authorizationRef: call.authorizationRef,
      deadline: call.deadline,
      traceRef: call.traceRef,
    })
  const issuedStamp = callStamp(),
    callerSignal = call.signal
  const hooks = [
    policy?.identity,
    policy?.identity.resolve,
    policy?.authorize,
    policy?.resolver,
    takeKey?.use,
  ]
  const stop = new AbortController()
  const pending = new Set<Promise<unknown>>()
  let disposal: Promise<void> | undefined,
    dispatched = false,
    committed = false
  function unchanged() {
    return (
      [...captures].every(([key, value]) => settings[key as keyof ReferenceModelOptions] === value) &&
      call.signal === callerSignal &&
      callStamp() === issuedStamp &&
      [policy?.identity, policy?.identity.resolve, policy?.authorize, policy?.resolver, takeKey?.use].every(
        (hook, i) => hook === hooks[i],
      ) &&
      frozen ===
        digest({
          installed: installed ?? null,
          endpoints: destinations ?? null,
          network: policy ? { rules: policy.rules, tenant: policy.tenantId } : null,
        } as never)
    )
  }
  function permit(signal: AbortSignal) {
    if (stop.signal.aborted) reject('model_egress_closed')
    if (
      signal.aborted ||
      callerSignal.aborted ||
      !Number.isFinite(Date.parse(call.deadline)) ||
      Date.parse(call.deadline) <= Date.now()
    )
      reject('model_egress_cancelled', 'cancelled')
    const requestLimit = settings.maxRequestBytes ?? 1024 * 1024,
      responseLimit = settings.maxResponseBytes ?? 2 * 1024 * 1024
    if (
      ![requestLimit, responseLimit].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      requestLimit > 1024 * 1024 ||
      responseLimit > 2 * 1024 * 1024
    )
      reject('model_egress_limits')
    if (
      !installed ||
      !destinations ||
      !policy ||
      !takeKey ||
      !stillInstalled ||
      !policy.identity ||
      !policy.authorize ||
      !policy.resolver ||
      !takeKey.use
    )
      reject('model_egress_owner')
    if (installed.api !== 'openai-completions' && installed.api !== 'anthropic-messages')
      reject('model_egress_api', 'incompatible')
    const declarations = destinations.filter((item) => item.endpointRef === installed.endpointRef)
    if (
      declarations.length !== 1 ||
      !declarations[0] ||
      declarations[0].method !== 'POST' ||
      !validate('NetworkTarget', declarations[0].target).ok
    )
      reject('model_egress_target')
    if (
      !unchanged() ||
      !validate('BindingRef', installed.binding).ok ||
      installed.binding.contract !== 'agh.model-adapter' ||
      !validate('SecretHandle', installed.handle).ok ||
      !validate('SecretConsumerBinding', installed.consumer).ok ||
      installed.consumer.consumer !== 'model' ||
      installed.consumer.audience !== installed.handle.audience ||
      installed.consumer.secretId !== installed.handle.secretId ||
      call.bindingId !== installed.binding.bindingId ||
      stillInstalled(call, installed) !== true ||
      !unchanged()
    )
      reject('model_egress_binding')
  }
  function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, fail) => {
      const listener = () => fail(new ReferenceEgressError('cancelled', 'model_egress_cancelled'))
      signal.addEventListener('abort', listener, { once: true })
      if (signal.aborted) listener()
      task.then(resolve, fail).finally(() => signal.removeEventListener('abort', listener))
    })
  }
  async function policyGate(target: NetworkTarget, signal: AbortSignal) {
    permit(signal)
    if (!policy) reject('model_egress_owner')
    const auth = await abortable(policy.identity.resolve({ principalRef: call.principalRef }, call), signal)
    if (
      !auth.ok ||
      !validate('AuthenticatedIdentity', auth.value).ok ||
      auth.value.principalRef !== call.principalRef ||
      auth.value.tenantRef !== policy.tenantId ||
      Date.parse(auth.value.expiresAt) <= Date.now() ||
      !(await abortable(Promise.resolve(policy.authorize(target, call)), signal))
    )
      reject('model_egress_network')
    permit(signal)
    let match: (typeof policy.rules)[number] | undefined
    for (const entry of policy.rules) {
      if (
        entry.scheme !== target.scheme ||
        entry.host.toLowerCase() !== target.host.toLowerCase() ||
        entry.port !== target.port
      )
        continue
      if (entry.effect === 'deny') reject('model_egress_network')
      if (entry.targetId === target.targetId) match = entry
    }
    if (!match) reject('model_egress_network')
    if (match.proxy) reject('model_egress_proxy', 'incompatible')
    return match
  }
  async function material<T>(
    signal: AbortSignal,
    apply: (key: string, active: AbortSignal) => Promise<T>,
  ): Promise<T> {
    permit(signal)
    if (!installed || !takeKey) reject('model_egress_owner')
    let box: { value: T } | undefined, localError: unknown
    const decision = await abortable(
      takeKey.use(installed.handle, installed.consumer, call, async (key, credentialSignal) => {
        try {
          const active = AbortSignal.any([signal, credentialSignal])
          permit(active)
          if (box || !key.trim() || /[\p{Cc}]/u.test(key)) reject('model_egress_credential')
          const effect = apply(key, active)
          pending.add(effect)
          try {
            box = { value: await effect }
          } finally {
            pending.delete(effect)
          }
        } catch (problem) {
          localError =
            problem instanceof ReferenceEgressError
              ? problem
              : new ReferenceEgressError(
                  committed ? 'unknown_effect' : 'denied',
                  committed ? 'model_egress_unknown' : 'model_egress_unavailable',
                )
          throw localError
        }
      }),
      signal,
    )
    if (localError) throw localError
    if (!decision.ok)
      reject(
        decision.error.code === 'cancelled' ? 'model_egress_cancelled' : 'model_egress_credential',
        decision.error.code === 'cancelled' ? 'cancelled' : 'denied',
      )
    permit(signal)
    if (!box) reject('model_egress_credential')
    return box.value
  }
  function perform<T>(signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const limit = new AbortController()
    const duration = Math.min(30_000, Math.max(1, Date.parse(call.deadline) - Date.now()))
    const timer = setTimeout(() => limit.abort(), Number.isFinite(duration) ? duration : 1)
    const merged = AbortSignal.any([signal, callerSignal, stop.signal, limit.signal])
    const task = Promise.resolve()
      .then(() => fn(merged))
      .catch((problem) => {
        if (problem instanceof ReferenceEgressError) {
          if (committed && problem.code === 'cancelled') reject('model_egress_unknown', 'unknown_effect')
          throw problem
        }
        if (merged.aborted)
          reject(
            committed ? 'model_egress_unknown' : 'model_egress_cancelled',
            committed ? 'unknown_effect' : 'cancelled',
          )
        reject(
          committed ? 'model_egress_unknown' : 'model_egress_unavailable',
          committed ? 'unknown_effect' : 'denied',
        )
      })
      .finally(() => {
        clearTimeout(timer)
        pending.delete(task)
      })
    pending.add(task)
    return task
  }
  return Object.freeze({
    resolveCredential(route: string, signal: AbortSignal): Promise<string> {
      return perform(signal, async (active) => {
        permit(active)
        if (route !== installed?.route) reject('model_egress_binding')
        return material(active, async (key) => key)
      })
    },
    fetch: ((input, init) =>
      perform(init?.signal ?? (input instanceof Request ? input.signal : callerSignal), async (signal) => {
        permit(signal)
        const request = new Request(input, init),
          uri = new URL(request.url)
        const active = AbortSignal.any([signal, request.signal])
        const selected = destinations?.filter((item) => item.endpointRef === installed?.endpointRef)
        if (selected?.length !== 1 || !selected[0] || !validate('NetworkTarget', selected[0].target).ok)
          reject('model_egress_target')
        const endpoint = selected[0],
          destination = endpoint.target
        const requestPort = Number(uri.port || (uri.protocol === 'https:' ? 443 : 80))
        if (
          uri.hash ||
          uri.username ||
          uri.password ||
          uri.protocol !== `${destination.scheme}:` ||
          uri.hostname.toLowerCase() !== destination.host.toLowerCase() ||
          requestPort !== destination.port ||
          uri.pathname + uri.search !== destination.path ||
          endpoint.method !== 'POST' ||
          request.method !== endpoint.method
        )
          reject('model_egress_target')
        if (dispatched) reject('model_egress_replay', 'unknown_effect')
        const blocks: Uint8Array[] = [],
          bodyReader = request.body?.getReader()
        let inputBytes = 0
        try {
          while (bodyReader) {
            const next = await abortable(bodyReader.read(), active)
            if (next.done) break
            inputBytes += next.value.length
            if (inputBytes > (settings.maxRequestBytes ?? 1024 * 1024)) reject('model_egress_limits')
            blocks.push(next.value)
          }
        } finally {
          if (bodyReader) void bodyReader.cancel().catch(() => {})
        }
        const body = Buffer.concat(blocks)
        if (body.length > (settings.maxRequestBytes ?? 1024 * 1024)) reject('model_egress_limits')
        const permitted = await policyGate(destination, active)
        if (!policy) reject('model_egress_owner')
        const answers = await abortable(
          policy.resolver(destination.host.replace(/^\[|\]$/g, ''), { all: true, order: 'verbatim' }),
          active,
        ).catch(() => {
          if (active.aborted) reject('model_egress_cancelled', 'cancelled')
          reject('model_egress_connect', 'retryable')
        })
        if (
          answers.length === 0 ||
          answers.some(
            (answer) =>
              answer.family !== 4 ||
              isIP(answer.address) !== 4 ||
              (permitted.addresses
                ? !permitted.addresses.includes(answer.address)
                : !publicIpv4(answer.address)),
          )
        )
          reject('model_egress_dns')
        const hostAddress = destination.host.replace(/^\[|\]$/g, '')
        if (isIP(hostAddress) && answers.some((answer) => answer.address !== hostAddress))
          reject('model_egress_dns')
        await policyGate(destination, active)
        return material(active, async (key, final) => {
          const outgoing: Record<string, string> = {}
          const authHeader = installed?.api === 'openai-completions' ? 'authorization' : 'x-api-key'
          const authValue = authHeader === 'authorization' ? `Bearer ${key}` : key
          for (const [name, text] of request.headers.entries()) {
            if (name === authHeader) {
              if (text !== authValue) reject('model_egress_credential')
              continue
            }
            switch (name) {
              case 'accept':
              case 'content-type':
              case 'user-agent':
              case 'x-request-id':
              case 'anthropic-version':
              case 'anthropic-beta':
              case 'x-stainless-lang':
              case 'x-stainless-package-version':
              case 'x-stainless-os':
              case 'x-stainless-arch':
              case 'x-stainless-runtime':
              case 'x-stainless-runtime-version':
              case 'x-stainless-retry-count':
              case 'x-stainless-timeout':
              case 'x-stainless-helper-method':
              case 'anthropic-dangerous-direct-browser-access':
              case 'x-client-request-id':
              case 'x-session-affinity':
              case 'x-session-id':
              case 'session_id':
                break
              default:
                reject('model_egress_headers')
            }
            if (/[\p{Cc}]/u.test(text) || text.includes(key)) reject('model_egress_headers')
            outgoing[name] = text
          }
          if (body.includes(Buffer.from(key)) || uri.href.includes(key)) reject('model_egress_headers')
          await policyGate(destination, final)
          permit(final)
          if (dispatched) reject('model_egress_replay', 'unknown_effect')
          outgoing[authHeader] = authValue
          dispatched = true
          return new Promise<Response>((resolve, fail) => {
            const socket = (destination.scheme === 'https' ? https : http)(
              uri,
              {
                method: 'POST',
                headers: outgoing,
                signal: final,
                agent: false,
                lookup(_hostname, options, callback) {
                  const answer = answers[0]
                  if (!answer) {
                    callback(new Error('No validated address'), '', 4)
                    return
                  }
                  if (options.all) callback(null, [{ address: answer.address, family: 4 }])
                  else callback(null, answer.address, 4)
                },
              },
              (incoming) => {
                const status = incoming.statusCode ?? 0
                if ([301, 302, 303, 307, 308].includes(status)) {
                  incoming.destroy()
                  fail(new ReferenceEgressError('denied', 'model_egress_redirect'))
                  return
                }
                const chunks: Buffer[] = []
                let size = 0
                incoming.on('data', (chunk: Buffer) => {
                  size += chunk.length
                  if (size > (settings.maxResponseBytes ?? 2 * 1024 * 1024)) {
                    incoming.destroy()
                    fail(new ReferenceEgressError('denied', 'model_egress_limits'))
                  } else chunks.push(chunk)
                })
                incoming.on('error', () =>
                  fail(new ReferenceEgressError('unknown_effect', 'model_egress_unknown')),
                )
                incoming.on('end', () => {
                  try {
                    permit(final)
                    const data = Buffer.concat(chunks)
                    if (data.includes(Buffer.from(key))) reject('model_egress_response')
                    const safe: Record<string, string> = {},
                      mime = incoming.headers['content-type']
                    if (typeof mime === 'string' && !mime.includes(key) && !/[\p{Cc}]/u.test(mime))
                      safe['content-type'] = mime
                    resolve(
                      new Response([204, 205, 304].includes(status) ? null : data, { status, headers: safe }),
                    )
                  } catch (problem) {
                    fail(problem)
                  }
                })
              },
            )
            socket.on('error', () =>
              fail(
                new ReferenceEgressError(
                  committed ? 'unknown_effect' : final.aborted ? 'cancelled' : 'retryable',
                  committed
                    ? 'model_egress_unknown'
                    : final.aborted
                      ? 'model_egress_cancelled'
                      : 'model_egress_connect',
                ),
              ),
            )
            // Do not call end/flushHeaders until this attempt has its own established connection.
            socket.once('socket', (transport) => {
              transport.once(destination.scheme === 'https' ? 'secureConnect' : 'connect', () => {
                try {
                  permit(final)
                  const fingerprint = createHash('sha256').update(body).digest('hex')
                  if (settings.beforeWrite && settings.beforeWrite(fingerprint) !== true)
                    reject('model_egress_fence')
                  committed = true
                  socket.end(body)
                } catch (problem) {
                  transport.destroy()
                  socket.destroy()
                  fail(
                    problem instanceof ReferenceEgressError
                      ? problem
                      : new ReferenceEgressError(
                          committed ? 'unknown_effect' : 'denied',
                          committed ? 'model_egress_unknown' : 'model_egress_fence',
                        ),
                  )
                }
              })
            })
          })
        })
      })) satisfies typeof globalThis.fetch,
    fenced: () => committed,
    close(): Promise<void> {
      if (!disposal) {
        stop.abort()
        disposal = Promise.allSettled([...pending]).then(() => undefined)
      }
      return disposal
    },
  })
}
