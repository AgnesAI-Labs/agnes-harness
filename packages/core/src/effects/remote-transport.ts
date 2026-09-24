/**
 * Portable remote channel contract (B1). No host implementation types are required.
 *
 * exec MUST preserve argv, cwd, env and stdin. For shell-only APIs quote every argv element
 * with single quotes and escape each embedded quote by closing, backslash-quoting, and reopening
 * the quoted string; never interpolate raw elements. Nonzero exits MUST resolve; only failures
 * to start/communicate reject. For SDKs such as E2B, catch CommandExitError and return its result.
 * stdin may require multiple requests. Abort may only abandon waiting; providers must document
 * whether they also terminate the process. timeout and signal result fields are best-effort.
 * maxOutputBytes/truncated are best-effort client-visible limits: client byte truncation is
 * permitted. truncated means returned output is incomplete, regardless of where it was cut.
 *
 * download of a missing path MUST reject with code ENOENT, never an empty result. upload MUST
 * create missing parents. ENOTDIR is best-effort (ENOENT is allowed); EACCES/EISDIR are also
 * best-effort. Otherwise reject with a structured POSIX code or UNKNOWN, never guessed text.
 * An optional exec probe may recover a precise errno. A partially completed upload is not
 * atomic: retain completed writes, do not roll them back. Callers own atomic staging.
 *
 * alive is synchronous local knowledge; it MUST NOT perform network I/O. close releases the
 * channel, not necessarily the sandbox, and is idempotent. After close alive is false and
 * exec/upload/download MUST reject. Remote sandbox destruction belongs to provider lifecycle;
 * host workspace cleanup only removes a directory. Never fall back to local execution.
 */
export type RemoteTransport = Readonly<{
  exec(
    cmd: string[],
    opts: {
      cwd: string
      env?: Record<string, string>
      stdin?: string
      timeoutMs?: number
      signal?: AbortSignal
      maxOutputBytes?: number
    },
  ): Promise<{
    code: number
    stdout: string
    stderr: string
    truncated: boolean
    timedOut?: boolean
    signal?: string
  }>
  upload(files: readonly { path: string; content: Uint8Array }[]): Promise<void>
  download(paths: readonly string[]): Promise<readonly { path: string; content: Uint8Array }[]>
  /** False once the channel is gone. Operations must then throw, never degrade to a local path. */
  alive(): boolean
  close(): Promise<void>
}>

export class RemoteTransportClosed extends Error {
  override name = 'RemoteTransportClosed'
  constructor() {
    super('the remote transport is closed')
  }
}
