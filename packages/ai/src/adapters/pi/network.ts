import type { AiErrorCode } from '@agnes/protocol'

/**
 * Where in one exchange a network failure struck: while the connection was being opened, after the
 * request left and before any of the response came back, or once the response had started.
 */
export type NetPhase = 'connect' | 'first-byte' | 'stream'

/** A network failure in closed form: a code from the list below and, when it is known, the phase. */
export type NetFailure = { code: string; phase?: NetPhase }

type Meaning = { what: string; retryable: boolean; timeout?: string | undefined; connect?: true }

/** A failure a second attempt may well survive; `inbound` is one that can only happen on the way in. */
const blip = (what: string, timeout?: string): Meaning => ({ what, retryable: true, timeout })
const inbound = (what: string, timeout?: string): Meaning => ({ ...blip(what, timeout), connect: true })
/** A failure on the way in that asking again will meet the same way. */
const refused = (what: string): Meaning => ({ what, retryable: false, connect: true })
const CERT = refused("the model provider's TLS certificate was not accepted")
const TLS = refused('the TLS connection to the model provider failed')
/** An HTTP-client code nobody listed: named, but neither placed nor retried. */
const CLIENT: Meaning = { what: 'the HTTP client failed', retryable: false }

/**
 * The network codes an event may name, what each means and whether asking again can help. The wire
 * library reduces every one of these to "Connection error." or "terminated", and a fallback that
 * cannot tell them apart from a misconfiguration does not retry - so a reset that a second attempt
 * would have survived ended the turn as `status=?`.
 *
 * A certificate or TLS failure is the exception among them: one that is refused now is refused in a
 * second as well, and is a proxy or a clock to look at rather than a blip to wait out.
 */
const KNOWN: Record<string, Meaning> = {
  ECONNRESET: blip('the connection to the model provider was reset'),
  ECONNABORTED: blip('the connection to the model provider was aborted'),
  EPIPE: blip('the connection to the model provider broke while sending'),
  ECONNREFUSED: inbound('the model provider refused the connection'),
  ENOTFOUND: inbound("the model provider's host name was not found"),
  EAI_AGAIN: inbound("the model provider's host name could not be resolved"),
  ENETUNREACH: inbound('the network to the model provider is unreachable'),
  EHOSTUNREACH: inbound("the model provider's host is unreachable"),
  ENETDOWN: inbound('the network is down'),
  ETIMEDOUT: blip('the connection to the model provider timed out', 'TCP timeout'),
  UND_ERR_SOCKET: blip('the model provider closed the connection'),
  UND_ERR_CLOSED: blip('the connection to the model provider was closed'),
  UND_ERR_CONNECT_TIMEOUT: inbound('the connection to the model provider timed out', 'connect timeout'),
  UND_ERR_HEADERS_TIMEOUT: blip('the model provider did not answer in time', 'headers timeout'),
  UND_ERR_BODY_TIMEOUT: blip('the model provider stopped sending', 'body timeout'),
  ERR_TLS_HANDSHAKE_TIMEOUT: inbound('the TLS handshake timed out', 'handshake timeout'),
  EPROTO: TLS,
  ...Object.fromEntries(
    [
      'CERT_HAS_EXPIRED',
      'CERT_NOT_YET_VALID',
      'CERT_REVOKED',
      'CERT_UNTRUSTED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_GET_ISSUER_CERT',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ].map((code) => [code, CERT]),
  ),
}

/**
 * What a code means, for one on the list or one with the shape of the HTTP client's or OpenSSL's own
 * families. A shaped code is a fixed identifier that cannot carry a URL or a key, so naming it is as
 * safe as naming a listed one; what an HTTP-client code outside the list means is not known here, so
 * it is named but neither placed nor retried.
 */
function meaning(code: string): Meaning | undefined {
  if (Object.hasOwn(KNOWN, code)) return KNOWN[code]
  if (/^ERR_(?:SSL|TLS)_[A-Z0-9_]{1,48}$/.test(code)) return TLS
  if (/^UND_ERR_[A-Z0-9_]{1,48}$/.test(code)) return CLIENT
  return undefined
}

const PHASE: Record<NetPhase, string> = {
  connect: 'while connecting',
  'first-byte': 'while waiting for the first byte',
  stream: 'mid-stream',
}

