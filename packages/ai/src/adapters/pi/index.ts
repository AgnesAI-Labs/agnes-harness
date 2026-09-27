import type { ModelRecord, RequestBody, RouteDecl } from '@agnes/protocol'
import type {
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  ModelAuth,
  ProviderStreamOptions,
} from '@earendil-works/pi-ai'
import { type AdapterStreamOptions, WireAdapter, type WireEvent } from '../../adapter.js'
import { AiSetupError } from '../../errors.js'
import { sha256Hex } from '../../hash.js'
import { probeInference } from './probe.js'
import { probeModelsEndpoint } from './probe-models.js'
import { toContext } from './to-context.js'
import { translateEvent } from './translate.js'
import { AMBIENT_CREDENTIAL_APIS, streamOverApi } from './wire.js'

/**
 * DEPLOYMENT NOTES — read these before deploying a route table, and carry them into the delivery
 * notes for any deployment that upgrades onto this adapter.
 *
 * 1. ON BEDROCK, THE ENVIRONMENT STILL DECIDES THE DESTINATION. THIS IS OPEN, NOT CLOSED, AND IT IS
 *    THE ORDINARY PRODUCTION CONFIGURATION RATHER THAN AN EXOTIC ONE.
 *
 *    `bedrock-converse-stream` pins the request to the declared base URL only for a host that is not
 *    a standard Bedrock one. For `bedrock-runtime[-fips].<region>.amazonaws.com[.cn]` — the only
 *    host a deployment that is not fronting Bedrock with its own gateway has — the library pins the
 *    endpoint only when no region and no profile are configured, and AWS_REGION is set by default on
 *    EC2, ECS, Lambda and EKS. So in the majority deployment the declared endpoint is advisory and
 *    the bound credential goes wherever the environment points it. It cannot be closed from inside
 *    this package: passing a region is itself one of the two things that turns the pinning off, no
 *    option on the library's surface sets the endpoint unconditionally, and writing a process-wide
 *    AWS variable from here would restore the environment dependency this adapter exists to remove.
 *
 *    So it is owed by whatever assembles the process this adapter runs in. Two roles, both needed —
 *    clearing only the second leaves the first free to re-point the region:
 *
 *      (a) stop the library from unpinning, by ensuring none of these is set (or setting them to the
 *          declared route's own region): AWS_REGION, AWS_DEFAULT_REGION, AWS_PROFILE.
 *      (b) once unpinned, the AWS SDK resolves the destination itself, from:
 *          AWS_ENDPOINT_URL_BEDROCK_RUNTIME (service-specific, consulted first),
 *          AWS_ENDPOINT_URL (global fallback),
 *          AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE (the same setting reached through the
 *          profile, as `endpoint_url` or `services.bedrock_runtime.endpoint_url` — so an env-only
 *          sweep is incomplete, since ~/.aws/config reaches it on the default path),
 *          AWS_USE_FIPS_ENDPOINT and AWS_USE_DUALSTACK_ENDPOINT (which host family is resolved),
 *          and AWS_REGION / AWS_DEFAULT_REGION again in their second role, because the host is
 *          rebuilt out of `config.region` — a route declaring `us-east-1` can be answered by
 *          `eu-west-1` with no endpoint variable set at all.
 *
 *    The single strongest lever is to SET AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true, which is the
 *    SDK's own opt-out; the region and profile clearing is second.
 *
 * 2. TWO BEHAVIOUR CHANGES A DEPLOYMENT CAN NOTICE.
 *
 *    AZURE_OPENAI_DEPLOYMENT_NAME_MAP is no longer honoured. It chose which model answered and what
 *    was billed, from the environment; the deployment name is now pinned to the model the request
 *    named. A deployment that renamed a model through that map states the name in its catalogue
 *    record instead, where the rest of the route table can see it.
 *
 *    A Vertex base URL holding `{location}` is refused at assembly rather than resolved. The library
 *    discards such a base URL and rebuilds the destination out of GOOGLE_CLOUD_LOCATION, which is a
 *    Google public endpoint the route never named, so the refusal is the point. A route table copied
 *    from a vendor catalogue with the path left templated hits this; the error names the route and
 *    the reason, and the fix is to write the location into the URL.
 *
 * 3. AZURE_OPENAI_API_VERSION is still read from the environment. It is not a destination — the host
 *    stays the declared one — but it shapes the request as `?api-version=`, so which version a
 *    deployment talks is chosen by its environment and not by its route table. Registered, not
 *    fixed.
 */
