// The error surface. `kind` is a closed discriminant: callers switch on it rather than on
// an instanceof chain, which is not reliable across bundles in a node/browser dual build.
import type { RpcError } from '@agnes/protocol'

export type SdkErrorKind =
  | 'json-rpc'
  | 'transport-closed'
  | 'request-timeout'
  | 'protocol-violation'
  | 'claim-denied'
  | 'unsupported'

// A structural copy of CloseInfo. transport/types.ts owns the definition; this module sits
// earlier in the dependency order, so a structural type avoids an errors -> transport edge.
export type CloseInfoLike = {
  reason: 'eof' | 'error' | 'closed' | 'exit'
  exitCode?: number | null
  signal?: string | null
  stderrTail?: string
  error?: Error
}

export class SdkError extends Error {
  readonly kind: SdkErrorKind
  constructor(kind: SdkErrorKind, message: string) {
    super(message)
    this.kind = kind
    this.name = 'SdkError'
  }
}

export class JsonRpcError extends SdkError {
  readonly code: number
  readonly data: { code: string } & Record<string, unknown>
  // The wire error kept verbatim: `message` has the `(code)` suffix appended into it, and
  // answering a server-to-client request with a locally thrown JsonRpcError needs a lossless
  // source. The alternative is stripping the suffix with a regex, which strips the wrong
  // thing the moment a server message ends in " (-32602)" of its own.
  readonly rpc: RpcError
  constructor(err: RpcError) {
    super('json-rpc', `${err.message} (${err.code})`)
    this.name = 'JsonRpcError'
    this.code = err.code
    this.data = err.data
    this.rpc = err
  }
}

export class TransportClosed extends SdkError {
  readonly info: CloseInfoLike
  constructor(info: CloseInfoLike) {
    const exit = info.exitCode != null ? ` exit=${info.exitCode}` : ''
    // stderr is untrusted diagnostic material and can contain credentials. Keep the bounded
    // diagnostic field available explicitly, but never interpolate it into an exception message.
    super('transport-closed', `transport closed: ${info.reason}${exit}`)
    this.name = 'TransportClosed'
    this.info = info
  }
}

export class RequestTimeout extends SdkError {
  readonly method: string
  readonly timeoutMs: number
  constructor(method: string, timeoutMs: number) {
    super('request-timeout', `${method} timed out after ${timeoutMs} ms`)
    this.name = 'RequestTimeout'
    this.method = method
    this.timeoutMs = timeoutMs
  }
}

export type ProtocolViolationKind =
  | 'schema'
  | 'frame-too-large'
  | 'invalid-json'
  | 'invalid-envelope'
  | 'invalid-utf8'
  | 'truncated-frame'
  | 'decoder-poisoned'

export class ProtocolViolation extends SdkError {
  readonly detail: string
  constructor(
    detail: string,
    readonly violationKind: ProtocolViolationKind = 'schema',
  ) {
    super('protocol-violation', detail)
    this.name = 'ProtocolViolation'
    this.detail = detail
  }
}

// A transport or auth kind the entry point did not register. It typechecks and then fails
// at construction, so a caller handling `--transport` has one branch to write, not a plain
// Error alongside the closed set.
export class Unsupported extends SdkError {
  readonly what: string
  constructor(what: string) {
    super('unsupported', `${what} is not available in this build`)
    this.name = 'Unsupported'
    this.what = what
  }
}

export class ClaimDenied extends SdkError {
  readonly reason: string
  constructor(reason: string) {
    super('claim-denied', reason)
    this.name = 'ClaimDenied'
    this.reason = reason
  }
}