/**
 * The first known code on an error or on anything it wraps. The fetch throws `fetch failed` or
 * `terminated` and keeps the system error a cause or two down, and an address that every family
 * refused arrives as an aggregate of them. Only the code is read, and the two facts that say the
 * connection was never made: the system call that failed, and Node's own wording for a TLS handshake
 * cut off. Nothing else on the error is looked at, and nothing at all is copied but the code.
 */
function find(error: unknown): { code: string; connect: boolean } | undefined {
  const queue: unknown[] = [error]
  try {
    for (let i = 0; i < queue.length && i < 16; i++) {
      const e = queue[i]
      if (typeof e !== 'object' || e === null) continue
      const { code, syscall, message, cause, errors } = e as Record<string, unknown>
      if (typeof code === 'string' && meaning(code))
        return {
          code,
          connect:
            syscall === 'connect' ||
            syscall === 'getaddrinfo' ||
            (typeof message === 'string' && message.includes('before secure TLS connection was established')),
        }
      if (cause !== undefined) queue.push(cause)
      if (Array.isArray(errors)) queue.push(...errors)
    }
  } catch {
    // An error with a throwing getter is not one this can read, and a failure to describe a failure
    // must not replace it.
  }
  return undefined
}

/**
 * A failure the fetch itself threw, in closed form, or nothing when it carries no known code. `phase`
 * is where it was caught - the fetch rejecting or the body read failing - and is narrowed to
 * `connect` when the code or the failed call says the connection was never made.
 */
export function networkFailure(error: unknown, phase: 'first-byte' | 'stream'): NetFailure | undefined {
  const found = find(error)
  if (!found) return undefined
  const m = meaning(found.code) ?? CLIENT
  if (m === CLIENT) return { code: found.code }
  return {
    code: found.code,
    phase: phase === 'first-byte' && (m.connect || found.connect) ? 'connect' : phase,
  }
}

/**
 * A known code in failure text, for the apis whose fetch this adapter cannot see. Only a token that is
 * itself a known code is taken, so the text around it - an address, a host name - is not. Where it
 * struck is known only for a code that cannot happen anywhere but on the way in.
 */
export function networkCodeIn(text: string): NetFailure | undefined {
  for (const [token] of text.matchAll(/\b[A-Z][A-Z0-9_]{3,63}\b/g)) {
    const m = meaning(token)
    if (m) return m.connect ? { code: token, phase: 'connect' } : { code: token }
  }
  return undefined
}

/**
 * A network failure as a code, a sentence and a verdict on asking again. The sentence is assembled
 * from the fixed phrases above and the code, so it says what happened and where - "the connection to
 * the model provider was reset while waiting for the first byte (ECONNRESET)" - without a word the
 * far end or the network stack wrote. A timeout is reported as one, with the timer that fired.
 */
export function describeNetworkFailure(f: NetFailure): {
  code: AiErrorCode
  message: string
  retryable: boolean
} {
  const m = meaning(f.code) ?? CLIENT
  const where = f.phase ? ` ${PHASE[f.phase]}` : ''
  return {
    code: m.timeout ? 'TIMEOUT' : 'TRANSPORT',
    message: `${m.what}${where} (${m.timeout ? `${m.timeout}, ` : ''}${f.code})`,
    retryable: m.retryable,
  }
}

/**
 * The response with its body read through a watcher, so a failure partway through the body is seen
 * here with its cause intact instead of reaching the classifier as "terminated". Every chunk and the
 * error itself pass through unchanged, and a cancel is passed back to the original body.
 */
export function watchBody(response: Response, onError: (error: unknown) => void): Response {
  const body = response.body
  // A status that may not carry a body cannot be rebuilt around one, and has nothing to watch.
  if (body === null || [101, 204, 205, 304].includes(response.status)) return response
  const reader = body.getReader()
  const watched = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>
      try {
        next = await reader.read()
      } catch (error) {
        onError(error)
        controller.error(error)
        return
      }
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    cancel: (reason) => reader.cancel(reason),
  })
  const out = new Response(watched, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  // The client libraries read it for their own log lines; a rebuilt response would otherwise say ''.
  Object.defineProperty(out, 'url', { value: response.url })
  return out
}