/** A route this package was told about, endpoint and catalogue together, rather than discovered. */
export type ManualRoute = RouteDecl & {
  models: ModelRecord[]
  /**
   * Says that this route is served without any credential. It has to be stated, because the default
   * is to refuse: a route that is silently keyless is indistinguishable from one whose credential
   * was meant to be bound and was not, and the two must not fail the same way.
   *
   * It is refused outright on the apis in `AMBIENT_CREDENTIAL_APIS`, where it would not describe the
   * request it produces.
   */
  keyless?: boolean
}

/**
 * A route has to say where it points before it may stream. The schema only bounds the length of the
 * field, so an empty or relative string arrives here as a valid declaration — and the wire library
 * reads an absent base URL as "use the vendor's default", which turns a route that declared no
 * endpoint into a request to a vendor's production API carrying the deployment's own credential.
 * Rejecting it at assembly makes that a startup failure instead of a silent egress.
 *
 * The value is not echoed. A base URL is a plausible place for a token to be hidden, and this
 * message is going to be logged.
 *
 * Half of this belongs in the schema — a minimum length and an absolute-http format, so a malformed
 * route table is refused at the door where the error can name the field while the operator is still
 * holding the file. That is owed at the next change to the declaration, along with the question this
 * function cannot answer: whether a route may state that its endpoint is final. This check stays
 * either way, because a route is also built programmatically and never meets the schema.
 */
function requireAbsoluteHttpUrl(decl: RouteDecl): void {
  let url: URL
  try {
    url = new URL(decl.baseUrl)
  } catch {
    throw new AiSetupError('INVALID_BASE_URL', { route: decl.route, reason: 'not an absolute URL' })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new AiSetupError('INVALID_BASE_URL', { route: decl.route, reason: 'not http or https' })
  // Userinfo is a credential, and the client sends it as Basic auth. Allowing it would put a secret
  // inline in the route table, which is the one place a credential may not be: every other one is
  // named by `credentialRef` and resolved from the store, and this one would also ride out of the
  // package inside `routes()`.
  if (url.username !== '' || url.password !== '')
    throw new AiSetupError('INVALID_BASE_URL', { route: decl.route, reason: 'credential in the base URL' })
  // A host that is a template is not a destination. The wire library discards a Vertex base URL
  // containing `{location}` and rebuilds the host out of GOOGLE_CLOUD_LOCATION, so a route declaring
  // one would reach whichever host the environment named — the same egress this function exists to
  // stop, spelled as a placeholder instead of as an empty string.
  //
  // This is stricter than the library on the host, on purpose: any brace at all is refused, so a
  // percent-encoded `%7Blocation%7D` — which `URL` decodes back into the hostname, and which the
  // library would have kept because it tests the raw string — is refused too, and so is a lone `{`.
  if (url.hostname.includes('{'))
    throw new AiSetupError('INVALID_BASE_URL', { route: decl.route, reason: 'placeholder in the host' })
  // And the library's own condition, which is the whole trimmed string and not the host: a base URL
  // holding `{location}` anywhere is discarded entirely. A canonical Vertex endpoint carries it in
  // the path as well as in the host (`…/v1/projects/<p>/locations/{location}/…`), so a catalogue
  // entry copied with the host filled in and the path left templated is the likelier shape, and it
  // is the one that reaches `aiplatform.googleapis.com` with the route's credential.
  if (decl.baseUrl.trim().includes('{location}'))
    throw new AiSetupError('INVALID_BASE_URL', {
      route: decl.route,
      reason: 'placeholder in the base URL',
    })
}

// Only the async iteration is used, so that is all this asks for: a test can hand in a plain async
// generator, and the real function satisfies it because its stream is one.
export type PiStream = (
  model: Model<Api>,
  context: Context,
  options?: ProviderStreamOptions,
) => AsyncIterable<AssistantMessageEvent>

const RETRY_BASE_MS = 500

/** The declared record, in the shape the wire library reads it. */
export function toPiModel(
  decl: RouteDecl,
  record: ModelRecord,
  headers: Record<string, string> = {},
): Model<Api> {
  const declaredThinkingMap = record.thinkingLevelMap as Record<string, string> | undefined
  // Once a catalogue publishes an explicit map, absence is unsupported rather than "let the wire
  // library guess". pi uses null for that distinction while the protocol's public map exposes only
  // usable string values, so restore the closed negative entries at this private boundary.
  const thinkingLevelMap = declaredThinkingMap
    ? Object.fromEntries(
        ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => [
          level,
          Object.hasOwn(declaredThinkingMap, level) ? declaredThinkingMap[level] : null,
        ]),
      )
    : undefined
  return {
    id: record.id,
    name: record.name,
    api: decl.api as Api,
    provider: decl.route,
    baseUrl: decl.baseUrl,
    reasoning: record.reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: record.input,
    cost: { ...record.cost },
    contextWindow: record.contextWindow,
    maxTokens: record.maxTokens,
    ...(record.samplingParams ? { samplingParams: record.samplingParams as Record<string, unknown> } : {}),
    // Per-request headers win over the ones the catalogue declared: the caller knows about this
    // request, the catalogue only about the route.
    headers: { ...(record.headers ?? {}), ...headers },
    ...(record.compat ? { compat: record.compat as never } : {}),
  }
}

