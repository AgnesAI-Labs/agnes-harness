import type {
  CountResult,
  InferenceEvent,
  ModelRecord,
  ProbeReport,
  RequestBody,
  RouteDecl,
  ToolCall,
} from '@agnes/protocol'
import { isUsableCredential } from './credentials.js'
import type { SentReport } from './stamp.js'

// What an adapter is allowed to emit. It is the outward event union minus the three things only the
// provider facade may produce: the opening stamp, the "looked like a call but nothing parsed it"
// deviation, and the `via` tag on a finished call — an adapter reports the call it received off the
// wire and does not get to claim how it was recovered.
export type WireEvent =
  | Exclude<InferenceEvent, { type: 'sent' } | { type: 'deviation' } | { type: 'toolcall_end' }>
  | { type: 'toolcall_end'; call: ToolCall }

export type AdapterStreamOptions = {
  /** Called before network I/O with the actual serialized body digest, never credentials. */
  reportSent?: (report: SentReport) => void
  signal: AbortSignal
  toolNames: string[]
  /** A caller can disable this call's retries, but cannot increase the adapter's retry budget. */
  retry?: false
  sessionKey: string
  timeoutMs: { firstToken: number; total: number }
}

/**
 * One implementation per wire protocol. An adapter translates between that protocol and this
 * package's event union and does nothing else: recovering tool calls out of prose is the facade's
 * job, so the same recovery rules apply to every adapter rather than being reimplemented per vendor.
 */
export abstract class WireAdapter {
  abstract readonly id: string
  abstract routes(): RouteDecl[]
  abstract models(route: string): ModelRecord[]
  abstract stream(route: string, req: RequestBody, opts: AdapterStreamOptions): AsyncIterable<WireEvent>
  count?(route: string, req: RequestBody, opts: { signal: AbortSignal }): Promise<CountResult>
  refresh?(route: string, signal: AbortSignal): Promise<void>
  probe?(route: string, signal: AbortSignal): Promise<ProbeReport>

  // A real private field, not a TypeScript-private one, and what that does and does not buy:
  //
  // What it guarantees. `private` is erased at compile time, leaving an ordinary own property that
  // shows up in Object.keys(), in JSON.stringify, in a structured clone, in util.inspect and in
  // anything else that walks an object generically. `#credentials` is invisible to all of those, so
  // a credential cannot ride out of the process inside a serialised adapter, a log line or a crash
  // dump. That is the threat this defends against: accidental exposure through generic traversal.
  //
  // What it does not guarantee. It is not a barrier against code that goes looking. `credentialFor`
  // is `protected`, which is also erased, so it stays an ordinary prototype method and
  // `(adapter as any).credentialFor(route)` returns the value. Subclasses need that method, so no
  // spelling in this language both keeps it available to them and hides it from a deliberate caller.
  // `bindCredential` is likewise reachable, so in-process code can overwrite a credential after
  // assembly; it is left public and unsealed on purpose, because the assembly path binds after
  // construction and rotating a short-lived token needs the same door — and sealing it would close
  // half of an opening that `credentialFor` leaves open anyway. Code that can call either already
  // runs in this process and can reach the value by other means.
  readonly #credentials = new Map<string, string>()

  /**
   * Called once per route at assembly time, before any request. The value stays in this adapter's
   * memory and is never returned, logged or attached to an event.
   *
   * A credential with nothing printable in it — empty, whitespace, or the invisible characters
   * `trim()` leaves behind — is stored as absent rather than as itself. The gate on the request path
   * asks whether a credential is present, so a blank one would pass it and then reach the wire as an
   * empty `Bearer`: the fail-closed check would have run and let through exactly the request it
   * exists to stop. Surrounding whitespace is trimmed for the same reason it is trimmed off a pasted
   * key everywhere else: it is never part of the secret.
   */
  bindCredential(route: string, value: string | undefined): void {
    const trimmed = value?.trim()
    if (trimmed === undefined || !isUsableCredential(trimmed)) this.#credentials.delete(route)
    else this.#credentials.set(route, trimmed)
  }

  /** Reachable at runtime despite `protected` — see the note on the store above. */
  protected credentialFor(route: string): string | undefined {
    return this.#credentials.get(route)
  }
}
