import net from 'node:net'
import tls from 'node:tls'

/**
 * The enforcement of "no test reaches a real network", as a property of the process rather than an
 * enumeration of the ways out of it.
 *
 * The recorders in the loopback tests grew a listener at a time — a request handler, then `upgrade`
 * for the WebSocket handshake, then a `fetch` wrapper — and each time the thing that was missing was
 * a transport nobody had listed. Two holes were still open with all three in place: the AWS client
 * builds its requests with `NodeHttpHandler` and never touches `globalThis.fetch`, so a `fetch`
 * wrapper could neither see nor stop it, and an HTTP CONNECT tunnel — what an `HTTPS_PROXY` opens —
 * arrives on neither `request` nor `upgrade`.
 *
 * Every one of those paths, and anything that is not HTTP at all, ends at the same two functions:
 * `net.Socket.prototype.connect` for a plain socket and `tls.connect` for a TLS one. Wrapping them
 * and refusing any destination that is not loopback turns the list of destination-shaped environment
 * variables from the load-bearing control into documentation: a redirection through a variable
 * nobody thought to enumerate becomes a hard failure here instead of an assertion nobody wrote.
 *
 * A refused destination is recorded *and* thrown, because a client that swallows the error would
 * otherwise turn a caught egress attempt into a passing test. `assertLoopbackOnly()` in an
 * `afterEach` is what makes the record fail the test that produced it.
 */
export type OffMachineAttempt = { host: string; port: number | undefined; via: 'socket' | 'tls' }

const attempts: OffMachineAttempt[] = []

type ConnectFn = (...args: never[]) => unknown

let originalSocketConnect: ConnectFn | undefined
let originalTlsConnect: ConnectFn | undefined

/**
 * Loopback is the literal address the servers in these tests bind, plus the names and the v6 form
 * that reach the same place. Anything else — a hostname that has yet to be resolved included, since
 * this runs before the lookup — is off this machine as far as this guard is concerned.
 */
function isLoopback(host: string): boolean {
  const h = host.replace(/^\[/, '').replace(/]$/, '').toLowerCase()
  return h.startsWith('127.') || h === '::1' || h === '0:0:0:0:0:0:0:1' || h === 'localhost'
}

/**
 * The destination of a `connect` call, in whichever of the overloads it was written:
 * `(options)`, `(port, host?)`, `(path)`. A unix socket path has no host and cannot leave the
 * machine, so it is not a destination this guard has anything to say about.
 */
function destinationOf(args: readonly unknown[]): { host: string; port: number | undefined } | null {
  const [first, second] = args
  // `net.connect(port, host)` does not reach the prototype in that shape: the module function
  // normalizes its arguments into a single `[options, callback]` array first, and a guard that only
  // understood the documented overloads read that array as an options object with no host in it and
  // waved it through. Unwrap it before anything else.
  if (Array.isArray(first)) return destinationOf(first as readonly unknown[])
  if (typeof first === 'number')
    return { host: typeof second === 'string' ? second : 'localhost', port: first }
  if (typeof first === 'string') return null
  if (first === null || typeof first !== 'object') return null
  const options = first as { path?: unknown; host?: unknown; hostname?: unknown; port?: unknown }
  if (typeof options.path === 'string') return null
  const host =
    typeof options.host === 'string'
      ? options.host
      : typeof options.hostname === 'string'
        ? options.hostname
        : 'localhost'
  const port = typeof options.port === 'number' ? options.port : Number(options.port) || undefined
  return { host, port }
}

function check(via: 'socket' | 'tls', args: readonly unknown[]): void {
  const destination = destinationOf(args)
  if (destination === null || isLoopback(destination.host)) return
  attempts.push({ ...destination, via })
  throw new Error(
    `the loopback guard refused an outbound connection to ${destination.host}:${destination.port ?? '?'} (${via})`,
  )
}

/** Idempotent, so two files that both install it in `beforeAll` do not stack wrappers. */
export function installLoopbackOnly(): void {
  if (originalSocketConnect !== undefined) return
  originalSocketConnect = net.Socket.prototype.connect as unknown as ConnectFn
  originalTlsConnect = tls.connect as unknown as ConnectFn
  const socketConnect = originalSocketConnect
  const tlsConnect = originalTlsConnect
  net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: unknown[]) {
    check('socket', args)
    return Reflect.apply(socketConnect, this, args)
  } as typeof net.Socket.prototype.connect
  ;(tls as { connect: unknown }).connect = function patchedTlsConnect(...args: unknown[]) {
    check('tls', args)
    return Reflect.apply(tlsConnect, tls, args)
  }
}

export function restoreLoopbackOnly(): void {
  if (originalSocketConnect === undefined) return
  net.Socket.prototype.connect = originalSocketConnect as typeof net.Socket.prototype.connect
  ;(tls as { connect: unknown }).connect = originalTlsConnect
  originalSocketConnect = undefined
  originalTlsConnect = undefined
}

export function offMachineAttempts(): OffMachineAttempt[] {
  return [...attempts]
}

export function clearOffMachineAttempts(): void {
  attempts.length = 0
}

/** Fails the test that produced the attempt, whether or not the client swallowed the throw. */
export function assertLoopbackOnly(): void {
  const seen = offMachineAttempts()
  clearOffMachineAttempts()
  if (seen.length > 0)
    throw new Error(
      `a test tried to connect off this machine: ${seen
        .map((a) => `${a.via} ${a.host}:${a.port ?? '?'}`)
        .join(', ')}`,
    )
}