/**
 * Speaks to anything the wire library speaks to, over routes this package was told about rather
 * than ones it discovered. Two rules shape what it does beyond translating events:
 *
 * A credential never comes from the environment. Every route needs one bound before it may stream,
 * unless it declared itself `keyless`, so a route that was meant to have a credential and did not
 * get one fails closed here instead of reaching the wire with whatever happened to be exported. On
 * the two apis whose client library has an ambient credential chain of its own, `keyless` is refused
 * as well, because there it does not describe a request without a credential.
 *
 * Retrying stops at the first event. Once a delta has been forwarded the caller has seen part of an
 * answer, and a second attempt would append a second answer to it — so a failure after that point
 * is reported, not retried.
 */
export class PiAdapter extends WireAdapter {
  readonly id: string
  private readonly streamImpl: PiStream
  private readonly providerId: string | undefined
  private readonly resolveCredential:
    | ((route: string, signal: AbortSignal) => Promise<string | ModelAuth>)
    | undefined
  private readonly recoverRejectedAuth:
    | ((route: string, rejected: ModelAuth, signal: AbortSignal) => Promise<boolean>)
    | undefined
  private readonly manual: Map<string, ManualRoute>
  private readonly maxRetries: number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>

  constructor(cfg: {
    id?: string
    /** Built-in provider identity, distinct from an account's routing name. */
    providerId?: string
    manualRoutes: ManualRoute[]
    streamImpl?: PiStream
    resolveCredential?: (route: string, signal: AbortSignal) => Promise<string | ModelAuth>
    /**
     * Called once when an authenticated request is rejected before any output. Returning true says
     * the store invalidated that credential or already holds a replacement, so the adapter resolves
     * auth again and retries once.
     */
    recoverRejectedAuth?: (route: string, rejected: ModelAuth, signal: AbortSignal) => Promise<boolean>
    maxRetries?: number
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  }) {
    super()
    this.id = cfg.id ?? 'pi'
    this.providerId = cfg.providerId
    this.streamImpl = cfg.streamImpl ?? streamOverApi
    this.resolveCredential = cfg.resolveCredential
    this.recoverRejectedAuth = cfg.recoverRejectedAuth
    for (const r of cfg.manualRoutes) requireAbsoluteHttpUrl(r)
    this.manual = new Map(cfg.manualRoutes.map((r) => [r.route, r]))
    this.maxRetries = cfg.maxRetries ?? 2
    this.sleep =
      cfg.sleep ??
      ((ms, signal) =>
        new Promise((res) => {
          const t = setTimeout(res, ms)
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t)
              res()
            },
            { once: true },
          )
        }))
  }

  routes(): RouteDecl[] {
    return [...this.manual.values()].map(({ models: _models, keyless: _keyless, ...decl }) => decl)
  }

  models(route: string): ModelRecord[] {
    return this.manual.get(route)?.models ?? []
  }

  override async probe(route: string, signal: AbortSignal) {
    const started = performance.now()
    const ac = new AbortController()
    const onAbort = () => ac.abort()
    if (signal.aborted) ac.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => ac.abort(), 30_000)
    try {
      const decl = this.manual.get(route)
      const models = [...this.models(route)]
      const catalogue = await probeModelsEndpoint(
        decl,
        this.credentialFor(route),
        decl?.keyless === true,
        ac.signal,
      )
      // Codex has no compatible /models endpoint; its real inference checks remain authoritative.
      const checks = decl?.api === 'openai-codex-responses' ? [] : [catalogue]
      for (const model of models.length > 0 ? models : [undefined]) {
        const result = await probeInference(this, route, model, ac.signal)
        checks.push(...result.checks.filter((check) => check.name !== 'models_endpoint'))
      }
      return {
        route,
        checks,
        ok: checks.every((check) => check.ok),
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      ac.abort()
    }
  }

  /** Overridden by a subclass that has request headers of its own to add. */
  protected requestHeaders(_route: string, _req: RequestBody): Record<string, string> {
    return {}
  }

  protected streamOptions(
    route: string,
    req: RequestBody,
    opts: AdapterStreamOptions,
  ): ProviderStreamOptions {
    const credential = this.credentialFor(route)
    const decl = this.manual.get(route)
    return {
      signal: opts.signal,
      ...(credential !== undefined ? { apiKey: credential } : {}),
      sessionId: req.sessionKey,
      cacheRetention: 'short',
      // Nine of the ten apis send to `model.baseUrl` and read nothing else for a destination.
      // `azure-openai-responses` resolves its endpoint as `azureBaseUrl`, then AZURE_OPENAI_BASE_URL,
      // then AZURE_OPENAI_RESOURCE_NAME, and only then `model.baseUrl` — so the declared endpoint was
      // last, and either variable sent the route's own credential to a host nobody declared while the
      // declared one was never contacted. Passing the declaration as the first of those pins it. The
      // same api takes its deployment name from AZURE_OPENAI_DEPLOYMENT_NAME_MAP unless it is given
      // one, which lets the environment decide which model answers; that is pinned for the same
      // reason. A deployment that renames a model says so in its catalogue record instead.
      //
      // Both keys are inert on the other nine, which never look at them.
      ...(decl !== undefined ? { azureBaseUrl: decl.baseUrl, azureDeploymentName: req.model } : {}),
      // The library's own retry loop stays off. Whether a failure may be repeated is decided here,
      // where it is known whether the caller has already seen part of the answer.
      maxRetries: 0,
      ...(req.sampling?.temperature !== undefined ? { temperature: req.sampling.temperature } : {}),
      ...(req.sampling?.maxTokens !== undefined ? { maxTokens: req.sampling.maxTokens } : {}),
      ...(req.sampling?.thinking !== undefined && req.sampling.thinking !== 'off'
        ? { reasoningEffort: req.sampling.thinking }
        : {}),
    }
  }

  async *stream(route: string, req: RequestBody, opts: AdapterStreamOptions): AsyncIterable<WireEvent> {
    const decl = this.manual.get(route)
    const record = decl?.models.find((m) => m.id === req.model)
    if (!decl || !record) {
      yield {
        type: 'error',
        reason: 'error',
        code: 'NO_MODEL',
        message: `route=${route} model=${req.model}`,
        retryable: false,
      }
      return
    }
    // Fail closed on the absence of a credential, not on the absence of a declaration that one was
    // wanted. A route that names no credentialRef and binds nothing is either genuinely keyless —
    // in which case it says so — or a misconfiguration, and the second reading is the dangerous one.
    const keyless = decl.keyless === true && decl.credentialRef === undefined
    // On two apis "keyless" would mean the opposite of what it says — see AMBIENT_CREDENTIAL_APIS.
    // The declaration is refused rather than honoured, because honouring it ships the host's own
    // cloud identity to whatever endpoint the route named.
    if (keyless && AMBIENT_CREDENTIAL_APIS.has(decl.api)) {
      yield {
        type: 'error',
        reason: 'error',
        code: 'AUTH',
        message: `route=${route} api=${decl.api} keyless refused: this api authenticates from the host environment`,
        retryable: false,
      }
      return
    }
    if (!keyless && !this.resolveCredential && this.credentialFor(route) === undefined) {
      yield { type: 'error', reason: 'error', code: 'AUTH', message: `route=${route}`, retryable: false }
      return
    }
    const thinking = req.sampling?.thinking
    const thinkingLevelMap = record.thinkingLevelMap as Record<string, string> | undefined
    const mappedThinking = thinking === undefined ? undefined : thinkingLevelMap?.[thinking]
    if (
      (thinking !== undefined &&
        thinking !== 'off' &&
        (!record.reasoning || !Object.hasOwn(thinkingLevelMap ?? {}, thinking) || !mappedThinking?.trim())) ||
      (thinking === 'off' &&
        record.reasoning &&
        thinkingLevelMap !== undefined &&
        (!Object.hasOwn(thinkingLevelMap, thinking) || !mappedThinking?.trim()))
    ) {
      yield {
        type: 'error',
        reason: 'error',
        code: 'FORMAT',
        message: `route=${route} model=${req.model} thinking=${thinking} unsupported`,
        retryable: false,
      }
      return
    }
    const requestHeaders = this.requestHeaders(route, req)
    const dropThinking = record.thinkingReplay === 'drop'
    const { context } = toContext(req, { dropThinking })
    const transforms: Array<{ event: string; ext: string }> = []
    if (
      dropThinking &&
      req.messages.some((m) => m.role === 'assistant' && m.content.some((c) => c.type === 'thinking'))
    )
      transforms.push({ event: 'thinking_replay', ext: 'pi' })
    if (record.compat && Object.keys(record.compat).length > 0)
      transforms.push({ event: 'compat', ext: 'pi' })
    // These APIs accept fetch and serialize their final request before calling it. Google rejects
    // custom fetch; Bedrock uses Smithy and Codex can use WebSockets. Those remain unreported.
    const observable = new Set([
      'openai-completions',
      'openai-responses',
      'openai-codex-responses',
      'azure-openai-responses',
      'anthropic-messages',
      'mistral-conversations',
      'pi-messages',
    ])
    const fetchBody: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const bytes = new Uint8Array(await request.clone().arrayBuffer())
      opts.reportSent?.({ sentHash: sha256Hex(bytes), transforms })
      return globalThis.fetch(request)
    }
    // Two deadlines, both enforced here rather than by the wire library, and both merged with the
    // caller's own signal into one controller so the request below sees a single cancellation.
    //
    // The first-token deadline is spent once anything arrives: after that a stream is answering,
    // and the question stops being "did this route respond" and becomes "will this answer end".
    // The total deadline is what answers the second one. A route that hangs with neither is a turn
    // that never finishes, and a session that can never be closed.
    const inner = new AbortController()
    const onAbort = () => inner.abort()
    if (opts.signal.aborted) inner.abort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
    const total = setTimeout(() => inner.abort(), opts.timeoutMs.total)
    let first: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => inner.abort(),
      opts.timeoutMs.firstToken,
    )
    let firstSeen = false
    // One listener for the whole run. Racing a freshly built promise per event would register a
    // listener per event, which on a long answer is a leak that grows with the answer.
    const stopped = abortPromise(inner.signal)
    try {
      let attempt = 0
      let authRecoveryAttempted = false
      for (;;) {
        // Per attempt, not shared: two streams in flight in one process must not draw tool-call
        // ordinals from one counter.
        let ordinal = 0
        const nextOrdinal = () => ordinal++
        let emitted = false
        let retryAfter: number | undefined
        let requestAuth: ModelAuth | undefined
        if (this.resolveCredential) {
          try {
            const result = await Promise.race([this.resolveCredential(route, inner.signal), stopped])
            if (result === ABORTED || inner.signal.aborted) {
              yield {
                type: 'error',
                reason: opts.signal.aborted ? 'aborted' : 'error',
                code: opts.signal.aborted ? 'ABORTED' : 'TIMEOUT',
                message: 'authentication interrupted',
                retryable: false,
              }
              return
            }
            requestAuth = typeof result === 'string' ? { apiKey: result } : result
            if (
              (!requestAuth.apiKey?.trim() && Object.keys(requestAuth.headers ?? {}).length === 0) ||
              (requestAuth.baseUrl !== undefined && !requestAuth.baseUrl.trim())
            )
              throw new Error('empty')
          } catch {
            yield {
              type: 'error',
              reason: opts.signal.aborted ? 'aborted' : 'error',
              code: opts.signal.aborted ? 'ABORTED' : 'AUTH',
              message: 'authentication unavailable',
              retryable: false,
            }
            return
          }
        }
        const requestModel = toPiModel(
          requestAuth?.baseUrl ? { ...decl, baseUrl: requestAuth.baseUrl } : decl,
          record,
          Object.fromEntries(
            Object.entries({ ...requestHeaders, ...requestAuth?.headers }).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          ),
        )
        if (this.providerId) requestModel.provider = this.providerId
        const it = this.streamImpl(requestModel, context, {
          ...this.streamOptions(route, req, { ...opts, signal: inner.signal }),
          ...(requestAuth?.apiKey === undefined ? {} : { apiKey: requestAuth.apiKey }),
          // pi-ai checks header-owned authentication in stream options before it
          // constructs a client. Model headers alone cannot authenticate Kimi OAuth.
          ...(requestAuth?.headers === undefined ? {} : { headers: requestAuth.headers }),
          ...(decl.api === 'openai-codex-responses' && this.resolveCredential
            ? { transport: 'sse' as const }
            : {}),
          ...(observable.has(decl.api) ? { fetch: fetchBody } : {}),
        })[Symbol.asyncIterator]()
        try {
          for (;;) {
            // Racing rather than `for await`, because a hung stream never produces the next value
            // and a loop waiting on it could not notice its own deadline passing.
            const next = await Promise.race([it.next(), stopped])
            if (next === ABORTED || next.done) break
            if (!firstSeen) {
              firstSeen = true
              clearTimeout(first)
              first = undefined
            }
            for (const w of translateEvent(next.value, requestModel, nextOrdinal)) {
              if (
                w.type === 'error' &&
                w.code === 'AUTH' &&
                !emitted &&
                !authRecoveryAttempted &&
                requestAuth &&
                this.recoverRejectedAuth &&
                !inner.signal.aborted
              ) {
                authRecoveryAttempted = true
                try {
                  const recovered = await Promise.race([
                    this.recoverRejectedAuth(route, requestAuth, inner.signal),
                    stopped,
                  ])
                  // Cancellation is terminal. Do not turn it into a zero-delay retry: a custom
                  // sleep/credential resolver is allowed to settle immediately and could otherwise
                  // perform one extra credential lookup after the caller has stopped the turn.
                  if (recovered === ABORTED || inner.signal.aborted) break
                  if (recovered) retryAfter = 0
                } catch {
                  // Keep the original sanitized AUTH result. Credential-store and refresh details
                  // can contain secrets and must not replace it.
                }
                if (retryAfter !== undefined) break
              }
              if (
                w.type === 'error' &&
                !emitted &&
                w.retryable &&
                opts.retry !== false &&
                attempt < this.maxRetries &&
                !inner.signal.aborted
              ) {
                retryAfter = w.retryAfterMs ?? RETRY_BASE_MS * 2 ** attempt
                break
              }
              emitted = true
              yield w
              if (w.type === 'done' || w.type === 'error') return
            }
            if (retryAfter !== undefined) break
          }
        } finally {
          // Abandoning an iterator without closing it leaves the previous attempt's request running
          // beside the retry. The result is not awaited: a hung generator's `return` settles only
          // when the thing it is hung on does, which is the case this exists for.
          void it.return?.(undefined)?.then(undefined, () => {})
        }
        if (inner.signal.aborted) {
          // Whose cancellation it was decides what the caller is told, and the two are not the same
          // outcome: an abort is the caller's own decision and is never retried, a deadline is the
          // route's failure and may be.
          if (opts.signal.aborted)
            yield { type: 'error', reason: 'aborted', code: 'ABORTED', message: 'aborted', retryable: false }
          else
            yield {
              type: 'error',
              reason: 'error',
              code: 'TIMEOUT',
              message: firstSeen ? 'total timeout' : 'first token timeout',
              retryable: true,
            }
          return
        }
        if (retryAfter === undefined) {
          // A stream that ended without saying anything is a failure the caller has to see; silence
          // would otherwise read as an empty but successful answer.
          if (!emitted)
            yield {
              type: 'error',
              reason: 'error',
              code: 'TRANSPORT',
              message: 'empty stream',
              retryable: true,
            }
          return
        }
        attempt++
        await this.sleep(retryAfter, inner.signal)
        if (!inner.signal.aborted) {
          // The event that caused a retry is suppressed, so it is not a first response from the
          // caller's perspective. Give the replacement request its own first-token deadline while
          // the original total deadline continues to bound the complete operation.
          firstSeen = false
          if (first) clearTimeout(first)
          first = setTimeout(() => inner.abort(), opts.timeoutMs.firstToken)
        }
      }
    } finally {
      clearTimeout(total)
      if (first) clearTimeout(first)
      opts.signal.removeEventListener('abort', onAbort)
    }
  }
}

const ABORTED = Symbol('aborted')

/** Resolves when the run is cancelled, whoever cancelled it, and never rejects. */
function abortPromise(signal: AbortSignal): Promise<typeof ABORTED> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(ABORTED)
    else signal.addEventListener('abort', () => resolve(ABORTED), { once: true })
  })
}
